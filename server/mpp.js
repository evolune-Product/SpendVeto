// MPP (Machine Payments Protocol) governance — the buyer's side of Stripe and
// Tempo's HTTP 402 standard.
//
// MPP (mpp.dev; individual IETF draft "The 'Payment' HTTP Authentication
// Scheme", draft-httpauth-payment-01) is x402's sibling. A server answers 402
// with one `WWW-Authenticate: Payment …` challenge per offer; the client pays
// one and retries with `Authorization: Payment <credential>`. Three intents:
// `charge` (one payment), `session` (lock a deposit in an escrow channel, then
// stream signed vouchers against it) and `subscription` (a recurring debit).
// The official client, mppx, leaves the decision to the caller — its docs
// point at preparePayment/onChallenge to "apply a spending policy before
// paying". This module is that policy, and these are the MPP-specific ways an
// agent overspends without it:
//
//   - A session's `amount` is the price per UNIT, "not a total charge". What
//     the agent risks is the deposit it locks, so that is the number policy
//     decides on and holds against the budget until the session closes.
//   - A session names its own escrow contract. One that isn't Tempo's channel
//     reserve asks the agent to deposit into code nobody vetted.
//   - A charge can carry `splits` that route part of the amount to other
//     recipients. An allowlist that only checks `recipient` lets a split send
//     most of the money somewhere the policy never approved.
//   - mppx's parser accepts already-expired challenges and any `header` value;
//     the spec says a client MUST NOT send a credential for either.
//   - The Tempo method drafts disagree about the default chain (charge says
//     the testnet, 42431; session says mainnet, 4217), so a challenge without
//     an explicit chainId has no single meaning.
//   - A subscription is a standing commitment, not a payment: a human signs
//     off on the first one, the way a card mandate needs the customer's own
//     authentication on its first debit.
//
// What this module is NOT: it does not sign, pay, or verify credentials and it
// holds no keys. It reads what the server offered, prices it, and decides —
// before mppx creates a credential. Settlement stays between mppx and the
// server; recording a session's actual spend is the caller's report.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "./store.js";
import { randomUUID } from "node:crypto";
import { CHAINS, DATA_DIR } from "../shared-config.js";

export const MPP_INTENTS = ["charge", "session", "subscription"];
export const MPP_PRICED_METHODS = ["tempo", "evm", "stripe", "card"];

// Tempo networks by chain id, named the way a policy names chains.
export const TEMPO_NETWORKS = { 4217: "tempo", 42431: "tempo-moderato" };
export const MPP_NETWORK_IDS = Object.values(TEMPO_NETWORKS);

// TIP-20 USD stablecoins (every TIP-20 token uses 6 decimals), from viem's
// generated token list (viem/tokens, 2.57.7) and mppx 0.13.5's defaults —
// checked 2026-10-19. OUSD is on both networks at one address (mppx: "deployed
// at the same address on Tempo mainnet and Moderato"). Anything else on Tempo
// is unpriced and refused: a token this table doesn't know is not assumed to
// be worth a dollar.
const TEMPO_USD_TOKENS = {
  4217: {
    "0x20c0000000000000000000006a37da5c996874be": "OUSD",
    "0x20c0000000000000000000000000000000000000": "pathUSD",
    "0x20c000000000000000000000b9537d11c60e8b50": "USDC.e",
  },
  42431: {
    "0x20c0000000000000000000006a37da5c996874be": "OUSD",
    "0x20c0000000000000000000000000000000000000": "pathUSD",
    "0x20c0000000000000000000009e8d7eb59b783726": "USDC.e",
    "0x20c0000000000000000000000000000000000001": "AlphaUSD",
    "0x20c0000000000000000000000000000000000002": "BetaUSD",
    "0x20c0000000000000000000000000000000000003": "ThetaUSD",
  },
};

// Tempo's TIP-1034 channel reserve, the same address on both networks — the
// escrow mppx itself pins unless a caller sets allowCustomEscrow.
export const TEMPO_ESCROW = "0x4d50500000000000000000000000000000000000";

// The only places a client may put a credential (draft §5.2): Authorization,
// or Payment-Authorization when the challenge asks for it.
const CREDENTIAL_HEADERS = new Set(["authorization", "payment-authorization"]);

const fail = (code, reason, suggestion) => ({ ok: false, code, reason, suggestion });
const round = (n) => Math.round(n * 1e6) / 1e6;
const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

