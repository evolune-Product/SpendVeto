// Shared test harness for the Governance API. Runs against a REAL Postgres —
// the properties under test (row locks, unique indexes, triggers) don't exist
// in a mock.
//
//   GOVERN_TEST_DATABASE_URL=postgres://.../spendveto_test npm run test:govern
//
// The suite drops and recreates every sv_ table, so it refuses to run against
// a database whose name does not contain "test".
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPool } from "../db.js";
import { migrateUp, migrateDown } from "../migrate.js";
import { createGovernApp } from "../app.js";
import { createTenant, mintKeyForTenant } from "../admin.js";

export const DB_URL = process.env.GOVERN_TEST_DATABASE_URL;

export function assertTestDb() {
  if (!DB_URL) throw new Error("set GOVERN_TEST_DATABASE_URL to a disposable Postgres database (its name must contain 'test')");
  const name = new URL(DB_URL).pathname.slice(1);
  if (!/test/i.test(name)) throw new Error(`refusing to run: database "${name}" does not look disposable (name must contain "test")`);
}

export async function freshDb() {
  assertTestDb();
  const pool = createPool(DB_URL, { max: 20 });
  await migrateDown(pool, 100);
  await migrateUp(pool);
  return pool;
}

// A controllable clock: tests move time instead of sleeping.
export function makeClock(start = new Date("2026-03-15T10:00:00.000Z")) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance(seconds) {
      t += seconds * 1000;
    },
    set(d) {
      t = new Date(d).getTime();
    },
  };
}

export async function startApp(pool, opts = {}) {
  const { app, engine, admin } = createGovernApp({ pool, ...opts });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { url, engine, admin, close: () => new Promise((r) => server.close(r)) };
}

export function client(url, key) {
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, body: json };
  };
  return {
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, b, h) => call("POST", p, b ?? {}, h),
    put: (p, b, h) => call("PUT", p, b ?? {}, h),
    del: (p, h) => call("DELETE", p, undefined, h),
  };
}

// A tenant with one key per scope, a second approve key (two humans), and an
// admin key.
export async function tenantWithKeys(pool, name = "Acme") {
  const t = await createTenant(pool, { name });
  const keys = { admin: t.admin_key };
  for (const scope of ["spend", "approve", "approve_as", "manage", "read"]) {
    keys[scope] = (await mintKeyForTenant(pool, t.tenant.id, { scopes: [scope], label: scope })).key;
  }
  keys.approve2 = (await mintKeyForTenant(pool, t.tenant.id, { scopes: ["approve"], label: "approve2" })).key;
  return { id: t.tenant.id, keys };
}

export const usd = (dollars) => Math.round(dollars * 1_000_000);

// Spawns a real server process (for the cross-process concurrency proof).
export async function spawnServer(port, env = {}) {
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, SPENDVETO_DATABASE_URL: DB_URL, GOVERN_PORT: String(port), GOVERN_AUTO_MIGRATE: "0", GOVERN_SWEEP_MS: "600000", GOVERN_RATE_LIMIT_PER_SEC: "100000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (r.ok) return { proc, url: `http://127.0.0.1:${port}/v1`, kill: () => proc.kill() };
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill();
  throw new Error(`server on :${port} did not start:\n${output}`);
}
