// The property the whole module exists for: under concurrency, across
// separate server PROCESSES sharing one database, a cap is never exceeded and
// an idempotency key never reserves twice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, client, tenantWithKeys, spawnServer, usd } from "./helpers.mjs";

let pool, s1, s2, keys;

before(async () => {
  pool = await freshDb();
  const t = await tenantWithKeys(pool);
  keys = t.keys;
  [s1, s2] = await Promise.all([spawnServer(18451), spawnServer(18452)]);
});
after(async () => {
  s1?.kill();
  s2?.kill();
  await pool?.end();
});

const window = async (budget) => {
  const { rows } = await pool.query(
    `SELECT w.spent_micros, w.reserved_micros, w.calls FROM sv_budget_windows w JOIN sv_budgets b ON b.id = w.budget_id WHERE b.external_id = $1`,
    [budget]
  );
  return rows[0];
};

test("200 concurrent $1 requests against a $50 cap, split across two processes: exactly 50 pass", async () => {
  await client(s1.url, keys.manage).put("/budgets/race", { cap_micros: usd(50) });
  const c1 = client(s1.url, keys.spend);
  const c2 = client(s2.url, keys.spend);
  const results = await Promise.all(
    Array.from({ length: 200 }, (_, i) => (i % 2 ? c1 : c2).post("/authorize", { budget: "race", estimate_micros: usd(1) }))
  );
  const statuses = results.map((r) => r.status);
  const allowed = statuses.filter((s) => s === 201).length;
  const denied = results.filter((r) => r.status === 403 && r.body.code === "budget_cap").length;
  assert.equal(allowed, 50, `allowed ${allowed}; statuses: ${JSON.stringify(statuses.filter((s) => s !== 201 && s !== 403))}`);
  assert.equal(denied, 150);
  const w = await window("race");
  assert.equal(w.reserved_micros, usd(50));
  assert.equal(w.calls, 50);
});

test("a shared parent cap holds when siblings race from both processes", async () => {
  await client(s1.url, keys.manage).post("/budgets/sync", {
    budgets: [{ budget: "p", cap_micros: usd(30) }, ...Array.from({ length: 6 }, (_, i) => ({ budget: `kid${i}`, parent: "p", cap_micros: usd(100) }))],
  });
  const results = await Promise.all(
    Array.from({ length: 120 }, (_, i) => client(i % 2 ? s1.url : s2.url, keys.spend).post("/authorize", { budget: `kid${i % 6}`, estimate_micros: usd(1) }))
  );
  assert.equal(results.filter((r) => r.status === 201).length, 30);
  assert.equal((await window("p")).reserved_micros, usd(30));
});

test("authorize, settle and void interleaved under load keep the books exact", async () => {
  await client(s1.url, keys.manage).put("/budgets/books", { cap_micros: usd(1000) });
  const spendClients = [client(s1.url, keys.spend), client(s2.url, keys.spend)];
  const ops = Array.from({ length: 150 }, async (_, i) => {
    const c = spendClients[i % 2];
    const a = await c.post("/authorize", { budget: "books", estimate_micros: usd(2) });
    assert.equal(a.status, 201);
    const other = spendClients[(i + 1) % 2]; // settle through the OTHER process
    if (i % 3 === 0) return other.post(`/reservations/${a.body.reservation_id}/void`);
    return other.post(`/reservations/${a.body.reservation_id}/settle`, { actual_micros: usd(1.5) });
  });
  const done = await Promise.all(ops);
  assert.ok(done.every((r) => r.status === 200));
  const settledCount = 150 - 50;
  const w = await window("books");
  assert.equal(w.reserved_micros, 0, "every hold was released exactly once");
  assert.equal(w.spent_micros, usd(1.5) * settledCount);
  const { rows } = await pool.query(
    `SELECT sum(actual_micros)::bigint AS s FROM sv_reservations r JOIN sv_budgets b ON b.id = r.budget_id WHERE b.external_id = 'books' AND status = 'settled'`
  );
  assert.equal(rows[0].s, w.spent_micros, "window counters agree with the reservation rows");
});

test("one idempotency key fired 40 times concurrently at both processes reserves exactly once", async () => {
  await client(s1.url, keys.manage).put("/budgets/idem-race", { cap_micros: usd(100) });
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => client(i % 2 ? s1.url : s2.url, keys.spend).post("/authorize", { budget: "idem-race", estimate_micros: usd(1), idempotency_key: "the-one" }))
  );
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  assert.equal(new Set(results.map((r) => r.body.reservation_id)).size, 1);
  assert.equal((await window("idem-race")).reserved_micros, usd(1));
});

test("bulk syncs racing authorizes and webhook changes on the same tree: no deadlock surfaces as an error", async () => {
  const tree = [{ budget: "sx-org", cap_micros: usd(10000) }, ...Array.from({ length: 8 }, (_, i) => ({ budget: `sx-${i}`, parent: "sx-org" }))];
  await client(s1.url, keys.manage).post("/budgets/sync", { budgets: tree });
  const ops = [];
  for (let i = 0; i < 120; i++) {
    const c = i % 2 ? s1.url : s2.url;
    if (i % 10 === 0) {
      // Reversed order in the payload: the server must still lock in id order.
      ops.push(client(c, keys.manage).post("/budgets/sync", { budgets: [...tree].reverse().map((b) => ({ ...b, label: `v${i}` })) }));
    } else if (i % 15 === 1) {
      ops.push(client(c, keys.admin).put("/tenant/webhook", { url: null }));
    } else {
      ops.push(client(c, keys.spend).post("/authorize", { budget: `sx-${i % 8}`, estimate_micros: 1000 }).then(async (r) => {
        if (r.status === 201) await client(c, keys.spend).post(`/reservations/${r.body.reservation_id}/void`);
        return r;
      }));
    }
  }
  const results = await Promise.all(ops);
  const bad = results.filter((r) => r.status >= 500);
  assert.equal(bad.length, 0, JSON.stringify(bad.map((r) => r.body)));
});

test("the audit chain stays intact after all of that concurrency", async () => {
  const v = await client(s2.url, keys.read).get("/events/verify");
  assert.equal(v.body.valid, true);
  assert.ok(v.body.length > 500);
  const { rows } = await pool.query("SELECT count(*)::int AS n, max(seq)::int AS m FROM sv_events");
  assert.equal(rows[0].n, rows[0].m, "no gaps or duplicate sequence numbers");
});