// ---- Parsing: the RFC 9110 challenge grammar the draft builds on ----

const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

// Split a WWW-Authenticate value into challenges. Several challenges can share
// one value — fetch's Headers joins repeated headers with ", " — so a comma
// alone doesn't end a challenge: a token followed by "=" is a parameter of the
// current one, any other token starts the next. Non-Payment schemes are kept
// only so their parameters don't bleed into a Payment challenge.
export function splitChallenges(value) {
  const out = [];
  let cur = null;
  let i = 0;
  const s = String(value);
  const n = s.length;
  const ws = (c) => c === " " || c === "\t";
  while (i < n) {
    while (i < n && (ws(s[i]) || s[i] === ",")) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && TCHAR.test(s[j])) j++;
    if (j === i) {
      i++; // stray character (a token68's "=" padding on some other scheme): skip it
      continue;
    }
    const tok = s.slice(i, j);
    let k = j;
    while (k < n && ws(s[k])) k++;
    if (cur && s[k] === "=" && s[k + 1] !== "=") {
      k++;
      while (k < n && ws(s[k])) k++;
      let v = "";
      if (s[k] === '"') {
        k++;
        while (k < n && s[k] !== '"') {
          if (s[k] === "\\" && k + 1 < n) k++;
          v += s[k++];
        }
        if (s[k] !== '"') {
          cur.error = "unterminated quoted-string";
          break;
        }
        k++;
      } else {
        const m = k;
        while (k < n && TCHAR.test(s[k])) k++;
        v = s.slice(m, k);
      }
      const name = tok.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(cur.params, name)) cur.error = `parameter "${name}" appears twice`;
      cur.params[name] = v;
      i = k;
    } else {
      cur = { scheme: tok, params: {} };
      out.push(cur);
      i = j;
    }
  }
  return out;
}

function decodeRequest(b64) {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9_-]+$/.test(b64)) return null; // base64url, padding forbidden (§5.1)
  try {
    const json = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    return json && typeof json === "object" && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

// Normalize one challenge — from a parsed header, or an object the way mppx
// hands it to onChallenge (request already decoded) — and check what the
// draft requires of it. Returns { ok, challenge } or a named failure.
export function normalizeChallenge(input) {
  let c;
  if (input && typeof input === "object" && !("params" in input)) {
    c = { ...input, request: typeof input.request === "string" ? decodeRequest(input.request) : input.request };
  } else {
    if (input?.error) return fail("mpp_challenge_malformed", `challenge could not be parsed: ${input.error}`, "refuse this offer — a challenge that doesn't parse can't be priced");
    const p = input?.params || {};
    c = { id: p.id, realm: p.realm, method: p.method, intent: p.intent, request: decodeRequest(p.request), requestRaw: p.request, expires: p.expires, description: p.description, digest: p.digest, header: p.header, opaque: p.opaque };
  }
  for (const k of ["id", "realm", "method", "intent"]) {
    if (typeof c[k] !== "string" || !c[k]) return fail("mpp_challenge_malformed", `challenge is missing "${k}"`, "refuse this offer — id, realm, method, intent and request are all required");
  }
  if (!c.request) return fail("mpp_challenge_malformed", "challenge request is missing or isn't base64url JSON without padding", "refuse this offer — its terms can't be read");
  if (!/^[a-z]+$/.test(c.method)) return fail("mpp_challenge_malformed", `method "${c.method}" isn't a lowercase method name`, "refuse this offer — the draft requires lowercase letters only");
  return { ok: true, challenge: c };
}

export function parseChallenges(input) {
  const values = Array.isArray(input) ? input : [input];
  const offers = [];
  for (const v of values) {
    if (v && typeof v === "object") offers.push(normalizeChallenge(v));
    else for (const ch of splitChallenges(v || "")) if (ch.scheme.toLowerCase() === "payment") offers.push(normalizeChallenge(ch));
  }
  return offers;
}

// ---- Pricing: base units on the wire → USD, or a refusal ----

function baseUnits(v) {
  return typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) ? BigInt(v) : null;
}
const unitsToUSD = (units, decimals) => round(Number(units) / 10 ** decimals);

function chainIdOf(request) {
  const id = request.methodDetails?.chainId ?? request.chainId;
  return Number.isInteger(id) ? id : null;
}

