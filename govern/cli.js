// Host-side administration for the Governance API. Talks to Postgres directly,
// so it works before any key exists — this is how the first tenant and its
// admin key are created (there is deliberately no unauthenticated HTTP way).
//
//   npm run govern:admin -- migrate up|down
//   npm run govern:admin -- create-tenant --name "Acme"
//   npm run govern:admin -- mint-key --tenant <uuid> --scopes spend,read --label evolune-backend
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createPool } from "./db.js";
import { migrateUp, migrateDown } from "./migrate.js";
import { createTenant, mintKeyForTenant } from "./admin.js";

dotenv.config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)), quiet: true });

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const [cmd, sub] = process.argv.slice(2);
const pool = createPool(process.env.SPENDVETO_DATABASE_URL, { max: 2 });
try {
  if (cmd === "migrate" && sub === "up") {
    console.log("applied:", (await migrateUp(pool)).join(", ") || "(nothing to apply)");
  } else if (cmd === "migrate" && sub === "down") {
    console.log("reverted:", (await migrateDown(pool, Number(flag("steps")) || 1)).join(", ") || "(nothing to revert)");
  } else if (cmd === "create-tenant") {
    await migrateUp(pool);
    const name = flag("name");
    if (!name) throw new Error("--name is required");
    const out = await createTenant(pool, { name });
    console.log(JSON.stringify(out, null, 2));
    console.error("\nThe admin key above is shown once. Store it now.");
  } else if (cmd === "mint-key") {
    const tenant = flag("tenant");
    const scopes = (flag("scopes") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!tenant || !scopes.length) throw new Error("--tenant and --scopes are required");
    const key = await mintKeyForTenant(pool, tenant, { scopes, label: flag("label") || "" });
    console.log(JSON.stringify(key, null, 2));
    console.error("\nThe key above is shown once. Store it now.");
  } else {
    console.log("usage: migrate up|down [--steps n] | create-tenant --name X | mint-key --tenant ID --scopes a,b [--label L]");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("error:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
