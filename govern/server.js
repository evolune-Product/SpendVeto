// SpendVeto Governance API server.
//
//   SPENDVETO_DATABASE_URL=postgres://... npm run govern      # :8405
//
// Runs migrations on boot (GOVERN_AUTO_MIGRATE=0 to skip), then two
// background loops: the expiry sweeper (releases reservations nobody settled
// and approvals nobody answered — both fail closed) and the webhook outbox
// worker. Several processes can run against one database at once; every
// decision is serialized by row locks in Postgres, not by this process.
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createPool } from "./db.js";
import { migrateUp } from "./migrate.js";
import { createGovernApp } from "./app.js";
import { deliverDue } from "./webhooks.js";

dotenv.config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)), quiet: true });

const PORT = Number(process.env.GOVERN_PORT) || 8405;
const SWEEP_MS = Number(process.env.GOVERN_SWEEP_MS) || 15000;
const WEBHOOK_POLL_MS = Number(process.env.GOVERN_WEBHOOK_POLL_MS) || 2000;

const pool = createPool(process.env.SPENDVETO_DATABASE_URL);
pool.on("error", (err) => console.error("[govern] idle database client error:", err.message));

if (process.env.GOVERN_AUTO_MIGRATE !== "0") {
  const applied = await migrateUp(pool);
  if (applied.length) console.log(`[govern] applied migrations: ${applied.join(", ")}`);
}

const { app, engine } = createGovernApp({ pool });

function loop(name, ms, fn) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap with a slow previous run
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[govern] ${name} failed:`, err.message);
    } finally {
      running = false;
    }
  }, ms);
  return timer;
}

const timers = [loop("expiry sweep", SWEEP_MS, () => engine.expireDue()), loop("webhook delivery", WEBHOOK_POLL_MS, () => deliverDue(pool))];

const server = app.listen(PORT, () => {
  console.log(`SpendVeto Governance API on :${PORT} (deployment: ${process.env.SPENDVETO_DEPLOYMENT || "cloud"})`);
});
server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `[govern] port ${PORT} is already in use` : err);
  process.exit(1);
});

async function shutdown() {
  timers.forEach(clearInterval);
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