// What one unit of the request's `amount` is worth, and where it settles.
export function priceRequest(method, request) {
  if (method === "tempo") {
    const chainId = chainIdOf(request);
    if (chainId == null) return fail("mpp_chain_unspecified", "the Tempo offer names no chainId, and the method drafts disagree on the default (testnet 42431 for charge, mainnet 4217 for session)", "refuse — ask the server to state methodDetails.chainId explicitly");
    if (!TEMPO_NETWORKS[chainId]) return fail("mpp_chain_unknown", `chainId ${chainId} is not a Tempo network (4217 mainnet, 42431 Moderato)`, "refuse this offer");
    const symbol = typeof request.currency === "string" ? TEMPO_USD_TOKENS[chainId][request.currency.toLowerCase()] : null;
    if (!symbol) return fail("mpp_currency_unpriced", `currency ${request.currency} is not a USD stablecoin SpendVeto knows on ${TEMPO_NETWORKS[chainId]}`, "refuse — an unknown token is never assumed to be worth a dollar; pay with OUSD, pathUSD or USDC.e");
    return { ok: true, decimals: 6, symbol, network: TEMPO_NETWORKS[chainId], chainId, settlesOnChain: true };
  }
  if (method === "evm") {
    const chainId = chainIdOf(request);
    if (chainId == null) return fail("mpp_chain_unspecified", "the EVM offer names no chainId", "refuse — ask the server to state the chain");
    const chain = CHAINS.find((c) => c.caip2 === `eip155:${chainId}`);
    if (!chain) return fail("mpp_chain_unknown", `chainId ${chainId} is not in SpendVeto's chain registry`, "refuse this offer, or register the chain first");
    if (typeof request.currency !== "string" || request.currency.toLowerCase() !== String(chain.usdc).toLowerCase()) {
      return fail("mpp_currency_unpriced", `currency ${request.currency} is not the registry's USDC on ${chain.id}`, "refuse — only the chain's registered USDC is priced");
    }
    if (request.decimals != null && request.decimals !== 6) return fail("mpp_currency_unpriced", `the offer says ${request.decimals} decimals; USDC has 6`, "refuse — the decimals don't match the token");
    return { ok: true, decimals: 6, symbol: "USDC", network: chain.id, chainId, settlesOnChain: true };
  }
  if (method === "stripe" || method === "card") {
    if (String(request.currency).toLowerCase() !== "usd") return fail("mpp_currency_unpriced", `currency "${request.currency}" — only USD card and Stripe offers are priced`, "refuse, or pay a USD offer if the server makes one");
    return { ok: true, decimals: 2, symbol: "USD", network: null, chainId: null, settlesOnChain: false };
  }
  return fail("mpp_method_unpriced", `method "${method}" isn't one SpendVeto can price yet (priced: ${MPP_PRICED_METHODS.join(", ")})`, "refuse this offer rather than guess its value, or pay one of the server's other offers");
}

// ---- Assessment: the MPP-specific rules, before the policy engine ----

const PERIOD_DAYS = { day: 1, week: 7, month: 30 };

