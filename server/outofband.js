// Out-of-band spend detection — the payments an agent makes without asking.
//
// Everything SpendVeto governs passes through it. An agent that holds its own
// key can also pay around it: a direct USDC transfer, an x402 session through
// some other facilitator, a second MCP server with its own payment rail. Each
// in-gate call passes and the budget is exceeded in aggregate anyway — the gap
// GitHub issue #1 named. So the governed wallets are watched where the money
// actually moves, the chain, and every outgoing stablecoin transfer is
// reconciled against the ledger:
//
//   - one SpendVeto recorded (same transaction hash, or the same payer, payee,
//     amount and chain moments apart) is managed: already counted;
//   - one it never saw is UNMANAGED spend — booked against the same hourly
//     budget and delegation caps as governed spend, so the caps stay truthful;
//     alerted; and, under policy.outOfBand.onDetect "freeze", the wallet is
//     frozen until a human looks.
//
// What this is NOT: prevention. A wallet whose key the agent holds can always
// sign something; detection is what a key-holding agent allows. Prevention is
// custody — the keyless enforcement proxy (proxy/server.js) — or sellers that
// require governed-spend attestations (integrations/seller-express.js).
// Only stablecoin transfers the registry can price are valued; native-coin
// transfers aren't watched.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "./store.js";
import { createPublicClient, http, parseAbiItem } from "viem";
import { CHAINS, DATA_DIR } from "../shared-config.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const STATE_PATH = `${DATA_DIR}/outofband.json`;
const KEEP = 5000; // recent transfer keys and matched ledger entries remembered, for idempotency

export const OUT_OF_BAND_DEFAULTS = {
  enabled: false,
  onDetect: "alert", // or "freeze"
  pollSeconds: 60,
  chains: ["base-sepolia"],
  wallets: [],
  ignoreTo: [],
  lookbackBlocks: 1000,
  maxBlockRange: 2000,
  matchWindowSeconds: 900,
  graceSeconds: 120,
};

export function outOfBandSettings(policy) {
  const o = policy?.outOfBand || {};
  return {
    ...OUT_OF_BAND_DEFAULTS,
    ...o,
    onDetect: o.onDetect === "freeze" ? "freeze" : "alert",
    chains: Array.isArray(o.chains) && o.chains.length ? o.chains : OUT_OF_BAND_DEFAULTS.chains,
    wallets: Array.isArray(o.wallets) ? o.wallets : [],
    ignoreTo: Array.isArray(o.ignoreTo) ? o.ignoreTo : [],
  };
}

const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const round = (n) => Math.round(n * 1e6) / 1e6;

// One transfer, the same shape whether it came from an RPC scan or an
// indexer's webhook. Anything that isn't a well-formed EVM token transfer on a
// registered chain is dropped, never guessed into shape.
export function normalizeTransfer(t) {
  const chain = CHAINS.find((c) => c.id === t?.chain);
  if (!chain || !/^eip155:/.test(chain.caip2 || "")) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(t.txHash || "") || !isAddress(t.from) || !isAddress(t.to) || !isAddress(t.token)) return null;
  const logIndex = Number(t.logIndex);
  if (!Number.isInteger(logIndex) || logIndex < 0) return null;
  let value;
  try {
    value = BigInt(t.value);
  } catch {
    return null;
  }
  if (value <= 0n) return null;
  const blockTime = t.blockTime != null ? new Date(typeof t.blockTime === "number" ? t.blockTime * 1000 : t.blockTime) : null;
  return {
    chain: chain.id,
    txHash: t.txHash.toLowerCase(),
    logIndex,
    from: t.from.toLowerCase(),
    to: t.to.toLowerCase(),
    token: t.token.toLowerCase(),
    value: value.toString(),
    blockNumber: t.blockNumber != null ? String(t.blockNumber) : null,
    blockTime: blockTime && Number.isFinite(blockTime.getTime()) ? blockTime.toISOString() : null,
  };
}

// The registry's USDC on that chain is priced (6 decimals); any other token is
// recorded as unpriced — still unmanaged, still alerted, but never assumed to
// be worth a dollar.
export function priceTransfer(t) {
  const chain = CHAINS.find((c) => c.id === t.chain);
  if (chain?.usdc && chain.usdc.toLowerCase() === t.token) return round(Number(t.value) / 1e6);
  return null;
}

export const transferKey = (t) => `${t.chain}:${t.txHash}:${t.logIndex}`;

function readState() {
  try {
    const st = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return { cursors: st.cursors || {}, seen: Array.isArray(st.seen) ? st.seen : [], matched: Array.isArray(st.matched) ? st.matched : [], pending: Array.isArray(st.pending) ? st.pending : [], lastScan: st.lastScan || null };
  } catch {
    return { cursors: {}, seen: [], matched: [], pending: [], lastScan: null };
  }
}

function writeState(st) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ ...st, seen: st.seen.slice(-KEEP), matched: st.matched.slice(-KEEP) }, null, 2));
}

export function outOfBandState() {
  return readState();
}

