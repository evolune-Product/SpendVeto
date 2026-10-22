// Reserve → settle → void, caps at every level of the tree, windows, expiry,
// idempotency and input validation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startApp, client, tenantWithKeys, makeClock, usd } from "./helpers.mjs";

let pool, app, clock, t, spend, manage, read;

before(async () => {
  pool = await freshDb();
  clock = makeClock();
  app = await startApp(pool, { now: clock.now });
  t = await tenantWithKeys(pool);
  spend = client(app.url, t.keys.spend);
  manage = client(app.url, t.keys.manage);
  read = client(app.url, t.keys.read);
});
after(async () => {
  await app?.close();
  await pool?.end();
});

const authorize = (budget, dollars, extra = {}) => spend.post("/authorize", { budget, estimate_micros: usd(dollars), ...extra });
const usageOf = async (budget) => (await read.get(`/budgets/${budget}`)).body.budget.usage;

test("allow reserves the estimate; settle replaces it with the actual", async () => {
  await manage.put("/budgets/basic", { cap_micros: usd(10), period: "month" });
  const a = await authorize("basic", 2, { model: "claude-sonnet-4-6", provider: "anthropic", operation: "llm.chat" });
  assert.equal(a.status, 201);
  assert.equal(a.body.decision, "allow");
  assert.deepEqual(await usageOf("basic"), { window_start: "2026-03-01T00:00:00.000Z", spent_micros: 0, reserved_micros: usd(2), calls: 1, remaining_micros: usd(8) });

  const s = await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(0.75), input_tokens: 1200, output_tokens: 300 });
  assert.equal(s.status, 200);
  assert.equal(s.body.status, "settled");
  assert.equal(s.body.over_estimate, false);
  const u = await usageOf("basic");
  assert.equal(u.reserved_micros, 0, "the unused headroom is released");
  assert.equal(u.spent_micros, usd(0.75));
  assert.equal(u.remaining_micros, usd(9.25));
});

test("a cap refuses the call that would cross it, with a code and a concrete suggestion", async () => {
  await manage.put("/budgets/capped", { cap_micros: usd(5) });
  assert.equal((await authorize("capped", 4)).status, 201);
  const d = await authorize("capped", 2);
  assert.equal(d.status, 403);
  assert.equal(d.body.decision, "deny");
  assert.equal(d.body.code, "budget_cap");
  assert.equal(d.body.budget, "capped");
  assert.match(d.body.suggestion, /\$1\.00/, "tells the agent exactly how much is left");
  // Exactly the remaining amount still fits.
  assert.equal((await authorize("capped", 1)).status, 201);
});

test("an ancestor's cap binds the whole subtree (two teams share a department cap)", async () => {
  await manage.put("/budgets/dept", { cap_micros: usd(10) });
  await manage.put("/budgets/team-a", { parent: "dept", cap_micros: usd(8) });
  await manage.put("/budgets/team-b", { parent: "dept", cap_micros: usd(8) });
  assert.equal((await authorize("team-a", 6)).status, 201);
  const d = await authorize("team-b", 6);
  assert.equal(d.status, 403);
  assert.equal(d.body.code, "budget_cap");
  assert.equal(d.body.budget, "dept", "the refusal names the level that refused");
  assert.match(d.body.reason, /left on "dept", a parent of "team-b"/);
  assert.equal((await authorize("team-b", 4)).status, 201);
  // Department usage is the sum of its subtree.
  assert.equal((await usageOf("dept")).reserved_micros, usd(10));
});

test("per-call limit on an ancestor applies to every descendant", async () => {
  await manage.put("/budgets/org-pc", { per_call_max_micros: usd(1) });
  await manage.put("/budgets/agent-pc", { parent: "org-pc" });
  const d = await authorize("agent-pc", 1.5);
  assert.equal(d.body.code, "per_call_cap");
  assert.equal(d.body.budget, "org-pc");
  assert.equal((await authorize("agent-pc", 1)).status, 201);
});

test("max calls per period", async () => {
  await manage.put("/budgets/calls", { max_calls_per_period: 2, period: "hour" });
  assert.equal((await authorize("calls", 0.01)).status, 201);
  assert.equal((await authorize("calls", 0.01)).status, 201);
  const d = await authorize("calls", 0.01);
  assert.equal(d.body.code, "call_limit");
  clock.advance(3600); // next hour window
  assert.equal((await authorize("calls", 0.01)).status, 201);
});

test("windows roll over on calendar boundaries (UTC)", async () => {
  clock.set("2026-03-31T23:59:00.000Z");
  await manage.put("/budgets/monthly", { cap_micros: usd(1), period: "month" });
  const a = await authorize("monthly", 1);
  await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(1) });
  assert.equal((await authorize("monthly", 0.5)).body.code, "budget_cap");
  clock.set("2026-04-01T00:00:01.000Z");
  assert.equal((await authorize("monthly", 0.5)).status, 201, "April starts with a fresh budget");
  clock.set("2026-03-15T10:00:00.000Z");
});

