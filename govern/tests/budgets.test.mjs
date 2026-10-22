// Budget tree management: partial updates, cycles, depth, bulk sync, archive.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startApp, client, tenantWithKeys, usd } from "./helpers.mjs";

let pool, app, manage, read, spend;

before(async () => {
  pool = await freshDb();
  app = await startApp(pool);
  const t = await tenantWithKeys(pool);
  manage = client(app.url, t.keys.manage);
  read = client(app.url, t.keys.read);
  spend = client(app.url, t.keys.spend);
});
after(async () => {
  await app?.close();
  await pool?.end();
});

test("create returns 201 with defaults; update returns 200", async () => {
  const c = await manage.put("/budgets/org-1", { label: "Acme", kind: "org", cap_micros: usd(500) });
  assert.equal(c.status, 201);
  assert.equal(c.body.budget.period, "month");
  assert.equal(c.body.budget.approvals_required, 1);
  const u = await manage.put("/budgets/org-1", { label: "Acme Inc" });
  assert.equal(u.status, 200);
  assert.equal(u.body.created, false);
});

test("an omitted field keeps its stored value; an explicit null clears it", async () => {
  await manage.put("/budgets/keep", { cap_micros: usd(10), approval_above_micros: usd(2), per_call_max_micros: usd(1) });
  const u = await manage.put("/budgets/keep", { cap_micros: usd(20) });
  assert.equal(u.body.budget.cap_micros, usd(20));
  assert.equal(u.body.budget.approval_above_micros, usd(2), "not mentioned → untouched");
  const c = await manage.put("/budgets/keep", { approval_above_micros: null });
  assert.equal(c.body.budget.approval_above_micros, null);
  assert.equal(c.body.budget.per_call_max_micros, usd(1));
});

test("reparenting is refused when it would create a cycle (direct or indirect)", async () => {
  await manage.put("/budgets/c-a", {});
  await manage.put("/budgets/c-b", { parent: "c-a" });
  await manage.put("/budgets/c-c", { parent: "c-b" });
  const self = await manage.put("/budgets/c-a", { parent: "c-a" });
  assert.equal(self.body.code, "budget_cycle");
  const indirect = await manage.put("/budgets/c-a", { parent: "c-c" });
  assert.equal(indirect.status, 409);
  assert.equal(indirect.body.code, "budget_cycle");
  // A legal move still works, and the tree reflects it.
  await manage.put("/budgets/c-root", {});
  await manage.put("/budgets/c-a", { parent: "c-root" });
  const g = await read.get("/budgets/c-c");
  assert.deepEqual(g.body.budget.chain.map((x) => x.budget), ["c-c", "c-b", "c-a", "c-root"]);
  // Detaching to a root works too.
  assert.equal((await manage.put("/budgets/c-a", { parent: null })).body.budget.parent_id, null);
});

test("concurrent opposite reparents cannot both succeed (no cycle can slip through)", async () => {
  for (let i = 0; i < 10; i++) {
    await manage.put(`/budgets/r${i}-x`, { parent: null });
    await manage.put(`/budgets/r${i}-y`, { parent: null });
    const [p, q] = await Promise.all([
      manage.put(`/budgets/r${i}-x`, { parent: `r${i}-y` }),
      manage.put(`/budgets/r${i}-y`, { parent: `r${i}-x` }),
    ]);
    const ok = [p, q].filter((r) => r.status === 200).length;
    assert.equal(ok, 1, `round ${i}: exactly one reparent may win (got ${p.status}/${q.status})`);
  }
});

test("trees deeper than 16 levels are refused", async () => {
  await manage.put("/budgets/d0", {});
  for (let i = 1; i < 16; i++) assert.equal((await manage.put(`/budgets/d${i}`, { parent: `d${i - 1}` })).status, 201);
  const tooDeep = await manage.put("/budgets/d16", { parent: "d15" });
  assert.equal(tooDeep.status, 422);
  assert.equal(tooDeep.body.code, "budget_too_deep");
});

test("unknown parent → 404 unknown_parent", async () => {
  const r = await manage.put("/budgets/orphan", { parent: "nope" });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "unknown_parent");
});

