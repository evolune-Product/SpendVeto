// Proof, not assertion: this script makes real governance decisions with NO SpendVeto server
// process running at all — nothing on :8402, nothing on :8404, no network interface touched.
// Run it standalone: `node demo-offline.mjs` (no `npm run server` first, on purpose).
//
// The scenario: an agent that synced its governance state once (the policy, its wallet's last-
// known spend, its delegation chain) before going offline — a flight, an edge location with no
// path back to the control plane, a browser extension that can't assume connectivity — and now
// has to decide, locally, whether four different spend attempts are allowed.

import { loadPolicyWasmFile } from "./loader.js";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(new URL("./build/release.wasm", import.meta.url));

console.log("Loading the compiled policy module (no server, no network)...\n");
const policy = await loadPolicyWasmFile(wasmPath);
console.log(`Loaded. ABI version ${policy.abiVersion}. This process has made zero HTTP requests.\n`);

// This is what "synced earlier, while online" looks like — a snapshot an agent would have pulled
// from the real server (GET /api/policy, GET /api/freezes, GET /api/ledger, GET /api/delegations)
// before losing connectivity. Everything after this point is pure, local, offline computation.
const syncedPolicy = {
  maxPerCallUSD: 0.05,
  maxPerHourUSD: 0.15,
  maxCallsPerHour: 8,
  requireApprovalAboveUSD: 0.02,
  allowedChains: ["base-sepolia", "base"],
};
const syncedFreezeStatus = null; // this wallet was not frozen as of the last sync
const syncedRecentSpend = { totalUSD: 0.12, count: 3 }; // this wallet's settled spend, last synced hour

function attempt(label, overrides) {
  const input = {
    address: "0xoffline-agent",
    toolId: "review",
    chain: "base-sepolia",
    category: null,
    payee: null,
    policy: syncedPolicy,
    frozen: syncedFreezeStatus,
    nowUTCHour: new Date().getUTCHours(),
    recent: syncedRecentSpend,
    heldUSD: 0,
    categorySpent: 0,
    delegationChain: [],
    ...overrides,
  };
  const decision = policy.evaluate(input);
  const verdict = decision.allowed ? (decision.requiresApproval ? "ALLOW (needs approval)" : "ALLOW") : `DENY (${decision.code})`;
  console.log(`[${label}] $${input.proposedPriceUSD} on ${input.chain} -> ${verdict}`);
  if (!decision.allowed) console.log(`           ${decision.reason}`);
  return decision;
}

console.log("Four spend attempts, decided entirely offline:\n");
attempt("cheap call, well within budget", { proposedPriceUSD: 0.01 });
attempt("above the per-call cap", { proposedPriceUSD: 0.08 });
attempt("under the per-call cap, but would exceed this hour's $0.15 budget ($0.12 already spent)", { proposedPriceUSD: 0.04 });
attempt("wrong chain for the synced allowlist", { proposedPriceUSD: 0.01, chain: "polygon" });

console.log("\nAll four decisions above were made with zero I/O, using only the state synced before");
console.log("going offline. When connectivity returns, the host reconciles these decisions against");
console.log("the live server the same way any eventually-consistent edge cache would — but the agent");
console.log("was never blocked waiting for a round trip that couldn't happen.");