test("a 'total' budget never resets", async () => {
  await manage.put("/budgets/lifetime", { cap_micros: usd(1), period: "total" });
  const a = await authorize("lifetime", 1);
  await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(1) });
  clock.advance(86400 * 400);
  assert.equal((await authorize("lifetime", 0.01)).body.code, "budget_cap");
  clock.set("2026-03-15T10:00:00.000Z");
});

test("void releases the hold; voiding twice is a no-op; a voided reservation cannot be settled", async () => {
  await manage.put("/budgets/v", { cap_micros: usd(3) });
  const a = await authorize("v", 3);
  assert.equal((await authorize("v", 1)).body.code, "budget_cap");
  const v1 = await spend.post(`/reservations/${a.body.reservation_id}/void`);
  assert.equal(v1.status, 200);
  assert.equal(v1.body.status, "voided");
  assert.equal((await spend.post(`/reservations/${a.body.reservation_id}/void`)).body.replayed, true);
  assert.equal((await usageOf("v")).reserved_micros, 0);
  const s = await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: 1 });
  assert.equal(s.status, 409);
  assert.equal(s.body.code, "reservation_voided");
  assert.equal((await authorize("v", 3)).status, 201);
});

test("settle is idempotent for the same amount and refuses a different one", async () => {
  await manage.put("/budgets/idem-settle", { cap_micros: usd(10) });
  const a = await authorize("idem-settle", 1);
  const path = `/reservations/${a.body.reservation_id}/settle`;
  assert.equal((await spend.post(path, { actual_micros: usd(0.5) })).status, 200);
  const again = await spend.post(path, { actual_micros: usd(0.5) });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal((await usageOf("idem-settle")).spent_micros, usd(0.5), "a retried settle never double-books");
  const diff = await spend.post(path, { actual_micros: usd(0.6) });
  assert.equal(diff.status, 409);
  assert.equal(diff.body.code, "already_settled");
});

test("an actual above the estimate is booked (the money was really spent) and flagged", async () => {
  await manage.put("/budgets/over", { cap_micros: usd(10) });
  const a = await authorize("over", 1);
  const s = await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(1.4) });
  assert.equal(s.body.over_estimate, true);
  assert.equal((await usageOf("over")).spent_micros, usd(1.4));
});

test("an unsettled reservation expires, releases its hold, and a late settle is still booked", async () => {
  await manage.put("/budgets/exp", { cap_micros: usd(2) });
  const a = await authorize("exp", 2, { ttl_seconds: 60 });
  assert.equal((await authorize("exp", 1)).body.code, "budget_cap");
  clock.advance(61);
  assert.equal(await app.engine.expireDue(), 1);
  const r = await spend.get(`/reservations/${a.body.reservation_id}`);
  assert.equal(r.body.status, "expired");
  assert.equal((await usageOf("exp")).reserved_micros, 0);
  const late = await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(0.3) });
  assert.equal(late.status, 200);
  assert.equal(late.body.late_settle, true);
  assert.equal((await usageOf("exp")).spent_micros, usd(0.3));
  clock.set("2026-03-15T10:00:00.000Z");
});

test("idempotency: same key + same request replays; same key + different request is a conflict", async () => {
  await manage.put("/budgets/idem", { cap_micros: usd(10) });
  const first = await authorize("idem", 1, { idempotency_key: "run-42-step-3" });
  const replay = await authorize("idem", 1, { idempotency_key: "run-42-step-3" });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.reservation_id, first.body.reservation_id);
  assert.equal(replay.body.replayed, true);
  assert.equal((await usageOf("idem")).reserved_micros, usd(1), "a retried authorize never reserves twice");
  const conflict = await authorize("idem", 2, { idempotency_key: "run-42-step-3" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "idempotency_conflict");
  // Header form works too.
  const h = await spend.post("/authorize", { budget: "idem", estimate_micros: usd(1) }, { "Idempotency-Key": "hdr-1" });
  const h2 = await spend.post("/authorize", { budget: "idem", estimate_micros: usd(1) }, { "Idempotency-Key": "hdr-1" });
  assert.equal(h2.body.reservation_id, h.body.reservation_id);
});

