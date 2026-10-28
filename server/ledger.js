import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, isPostgres, ledgerRows as storedLedgerRows, appendLedgerRow } from "./store.js";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR as STATE_DIR } from "../shared-config.js";

const DATA_DIR = STATE_DIR;
const LEDGER_PATH = `${DATA_DIR}/ledger.json`;
const BALANCES_PATH = `${DATA_DIR}/balances.json`;
const STARTING_SIM_BALANCE = 5.0;

// Hash-chained audit ledger (issue #11). Each entry carries the hash of the
// entry before it, so the ledger is tamper-evident: editing, deleting, or
// reordering any historical row breaks every hash after it, and
// verifyLedgerChain() reports exactly where. This turns the ledger from "a
// JSON file an admin can quietly edit" into an append-only audit record —
// the property an enterprise buyer's compliance team actually asks for.
// It is NOT a blockchain and makes no distributed-consensus claim; it's a
// standard hash chain (the same construction as a Git commit history).
const GENESIS_HASH = "0".repeat(64);

// The fields that are bound into the hash. Deliberately excludes prevHash and
// entryHash themselves; everything else about the entry is covered.
function entryDigest(entry, prevHash) {
  const { entryHash, prevHash: _p, ...bound } = entry;
  const canonical = JSON.stringify(bound, Object.keys(bound).sort());
  return createHash("sha256").update(prevHash + canonical).digest("hex");
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(path, fallback) {
  ensureDataDir();
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  ensureDataDir();
  writeFileSync(path, JSON.stringify(value, null, 2));
}

// The ledger stays in memory between reads; the file is re-parsed only when it
// changes on disk (the test suite and the CLI write it directly). Before, every
// read parsed the whole file — what made a 10,000-entry ledger slow. Callers
// get a copy of the array, never the cache itself.
let cachedRows = null;
let cachedStamp = null;
function fileStamp() {
  try {
    const st = statSync(LEDGER_PATH);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}
function ledgerRows() {
  // With Postgres storage the ledger is the store's append-only table (server/store.js).
  if (isPostgres()) return storedLedgerRows();
  const stamp = fileStamp();
  if (!cachedRows || stamp !== cachedStamp) {
    cachedRows = readJson(LEDGER_PATH, []);
    cachedStamp = stamp;
  }
  return cachedRows;
}

export function getLedger() {
  return ledgerRows().slice();
}

export function appendLedgerEntry(entry) {
  const ledger = ledgerRows();
  const prevHash = ledger.length ? ledger[ledger.length - 1].entryHash || GENESIS_HASH : GENESIS_HASH;
  const record = { ts: new Date().toISOString(), ...entry, prevHash };
  record.entryHash = entryDigest(record, prevHash);
  if (isPostgres()) {
    appendLedgerRow(record); // one INSERT, not a rewrite of the whole history
    return ledger.slice();
  }
  ledger.push(record);
  writeJson(LEDGER_PATH, ledger);
  cachedStamp = fileStamp();
  return ledger.slice();
}

// Walk the chain and confirm every entry's hash still matches its content and
// its link to the entry before it. Returns { valid, length, brokenAt } —
// brokenAt is the index of the first tampered/broken entry, or null if intact.
export function verifyLedgerChain() {
  const ledger = getLedger();
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i];
    // Pre-#11 entries (written before hash-chaining existed) have no entryHash;
    // treat the first hashed entry as the start of the verifiable chain rather
    // than failing a ledger that legitimately predates the feature.
    if (e.entryHash == null) {
      prevHash = GENESIS_HASH;
      continue;
    }
    if (e.prevHash !== prevHash || entryDigest(e, e.prevHash) !== e.entryHash) {
      return { valid: false, length: ledger.length, brokenAt: i };
    }
    prevHash = e.entryHash;
  }
  return { valid: true, length: ledger.length, brokenAt: null };
}

export function getBalances() {
  return readJson(BALANCES_PATH, {});
}

function saveBalances(balances) {
  writeJson(BALANCES_PATH, balances);
}

// Balances are per address AND per chain — paying on Polygon debits the
// Polygon balance, never the Base one. Each (address, chain) pair is seeded
// on first sight, modelling a wallet the user pre-funded on that chain.
// Older single-number balances migrate to { "base-sepolia": n } on read.
function chainBalancesOf(balances, key) {
  if (typeof balances[key] === "number") balances[key] = { "base-sepolia": balances[key] };
  if (!balances[key]) balances[key] = {};
  return balances[key];
}

export function getSimBalance(address, chain = "base-sepolia") {
  const balances = getBalances();
  const perChain = chainBalancesOf(balances, address.toLowerCase());
  if (!(chain in perChain)) {
    perChain[chain] = STARTING_SIM_BALANCE;
    saveBalances(balances);
  }
  return perChain[chain];
}

export function debitSimBalance(address, amountUSD, chain = "base-sepolia") {
  const balances = getBalances();
  const perChain = chainBalancesOf(balances, address.toLowerCase());
  if (!(chain in perChain)) perChain[chain] = STARTING_SIM_BALANCE;
  perChain[chain] = Math.round((perChain[chain] - amountUSD) * 1e6) / 1e6;
  saveBalances(balances);
  return perChain[chain];
}

export function creditSimBalance(address, amountUSD, chain = "base-sepolia") {
  const balances = getBalances();
  const perChain = chainBalancesOf(balances, address.toLowerCase());
  if (!(chain in perChain)) perChain[chain] = STARTING_SIM_BALANCE;
  perChain[chain] = Math.round((perChain[chain] + amountUSD) * 1e6) / 1e6;
  saveBalances(balances);
  return perChain[chain];
}

export function recentPaidSpend(address, sinceMs) {
  const cutoff = Date.now() - sinceMs;
  const key = address.toLowerCase();
  const entries = getLedger().filter(
    (e) => e.status === "paid" && e.address?.toLowerCase() === key && new Date(e.ts).getTime() >= cutoff
  );
  const totalUSD = entries.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  return { totalUSD, count: entries.length };
}
