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
    assert.deepEqual(await migrateUp(pool), ["001_init"]);
    const first = await tables(pool);
    assert.ok(first.includes("sv_reservations") && first.includes("sv_events"));
    assert.deepEqual(await migrateUp(pool), [], "already applied");
    assert.deepEqual(await migrateDown(pool, 1), ["001_init"]);
    assert.deepEqual(await tables(pool), ["sv_schema_migrations"], "down removes everything up created");
    await migrateUp(pool);
    assert.deepEqual(await tables(pool), first);
  } finally {
    await pool?.end();
  }
});

test("two runners racing on boot apply the migration exactly once", async () => {
  const pool = createPool(DB_URL);
  try {
    await migrateDown(pool, 100);
    const [a, b] = await Promise.all([migrateUp(pool), migrateUp(pool)]);
    assert.equal(a.length + b.length, 1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM sv_schema_migrations");
    assert.equal(rows[0].n, 1);
  } finally {
    await pool?.end();
  }
});
