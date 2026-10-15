// x402 `auth-capture` scheme governance — the buyer's side of an escrow.
//
// `exact` moves a fixed amount once and can never give it back. `auth-capture`
// (x402-foundation/x402, specs/schemes/auth-capture, v1.1 2026-08-18; TS SDK
// support merged 2026-10-06) gives a payment a lifecycle instead: the client
// signs ONE token authorization for a maximum, the funds move into the
// commerce-payments `AuthCaptureEscrow`, and from then on the SELLER drives it
// — `capture` (repeatable, up to the hold), `void` (release the rest),
// `refund` (after the fact, until a deadline). The client's only move after
// signing is `reclaim`: recovering its own hold once the capture deadline has
// passed, a call the facilitator never relays.
//
// That is a better deal for a buyer than `exact` — recourse exists — but only
// if somebody on the buyer's side is actually holding the seller to the
// terms. Nobody does today: the facilitator validates the seller's calls for
// the seller's protocol, and the agent that signed has moved on. So this
// module does four things, all on the buyer's side, none of them a facilitator:
//
//   1. Refuses to sign a malformed or hostile route BEFORE any money moves —
//      a non-canonical escrow (the authorization would pay a contract nobody
//      audited), a token authorization pointed at the wrong collector, deadlines
//      out of order, a fee recipient left open with a fee range granted (the
//      spec forbids it: the submitter could route the fee anywhere), and the
//      one the spec warns about by name — a collect-only route that publishes
//      sync capture, which escrows the buyer's funds and then strands them
//      until the capture deadline.
//   2. Governs the MAXIMUM, not the eventual charge, and holds the open escrow
//      against the hourly budget until it resolves (same pre-auth semantics as
//      server/upto.js; both feed /api/upto/holds, which client/policy.js reads).
//   3. Re-checks every seller lifecycle call against the terms the buyer
//      signed: capture never beyond the hold or after the capture deadline,
//      charge at most once and never above the maximum, refund never beyond
//      what was captured or after the refund deadline.
//   4. Watches for money left behind: a hold the seller neither captured nor
//      voided by the capture deadline is the buyer's to reclaim, and the
//      reclaim call is the buyer's alone. Nothing else reports that number.
//
// What this module is NOT: it does not sign, relay, or submit anything, it is
// not a facilitator, and it reads no chain state. Lifecycle events reach it
// from whoever observes them (the seller's settle responses, an indexer, the
// operator); it checks them against the signed terms and books the result.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CHAINS } from "../shared-config.js";

const DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));
const AC_PATH = `${DATA_DIR}/authcapture.json`;

// The two canonical commerce-payments CREATE2 sets named by the EVM binding
// (scheme_auth_capture_evm.md, "Commerce-payments deployments"). Same address
// on every supported chain for a given deployment; an omitted
// extra.authCaptureEscrow means v1.1.
export const ESCROW_DEPLOYMENTS = {
  "v1.1": {
    escrow: "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c",
    eip3009Collector: "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88",
    permit2Collector: "0xD69831Aed5bfe262067ec4c751f4F830EcdD446e",
    operatorRefundCollector: "0x7a03443724d14798c4AB4622F1DAAcA761Fea486",
  },
  "v1.0": {
    escrow: "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff",
    eip3009Collector: "0x0E3dF9510de65469C4518D7843919c0b8C7A7757",
    permit2Collector: "0x992476B9Ee81d52a5BdA0622C333938D0Af0aB26",
    operatorRefundCollector: "0x934907bffd0901b6A21e398B9C53A4A38F02fa5d",
  },
};

// Buyer-side defaults when policy.authCapture leaves a field out. A week is a
// long time for an agent's money to sit in someone else's escrow; an operator
// who wants longer says so. The refund-window floor is off by default — an
// operator who wants "buyer protection or we don't pay" sets it.
export const AUTH_CAPTURE_DEFAULTS = {
  maxHoldSeconds: 7 * 24 * 3600,
  minRefundWindowSeconds: 0,
  allowedFlows: ["escrow", "authorization"],
  allowedOperatorTypes: ["delegated", "custom"],
  allowedOperators: null,
};

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const isZero = (v) => v == null || same(v, ZERO);
const round = (n) => Math.round(n * 1e6) / 1e6;
const fail = (code, reason, suggestion) => ({ ok: false, code, reason, suggestion });

