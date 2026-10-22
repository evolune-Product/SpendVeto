// Human approval: persisted, multi-approver, fails closed on timeout, and a
// key that can spend can never approve.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startApp, client, tenantWithKeys, makeClock, usd } from "./helpers.mjs";

let pool, app, clock, t, spend, approve, approve2, approveAs, admin, manage, read;

before(async () => {
  pool = await freshDb();
  clock = makeClock();
  app = await startApp(pool, { now: clock.now });
  t = await tenantWithKeys(pool);
  spend = client(app.url, t.keys.spend);
  approve = client(app.url, t.keys.approve);
  approve2 = client(app.url, t.keys.approve2);
  approveAs = client(app.url, t.keys.approve_as);
  admin = client(app.url, t.keys.admin);
  manage = client(app.url, t.keys.manage);
  read = client(app.url, t.keys.read);
  await manage.put("/budgets/org", { cap_micros: usd(100), approval_above_micros: usd(5) });
  await manage.put("/budgets/agent", { parent: "org" });
});
after(async () => {
  await app?.close();
  await pool?.end();
});

const authorize = (dollars, extra = {}, c = spend) => c.post("/authorize", { budget: "agent", estimate_micros: usd(dollars), ...extra });
const usage = async (b = "org") => (await read.get(`/budgets/${b}`)).body.budget.usage;

test("below the threshold: no approval needed", async () => {
  assert.equal((await authorize(5)).body.decision, "allow");
});

test("above an ancestor's threshold: needs_approval, the amount is held, settle is refused until approved", async () => {
  const before = (await usage()).reserved_micros;
  const a = await authorize(20, { operation: "llm.chat", model: "big-model" });
  assert.equal(a.status, 202);
  assert.equal(a.body.decision, "needs_approval");
  assert.ok(a.body.approval_id);
  assert.equal((await usage()).reserved_micros, before + usd(20), "approved spend must still fit when it lands");
  const early = await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(1) });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "approval_pending");

  const pending = await read.get("/approvals?status=pending");
  assert.ok(pending.body.approvals.some((x) => x.approval_id === a.body.approval_id));
  const detail = await spend.get(`/approvals/${a.body.approval_id}`);
  assert.equal(detail.body.approval.budget, "agent");
  assert.equal(detail.body.approval.model, "big-model");

  const d = await approve.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" });
  assert.equal(d.status, 200);
  assert.equal(d.body.approval.status, "approved");
  const r = await spend.get(`/reservations/${a.body.reservation_id}`);
  assert.equal(r.body.status, "held");
  assert.equal((await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(12) })).status, 200);
});

test("a spend key cannot approve its own request", async () => {
  const a = await authorize(10);
  const r = await spend.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "insufficient_scope");
  await spend.post(`/reservations/${a.body.reservation_id}/void`);
});

