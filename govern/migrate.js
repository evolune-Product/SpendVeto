// Minimal, reversible migration runner. Each migration is a pair of files,
// NNN_name.up.sql and NNN_name.down.sql, applied in a transaction and recorded
// in sv_schema_migrations. Every migration must have a working down file: the
// test suite runs up → down → up on a real database to prove it.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

function listMigrations() {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".up.sql")).sort();
  return names.map((f) => {
    const id = f.replace(/\.up\.sql$/, "");
    return { id, up: readFileSync(DIR + f, "utf8"), down: readFileSync(DIR + `${id}.down.sql`, "utf8") };
  });
}

async function ensureTable(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS sv_schema_migrations (
    id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
}

// Serialize concurrent runners (two server processes booting at once) on one
// advisory lock so a migration is never applied twice.
const LOCK_KEY = 784021;

export async function migrateUp(pool) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await ensureTable(client);
    const done = new Set((await client.query("SELECT id FROM sv_schema_migrations")).rows.map((r) => r.id));
    for (const m of listMigrations()) {
      if (done.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.up);
        await client.query("INSERT INTO sv_schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        applied.push(m.id);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.id} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

// Reverts the most recent `steps` migrations.
export async function migrateDown(pool, steps = 1) {
  const client = await pool.connect();
  const reverted = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await ensureTable(client);
    const done = (await client.query("SELECT id FROM sv_schema_migrations ORDER BY id DESC")).rows.map((r) => r.id);
    const byId = new Map(listMigrations().map((m) => [m.id, m]));
    for (const id of done.slice(0, steps)) {
      const m = byId.get(id);
      if (!m) throw new Error(`migration ${id} is applied but its files are missing`);
      await client.query("BEGIN");
      try {
        await client.query(m.down);
        await client.query("DELETE FROM sv_schema_migrations WHERE id = $1", [id]);
        await client.query("COMMIT");
        reverted.push(id);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`down migration ${id} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return reverted;
}
