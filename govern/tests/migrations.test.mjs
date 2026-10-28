// Migrations reverse cleanly and are safe to run twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../db.js";
import { migrateUp, migrateDown } from "../migrate.js";
import { assertTestDb, DB_URL } from "./helpers.mjs";

const tables = async (pool) =>
  (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'sv\\_%' ORDER BY 1")).rows.map((r) => r.tablename);

test("up → down → up leaves an identical schema; a second up is a no-op", async () => {
  assertTestDb();
  const pool = createPool(DB_URL);
  try {
    await migrateDown(pool, 100);
    assert.deepEqual(await tables(pool), ["sv_schema_migrations"]);
    assert.deepEqual(await migrateUp(pool), ["001_init", "002_signups", "003_wallet_signup"]);
    const first = await tables(pool);
    assert.ok(first.includes("sv_reservations") && first.includes("sv_events") && first.includes("sv_signups") && first.includes("sv_wallet_challenges"));
    assert.deepEqual(await migrateUp(pool), [], "already applied");
    assert.deepEqual(await migrateDown(pool, 3), ["003_wallet_signup", "002_signups", "001_init"]);
    assert.deepEqual(await tables(pool), ["sv_schema_migrations"], "down removes everything up created");
    await migrateUp(pool);
    assert.deepEqual(await tables(pool), first);
  } finally {
    await pool?.end();
  }
});

test("two runners racing on boot apply each migration exactly once", async () => {
  const pool = createPool(DB_URL);
  try {
    await migrateDown(pool, 100);
    const [a, b] = await Promise.all([migrateUp(pool), migrateUp(pool)]);
    assert.equal(a.length + b.length, 3);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM sv_schema_migrations");
    assert.equal(rows[0].n, 3);
  } finally {
    await pool?.end();
  }
});
