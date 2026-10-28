import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// In-memory by design: an approval only needs to survive one client's poll
// loop within a single server run, unlike the ledger (which is the durable
// record) — this mirrors the existing nonce store in simulate.js.
const approvals = new Map(); // id -> record

export function createApproval({ address, resource, price }) {
  const id = randomUUID();
  const record = { id, address, resource, price, status: "pending", approvals: 0, ts: new Date().toISOString(), decidedAt: null };
  approvals.set(id, record);
  return record;
}

// One-click decide links (the approval alert's approveUrl/denyUrl) carry a
// token bound to the approval id AND the decision, so knowing an id is not
// enough to approve it — the id is visible to anything that can list
// approvals. The secret lives only in this process: approvals are in-memory
// too, so a restart retires links and approvals together.
const LINK_SECRET = randomBytes(32);
export function decideLinkToken(id, decision) {
  return createHmac("sha256", LINK_SECRET).update(`spendveto-decide:${id}:${decision}`).digest("base64url");
}
export function verifyDecideLinkToken(id, decision, token) {
  const want = Buffer.from(decideLinkToken(id, decision));
  const got = Buffer.from(String(token || ""));
  return got.length === want.length && timingSafeEqual(got, want);
}

export function getApproval(id) {
  return approvals.get(id) || null;
}

// requiredApprovals > 1 = the Safe-style N-approver rule: a deny is always
// final and instant, but "approved" only lands when enough humans have
// clicked — one keyholder can stop a spend, one alone can't authorize it.
export function decideApproval(id, decision, requiredApprovals = 1) {
  const record = approvals.get(id);
  if (!record || record.status !== "pending") return null;
  if (decision === "denied") {
    record.status = "denied";
    record.decidedAt = new Date().toISOString();
    return record;
  }
  record.approvals = (record.approvals || 0) + 1;
  if (record.approvals >= requiredApprovals) {
    record.status = "approved";
    record.decidedAt = new Date().toISOString();
  }
  return record;
}

export function listApprovals() {
  return [...approvals.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

// Server-authoritative enforcement (issue #8): the payment gate looks up an
// approved, not-yet-consumed approval that matches the spend it's about to
// settle. This is what makes an above-threshold spend impossible to push
// through a hand-rolled client that skips the approval step — the gate itself
// demands a real approval record before it will settle. Matching is on
// (address, resource, price); the oldest matching approval is returned.
export function findApprovableFor(address, resource, price) {
  const addr = String(address).toLowerCase();
  const priceNum = Number(price);
  return (
    [...approvals.values()]
      .filter(
        (r) =>
          r.status === "approved" &&
          !r.consumed &&
          r.address?.toLowerCase() === addr &&
          r.resource === resource &&
          Number(r.price) === priceNum
      )
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))[0] || null
  );
}

// An approval is single-use: once the gate settles against it, it can never
// authorize a second settlement (replaying an old approval to pay twice is
// exactly the attack this closes).
export function consumeApproval(id) {
  const record = approvals.get(id);
  if (!record || record.status !== "approved" || record.consumed) return null;
  record.consumed = true;
  record.consumedAt = new Date().toISOString();
  return record;
}