// Everything about one offer that doesn't depend on the agent's budget: is it
// well-formed and payable, what does it put at risk, and to whom. `deposit` is
// the session deposit the agent proposes in base units (default: the server's
// suggestedDeposit). The policy engine then decides on `exposureUSD`.
export function assessChallenge(c, { now = Date.now(), deposit, mpp = {} } = {}) {
  if (!MPP_INTENTS.includes(c.intent)) return fail("mpp_intent_unsupported", `intent "${c.intent}" isn't governed (governed: ${MPP_INTENTS.join(", ")})`, "refuse this offer");
  if (c.header != null && !CREDENTIAL_HEADERS.has(String(c.header).toLowerCase())) {
    return fail("mpp_credential_header_invalid", `the challenge asks for the credential in "${c.header}" — the draft forbids sending it anywhere but Authorization or Payment-Authorization`, "refuse — a server asking for the credential in an arbitrary header is not following the protocol");
  }
  if (c.expires != null) {
    const exp = Date.parse(c.expires);
    if (!Number.isFinite(exp)) return fail("mpp_challenge_malformed", `expires "${c.expires}" isn't an RFC 3339 timestamp`, "refuse this offer");
    if (exp <= now) return fail("mpp_challenge_expired", `the challenge expired at ${c.expires}`, "request the resource again for a fresh challenge — never pay an expired one");
  }
  const r = c.request;
  if ("expires" in r) return fail("mpp_challenge_malformed", "the request repeats the expiry, which the draft forbids (it belongs in the header only)", "refuse this offer");
  if (Array.isArray(mpp.allowedMethods) && mpp.allowedMethods.length && !mpp.allowedMethods.includes(c.method)) {
    return fail("mpp_method_not_allowed", `method "${c.method}" is not in policy.mpp.allowedMethods (${mpp.allowedMethods.join(", ")})`, "pay one of the server's other offers, or have a human add the method");
  }
  const price = priceRequest(c.method, r);
  if (!price.ok) return price;
  const amount = baseUnits(r.amount);
  if (amount == null) return fail("mpp_challenge_malformed", `amount "${r.amount}" isn't a base-unit integer string`, "refuse this offer");
  if (price.settlesOnChain && !isAddress(r.recipient)) return fail("mpp_recipient_missing", "an on-chain offer must name its recipient address", "refuse — there is no payee to check");
  const recipient = r.recipient ? String(r.recipient) : null;
  const base = { ok: true, id: c.id, realm: c.realm, method: c.method, intent: c.intent, currency: { address: r.currency, symbol: price.symbol, decimals: price.decimals }, network: price.network, chainId: price.chainId, recipient, resource: `mpp:${c.realm}:${c.method}:${c.intent}`, expires: c.expires ?? null };

  if (c.intent === "charge") {
    // Every recipient of the money is a payee. Splits are checked against the
    // same allowlist, sanctions list and reputation as the main recipient.
    const splits = Array.isArray(r.methodDetails?.splits) ? r.methodDetails.splits : [];
    let splitTotal = 0n;
    const payees = recipient ? [{ payee: recipient, units: amount }] : [];
    for (const sp of splits) {
      const u = baseUnits(sp?.amount);
      if (u == null || !isAddress(sp?.recipient)) return fail("mpp_challenge_malformed", "a split is missing its amount or recipient address", "refuse this offer");
      splitTotal += u;
      payees.push({ payee: sp.recipient, units: u });
    }
    if (splitTotal > amount) return fail("mpp_splits_exceed_amount", `splits total ${splitTotal} base units, more than the ${amount} being charged`, "refuse — the offer routes more than it charges");
    if (payees[0]) payees[0].units = amount - splitTotal; // the main recipient receives what the splits don't
    const chargeUSD = unitsToUSD(amount, price.decimals);
    return { ...base, exposureUSD: chargeUSD, chargeUSD, maxAmount: String(amount), payees: payees.map((p) => ({ payee: p.payee, usd: unitsToUSD(p.units, price.decimals) })) };
  }

  if (c.intent === "session") {
    const escrow = r.methodDetails?.escrowContract;
    if (c.method === "tempo") {
      if (!isAddress(escrow)) return fail("mpp_session_escrow_missing", "the session names no escrow contract", "refuse — a session deposit must go to an escrow");
      if (escrow.toLowerCase() !== TEMPO_ESCROW && mpp.allowCustomEscrow !== true) {
        return fail("mpp_session_escrow_untrusted", `the session's escrow ${escrow} is not Tempo's channel reserve (${TEMPO_ESCROW})`, "refuse — depositing into an unvetted contract can lose the whole deposit; a human can set policy.mpp.allowCustomEscrow after reviewing it");
      }
    }
    const depositUnits = deposit != null ? baseUnits(String(deposit)) : baseUnits(r.suggestedDeposit);
    if (depositUnits == null || depositUnits === 0n) return fail("mpp_session_deposit_missing", "no deposit to govern: the offer suggests none and none was proposed", "propose a deposit (the most this session may lock) and evaluate again");
    const unitUSD = unitsToUSD(amount, price.decimals);
    if (mpp.maxUnitPriceUSD != null && unitUSD > Number(mpp.maxUnitPriceUSD)) {
      return fail("mpp_unit_price_cap", `the session charges $${unitUSD} per ${r.unitType || "unit"}, above policy.mpp.maxUnitPriceUSD $${mpp.maxUnitPriceUSD}`, "refuse this session, or have a human raise the cap");
    }
    const depositUSD = unitsToUSD(depositUnits, price.decimals);
    return { ...base, exposureUSD: depositUSD, depositUSD, unitUSD, unitType: r.unitType || null, maxDeposit: String(depositUnits), escrow: escrow || null, payees: recipient ? [{ payee: recipient, usd: depositUSD }] : [] };
  }

  // subscription
  const periodUnit = r.periodUnit;
  if (!PERIOD_DAYS[periodUnit]) return fail("mpp_challenge_malformed", `periodUnit "${periodUnit}" must be day, week or month`, "refuse this offer");
  if (c.method === "tempo" && periodUnit === "month") return fail("mpp_challenge_malformed", "Tempo subscriptions can't bill monthly (the Tempo subscription draft: servers MUST reject periodUnit month)", "refuse this offer");
  const periodCount = Number(r.periodCount ?? 1);
  if (!Number.isInteger(periodCount) || periodCount < 1) return fail("mpp_challenge_malformed", `periodCount "${r.periodCount}" must be a positive integer`, "refuse this offer");
  const periodUSD = unitsToUSD(amount, price.decimals);
  const periodMs = periodCount * PERIOD_DAYS[periodUnit] * 86400000;
  const ends = r.subscriptionExpires ? Date.parse(r.subscriptionExpires) : NaN;
  // The whole commitment when the subscription states its end; open-ended ones
  // are reported per period only — there is no total to promise.
  const periods = Number.isFinite(ends) && ends > now ? Math.ceil((ends - now) / periodMs) : null;
  return { ...base, exposureUSD: periodUSD, periodUSD, periodUnit, periodCount, commitmentUSD: periods ? round(periodUSD * periods) : null, subscriptionExpires: r.subscriptionExpires || null, payees: recipient ? [{ payee: recipient, usd: periodUSD }] : [] };
}

