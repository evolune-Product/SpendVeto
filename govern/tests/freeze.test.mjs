// Kill switch: manual freeze of any node stops its whole subtree; runaway
// bursts freeze automatically.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startApp, client, tenantWithKeys, makeClock, usd } from "./helpers.mjs";

let pool, app, clock, spend, manage, read;

before(async () => {
  pool = await freshDb();
  clock = makeClock();
  app = await startApp(pool, { now: clock.now });
  const t = await tenantWithKeys(pool);
  spend = client(app.url, t.keys.spend);
  manage = client(app.url, t.keys.manage);
  read = client(app.url, t.keys.read);
  await manage.post("/budgets/sync", { budgets: [{ budget: "org" }, { budget: "dept", parent: "org" }, { budget: "agent", parent: "dept" }] });
});
after(async () => {
  await app?.close();
  await pool?.end();
});

const authorize = (budget = "agent") => spend.post("/authorize", { budget, estimate_micros: usd(0.01) });

test("freezing a department stops every agent under it; unfreezing restores", async () => {
  const f = await manage.post("/budgets/dept/freeze", { reason: "investigating a cost spike" });
  assert.equal(f.status, 200);
  assert.equal(f.body.budget.frozen, true);
  const d = await authorize();
  assert.equal(d.status, 403);
  assert.equal(d.body.code, "budget_frozen");
  assert.equal(d.body.budget, "dept");
  assert.match(d.body.reason, /investigating a cost spike/);
  assert.equal((await authorize("org")).status, 201, "the parent itself is not frozen");
  // Freezing twice is a no-op; unfreezing an unfrozen budget is a 409.
  assert.equal((await manage.post("/budgets/dept/freeze", {})).body.replayed, true);
  assert.equal((await manage.post("/budgets/dept/unfreeze")).status, 200);
  assert.equal((await manage.post("/budgets/dept/unfreeze")).body.code, "not_frozen");
  assert.equal((await authorize()).status, 201);
});

test("a spend key cannot unfreeze", async () => {
  await manage.post("/budgets/org/freeze", {});
  assert.equal((await spend.post("/budgets/org/unfreeze")).status, 403);
  await manage.post("/budgets/org/unfreeze");
});

test("burst: more attempts per minute than allowed auto-freezes the budget, and stays frozen", async () => {
  await manage.put("/budgets/loopy", { parent: "org", burst_per_minute: 5, cap_micros: usd(0.02) });
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await authorize("loopy"));
  // Attempts 1-2 fit the cap, 3-5 are refused by the cap but still COUNT,
  // attempt 6 trips the burst limit.
  assert.deepEqual(results.slice(0, 2).map((r) => r.status), [201, 201]);
  assert.deepEqual(results.slice(2, 5).map((r) => r.body.code), ["budget_cap", "budget_cap", "budget_cap"]);
  assert.equal(results[5].body.code, "burst_frozen");
  assert.equal(results[6].body.code, "budget_frozen");
  const b = (await read.get("/budgets/loopy")).body.budget;
  assert.equal(b.frozen_source, "burst");
  clock.advance(120);
  assert.equal((await authorize("loopy")).body.code, "budget_frozen", "a new minute does not unfreeze it — a human must");
  await manage.post("/budgets/loopy/unfreeze");
  await manage.put("/budgets/loopy", { cap_micros: usd(1) });
  assert.equal((await authorize("loopy")).status, 201);
});