test("a retry with the key of a VOIDED or EXPIRED reservation is refused, never a fresh 'allow'", async () => {
  await manage.put("/budgets/idem-dead", { cap_micros: usd(2) });
  const a = await authorize("idem-dead", 2, { idempotency_key: "dead-1", ttl_seconds: 60 });
  await spend.post(`/reservations/${a.body.reservation_id}/void`);
  const retry = await authorize("idem-dead", 2, { idempotency_key: "dead-1", ttl_seconds: 60 });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, "reservation_voided");
  assert.equal((await usageOf("idem-dead")).reserved_micros, 0);

  const b = await authorize("idem-dead", 2, { idempotency_key: "dead-2", ttl_seconds: 60 });
  clock.advance(61);
  await app.engine.expireDue();
  const retry2 = await authorize("idem-dead", 2, { idempotency_key: "dead-2", ttl_seconds: 60 });
  assert.equal(retry2.status, 409);
  assert.equal(retry2.body.code, "reservation_expired");
  assert.equal(retry2.body.reservation_id, b.body.reservation_id);
  // A settled one replays fine (the work happened once).
  const c = await authorize("idem-dead", 1, { idempotency_key: "dead-3" });
  await spend.post(`/reservations/${c.body.reservation_id}/settle`, { actual_micros: usd(1) });
  const retry3 = await authorize("idem-dead", 1, { idempotency_key: "dead-3" });
  assert.equal(retry3.status, 201);
  assert.equal(retry3.body.status, "settled");
  clock.set("2026-03-15T10:00:00.000Z");
});

test("a refused request replays as the same refusal", async () => {
  await manage.put("/budgets/idem-deny", { cap_micros: usd(1) });
  const d1 = await authorize("idem-deny", 5, { idempotency_key: "deny-1" });
  const d2 = await authorize("idem-deny", 5, { idempotency_key: "deny-1" });
  assert.equal(d2.status, 403);
  assert.equal(d2.body.code, "budget_cap");
  assert.equal(d2.body.reservation_id, d1.body.reservation_id);
});

test("unknown budget fails closed with a 404 and a suggestion", async () => {
  const r = await authorize("does-not-exist", 1);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "unknown_budget");
  assert.ok(r.body.suggestion);
});

test("validation: bad amounts, unknown fields, floats in metadata, oversized input are all 400", async () => {
  await manage.put("/budgets/val", {});
  const cases = [
    { budget: "val", estimate_micros: -1 },
    { budget: "val", estimate_micros: 1.5 },
    { budget: "val", estimate_micros: "100" },
    { budget: "val", estimate_micros: 1e13 },
    { budget: "val" },
    { budget: "val", estimate_micros: 1, surprise: true },
    { budget: "val", estimate_micros: 1, metadata: { ratio: 0.5 } },
    { budget: "val", estimate_micros: 1, metadata: { nested: { a: 1 } } },
    { budget: "val", estimate_micros: 1, ttl_seconds: 1 },
    { budget: "bad id with spaces", estimate_micros: 1 },
    { budget: "val", estimate_micros: 1, model: "x\u0000y" },
  ];
  for (const body of cases) {
    const r = await spend.post("/authorize", body);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, "invalid_request");
  }
  assert.equal((await spend.post("/authorize", "{not json")).status, 400);
  const huge = { budget: "val", estimate_micros: 1, model: "x".repeat(70000) };
  assert.equal((await spend.post("/authorize", huge)).status, 413);
  assert.equal((await spend.post("/reservations/not-a-uuid/settle", { actual_micros: 1 })).status, 404);
  assert.equal((await read.get("/reservations?before=not-a-date")).status, 400);
  assert.equal((await read.get("/usage?from=garbage")).status, 400);
});

test("zero-cost calls and budgets with no cap are allowed and still counted", async () => {
  await manage.put("/budgets/uncapped", {});
  const a = await authorize("uncapped", 0);
  assert.equal(a.status, 201);
  assert.equal(a.body.budgets[0].remaining_micros, null);
  assert.equal((await usageOf("uncapped")).calls, 1);
});

test("usage report groups settled spend and rolls up a subtree", async () => {
  await manage.put("/budgets/r-org", {});
  await manage.put("/budgets/r-eng", { parent: "r-org" });
  await manage.put("/budgets/r-sales", { parent: "r-org" });
  for (const [b, est, act, model] of [["r-eng", 1, 0.4, "m1"], ["r-eng", 1, 0.6, "m2"], ["r-sales", 1, 0.25, "m1"]]) {
    const a = await authorize(b, est, { model });
    await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(act), input_tokens: 10, output_tokens: 5 });
  }
  const byBudget = await read.get("/usage?budget=r-org&include_descendants=true&group_by=budget");
  assert.equal(byBudget.status, 200);
  assert.equal(byBudget.body.total_spent_micros, usd(1.25));
  assert.deepEqual(byBudget.body.rows.map((r) => [r.key, r.spent_micros, r.calls]), [["r-eng", usd(1), 2], ["r-sales", usd(0.25), 1]]);
  const byModel = await read.get("/usage?budget=r-org&include_descendants=true&group_by=model");
  assert.deepEqual(byModel.body.rows.map((r) => [r.key, r.spent_micros]), [["m1", usd(0.65)], ["m2", usd(0.6)]]);
  const onlyEng = await read.get("/usage?budget=r-eng&group_by=budget");
  assert.equal(onlyEng.body.total_spent_micros, usd(1));
  assert.equal((await read.get("/usage?group_by=nonsense")).status, 400);
});
