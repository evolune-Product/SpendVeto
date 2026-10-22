// When the database cannot answer, every spend path refuses (503), so a
// caller that treats non-2xx as "do not spend" can never overspend because
// governance was down.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../db.js";
import { freshDb, startApp, client, tenantWithKeys, usd } from "./helpers.mjs";
import { resolveKey } from "../auth.js";
import { createEngine } from "../engine.js";

let pool;
before(async () => {
  pool = await freshDb();
});
after(async () => {
  await pool?.end();
});

test("database unreachable → health 503, authorize 503 governance_unavailable", async () => {
  const dead = createPool("postgres://nobody:nothing@127.0.0.1:1/none");
  const app = await startApp(dead);
  const h = await client(app.url).get("/health");
  assert.equal(h.status, 503);
  const r = await client(app.url, "svk_" + "a".repeat(48)).post("/authorize", { budget: "x", estimate_micros: 1 });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "governance_unavailable");
  assert.match(r.body.error, /do not proceed/);
  await app?.close();
  await dead.end().catch(() => {});
});

test("a budget row locked longer than lock_timeout fails closed instead of hanging", async () => {
  const t = await tenantWithKeys(pool);
  const app = await startApp(pool);
  await client(app.url, t.keys.manage).put("/budgets/locked", { cap_micros: usd(10) });
  const holder = await pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT * FROM sv_budgets WHERE external_id = 'locked' FOR UPDATE");
  const started = Date.now();
  const r = await client(app.url, t.keys.spend).post("/authorize", { budget: "locked", estimate_micros: usd(1) });
  await holder.query("ROLLBACK");
  holder.release();
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, "governance_unavailable");
  assert.ok(Date.now() - started < 9000, "bounded by lock_timeout, not by the client's patience");
  // And nothing was reserved by the failed attempt.
  const u = await client(app.url, t.keys.read).get("/budgets/locked");
  assert.equal(u.body.budget.usage.reserved_micros, 0);
  await app?.close();
});

test("engine-level: an unknown tenant's key resolves to nothing", async () => {
  assert.equal(await resolveKey(pool, "svk_" + "f".repeat(48)), null);
  assert.equal(typeof createEngine({ pool }).authorize, "function");
});