// ---- Holds: money MPP has been allowed to move but nobody has reported yet ----
//
// SpendVeto is not in an MPP payment's path — mppx pays the server directly —
// so the budget only sees what is reported. Rather than let unreported spend
// vanish, everything allowed is HELD against the budget (folded into
// GET /api/upto/holds, which client/policy.js adds to settled spend) until the
// client reports the outcome. An allowed charge nobody reports is booked as
// paid once its challenge expires: a governance layer that can't see the
// payment assumes it happened. A session's whole deposit stays held until the
// session closes — the funds sit in escrow until then, and over-counting
// exposure is the safe direction.

const STATE_PATH = `${DATA_DIR}/mpp.json`;
const CHARGE_TTL_MS = 5 * 60 * 1000; // a charge whose challenge states no expiry

function readState() {
  try {
    const st = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return { charges: Array.isArray(st.charges) ? st.charges : [], sessions: Array.isArray(st.sessions) ? st.sessions : [] };
  } catch {
    return { charges: [], sessions: [] };
  }
}

function writeState(st) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// Lazy, like server/upto.js: an unreported charge past its expiry becomes
// "assumed_paid" on the next read, and `book` writes its ledger entry dated
// when it was allowed, so it ages out of the hourly window like any payment.
function sweep(st, book) {
  const now = Date.now();
  let changed = false;
  for (const c of st.charges) {
    if (c.status === "authorized" && Date.parse(c.expiresAt) <= now) {
      c.status = "assumed_paid";
      c.resolvedAt = new Date(now).toISOString();
      book(c);
      changed = true;
    }
  }
  return changed;
}

// Only a read that can book sweeps: marking a charge assumed_paid without
// writing its ledger entry would drop the spend from the budget entirely.
function load(book) {
  const st = readState();
  if (book && sweep(st, book)) writeState(st);
  return st;
}

export function mppHoldUSD(address, book) {
  if (!address) return 0;
  const st = load(book);
  const charges = st.charges.filter((c) => c.status === "authorized" && sameAddress(c.address, address)).reduce((sum, c) => sum + c.amountUSD, 0);
  const sessions = st.sessions.filter((x) => x.status === "open" && sameAddress(x.address, address)).reduce((sum, x) => sum + x.depositUSD, 0);
  return round(charges + sessions);
}

// A charge (or a subscription's first period) the policy allowed.
export function authorizeCharge({ address, offer, now = Date.now() }) {
  const st = load();
  const exp = offer.expires ? Date.parse(offer.expires) : NaN;
  const row = {
    id: `mppc_${randomUUID()}`,
    address,
    resource: offer.resource,
    realm: offer.realm,
    method: offer.method,
    intent: offer.intent,
    recipient: offer.recipient,
    network: offer.network,
    amountUSD: offer.intent === "subscription" ? offer.periodUSD : offer.chargeUSD,
    status: "authorized",
    authorizedAt: new Date(now).toISOString(),
    expiresAt: new Date(Number.isFinite(exp) ? exp : now + CHARGE_TTL_MS).toISOString(),
  };
  st.charges.push(row);
  writeState(st);
  return row;
}