function readAll() {
  if (!existsSync(AC_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(AC_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(rows) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(AC_PATH, JSON.stringify(rows, null, 2));
}

const settingsFrom = (policy) => ({ ...AUTH_CAPTURE_DEFAULTS, ...(policy?.authCapture || {}) });

// Resolve which canonical deployment a route names. Anything else is refused:
// the facilitator is required to reject it too, but by then the buyer would
// already have signed an authorization that names that contract.
function resolveDeployment(extra) {
  if (extra.authCaptureEscrow == null) return { version: "v1.1", ...ESCROW_DEPLOYMENTS["v1.1"] };
  for (const [version, d] of Object.entries(ESCROW_DEPLOYMENTS)) {
    if (same(extra.authCaptureEscrow, d.escrow)) return { version, ...d };
  }
  return null;
}

// Pre-sign evaluation of one 402 `accepts` entry with scheme "auth-capture".
// Pure: no state, no policy engine — server/index.js runs checkPolicy on the
// maximum afterwards. `authorizationTo` is the recipient the client's token
// authorization names (authorization.to for EIP-3009, spender for Permit2),
// when the caller has it.
export function evaluateRequirements(requirements, { policy, authorizationTo, nowMs = Date.now() } = {}) {
  const r = requirements || {};
  const extra = r.extra || {};
  const s = settingsFrom(policy);

  if (r.scheme !== "auth-capture") return fail("ac_scheme_mismatch", `scheme is "${r.scheme}", not "auth-capture"`, "send an accepts entry whose scheme is auth-capture");

  // The only network binding the spec defines is EVM, and the buyer prices
  // the maximum in the registry's stablecoin for that chain — an unknown
  // network or token is a price in a unit nobody here can read.
  const chain = CHAINS.find((c) => c.caip2 === r.network);
  if (!chain || chain.family) return fail("ac_network_unsupported", `network ${r.network} is not a registered EVM chain`, "auth-capture has only an EVM binding; use a registered EVM network");
  if (!same(r.asset, chain.usdc)) return fail("ac_asset_mismatch", `asset ${r.asset} is not ${chain.name}'s registered stablecoin ${chain.usdc}`, "only the registry's canonical stablecoin is priced here — an unknown token is an unknown price");
  const atomic = Number(r.amount);
  if (!Number.isFinite(atomic) || atomic <= 0) return fail("ac_amount_invalid", "amount must be a positive atomic-unit integer", "the amount is the maximum the client authorizes");
  const maxUSD = round(atomic / 1e6);

  const deployment = resolveDeployment(extra);
  if (!deployment) {
    return fail("ac_escrow_not_canonical", `extra.authCaptureEscrow ${extra.authCaptureEscrow} is not one of the two canonical commerce-payments escrows`, "refuse to sign: a non-canonical escrow is a contract nobody audited holding your funds — the facilitator must reject it too, but only after you signed");
  }
  const method = extra.assetTransferMethod || "eip3009";
  const expectedCollector = method === "permit2" ? deployment.permit2Collector : deployment.eip3009Collector;
  if (authorizationTo != null && !same(authorizationTo, expectedCollector)) {
    return fail("ac_collector_mismatch", `the token authorization pays ${authorizationTo}, but the ${deployment.version} ${method} collector is ${expectedCollector}`, "refuse to sign: an authorization pointed anywhere but the matching collector is a transfer, not an escrow");
  }

  const flow = extra.paymentFlow || "escrow";
  if (!["escrow", "authorization"].includes(flow)) return fail("ac_flow_invalid", `paymentFlow "${flow}" is not defined by the scheme`, "use escrow or authorization");
  if (!s.allowedFlows.includes(flow)) return fail("ac_flow_not_allowed", `paymentFlow "${flow}" is not in policy.authCapture.allowedFlows`, `allowed: ${s.allowedFlows.join(", ")}`);

  const operatorType = extra.operatorType || "delegated";
  if (!["delegated", "custom", "policy"].includes(operatorType)) return fail("ac_operator_type_invalid", `operatorType "${operatorType}" is not defined by the scheme`, "use delegated or custom");
  if (!s.allowedOperatorTypes.includes(operatorType)) return fail("ac_operator_type_not_allowed", `operatorType "${operatorType}" is not in policy.authCapture.allowedOperatorTypes`, `allowed: ${s.allowedOperatorTypes.join(", ")}`);
  if (!isAddr(extra.captureAuthorizer)) return fail("ac_extra_invalid", "extra.captureAuthorizer is required — it is the payment's operator", "the route must name its operator");
  if (Array.isArray(s.allowedOperators) && !s.allowedOperators.some((a) => same(a, extra.captureAuthorizer))) {
    return fail("ac_operator_not_allowed", `operator ${extra.captureAuthorizer} is not in policy.authCapture.allowedOperators`, "add the operator to the allowlist after reviewing who controls it, or decline the route");
  }

  // Deadlines: absolute Unix seconds (uint48). The escrow enforces
  // capture-before-refund ordering; a route that gets it backwards can't
  // have been tested against the contract it claims to use.
  const nowS = Math.floor(nowMs / 1000);
  const captureDeadline = Number(extra.captureDeadline);
  const refundDeadline = Number(extra.refundDeadline);
  if (!Number.isInteger(captureDeadline) || !Number.isInteger(refundDeadline)) return fail("ac_extra_invalid", "extra.captureDeadline and extra.refundDeadline are required Unix-second integers", "the route must state both deadlines");
  if (captureDeadline <= nowS) return fail("ac_deadline_passed", `captureDeadline ${captureDeadline} is not in the future`, "a hold that can never be captured is only ever reclaimed — ask for a fresh route");
  if (refundDeadline < captureDeadline) return fail("ac_deadline_order", `refundDeadline ${refundDeadline} is before captureDeadline ${captureDeadline}`, "the escrow requires the refund deadline at or after the capture deadline — this route cannot work as described");
  if (flow === "escrow" && captureDeadline - nowS > s.maxHoldSeconds) {
    return fail("ac_hold_too_long", `funds would sit in escrow up to ${captureDeadline - nowS}s, over policy.authCapture.maxHoldSeconds ${s.maxHoldSeconds}`, "ask for an earlier capture deadline or raise maxHoldSeconds — until then this money is neither spent nor yours");
  }
  if (refundDeadline - captureDeadline < s.minRefundWindowSeconds) {
    return fail("ac_refund_window_short", `the refund window is ${refundDeadline - captureDeadline}s, under policy.authCapture.minRefundWindowSeconds ${s.minRefundWindowSeconds}`, "this operator requires buyer recourse after capture; ask for a later refund deadline");
  }

  // Fees come out of what the receiver gets, not on top of what the buyer
  // pays — but the bounds still have to be ones the escrow will accept, and
  // the spec makes one combination illegal outright: a zero fee recipient
  // with a non-zero range lets the submitter name any address as recipient.
  const minFeeBps = Number(extra.minFeeBps);
  const maxFeeBps = Number(extra.maxFeeBps);
  if (!Number.isInteger(minFeeBps) || !Number.isInteger(maxFeeBps) || minFeeBps < 0 || maxFeeBps > 10000 || minFeeBps > maxFeeBps) {
    return fail("ac_fee_bounds_invalid", `fee bounds ${extra.minFeeBps}–${extra.maxFeeBps} bps are not 0 ≤ min ≤ max ≤ 10000`, "the route must state integer minFeeBps ≤ maxFeeBps in 0–10000");
  }
  if (isZero(extra.feeRecipient) && maxFeeBps > 0 && operatorType !== "policy") {
    return fail("ac_fee_receiver_unbound", `feeRecipient is the zero address with up to ${maxFeeBps} bps of fees granted`, "the spec forbids this under delegated/custom operators: the submitter could send the fee to any address — decline the route");
  }

  // The stranding case the spec names: collect-only routes (custom operators,
  // or delegated with no receiver authorizer) relay no lifecycle, so a
  // published (or defaulted) sync capture is refused after the collect has
  // already escrowed the funds — which then sit until the capture deadline.
  const collectOnly = operatorType === "custom" || (operatorType === "delegated" && isZero(extra.receiverAuthorizer));
  const captureMode = extra.captureMode || "sync";
  if (flow === "escrow" && collectOnly && captureMode === "sync") {
    return fail("ac_route_strands_funds", `a collect-only route (${operatorType}${operatorType === "delegated" ? ", no receiverAuthorizer" : ""}) with ${extra.captureMode ? "" : "default "}sync capture escrows the payment and then cannot capture or void it`, "decline: the funds would be stuck until captureDeadline and recoverable only by your own reclaim — the route must publish captureMode \"deferred\"");
  }
  if (flow === "authorization" && isZero(extra.receiverAuthorizer)) {
    return fail("ac_charge_unauthorizable", "the authorization flow settles by charge, and charge requires a non-zero receiverAuthorizer", "this route can never collect — decline it");
  }

  return {
    ok: true,
    maxUSD,
    chain: chain.id,
    payee: r.payTo || null,
    flow,
    operatorType,
    operator: extra.captureAuthorizer,
    escrowVersion: deployment.version,
    escrow: deployment.escrow,
    captureDeadline: new Date(captureDeadline * 1000).toISOString(),
    refundDeadline: new Date(refundDeadline * 1000).toISOString(),
    fees: { minFeeBps, maxFeeBps, feeRecipient: extra.feeRecipient || ZERO },
    collectOnly,
  };
}

// Lazy sweep, same reasoning as server/upto.js: a hold past its capture
// deadline can no longer be captured, so it stops holding budget — and the
// remaining balance becomes the buyer's to reclaim, which is the number worth
// surfacing. An authorization-flow payment never charged by its deadline just
// lapses (nothing moved).
function sweep(rows) {
  const now = Date.now();
  let changed = false;
  for (const row of rows) {
    if (row.status === "held" && Date.parse(row.captureDeadline) <= now) {
      row.status = "reclaimable";
      row.reclaimableUSD = round(row.maxUSD - row.capturedUSD);
      row.reclaimableSince = row.captureDeadline;
      changed = true;
    } else if (row.status === "authorized" && Date.parse(row.captureDeadline) <= now) {
      row.status = "lapsed";
      changed = true;
    }
  }
  return changed;
}

export function getPayments() {
  const rows = readAll();
  if (sweep(rows)) writeAll(rows);
  return rows;
}

export function findPayment(id) {
  return getPayments().find((r) => r.id === id) || null;
}

// What an address has committed to auth-capture and could still lose to a
// capture or charge: the uncaptured part of every live hold, plus the full
// maximum of every authorization-flow payment not yet charged.
export function authCaptureHoldUSD(address) {
  if (!address) return 0;
  return round(
    getPayments()
      .filter((r) => same(r.address, address))
      .reduce((sum, r) => sum + (r.status === "held" ? r.maxUSD - r.capturedUSD : r.status === "authorized" ? r.maxUSD : 0), 0)
  );
}

// Book a payment the buyer has just collected (authorize in the escrow flow,
// the client authorization in the authorization flow). The caller evaluated
// the route and ran policy on the maximum first.
export function recordCollect({ address, evaluation, toolId, category }) {
  const row = {
    id: `ac_${randomUUID()}`,
    address,
    payee: evaluation.payee,
    chain: evaluation.chain,
    toolId: toolId || null,
    category: category || null,
    flow: evaluation.flow,
    operatorType: evaluation.operatorType,
    operator: evaluation.operator,
    escrowVersion: evaluation.escrowVersion,
    escrow: evaluation.escrow,
    maxUSD: evaluation.maxUSD,
    captureDeadline: evaluation.captureDeadline,
    refundDeadline: evaluation.refundDeadline,
    fees: evaluation.fees,
    status: evaluation.flow === "escrow" ? "held" : "authorized",
    capturedUSD: 0,
    refundedUSD: 0,
    releasedUSD: 0,
    events: [{ op: evaluation.flow === "escrow" ? "authorize" : "verify", amountUSD: evaluation.maxUSD, at: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
  };
  const rows = getPayments();
  rows.push(row);
  writeAll(rows);
  return row;
}

function withPayment(id, fn) {
  const rows = getPayments();
  const row = rows.find((r) => r.id === id);
  if (!row) return fail("ac_unknown", `no auth-capture payment with id "${id}"`, "use an id returned by /api/authcapture/authorize");
  const result = fn(row);
  if (result.ok) writeAll(rows);
  return result;
}

const amountOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? round(n) : null;
};

// capture — escrow flow, repeatable up to the hold, never after the capture
// deadline (past it the hold belongs to the buyer's reclaim).
export function capturePayment(id, amountUSD) {
  return withPayment(id, (row) => {
    if (row.flow !== "escrow") return fail("ac_wrong_flow", `payment ${id} is an authorization-flow payment — it settles by charge, not capture`, "use charge");
    const amount = amountOf(amountUSD);
    if (amount == null) return fail("ac_amount_invalid", "capture amount must be a positive number", "send the amount being captured");
    if (row.status === "reclaimable" || Date.parse(row.captureDeadline) <= Date.now()) {
      return fail("ac_capture_after_deadline", `capture deadline ${row.captureDeadline} has passed`, "refuse it: past the capture deadline the remaining hold is the buyer's to reclaim, not the seller's to take");
    }
    if (row.status !== "held") return fail("ac_not_held", `payment ${id} is ${row.status} — nothing left to capture`, "a voided or fully captured payment holds nothing");
    const remaining = round(row.maxUSD - row.capturedUSD);
    if (amount > remaining) {
      return fail("ac_over_capture", `capture of $${amount} exceeds the remaining hold $${remaining} (authorized $${row.maxUSD}, captured $${row.capturedUSD})`, "refuse it and raise it with the seller — the buyer signed for the maximum, not past it");
    }
    row.capturedUSD = round(row.capturedUSD + amount);
    if (row.capturedUSD >= row.maxUSD) row.status = "captured";
    row.events.push({ op: "capture", amountUSD: amount, at: new Date().toISOString() });
    return { ok: true, payment: row, capturedUSD: amount, remainingUSD: round(row.maxUSD - row.capturedUSD) };
  });
}

// charge — authorization flow, exactly once, at most the maximum.
export function chargePayment(id, amountUSD) {
  return withPayment(id, (row) => {
    if (row.flow !== "authorization") return fail("ac_wrong_flow", `payment ${id} is an escrow payment — it settles by capture, not charge`, "use capture");
    if (row.status === "charged") return fail("ac_already_charged", `payment ${id} was already charged $${row.capturedUSD}`, "charge is terminal and happens once; a second charge is a replay");
    if (row.status !== "authorized") return fail("ac_not_chargeable", `payment ${id} is ${row.status}`, "the authorization lapsed at its deadline — the client must sign again");
    const amount = amountOf(amountUSD);
    if (amount == null) return fail("ac_amount_invalid", "charge amount must be a positive number", "send the amount being charged");
    if (amount > row.maxUSD) return fail("ac_over_charge", `charge of $${amount} exceeds the authorized maximum $${row.maxUSD}`, "refuse it — the client authorized at most the maximum");
    row.capturedUSD = amount;
    row.releasedUSD = round(row.maxUSD - amount);
    row.status = "charged";
    row.events.push({ op: "charge", amountUSD: amount, at: new Date().toISOString() });
    return { ok: true, payment: row, capturedUSD: amount, releasedUSD: row.releasedUSD };
  });
}

// void — release what is still held. Only while something is held.
export function voidPayment(id) {
  return withPayment(id, (row) => {
    if (row.flow !== "escrow") return fail("ac_wrong_flow", `payment ${id} is an authorization-flow payment — it holds nothing to void`, "an uncharged authorization simply lapses");
    if (row.status !== "held") return fail("ac_not_held", `payment ${id} is ${row.status} — nothing held to void`, row.status === "reclaimable" ? "past the capture deadline only the buyer's reclaim releases the hold" : "nothing to release");
    const released = round(row.maxUSD - row.capturedUSD);
    row.releasedUSD = round(row.releasedUSD + released);
    row.status = row.capturedUSD > 0 ? "captured" : "voided";
    row.events.push({ op: "void", amountUSD: released, at: new Date().toISOString() });
    return { ok: true, payment: row, releasedUSD: released };
  });
}

// refund — repeatable up to what was captured and not yet refunded, never
// after the refund deadline.
export function refundPayment(id, amountUSD) {
  return withPayment(id, (row) => {
    const amount = amountOf(amountUSD);
    if (amount == null) return fail("ac_amount_invalid", "refund amount must be a positive number", "send the amount being refunded");
    if (Date.parse(row.refundDeadline) <= Date.now()) return fail("ac_refund_after_deadline", `refund deadline ${row.refundDeadline} has passed`, "the escrow will not refund after its deadline — record it as a credit with the seller instead");
    const refundable = round(row.capturedUSD - row.refundedUSD);
    if (amount > refundable) return fail("ac_over_refund", `refund of $${amount} exceeds what is refundable ($${refundable}: captured $${row.capturedUSD}, refunded $${row.refundedUSD})`, "a refund returns captured money; it cannot return more than was taken");
    row.refundedUSD = round(row.refundedUSD + amount);
    row.events.push({ op: "refund", amountUSD: amount, at: new Date().toISOString() });
    return { ok: true, payment: row, refundedUSD: amount, refundableUSD: round(row.capturedUSD - row.refundedUSD) };
  });
}

// The buyer called reclaim onchain; book it so the money stops showing as
// stranded. Only valid once the hold is actually reclaimable.
export function markReclaimed(id, txHash) {
  return withPayment(id, (row) => {
    if (row.status !== "reclaimable") return fail("ac_not_reclaimable", `payment ${id} is ${row.status}`, Date.parse(row.captureDeadline) > Date.now() ? `reclaim opens at the capture deadline ${row.captureDeadline}` : "nothing to reclaim");
    row.status = "reclaimed";
    row.releasedUSD = round(row.releasedUSD + row.reclaimableUSD);
    row.events.push({ op: "reclaim", amountUSD: row.reclaimableUSD, txHash: txHash || null, at: new Date().toISOString() });
    return { ok: true, payment: row, recoveredUSD: row.reclaimableUSD };
  });
}

// Money the buyer can recover with its own reclaim call right now.
export function reclaimable(address) {
  const rows = getPayments().filter((r) => r.status === "reclaimable" && (!address || same(r.address, address)));
  return {
    address: address || null,
    count: rows.length,
    reclaimableUSD: round(rows.reduce((s, r) => s + r.reclaimableUSD, 0)),
    payments: rows.map((r) => ({ id: r.id, payee: r.payee, chain: r.chain, escrow: r.escrow, reclaimableUSD: r.reclaimableUSD, since: r.reclaimableSince })),
  };
}

export function authCaptureSummary(address) {
  const rows = getPayments().filter((r) => !address || same(r.address, address));
  const sum = (f) => round(rows.reduce((s, r) => s + f(r), 0));
  return {
    address: address || null,
    payments: rows.length,
    heldUSD: address ? authCaptureHoldUSD(address) : sum((r) => (r.status === "held" ? r.maxUSD - r.capturedUSD : r.status === "authorized" ? r.maxUSD : 0)),
    capturedUSD: sum((r) => r.capturedUSD),
    refundedUSD: sum((r) => r.refundedUSD),
    reclaimableUSD: sum((r) => (r.status === "reclaimable" ? r.reclaimableUSD : 0)),
    byStatus: rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {}),
  };
}
