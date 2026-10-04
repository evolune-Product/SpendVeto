// Sanctions screening test suite — real OFAC SDN entries, not synthetic placeholders. Every
// "sanctioned" test case below cites a real, currently-listed SDN uid so the claim is checkable
// against https://sanctionssearch.ofac.treas.gov/Details.aspx?id=<uid> by anyone, not just trusted.
// Two layers: direct screenAddress() unit tests (pure, no server needed), then an end-to-end pass
// through the real checkPolicy() with the real server running, proving the wiring in
// client/policy.js actually blocks a payment, not just that the standalone function returns the
// right verdict in isolation.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { screenAddress, sanctionsListStatus } from "../server/sanctions.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let passes = 0;
let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    passes++;
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail !== undefined ? " — " + detail : ""}`);
  }
}

// Real SDN entries, cited for independent verification:
// https://sanctionssearch.ofac.treas.gov/Details.aspx?id=24003 — Behzad MESRI (CYBER2, HRIT-IR)
const REAL_SANCTIONED_EVM = "0x252a8bd2319d8a555b872990601221b3a2053bce";
const REAL_SANCTIONED_EVM_ALT = "0x1CAb8177ACE78b1B6b1c393371F4F2dCAE40CbEB"; // same uid, different listed address, mixed-case on purpose (lowercasing is part of what's under test)
// https://sanctionssearch.ofac.treas.gov/Details.aspx?id=56360 — Rolan SOKOLOVSKI (ILLICIT-DRUGS-EO14059)
// Exact casing verified directly against the real downloaded SDN.XML (do not hand-reconstruct
// casing from an already-lowercased debug print — caught doing exactly that during development;
// base58 is case-sensitive, so a guessed casing silently fails to match the real stored entry).
const REAL_SANCTIONED_SOL = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi";
const CLEAN_EVM = "0x" + "0".repeat(37) + "Ab1"; // not a real SDN entry — a deliberately inert test address, computed (not hand-counted) to be exactly 40 hex chars
const CLEAN_SOL = "11111111111111111111111111111111111111111"; // Solana's well-known system program address, not an SDN entry

async function unitTests() {
  console.log("--- Direct screenAddress() tests ---");

  const status = sanctionsListStatus();
  check("the local list cache loaded (run `npm run sanctions:update` first if this fails)", status.active, JSON.stringify(status));
  if (!status.active) {
    console.log("Cannot continue without a loaded list — run: npm run sanctions:update");
    process.exit(1);
  }
  console.log(`List: ${status.uniqueAddressCount} addresses, published ${status.listPublishDate}, fetched ${status.ageDays} day(s) ago\n`);

  const hit1 = screenAddress(REAL_SANCTIONED_EVM, "base");
  check("a real SDN-listed EVM address is flagged on Base", hit1.sanctioned === true && hit1.match?.entries?.[0]?.sdnUid === "24003", JSON.stringify(hit1));

  const hit2 = screenAddress(REAL_SANCTIONED_EVM, "polygon");
  check("the SAME address is also flagged on Polygon — EVM address space is chain-agnostic, screening must be too", hit2.sanctioned === true, JSON.stringify(hit2));

  const hit3 = screenAddress(REAL_SANCTIONED_EVM, "arbitrum");
  check("...and on Arbitrum", hit3.sanctioned === true, JSON.stringify(hit3));

  const hitMixedCase = screenAddress(REAL_SANCTIONED_EVM_ALT, "ethereum");
  check("a mixed-case address still matches (case-insensitive comparison)", hitMixedCase.sanctioned === true, JSON.stringify(hitMixedCase));

  // Original case preserved deliberately — base58 is case-sensitive; screenAddress does its own
  // format-aware canonicalization and must not be fed a pre-lowercased Solana address (see the
  // "the module itself" bug this exact test caught during development).
  const hitSol = screenAddress(REAL_SANCTIONED_SOL, "solana-devnet");
  check("a real SDN-listed Solana address is flagged", hitSol.sanctioned === true && hitSol.match?.entries?.[0]?.sdnUid === "56360", JSON.stringify(hitSol));

  const clean1 = screenAddress(CLEAN_EVM, "base");
  check("a clean EVM address screens clean (screened:true, sanctioned:false)", clean1.sanctioned === false && clean1.screened === true, JSON.stringify(clean1));

  const clean2 = screenAddress(CLEAN_SOL, "solana-devnet");
  check("a clean Solana address screens clean", clean2.sanctioned === false && clean2.screened === true, JSON.stringify(clean2));

  const noPayee = screenAddress(null, "base");
  check("no address supplied is honestly reported as not screened, never silently 'clean'", noPayee.screened === false, JSON.stringify(noPayee));

  const unmapped = screenAddress(CLEAN_EVM, "aptos-testnet");
  check("a chain with no current OFAC digital-currency coverage is honestly 'not screened', not silently waved through as clean", unmapped.screened === false && unmapped.sanctioned === false, JSON.stringify(unmapped));

  const noChain = screenAddress(REAL_SANCTIONED_EVM, undefined);
  check("screening still catches a sanctioned EVM address even with no chain hint (format alone is enough)", noChain.sanctioned === true, JSON.stringify(noChain));
}

async function integrationTest() {
  console.log("\n--- End-to-end: the real checkPolicy() pipeline, real server running ---");
  const server = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, SPENDVETO_MODE: "simulate" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 25 && !out.includes("SpendVeto server"); i++) await sleep(200);
  if (!out.includes("SpendVeto server")) {
    console.error("Server failed to boot:", out);
    process.exit(1);
  }

  try {
    const { checkPolicy } = await import("../client/policy.js");

    const blocked = await checkPolicy("0x1111111111111111111111111111111111aaa1", 0.01, "review", "base-sepolia", null, REAL_SANCTIONED_EVM);
    check("checkPolicy() itself refuses a payment to a real SDN-listed payee (sanctioned_payee)", blocked.allowed === false && blocked.code === "sanctioned_payee", JSON.stringify(blocked));
    check("the denial names the real SDN uid, independently verifiable", /24003/.test(blocked.reason), blocked.reason);

    const allowed = await checkPolicy("0x2222222222222222222222222222222222aaa2", 0.01, "review", "base-sepolia", null, CLEAN_EVM);
    check("checkPolicy() allows the identical call to a clean payee", allowed.allowed === true, JSON.stringify(allowed));

    const noPayeeCall = await checkPolicy("0x3333333333333333333333333333333333aaa3", 0.01, "review", "base-sepolia");
    check("checkPolicy() with no external payee at all is unaffected by sanctions screening (first-party tool call)", noPayeeCall.allowed === true, JSON.stringify(noPayeeCall));
  } finally {
    server.kill();
  }
}

async function main() {
  await unitTests();
  await integrationTest();
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