test("even an admin key cannot approve a spend it requested itself", async () => {
  const a = await authorize(10, {}, admin);
  const r = await admin.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "self_approval");
  // ...but another key can.
  assert.equal((await approve.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" })).body.approval.status, "approved");
  await admin.post(`/reservations/${a.body.reservation_id}/void`);
});

test("deny releases the hold and the reservation can never be settled", async () => {
  const before = (await usage()).reserved_micros;
  const a = await authorize(30);
  const d = await approveAs.post(`/approvals/${a.body.approval_id}/decide`, { decision: "deny", actor: "user:priya", reason: "use a smaller model" });
  assert.equal(d.body.approval.status, "denied");
  assert.equal((await usage()).reserved_micros, before);
  const r = await spend.get(`/reservations/${a.body.reservation_id}`);
  assert.equal(r.body.status, "denied");
  assert.equal(r.body.denial.code, "approval_denied");
  assert.match(r.body.denial.reason, /user:priya: use a smaller model/);
  assert.equal((await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: 1 })).body.code, "reservation_denied");
  assert.equal((await approve.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" })).body.code, "approval_not_pending");
});

test("N-approver rule: one plain approve key cannot fill it alone, whatever actor it claims", async () => {
  await manage.put("/budgets/two-man", { approval_above_micros: 0, approvals_required: 2 });
  const a = await spend.post("/authorize", { budget: "two-man", estimate_micros: usd(1) });
  const path = `/approvals/${a.body.approval_id}/decide`;
  // Naming an actor needs approve_as; a plain approve key votes as itself.
  const spoof = await approve.post(path, { decision: "approve", actor: "user:someone-else" });
  assert.equal(spoof.status, 403);
  assert.equal(spoof.body.code, "actor_not_allowed");
  assert.equal((await approve.post(path, { decision: "approve" })).body.approval.status, "pending");
  const again = await approve.post(path, { decision: "approve" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "duplicate_approver");
  // A second human (a second key) completes it.
  const second = await approve2.post(path, { decision: "approve" });
  assert.equal(second.body.approval.status, "approved");
  assert.equal(second.body.approval.approvers.length, 2);
});

test("approve_as: a trusted service votes on behalf of distinct named humans, never the same one twice", async () => {
  const a = await spend.post("/authorize", { budget: "two-man", estimate_micros: usd(1) });
  const path = `/approvals/${a.body.approval_id}/decide`;
  assert.equal((await approveAs.post(path, { decision: "approve", actor: "user:a" })).body.approval.status, "pending");
  assert.equal((await approveAs.post(path, { decision: "approve", actor: "user:a" })).body.code, "duplicate_approver");
  const done = await approveAs.post(path, { decision: "approve", actor: "user:b" });
  assert.equal(done.body.approval.status, "approved");
  assert.deepEqual(done.body.approval.approvers.map((x) => x.actor), ["user:a", "user:b"]);
});

test("a budget frozen while the request waited: the approval cannot release the spend", async () => {
  const before = (await usage()).reserved_micros;
  const a = await authorize(9);
  await manage.post("/budgets/org/freeze", { reason: "cost spike" });
  const d = await approve.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" });
  assert.equal(d.status, 409);
  assert.equal(d.body.code, "budget_frozen");
  assert.equal(d.body.budget, "org");
  const r = await spend.get(`/reservations/${a.body.reservation_id}`);
  assert.equal(r.body.status, "denied");
  assert.equal(r.body.denial.code, "budget_frozen");
  assert.equal((await read.get(`/approvals/${a.body.approval_id}`)).body.approval.status, "denied");
  assert.equal((await usage()).reserved_micros, before, "the hold is released");
  await manage.post("/budgets/org/unfreeze");
});

test("an unanswered approval expires and fails closed (sweeper path)", async () => {
  const before = (await usage()).reserved_micros;
  const a = await authorize(8, { approval_ttl_seconds: 120 });
  clock.advance(121);
  assert.ok((await app.engine.expireDue()) >= 1);
  const ap = await read.get(`/approvals/${a.body.approval_id}`);
  assert.equal(ap.body.approval.status, "expired");
  assert.equal((await spend.get(`/reservations/${a.body.reservation_id}`)).body.status, "expired");
  assert.equal((await usage()).reserved_micros, before);
  // Spend that was never approved can never be settled, and the attempt is on record.
  const s = await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(8) });
  assert.equal(s.status, 409);
  assert.equal(s.body.code, "approval_not_granted");
  assert.equal((await usage()).spent_micros, usd(12), "nothing was booked");
  const events = (await read.get("/events?limit=1000")).body.events;
  assert.ok(events.some((e) => e.type === "settle.refused_unapproved" && e.reservation_id === a.body.reservation_id));
});

test("a decision arriving after the window closes is refused, and the spend stays refused", async () => {
  const a = await authorize(8, { approval_ttl_seconds: 60 });
  clock.advance(61); // no sweep: the decide call itself must notice
  const d = await approve.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" });
  assert.equal(d.status, 409);
  assert.equal(d.body.code, "approval_expired");
  assert.equal((await spend.get(`/reservations/${a.body.reservation_id}`)).body.status, "expired");
});

test("approval can wait for hours (long-running pipelines), up to the 7-day ceiling", async () => {
  const a = await authorize(9, { approval_ttl_seconds: 6 * 3600 });
  clock.advance(5 * 3600);
  await app.engine.expireDue();
  assert.equal((await approve.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" })).body.approval.status, "approved");
  // After approval the caller gets the reservation's full ttl to use it.
  const r = await spend.get(`/reservations/${a.body.reservation_id}`);
  assert.equal(new Date(r.body.expires_at).getTime() - clock.now().getTime(), 900 * 1000);
  // Approved, then left unsettled past its ttl: that spend WAS authorized, so a late settle is booked.
  clock.advance(901);
  await app.engine.expireDue();
  const late = await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(2) });
  assert.equal(late.status, 200);
  assert.equal(late.body.late_settle, true);
  assert.equal((await authorize(9, { approval_ttl_seconds: 604801 })).status, 400);
});

test("voiding a pending reservation cancels its approval", async () => {
  const a = await authorize(7);
  await spend.post(`/reservations/${a.body.reservation_id}/void`);
  assert.equal((await read.get(`/approvals/${a.body.approval_id}`)).body.approval.status, "cancelled");
  assert.equal((await approve.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" })).body.code, "approval_not_pending");
});