test("bulk sync creates parents before children whatever the order, in one transaction", async () => {
  const r = await manage.post("/budgets/sync", {
    budgets: [
      { budget: "s-team", parent: "s-dept", cap_micros: usd(10) },
      { budget: "s-agent", parent: "s-team" },
      { budget: "s-org", cap_micros: usd(1000) },
      { budget: "s-dept", parent: "s-org", cap_micros: usd(100) },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 4);
  assert.deepEqual(r.body.budgets.map((b) => b.budget), ["s-org", "s-dept", "s-team", "s-agent"]);
  const g = await read.get("/budgets/s-agent");
  assert.deepEqual(g.body.budget.chain.map((x) => x.budget), ["s-agent", "s-team", "s-dept", "s-org"]);
  // Re-sync is an update, not a duplicate.
  const again = await manage.post("/budgets/sync", { budgets: [{ budget: "s-team", parent: "s-dept", cap_micros: usd(20) }] });
  assert.equal(again.body.budgets[0].created, false);
});

test("bulk sync is all-or-nothing: one bad item rolls back the rest", async () => {
  const r = await manage.post("/budgets/sync", {
    budgets: [{ budget: "atomic-1" }, { budget: "atomic-2", parent: "does-not-exist" }],
  });
  assert.equal(r.status, 404);
  assert.equal((await read.get("/budgets/atomic-1")).status, 404, "atomic-1 must not exist after the rollback");
  const cyc = await manage.post("/budgets/sync", { budgets: [{ budget: "y1", parent: "y2" }, { budget: "y2", parent: "y1" }] });
  assert.equal(cyc.body.code, "budget_cycle");
  const dup = await manage.post("/budgets/sync", { budgets: [{ budget: "z" }, { budget: "z" }] });
  assert.equal(dup.body.code, "duplicate_budget");
});

test("archived budgets (and their descendants) refuse spend; PUT restores", async () => {
  await manage.put("/budgets/arch-parent", {});
  await manage.put("/budgets/arch-child", { parent: "arch-parent" });
  assert.equal((await manage.del("/budgets/arch-parent")).status, 200);
  assert.equal((await manage.del("/budgets/arch-parent")).body.code, "already_archived");
  const d = await spend.post("/authorize", { budget: "arch-child", estimate_micros: 1 });
  assert.equal(d.body.code, "budget_archived");
  assert.equal(d.body.budget, "arch-parent");
  const list = await read.get("/budgets");
  assert.ok(!list.body.budgets.some((b) => b.budget === "arch-parent"));
  assert.ok((await read.get("/budgets?include_archived=true")).body.budgets.some((b) => b.budget === "arch-parent"));
  await manage.put("/budgets/arch-parent", {});
  assert.equal((await spend.post("/authorize", { budget: "arch-child", estimate_micros: 1 })).status, 201);
});

test("changing the period never hides spend: refused with open holds, settled spend carried over", async () => {
  await manage.put("/budgets/per", { cap_micros: usd(100), period: "month" });
  const a = await spend.post("/authorize", { budget: "per", estimate_micros: usd(90) });
  const blocked = await manage.put("/budgets/per", { period: "week" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "period_change_with_open_holds");
  await spend.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(90) });
  assert.equal((await manage.put("/budgets/per", { period: "week" })).status, 200);
  const u = (await read.get("/budgets/per")).body.budget.usage;
  assert.equal(u.spent_micros, usd(90), "the month's spend follows the budget into its new window");
  assert.equal((await spend.post("/authorize", { budget: "per", estimate_micros: usd(20) })).body.code, "budget_cap");
  // Toggling back and forth never inflates the figure.
  await manage.put("/budgets/per", { period: "month" });
  await manage.put("/budgets/per", { period: "week" });
  assert.equal((await read.get("/budgets/per")).body.budget.usage.spent_micros, usd(90));
});

test("validation of budget fields", async () => {
  for (const body of [{ cap_micros: -1 }, { period: "fortnight" }, { approvals_required: 11 }, { burst_per_minute: 0 }, { unknown: 1 }, { cap_micros: 1.5 }]) {
    assert.equal((await manage.put("/budgets/val", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await manage.put("/budgets/has%20space", {})).status, 400);
});
