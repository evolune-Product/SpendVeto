// Where the core's state lives. Modules keep reading and writing their JSON
// documents with the file calls they always used — imported from here instead
// of node:fs.
//
//   file (default)      SPENDVETO_CORE_DATABASE_URL unset: these ARE node:fs. Nothing
//                       changes; `npx spendveto` needs no database.
//   postgres            SPENDVETO_CORE_DATABASE_URL set (its own variable, so pointing
//                       the Governance API at a database never moves the core): every document under the data
//                       directory is a row in sv_core_docs, and the ledger is an
//                       append-only table, sv_core_ledger (a trigger refuses any
//                       UPDATE or DELETE). Both are loaded into memory at start,
//                       so reads stay synchronous and fast; every write applies to
//                       memory at once and is persisted in order — and the server
//                       holds each HTTP response until the writes it caused are
//                       committed (awaitPersisted), so nothing is acknowledged
//                       before it is durable.
//
// One server writes (a Postgres advisory lock — a second refuses to start).
// Other processes (the proxy, the CLI) read and write documents too; each
// write is announced with NOTIFY and every process reloads that document.
// On first start against an empty database, existing data files are imported.
import * as fs from "node:fs";
import { relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../shared-config.js";

const ROOT = resolve(DATA_DIR);
const URL_ = process.env.SPENDVETO_CORE_DATABASE_URL;
// Kept as files even with a database: the OFAC cache (large, refetched from
// OFAC) and the ledger file itself (the ledger module owns its table).
const unmanaged = (key) => key.startsWith("sanctions/") || key === "ledger.json";
const keyOf = (path) => {
  const abs = resolve(String(path));
  return abs.startsWith(ROOT + sep) ? relative(ROOT, abs).split(sep).join("/") : null;
};

let pg = null; // { pool, docs: Map<key, { text, version }>, ledger: [], tail: Promise, failed: Error|null }
export const isPostgres = () => pg !== null;

const LOCK_KEY = 784031; // single core writer
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sv_core_docs (
  name        text PRIMARY KEY,
  body        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sv_core_ledger (
  seq          bigint PRIMARY KEY,
  entry        text NOT NULL,
  entry_hash   text,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION sv_core_ledger_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'sv_core_ledger is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sv_core_ledger_no_rewrite ON sv_core_ledger;
CREATE TRIGGER sv_core_ledger_no_rewrite BEFORE UPDATE OR DELETE ON sv_core_ledger
  FOR EACH ROW EXECUTE FUNCTION sv_core_ledger_append_only();`;

async function init() {
  const { default: pgLib } = await import("pg");
  const pool = new pgLib.Pool({ connectionString: URL_, max: Number(process.env.SPENDVETO_DB_POOL_MAX) || 5 });
  await pool.query(SCHEMA);
  const role = process.env.SPENDVETO_STORE_ROLE || (/server[\\/]index\.js$/.test(process.argv[1] || "") ? "server" : "client");
  if (role === "server") {
    const holder = await pool.connect();
    const { rows } = await holder.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    if (!rows[0].ok) {
      holder.release();
      await pool.end();
      throw new Error("another SpendVeto server already holds this database (one writer per database) — stop it first");
    }
    // Held for the life of the process: releasing the connection releases the lock.
  }
  const state = { pool, docs: new Map(), ledger: [], pendingRows: [], batchQueued: false, tail: Promise.resolve(), failed: null };
  const docRows = (await pool.query("SELECT name, body FROM sv_core_docs")).rows;
  const ledgerRows = (await pool.query("SELECT entry FROM sv_core_ledger ORDER BY seq")).rows;
  if (role === "server" && !docRows.length && !ledgerRows.length) await importFiles(pool);
  for (const r of role === "server" && !docRows.length ? (await pool.query("SELECT name, body FROM sv_core_docs")).rows : docRows) state.docs.set(r.name, { text: r.body, version: 1 });
  for (const r of role === "server" && !ledgerRows.length ? (await pool.query("SELECT entry FROM sv_core_ledger ORDER BY seq")).rows : ledgerRows) state.ledger.push(JSON.parse(r.entry));
  // Other processes' document writes, as they happen.
  const listener = await pool.connect();
  // A process's own writes are already in its memory — reloading them could
  // briefly put an older copy over a newer one — so notices carry the writer.
  listener.on("notification", (n) => {
    let note;
    try { note = JSON.parse(n.payload); } catch { return; }
    if (note.pid === process.pid) return;
    pool.query("SELECT body FROM sv_core_docs WHERE name = $1", [note.name]).then(({ rows }) => {
      const prev = state.docs.get(note.name);
      if (rows[0]) state.docs.set(note.name, { text: rows[0].body, version: (prev?.version || 0) + 1 });
      else state.docs.delete(note.name);
    }).catch(() => {});
  });
  await listener.query("LISTEN sv_core_docs");
  state.listener = listener;
  return state;
}

// First start against an empty database: bring the existing data files over.
async function importFiles(pool) {
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(resolve(dir, d.name)) : [resolve(dir, d.name)])) : []);
  let docs = 0, rows = 0;
  for (const file of walk(ROOT)) {
    const key = keyOf(file);
    if (!key || !key.endsWith(".json") || unmanaged(key)) continue;
    await pool.query("INSERT INTO sv_core_docs (name, body) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [key, fs.readFileSync(file, "utf8")]);
    docs++;
  }
  const ledgerFile = resolve(ROOT, "ledger.json");
  if (fs.existsSync(ledgerFile)) {
    const entries = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    for (let i = 0; i < entries.length; i++) await pool.query("INSERT INTO sv_core_ledger (seq, entry, entry_hash) VALUES ($1, $2, $3)", [i, JSON.stringify(entries[i]), entries[i].entryHash || null]);
    rows = entries.length;
  }
  if (docs || rows) console.error(`[store] imported ${docs} documents and ${rows} ledger entries from ${ROOT} into Postgres`);
}

// Every write runs after the previous one, so the database sees them in the
// order they happened. A write that fails after retries marks the store
// failed: from then on responses answer 503 rather than claim success.
function enqueue(fn) {
  pg.tail = pg.tail.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (err) {
        if (attempt >= 3) { pg.failed = err; console.error("[store] write failed:", err.message); return; }
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
  });
  return pg.tail;
}
// Resolves once every write made so far is committed; rejects if one failed.
export async function awaitPersisted() {
  if (!pg) return;
  await pg.tail;
  if (pg.failed) throw pg.failed;
}

function upsertDoc(key, text) {
  const prev = pg.docs.get(key);
  pg.docs.set(key, { text, version: (prev?.version || 0) + 1 });
  enqueue(async () => {
    const current = pg.docs.get(key);
    if (!current || current.text !== text) return; // superseded or deleted since — the later write persists it
    await pg.pool.query("INSERT INTO sv_core_docs (name, body, updated_at) VALUES ($1, $2, now()) ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, updated_at = now()", [key, text]);
    await pg.pool.query("SELECT pg_notify('sv_core_docs', $1)", [JSON.stringify({ name: key, pid: process.pid })]);
  });
}
function deleteDoc(key) {
  pg.docs.delete(key);
  enqueue(async () => {
    if (pg.docs.has(key)) return;
    await pg.pool.query("DELETE FROM sv_core_docs WHERE name = $1", [key]);
    await pg.pool.query("SELECT pg_notify('sv_core_docs', $1)", [JSON.stringify({ name: key, pid: process.pid })]);
  });
}

// The ledger module's table (server/ledger.js) — memory first, then in order.
export function ledgerRows() {
  return pg.ledger;
}
// Group commit: appends that arrive while a write is in flight go to the
// database together, as one INSERT — throughput grows with concurrency
// instead of being one round trip per entry. A batch that fails is retried
// as the same batch (enqueue's retry), never dropped.
export function appendLedgerRow(record) {
  pg.pendingRows.push({ seq: pg.ledger.length, record });
  pg.ledger.push(record);
  if (pg.batchQueued) return;
  pg.batchQueued = true;
  let batch = null;
  enqueue(async () => {
    if (!batch) {
      pg.batchQueued = false;
      batch = pg.pendingRows.splice(0);
    }
    if (!batch.length) return;
    await pg.pool.query(
      "INSERT INTO sv_core_ledger (seq, entry, entry_hash) SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[])",
      [batch.map((r) => r.seq), batch.map((r) => JSON.stringify(r.record)), batch.map((r) => r.record.entryHash || null)],
    );
  });
}

const enoent = (path) => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
const managedKey = (path) => {
  if (!pg) return null;
  const key = keyOf(path);
  return key && !unmanaged(key) ? key : null;
};

// ---- the node:fs subset the modules use ----
export function readFileSync(path, options) {
  const key = managedKey(path);
  if (!key) return fs.readFileSync(path, options);
  const doc = pg.docs.get(key);
  if (!doc) throw enoent(path);
  return options ? doc.text : Buffer.from(doc.text);
}
export function writeFileSync(path, data, options) {
  const key = managedKey(path);
  if (!key) return fs.writeFileSync(path, data, options);
  upsertDoc(key, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
}
export function existsSync(path) {
  const key = managedKey(path);
  if (!key) return fs.existsSync(path);
  return pg.docs.has(key) || [...pg.docs.keys()].some((k) => k.startsWith(key + "/"));
}
export function statSync(path, options) {
  const key = managedKey(path);
  if (!key) return fs.statSync(path, options);
  const doc = pg.docs.get(key);
  if (!doc) throw enoent(path);
  return { mtimeMs: doc.version, size: doc.text.length, isFile: () => true, isDirectory: () => false };
}
export function unlinkSync(path) {
  const key = managedKey(path);
  if (!key) return fs.unlinkSync(path);
  if (!pg.docs.has(key)) throw enoent(path);
  deleteDoc(key);
}
export function copyFileSync(src, dest, mode) {
  const from = managedKey(src), to = managedKey(dest);
  if (!from && !to) return fs.copyFileSync(src, dest, mode);
  writeFileSync(dest, readFileSync(src, "utf8"));
}
export function mkdirSync(path, options) {
  if (managedKey(path)) return; // directories are implicit in document names
  return fs.mkdirSync(path, options);
}
export const readdirSync = (...args) => fs.readdirSync(...args);

if (URL_) {
  pg = await init().catch((err) => {
    console.error(`[store] Postgres storage unavailable: ${err.message}`);
    process.exit(1);
  });
}

// For short-lived processes (the CLI scripts): wait for every write to be
// committed, then let go of the database so the process can exit.
export async function closeStore() {
  if (!pg) return;
  await awaitPersisted();
  pg.listener.release(true); // a checked-out client would hold pool.end() open forever
  await pg.pool.end().catch(() => {});
}