// Reconcile transfers against the ledger. Pure apart from the remembered
// keys: the caller books what comes back as unmanaged. `watched` are the
// governed wallets (lowercase); a transfer from anyone else isn't ours to
// judge, and one to an address in `ignoreTo` (the operator's own treasury,
// say) is a movement the operator declared legitimate.
//
// A payment SpendVeto itself just made can be on-chain a moment before the
// client has written its ledger entry, so an unmatched transfer younger than
// `graceSeconds` isn't judged yet: it waits (state.pending) and is matched
// again on the next scan or delivery, once its record has had time to land.
export function reconcile(rawTransfers, { ledger, watched, ignoreTo = [], matchWindowSeconds = OUT_OF_BAND_DEFAULTS.matchWindowSeconds, graceSeconds = OUT_OF_BAND_DEFAULTS.graceSeconds, now = Date.now() }) {
  const st = readState();
  const seen = new Set(st.seen);
  const matched = new Set(st.matched);
  const watchedSet = new Set(watched.map((a) => a.toLowerCase()));
  const ignoreSet = new Set(ignoreTo.map((a) => String(a).toLowerCase()));
  const paid = ledger.filter((e) => e.status === "paid");
  const out = { managed: [], unmanaged: [], ignored: [], deferred: 0, duplicates: 0, invalid: 0, foreign: 0 };
  const candidates = [...st.pending, ...rawTransfers];
  st.pending = [];
  const pendingKeys = new Set();
  for (const raw of candidates) {
    const t = normalizeTransfer(raw);
    if (!t) {
      out.invalid++;
      continue;
    }
    const key = transferKey(t);
    if (seen.has(key) || pendingKeys.has(key)) {
      out.duplicates++;
      continue;
    }
    if (!watchedSet.has(t.from)) {
      out.foreign++;
      continue;
    }
    if (ignoreSet.has(t.to)) {
      seen.add(key);
      st.seen.push(key);
      out.ignored.push(t);
      continue;
    }
    const usd = priceTransfer(t);
    const at = t.blockTime ? Date.parse(t.blockTime) : now;
    // Exact: the ledger entry carries this transaction's hash (testnet x402
    // payments record the facilitator's settlement hash).
    let entry = paid.find((e) => typeof e.txHash === "string" && e.txHash.toLowerCase() === t.txHash);
    // Otherwise the same payer, chain and amount (and payee, when the entry
    // names one) within the match window — each ledger entry claims at most
    // one transfer, so two identical payments can't hide behind one record.
    if (!entry && usd != null) {
      entry = paid.find(
        (e) =>
          !matched.has(e.entryHash) &&
          e.address?.toLowerCase() === t.from &&
          (e.chain || "base-sepolia") === t.chain &&
          Math.abs(Number(e.amount) - usd) < 1e-6 &&
          (!e.payTo || String(e.payTo).toLowerCase() === t.to) &&
          Math.abs(Date.parse(e.ts) - at) <= matchWindowSeconds * 1000
      );
    }
    if (entry) {
      seen.add(key);
      st.seen.push(key);
      matched.add(entry.entryHash);
      st.matched.push(entry.entryHash);
      out.managed.push({ transfer: t, entryHash: entry.entryHash });
    } else if (now - at < graceSeconds * 1000) {
      pendingKeys.add(key);
      st.pending.push(t);
      out.deferred++;
    } else {
      seen.add(key);
      st.seen.push(key);
      out.unmanaged.push({ transfer: t, usd });
    }
  }
  writeState(st);
  return out;
}

const rpcFor = (chain) => process.env[`SPENDVETO_RPC_${chain.id.toUpperCase().replace(/-/g, "_")}`] || chain.rpc;

// Read outgoing stablecoin transfers of the watched wallets from each chain's
// RPC: ERC-20 Transfer logs on the registry's USDC, filtered by sender. The
// first scan of a chain looks back `lookbackBlocks`; later scans resume from
// the block after the last one read, so nothing is read twice or skipped.
export async function scanChains({ chains, wallets, lookbackBlocks, maxBlockRange }) {
  const st = readState();
  const transfers = [];
  const scanned = [];
  for (const id of chains) {
    const chain = CHAINS.find((c) => c.id === id);
    if (!chain?.usdc || !/^eip155:/.test(chain.caip2 || "") || !wallets.length) continue;
    const client = createPublicClient({ transport: http(rpcFor(chain)) });
    const latest = await client.getBlockNumber();
    let from = st.cursors[id] != null ? BigInt(st.cursors[id]) + 1n : latest > BigInt(lookbackBlocks) ? latest - BigInt(lookbackBlocks) : 0n;
    const blockTimes = new Map();
    while (from <= latest) {
      const to = from + BigInt(maxBlockRange) - 1n < latest ? from + BigInt(maxBlockRange) - 1n : latest;
      const logs = await client.getLogs({ address: chain.usdc, event: TRANSFER, args: { from: wallets }, fromBlock: from, toBlock: to });
      for (const log of logs) {
        if (!blockTimes.has(log.blockNumber)) blockTimes.set(log.blockNumber, Number((await client.getBlock({ blockNumber: log.blockNumber })).timestamp));
        transfers.push({ chain: id, txHash: log.transactionHash, logIndex: log.logIndex, from: log.args.from, to: log.args.to, token: log.address, value: String(log.args.value), blockNumber: String(log.blockNumber), blockTime: blockTimes.get(log.blockNumber) });
      }
      from = to + 1n;
    }
    st.cursors[id] = String(latest);
    scanned.push({ chain: id, toBlock: String(latest) });
  }
  // The cursor is saved only after every chain's logs were read: a failed
  // scan is retried from the same blocks rather than silently skipping them.
  const fresh = readState();
  writeState({ ...fresh, cursors: { ...fresh.cursors, ...st.cursors }, lastScan: new Date().toISOString() });
  return { transfers, scanned };
}
