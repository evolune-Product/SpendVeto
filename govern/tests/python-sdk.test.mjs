// Runs the Python SDK's tests (sdk-python/tests/test_govern.py) against a live
// server on the test database, so the client Evolune's backend will use is
// exercised for real. Skips when no Python 3 interpreter is on PATH.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freshDb, startApp, tenantWithKeys } from "./helpers.mjs";

const python = ["python3", "python", "py"].find((cmd) => {
  const r = spawnSync(cmd, ["-c", "import sys; assert sys.version_info >= (3, 8)"], { stdio: "ignore" });
  return r.status === 0;
});

let pool, app, t;
before(async () => {
  pool = await freshDb();
  app = await startApp(pool);
  t = await tenantWithKeys(pool, "Python SDK");
});
after(async () => {
  await app?.close();
  await pool?.end();
});

test("Python SDK end-to-end", { skip: python ? false : "no Python 3.8+ interpreter on PATH" }, async () => {
  const testFile = fileURLToPath(new URL("../../sdk-python/tests/test_govern.py", import.meta.url));
  const env = {
    ...process.env,
    SPENDVETO_GOVERN_URL: app.url,
    SV_KEY_SPEND: t.keys.spend,
    SV_KEY_MANAGE: t.keys.manage,
    SV_KEY_READ: t.keys.read,
    SV_KEY_APPROVE: t.keys.approve,
    SV_KEY_APPROVE_AS: t.keys.approve_as,
  };
  const { code, output } = await new Promise((resolve) => {
    // -I isolated mode: no user site-packages, no cwd on sys.path.
    const p = spawn(python, ["-I", testFile, "-v"], { env });
    let output = "";
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("close", (code) => resolve({ code, output }));
  });
  assert.equal(code, 0, output);
  assert.match(output, /Ran 12 tests/);
  assert.match(output, /\nOK/);
});