// The client's report: "paid" (with the server's Payment-Receipt, kept as
// evidence) books the spend; "failed" releases the hold. Each charge resolves
// once — a second report is refused, never double-booked.
export function reportCharge(id, { outcome, receipt } = {}, book) {
  const st = load(book);
  const c = st.charges.find((x) => x.id === id);
  if (!c) return fail("mpp_charge_unknown", `no charge "${id}"`, "report against the chargeId returned by /api/mpp/evaluate");
  if (c.status !== "authorized") return fail("mpp_charge_resolved", `charge ${id} is already ${c.status}`, "nothing to report — each charge resolves once");
  if (outcome !== "paid" && outcome !== "failed") return fail("mpp_outcome_invalid", 'outcome must be "paid" or "failed"', "report what happened to the payment");
  c.status = outcome;
  c.resolvedAt = new Date().toISOString();
  if (receipt) c.receipt = String(receipt).slice(0, 2000);
  writeState(st);
  if (outcome === "paid") book?.(c);
  return { ok: true, charge: c };
}

// Bookkeeping only: the caller has already run the policy check on the deposit.
export function openSession({ address, offer, channelId }) {
  const st = load();
  const row = {
    id: `mpps_${randomUUID()}`,
    address,
    resource: offer.resource,
    realm: offer.realm,
    method: offer.method,
    recipient: offer.recipient,
    network: offer.network,
    currency: offer.currency,
    unitUSD: offer.unitUSD,
    unitType: offer.unitType,
    depositUSD: offer.depositUSD,
    maxDeposit: offer.maxDeposit,
    escrow: offer.escrow,
    channelId: channelId || null,
    cumulative: "0",
    spentUSD: 0,
    vouchers: 0,
    status: "open",
    openedAt: new Date().toISOString(),
  };
  st.sessions.push(row);
  writeState(st);
  return row;
}

// A voucher states the CUMULATIVE amount the server may claim, never a delta,
// and the escrow only caps it at the deposit. So the buyer's side refuses a
// voucher that goes backwards (a replay, or a server rewriting history) or
// past the deposit this session was approved for.
export function recordVoucher(id, cumulative) {
  const st = load();
  const s = st.sessions.find((x) => x.id === id);
  if (!s) return fail("mpp_session_unknown", `no session "${id}"`, "record vouchers against the sessionId returned when the session opened");
  if (s.status !== "open") return fail("mpp_session_closed", `session ${id} is ${s.status}`, "open a new session");
  const units = baseUnits(String(cumulative));
  if (units == null) return fail("mpp_voucher_invalid", "cumulative must be a base-unit integer string", "send the voucher's cumulativeAmount");
  if (units < BigInt(s.cumulative)) return fail("mpp_voucher_regressed", `voucher cumulative ${units} is below the ${s.cumulative} already signed`, "refuse — vouchers are cumulative and can't go backwards");
  if (units > BigInt(s.maxDeposit)) return fail("mpp_voucher_over_deposit", `voucher cumulative ${units} exceeds the approved deposit ${s.maxDeposit}`, "refuse to sign — the session would spend more than was approved; close it and evaluate a new one");
  s.cumulative = String(units);
  s.spentUSD = unitsToUSD(units, s.currency.decimals);
  s.vouchers += 1;
  writeState(st);
  return { ok: true, session: s, remainingUSD: round(s.depositUSD - s.spentUSD) };
}

// Closing books what was actually consumed and releases the rest of the hold.
export function closeSession(id, finalCumulative, book) {
  if (finalCumulative != null) {
    const r = recordVoucher(id, finalCumulative);
    if (!r.ok) return r;
  }
  const st = load();
  const s = st.sessions.find((x) => x.id === id);
  if (!s) return fail("mpp_session_unknown", `no session "${id}"`, "close the sessionId returned when the session opened");
  if (s.status !== "open") return fail("mpp_session_closed", `session ${id} is already ${s.status}`, "nothing to close");
  s.status = "closed";
  s.closedAt = new Date().toISOString();
  s.releasedUSD = round(s.depositUSD - s.spentUSD);
  writeState(st);
  book?.(s);
  return { ok: true, session: s };
}

export function mppState(address, book) {
  const st = load(book);
  const mine = (rows) => (address ? rows.filter((r) => sameAddress(r.address, address)) : rows);
  return { charges: mine(st.charges).slice(-200), sessions: mine(st.sessions).slice(-200) };
}
