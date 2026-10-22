// Keys, scopes, the operator surface, and tenant isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startApp, client, tenantWithKeys, usd } from "./helpers.mjs";

let pool, app, a, b;

before(async () => {
  process.env.SPENDVETO_OPERATOR_KEY = "op_test_secret_value";
  pool = await freshDb();
  app = await startApp(pool);
  a = await tenantWithKeys(pool, "Tenant A");
  b = await tenantWithKeys(pool, "Tenant B");
  await client(app.url, a.keys.manage).put("/budgets/shared-name", { cap_micros: usd(10), approval_above_micros: usd(1) });
  await client(app.url, b.keys.manage).put("/budgets/shared-name", { cap_micros: usd(10) });
});
after(async () => {
  delete process.env.SPENDVETO_OPERATOR_KEY;
  await app?.close();
  await pool?.end();
});

test("no key, malformed key, unknown key → 401", async () => {
  assert.equal((await client(app.url).post("/authorize", {})).status, 401);
  assert.equal((await client(app.url, "not-a-key").get("/budgets")).status, 401);
  assert.equal((await client(app.url, "svk_" + "0".repeat(48)).get("/budgets")).status, 401);
});

test("health needs no key", async () => {
  const r = await client(app.url).get("/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.db, "up");
});

test("each scope opens exactly its own endpoints", async () => {
  const matrix = [
    // [key, method, path, body, allowed]
    ["spend", "post", "/authorize", { budget: "shared-name", estimate_micros: 1 }, true],
    ["read", "post", "/authorize", { budget: "shared-name", estimate_micros: 1 }, false],
    ["manage", "post", "/authorize", { budget: "shared-name", estimate_micros: 1 }, false],
    ["approve", "post", "/authorize", { budget: "shared-name", estimate_micros: 1 }, false],
    ["spend", "put", "/budgets/x1", {}, false],
    ["read", "put", "/budgets/x1", {}, false],
    ["manage", "put", "/budgets/x1", {}, true],
    ["spend", "get", "/usage", undefined, false],
    ["read", "get", "/usage", undefined, true],
    ["manage", "post", "/keys", { scopes: ["spend"] }, false],
    ["read", "get", "/keys", undefined, false],
    ["admin", "post", "/keys", { scopes: ["read"] }, true],
    ["manage", "put", "/tenant/webhook", { url: null }, false],
    ["spend", "get", "/events", undefined, false],
    ["read", "get", "/events", undefined, true],
    ["admin", "post", "/authorize", { budget: "shared-name", estimate_micros: 1 }, true],
  ];
  for (const [scope, method, path, body, allowed] of matrix) {
    const r = await client(app.url, a.keys[scope])[method](path, body);
    if (allowed) assert.notEqual(r.status, 403, `${scope} ${method} ${path} should be allowed, got ${r.status}`);
    else {
      assert.equal(r.status, 403, `${scope} ${method} ${path} should be 403, got ${r.status}`);
      assert.equal(r.body.code, "insufficient_scope");
    }
  }
});

test("keys are stored hashed; the raw key is shown once and never listed", async () => {
  const admin = client(app.url, a.keys.admin);
  const created = await admin.post("/keys", { scopes: ["spend", "read"], label: "evolune-backend" });
  assert.equal(created.status, 201);
  assert.match(created.body.key, /^svk_[0-9a-f]{48}$/);
  const { rows } = await pool.query("SELECT key_hash FROM sv_api_keys WHERE id = $1", [created.body.id]);
  assert.notEqual(rows[0].key_hash, created.body.key);
  assert.equal(rows[0].key_hash.length, 64);
  const listed = await admin.get("/keys");
  assert.ok(!JSON.stringify(listed.body).includes(created.body.key));
  // A multi-scope key works for both.
  const multi = client(app.url, created.body.key);
  assert.equal((await multi.get("/usage")).status, 200);
  assert.equal((await multi.post("/authorize", { budget: "shared-name", estimate_micros: 1 })).status, 201);
});

test("a revoked key stops working immediately; a key cannot revoke itself", async () => {
  const admin = client(app.url, a.keys.admin);
  const k = await admin.post("/keys", { scopes: ["read"] });
  assert.equal((await client(app.url, k.body.key).get("/usage")).status, 200);
  assert.equal((await admin.del(`/keys/${k.body.id}`)).status, 200);
  assert.equal((await client(app.url, k.body.key).get("/usage")).status, 401);
  const self = await admin.get("/keys");
  const myId = self.body.keys.find((x) => x.label === "initial admin key").id;
  assert.equal((await admin.del(`/keys/${myId}`)).body.code, "cannot_revoke_self");
});

test("tenant isolation: another tenant's resources are invisible (404, not 403)", async () => {
  const aSpend = client(app.url, a.keys.spend);
  const bAll = client(app.url, b.keys.admin);
  const res = await aSpend.post("/authorize", { budget: "shared-name", estimate_micros: usd(2) });
  assert.equal(res.body.decision, "needs_approval");

  assert.equal((await bAll.get(`/reservations/${res.body.reservation_id}`)).status, 404);
  assert.equal((await bAll.post(`/reservations/${res.body.reservation_id}/settle`, { actual_micros: 1 })).status, 404);
  assert.equal((await bAll.post(`/reservations/${res.body.reservation_id}/void`)).status, 404);
  assert.equal((await bAll.get(`/approvals/${res.body.approval_id}`)).status, 404);
  const steal = await bAll.post(`/approvals/${res.body.approval_id}/decide`, { decision: "approve" });
  assert.equal(steal.status, 404, "tenant B cannot approve tenant A's spend");
  assert.equal((await client(app.url, a.keys.read).get(`/approvals/${res.body.approval_id}`)).body.approval.status, "pending");

  // Same external id, separate budgets: B's spend never touches A's numbers.
  const aRead = client(app.url, a.keys.read);
  const aBefore = (await aRead.get("/budgets/shared-name")).body.budget.usage;
  const bAuth = await bAll.post("/authorize", { budget: "shared-name", estimate_micros: usd(3) });
  assert.equal(bAuth.body.decision, "allow", "B's budget has no approval threshold; A's does");
  const aAfter = (await aRead.get("/budgets/shared-name")).body.budget.usage;
  assert.deepEqual(aAfter, aBefore);
  // B's views contain nothing of A's.
  const bEvents = JSON.stringify((await bAll.get("/events?limit=1000")).body);
  assert.ok(!bEvents.includes(res.body.reservation_id));
  const bRes = (await bAll.get("/reservations")).body.reservations;
  assert.ok(bRes.every((r) => r.reservation_id !== res.body.reservation_id));
  // B cannot hang a budget under A's budget (the parent lookup is per tenant).
  const cross = await bAll.put("/budgets/sneaky", { parent: "x1" });
  assert.equal(cross.status, 404);
  assert.equal(cross.body.code, "unknown_parent");
});

test("the database itself refuses a cross-tenant parent link", async () => {
  const { rows: aRows } = await pool.query("SELECT id FROM sv_budgets WHERE tenant_id = $1 LIMIT 1", [a.id]);
  await assert.rejects(
    pool.query("INSERT INTO sv_budgets (tenant_id, external_id, parent_id) VALUES ($1, 'evil', $2)", [b.id, aRows[0].id]),
    /sv_budgets_parent_same_tenant/
  );
});

test("operator endpoint: disabled without the env var, 401 on a wrong key, creates a tenant on the right one", async () => {
  const wrong = await client(app.url, "op_wrong").post("/operator/tenants", { name: "X" });
  assert.equal(wrong.status, 401);
  const ok = await client(app.url, "op_test_secret_value").post("/operator/tenants", { name: "Evolune Org 1" });
  assert.equal(ok.status, 201);
  assert.match(ok.body.admin_key, /^svk_/);
  const minted = await client(app.url, "op_test_secret_value").post(`/operator/tenants/${ok.body.tenant.id}/keys`, { scopes: ["spend"] });
  assert.equal(minted.status, 201);
  assert.equal((await client(app.url, ok.body.admin_key).get("/tenant")).body.tenant.name, "Evolune Org 1");
  const saved = process.env.SPENDVETO_OPERATOR_KEY;
  delete process.env.SPENDVETO_OPERATOR_KEY;
  assert.equal((await client(app.url, saved).post("/operator/tenants", { name: "Y" })).status, 404);
  process.env.SPENDVETO_OPERATOR_KEY = saved;
});

test("per-key rate limit answers 429 rather than hammering the database", async () => {
  const limited = await startApp(pool, { rateLimitPerSecond: 5 });
  const c = client(limited.url, a.keys.read);
  const statuses = await Promise.all(Array.from({ length: 30 }, () => c.get("/tenant").then((r) => r.status)));
  assert.ok(statuses.includes(429));
  assert.ok(statuses.includes(200));
  await limited.close();
});
