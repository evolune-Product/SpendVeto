#!/usr/bin/env node
// Postgres storage for the core server (server/store.js), end to end against a
// real database:
//
//   SPENDVETO_TEST_DATABASE_URL=postgres://.../spendveto_test npm run test:pg-storage
//   (falls back to GOVERN_TEST_DATABASE_URL; reads .env.local)
//
// Not in the published verify count — it needs a database a fresh clone may
// not have, the same reason the Governance API suite isn't. It drops and
// recreates the sv_core_ tables, so it refuses a database whose name lacks "test".
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { signLedgerEvent } from "../client/ledger-event.js";

config({ path: ".env.local", quiet: true });
const DB = process.env.SPENDVETO_TEST_DATABASE_URL || process.env.GOVERN_TEST_DATABASE_URL;
if (!DB) { console.error("set SPENDVETO_TEST_DATABASE_URL (or GOVERN_TEST_DATABASE_URL) to a disposable database"); process.exit(1); }
if (!/test/i.test(new URL(DB).pathname)) { console.error("refusing: the database name must contain 'test'"); process.exit(1); }

// spawnSync below freezes this process for seconds; a keep-alive socket the
// server closed meanwhile then fails on reuse. Retry those (a dead server
// still fails every attempt).
const rawFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  for (let attempt = 0; ; attempt++) {
    try { return await rawFetch(...args); } catch (err) {
      if (attempt < 2 && /ECONN(RESET|ABORTED)/.test(err.cause?.code || "")) continue;
      throw err;
    }
  }
};

const PORT = 8419, BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };
const db = new pg.Pool({ connectionString: DB });
const q = async (sql, args) => (await db.query(sql, args)).rows;

const dir = mkdtempSync(join(tmpdir(), "sv-pgstore-"));
writeFileSync(join(dir, "policy.json"), JSON.stringify({ maxPerCallUSD: 1, maxPerHourUSD: 1e6, maxCallsPerHour: 1e9, requireApprovalAboveUSD: 1e6, anomaly: { burstAttempts: 1e9, burstWindowSeconds: 1 } }, null, 2));
const env = (pgMode) => ({ ...process.env, PORT: String(PORT), SPENDVETO_DATA_DIR: dir, SPENDVETO_CORE_DATABASE_URL: pgMode ? DB : "" });

async function boot(pgMode) {
  const child = spawn(process.execPath, ["server/index.js"], { env: env(pgMode), stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  let exited = null; child.on("exit", (c) => (exited = c));
  for (let i = 0; i < 80 && exited === null; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {} await sleep(250); }
  return { child, out: () => out, exited: () => exited, stop: async () => { child.kill(); for (let i = 0; i < 40 && exited === null; i++) await sleep(100); } };
}
const json = (path, body, method = "POST") => fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const signer = privateKeyToAccount(generatePrivateKey());
const event = async (status = "paid", price = "0.002") => json("/api/ledger/event", await signLedgerEvent(signer, { resource: "/api/agent/review", price, status, reason: "pg-storage test" }));

let s;
try {
  await db.query("DROP TABLE IF EXISTS sv_core_docs, sv_core_ledger CASCADE");

  // ---- 1. file mode: an existing install with some history ----
  s = await boot(false);
  check("file mode boots with file storage", (await (await fetch(BASE + "/api/health")).json()).storage === "file");
  for (let i = 0; i < 5; i++) await event();
  await json("/api/freezes", { address: "0x00000000000000000000000000000000000000f1", reason: "pre-migration" });
  const fileLedger = (await (await fetch(BASE + "/api/ledger")).json()).entries;
  await s.stop();

  // ---- 2. first Postgres start: the files are imported ----
  s = await boot(true);
  const health = await (await fetch(BASE + "/api/health")).json();
  check("with SPENDVETO_CORE_DATABASE_URL the server runs on Postgres", health.storage === "postgres", JSON.stringify(health));
  const imported = (await (await fetch(BASE + "/api/ledger")).json()).entries;
  const chain = await (await fetch(BASE + "/api/ledger/verify-chain")).json();
  check("first start imports the existing ledger and documents — the hash chain still verifies", imported.length === fileLedger.length && imported.at(-1).entryHash === fileLedger.at(-1).entryHash && chain.valid === true && (await q("SELECT count(*)::int n FROM sv_core_docs WHERE name = 'freezes.json'"))[0].n === 1, `ledger=${imported.length} chain=${chain.valid}`);
  check("imported state is live: the pre-migration freeze still holds", (await (await fetch(BASE + "/api/freezes")).json()).freezes.some((f) => f.reason === "pre-migration" && !f.unfrozen));

  // ---- 3. durable before acknowledged ----
  const before = (await q("SELECT count(*)::int n FROM sv_core_ledger"))[0].n;
  const ack = await event();
  const afterAck = (await q("SELECT count(*)::int n FROM sv_core_ledger"))[0].n;
  check("a write's response arrives only after its row is in the database", ack.status === 204 && afterAck === before + 1, `ack=${ack.status} rows ${before}→${afterAck}`);
  const d = await json("/api/delegations", { parentAddress: signer.address, childAddress: "0x00000000000000000000000000000000000000c1", capUSD: 0.5, label: "pg child" });
  const delegRow = await q("SELECT body FROM sv_core_docs WHERE name = 'delegations.json'");
  check("documents are written through the same way (a delegation is in sv_core_docs when the API answers)", d.status === 201 && delegRow[0]?.body.includes("pg child"));

  // ---- 4. another process's write reaches the running server ----
  const invite = spawnSync(process.execPath, ["scripts/user.mjs", "invite", "pg-admin@example.com", "admin"], { env: env(true), encoding: "utf8" });
  let authOn = false;
  for (let i = 0; i < 30 && !authOn; i++) { authOn = (await (await fetch(BASE + "/api/auth/state")).json()).authRequired; if (!authOn) await sleep(100); }
  check("a CLI write (inviting the first admin) reaches the running server through Postgres", invite.status === 0 && authOn, invite.stderr.trim().slice(0, 120));
  spawnSync(process.execPath, ["-e", "import('./server/store.js').then(async (m) => { m.unlinkSync(process.env.SPENDVETO_DATA_DIR + '/users.json'); await m.closeStore(); })"], { env: { ...env(true), SPENDVETO_STORE_ROLE: "client" } });
  for (let i = 0; i < 30 && authOn; i++) { authOn = (await (await fetch(BASE + "/api/auth/state")).json()).authRequired; if (authOn) await sleep(100); }
  check("…and its removal does too (back to open mode)", authOn === false);

  // ---- 5. one writer per database ----
  const second = spawn(process.execPath, ["server/index.js"], { env: { ...env(true), PORT: String(PORT + 1) }, stdio: ["ignore", "pipe", "pipe"] });
  let secondOut = ""; second.stderr.on("data", (x) => (secondOut += x)); second.stdout.on("data", (x) => (secondOut += x));
  const secondExit = await new Promise((r) => { second.on("exit", r); setTimeout(() => { second.kill(); r("still running"); }, 15000); });
  check("a second server against the same database refuses to start", secondExit === 1 && /already holds this database/.test(secondOut), String(secondExit));

  // ---- 6. the database refuses history rewrites ----
  const rewrite = await db.query("UPDATE sv_core_ledger SET entry = entry WHERE seq = 0").then(() => "allowed", (e) => e.message);
  const erase = await db.query("DELETE FROM sv_core_ledger WHERE seq = 0").then(() => "allowed", (e) => e.message);
  check("sv_core_ledger is append-only in the database itself (UPDATE and DELETE are refused)", /append-only/.test(rewrite) && /append-only/.test(erase));

  // ---- 7. a restart loses nothing ----
  const beforeRestart = (await (await fetch(BASE + "/api/ledger")).json()).entries;
  await s.stop();
  rmSync(join(dir, "ledger.json"), { force: true }); // the files are no longer the source of truth
  s = await boot(true);
  const afterRestart = (await (await fetch(BASE + "/api/ledger")).json()).entries;
  const chain2 = await (await fetch(BASE + "/api/ledger/verify-chain")).json();
  check("after a restart the ledger, chain and documents come back from Postgres", afterRestart.length === beforeRestart.length && chain2.valid && (await (await fetch(BASE + "/api/delegations")).json()).delegations.some((x) => x.label === "pg child"), `ledger=${afterRestart.length}/${beforeRestart.length}`);

  // ---- 8. scale: appends no longer rewrite history ----
  const signers = Array.from({ length: 40 }, () => privateKeyToAccount(generatePrivateKey()));
  let n = afterRestart.length;
  const rates = [];
  let t0 = Date.now(), mark = n;
  while (n < 10000) {
    if (n - mark >= 2000) { rates.push(Math.round((n - mark) / ((Date.now() - t0) / 1000))); t0 = Date.now(); mark = n; }
    const batch = await Promise.all(Array.from({ length: 25 }, (_, i) => signLedgerEvent(signers[(n + i) % 40], { resource: "/api/agent/review", price: "0.001", status: "paid", reason: "scale" })));
    const st = await Promise.all(batch.map((ev) => json("/api/ledger/event", ev).then((r) => r.status)));
    if (st.some((x) => x !== 204)) throw new Error("append refused " + st.join(","));
    n += 25;
  }
  const lat = [];
  for (let i = 0; i < 50; i++) { const t = performance.now(); await (await fetch(BASE + "/api/stats")).arrayBuffer(); lat.push(performance.now() - t); }
  lat.sort((a, b) => a - b);
  // The property file storage lacked: appends don't slow down as history grows
  // (each is one INSERT, not a rewrite). The absolute rate is bounded by the
  // per-event signature check, not by storage.
  check(`appends hold their rate as the ledger grows to 10,000 (${rates.join(" → ")} /s per 2,000), /api/stats p50 ${lat[25].toFixed(1)} ms`, rates.at(-1) >= rates[0] * 0.6 && lat[25] < 100);
  const rows = (await q("SELECT count(*)::int n FROM sv_core_ledger"))[0].n;
  check("every append is a row — nothing buffered unwritten", rows === n, `${rows} rows / ${n} entries`);
  await s.stop();
} catch (err) {
  console.error(err);
  if (s) console.error("server exit code:", s.exited(), "\nserver output (tail):\n" + s.out().split("\n").slice(-30).join("\n"));
  failures++;
} finally {
  // Leave the shared test database as found (the Governance API suite lists sv_ tables).
  await db.query("DROP TABLE IF EXISTS sv_core_docs, sv_core_ledger CASCADE; DROP FUNCTION IF EXISTS sv_core_ledger_append_only()").catch(() => {});
  await db.end();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall Postgres storage checks passed");
process.exit(failures ? 1 : 0);
