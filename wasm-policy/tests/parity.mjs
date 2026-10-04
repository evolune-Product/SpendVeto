// Parity suite: every decision the compiled WASM module makes must exactly match the pure-JS
// reference (reference.mjs) for the same input — code, reason, suggestion, allowed/requiresApproval,
// byte for byte. Directed cases exercise each denial path explicitly (one per code, plus the
// boundary conditions that are easy to get off-by-one on); the fuzz pass then throws thousands of
// randomized inputs at both implementations looking for anything the directed cases didn't think
// of. A seeded PRNG keeps a failing run reproducible — rerun with the same seed to get the same
// failing case back, not a different one.

import { loadPolicyWasmFile } from "../loader.js";
import { evaluateReference } from "./reference.mjs";
import { fileURLToPath } from "node:url";

let failures = 0;
let passes = 0;

function check(label, ok, detail) {
  if (ok) {
    passes++;
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail !== undefined ? " — " + detail : ""}`);
  }
}

// Mulberry32 — small, seeded, deterministic. Reproducibility matters more here than statistical
// quality: a parity failure needs to be re-runnable, not a one-off Heisenbug.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeInput(rng) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const maybe = (p, v) => (rng() < p ? v : null);
  const chains = ["base-sepolia", "base", "polygon", "arbitrum", "solana-devnet"];
  const tools = ["review", "summarize", "translate", "haiku"];
  const categories = ["content", "data", "trading", null];
  const payees = ["0xaaa", "0xbbb", "0xccc", null];

  const hasChainAllowlist = rng() < 0.4;
  const hasPayeeAllowlist = rng() < 0.3;
  const hasHours = rng() < 0.3;
  const hasCategoryCap = rng() < 0.3;

  const delegationDepth = rng() < 0.5 ? 0 : Math.floor(rng() * 4);
  const delegationChain = [];
  for (let i = 0; i < delegationDepth; i++) {
    const capUSD = Math.round(rng() * 1 * 10000) / 10000;
    delegationChain.push({
      label: `hop${i}`,
      revoked: rng() < 0.08,
      expired: rng() < 0.08,
      expiresAt: "2026-01-01T00:00:00Z",
      allowedTools: rng() < 0.2 ? [pick(tools)] : null,
      allowedChains: rng() < 0.2 ? [pick(chains)] : null,
      allowedPayees: rng() < 0.2 ? [pick(payees.filter(Boolean))] : null,
      capUSD,
      subtreeSpend: Math.round(rng() * capUSD * 1.5 * 10000) / 10000,
      periodSeconds: rng() < 0.3 ? Math.floor(rng() * 86400) : 0,
    });
  }

  const category = pick(categories);
  const policy = {
    maxPerCallUSD: Math.round(rng() * 1 * 10000) / 10000,
    maxPerHourUSD: Math.round(rng() * 2 * 10000) / 10000,
    maxCallsPerHour: Math.floor(rng() * 15),
    requireApprovalAboveUSD: Math.round(rng() * 0.1 * 10000) / 10000,
  };
  if (hasChainAllowlist) policy.allowedChains = [pick(chains), pick(chains)];
  if (hasPayeeAllowlist) policy.allowedPayees = [pick(payees.filter(Boolean)), pick(payees.filter(Boolean))];
  if (hasHours) policy.allowedHoursUTC = { start: Math.floor(rng() * 24), end: Math.floor(rng() * 24) };
  if (hasCategoryCap && category) policy.categoryCapsUSD = { [category]: Math.round(rng() * 1 * 10000) / 10000 };

  return {
    address: "0xagent",
    proposedPriceUSD: Math.round(rng() * 1.2 * 10000) / 10000,
    toolId: maybe(0.8, pick(tools)),
    chain: maybe(0.8, pick(chains)),
    category,
    payee: pick(payees),
    policy,
    frozen: maybe(0.1, { isFrozen: rng() < 0.7, source: pick(["manual", "burst"]), reason: "test" }),
    nowUTCHour: Math.floor(rng() * 24),
    recent: { totalUSD: Math.round(rng() * 1 * 10000) / 10000, count: Math.floor(rng() * 15) },
    heldUSD: Math.round(rng() * 0.3 * 10000) / 10000,
    categorySpent: Math.round(rng() * 1 * 10000) / 10000,
    delegationChain,
  };
}

async function main() {
  const wasmPath = fileURLToPath(new URL("../build/release.wasm", import.meta.url));
  const policy = await loadPolicyWasmFile(wasmPath);
  check("the release module reports ABI version 1", policy.abiVersion === 1, `got ${policy.abiVersion}`);

  // --- Directed cases: one per denial code, plus the boundaries most likely to drift ---
  const base = {
    address: "0xagent",
    proposedPriceUSD: 0.01,
    toolId: "review",
    chain: "base-sepolia",
    category: null,
    payee: null,
    policy: { maxPerCallUSD: 0.05, maxPerHourUSD: 0.2, maxCallsPerHour: 10, requireApprovalAboveUSD: 0.015 },
    frozen: null,
    nowUTCHour: 14,
    recent: { totalUSD: 0, count: 0 },
    heldUSD: 0,
    categorySpent: 0,
    delegationChain: [],
  };

  const directed = [
    ["plain allow, no approval", base],
    ["requires approval just above threshold", { ...base, proposedPriceUSD: 0.0151 }],
    ["requires approval exactly at threshold boundary (not >, so still allow)", { ...base, proposedPriceUSD: 0.015 }],
    ["frozen wallet", { ...base, frozen: { isFrozen: true, source: "manual", reason: "review" } }],
    ["frozen object present but isFrozen false — not frozen", { ...base, frozen: { isFrozen: false, source: "manual", reason: "x" } }],
    ["chain not in allowlist", { ...base, policy: { ...base.policy, allowedChains: ["polygon"] } }],
    ["chain in allowlist — allowed", { ...base, policy: { ...base.policy, allowedChains: ["base-sepolia", "polygon"] } }],
    ["payee not in allowlist", { ...base, payee: "0xbad", policy: { ...base.policy, allowedPayees: ["0xgood"] } }],
    ["payee allowlist empty array denies everyone", { ...base, payee: "0xany", policy: { ...base.policy, allowedPayees: [] } }],
    ["payee case-insensitive match", { ...base, payee: "0xGOOD", policy: { ...base.policy, allowedPayees: ["0xgood"] } }],
    ["trading hours — outside normal window", { ...base, policy: { ...base.policy, allowedHoursUTC: { start: 1, end: 5 } }, nowUTCHour: 14 }],
    ["trading hours — inside normal window", { ...base, policy: { ...base.policy, allowedHoursUTC: { start: 9, end: 17 } }, nowUTCHour: 14 }],
    ["trading hours — wrap-around window, inside", { ...base, policy: { ...base.policy, allowedHoursUTC: { start: 22, end: 6 } }, nowUTCHour: 2 }],
    ["trading hours — wrap-around window, outside", { ...base, policy: { ...base.policy, allowedHoursUTC: { start: 22, end: 6 } }, nowUTCHour: 12 }],
    ["per-call cap exceeded", { ...base, proposedPriceUSD: 0.5 }],
    ["per-call cap exact boundary — allowed (not strictly over)", { ...base, proposedPriceUSD: 0.05 }],
    ["delegation revoked at depth 0", { ...base, delegationChain: [{ label: "kid", revoked: true, expired: false, capUSD: 1, subtreeSpend: 0, periodSeconds: 0 }] }],
    [
      "delegation revoked at depth 1 (ancestor)",
      { ...base, delegationChain: [{ label: "kid", revoked: false, expired: false, capUSD: 1, subtreeSpend: 0, periodSeconds: 0 }, { label: "parent", revoked: true, expired: false, capUSD: 1, subtreeSpend: 0, periodSeconds: 0 }] },
    ],
    ["delegation expired", { ...base, delegationChain: [{ label: "kid", revoked: false, expired: true, expiresAt: "2020-01-01T00:00:00Z", capUSD: 1, subtreeSpend: 0, periodSeconds: 0 }] }],
    [
      "tool scope violation",
      { ...base, toolId: "summarize", delegationChain: [{ label: "kid", revoked: false, expired: false, allowedTools: ["review"], capUSD: 1, subtreeSpend: 0, periodSeconds: 0 }] },
    ],
    [
      "chain scope violation",
      { ...base, chain: "polygon", delegationChain: [{ label: "kid", revoked: false, expired: false, allowedChains: ["base-sepolia"], capUSD: 1, subtreeSpend: 0, periodSeconds: 0 }] },
    ],
    [
      "payee scope violation",
      { ...base, payee: "0xbad", delegationChain: [{ label: "kid", revoked: false, expired: false, allowedPayees: ["0xgood"], capUSD: 1, subtreeSpend: 0, periodSeconds: 0 }] },
    ],
    [
      "delegation cap exceeded, with allowance window note",
      { ...base, delegationChain: [{ label: "kid", revoked: false, expired: false, capUSD: 0.005, subtreeSpend: 0, periodSeconds: 60 }] },
    ],
    [
      "three-level cascade — denial surfaces the correct ancestor label",
      {
        ...base,
        delegationChain: [
          { label: "grandchild", revoked: false, expired: false, capUSD: 10, subtreeSpend: 0, periodSeconds: 0 },
          { label: "child", revoked: false, expired: false, capUSD: 10, subtreeSpend: 0, periodSeconds: 0 },
          { label: "team-lead", revoked: false, expired: false, capUSD: 0.005, subtreeSpend: 0.003, periodSeconds: 0 },
        ],
      },
    ],
    ["category cap exceeded", { ...base, category: "content", categorySpent: 0.09, policy: { ...base.policy, categoryCapsUSD: { content: 0.1 } } }],
    ["hourly call-rate cap exceeded", { ...base, recent: { totalUSD: 0, count: 10 } }],
    ["hourly USD cap exceeded", { ...base, recent: { totalUSD: 0.19, count: 0 } }],
    ["hourly USD cap exceeded by held upto authorizations alone", { ...base, recent: { totalUSD: 0, count: 0 }, heldUSD: 0.19 }],
    ["malformed input: policy missing", { ...base, policy: undefined }],

    // Independent-audit regression cases — each pins one of the fixed findings so it can never
    // silently come back. Kept here rather than only in an ad-hoc script, matching this repo's
    // own rule that a fix without an assertion isn't really fixed.
    ["regression: numeric field sent as a JSON string still enforces the real cap (finding #1)", { ...base, proposedPriceUSD: "0.08" }],
    ["regression: cap itself sent as a JSON string is still the real cap, not the hardcoded default (finding #1)", { ...base, proposedPriceUSD: 0.02, policy: { ...base.policy, maxPerCallUSD: "0.01" } }],
    [
      "regression: non-string chain (a bare number) still participates in the allowlist check instead of silently bypassing it (finding #2)",
      { ...base, chain: 123, policy: { ...base.policy, allowedChains: ["base-sepolia"] } },
    ],
    ["regression: empty-string chain is falsy — the allowlist check is skipped, same as checkPolicy's own `if (chain && ...)` (finding #5)", { ...base, chain: "", policy: { ...base.policy, allowedChains: ["base-sepolia"] } }],
    ["regression: empty-string payee is falsy — the allowlist check is skipped (finding #5)", { ...base, payee: "", policy: { ...base.policy, allowedPayees: ["0xgood"] } }],
    [
      "regression: empty-string toolId is falsy — tool scope check is skipped (finding #5)",
      { ...base, toolId: "", delegationChain: [{ label: "kid", revoked: false, expired: false, allowedTools: ["review"], capUSD: 1, subtreeSpend: 0, periodSeconds: 0 }] },
    ],
    ["regression: empty-string category is falsy — category cap check is skipped (finding #5)", { ...base, category: "", categorySpent: 999, policy: { ...base.policy, categoryCapsUSD: { "": 0.001 } } }],
    ["regression: fractional trading-hours bounds disable the window check, matching Number.isInteger (finding #4)", { ...base, policy: { ...base.policy, allowedHoursUTC: { start: 9.5, end: 17.5 } }, nowUTCHour: 20 }],
    ["regression: whole-number-valued float hours bounds (9.0) still count as integers, matching Number.isInteger(9.0)===true (finding #4)", { ...base, policy: { ...base.policy, allowedHoursUTC: { start: 9.0, end: 17.0 } }, nowUTCHour: 20 }],
  ];

  for (const [label, input] of directed) {
    const ref = evaluateReference(input);
    const wasm = policy.evaluate(input);
    check(`parity: ${label}`, JSON.stringify(ref) === JSON.stringify(wasm), `ref=${JSON.stringify(ref)} wasm=${JSON.stringify(wasm)}`);
  }

  // --- Fuzz pass: thousands of randomized inputs, same assertion ---
  const SEED = 424242;
  const ITERATIONS = 50000;
  const rng = mulberry32(SEED);
  let fuzzFailures = 0;
  let codeCoverage = new Set();
  for (let i = 0; i < ITERATIONS; i++) {
    const input = makeInput(rng);
    const ref = evaluateReference(input);
    const wasm = policy.evaluate(input);
    codeCoverage.add(ref.code || (ref.allowed ? (ref.requiresApproval ? "allow_requires_approval" : "allow") : "?"));
    if (JSON.stringify(ref) !== JSON.stringify(wasm)) {
      fuzzFailures++;
      if (fuzzFailures <= 5) {
        console.log(`FAIL  fuzz#${i} (seed=${SEED}) input=${JSON.stringify(input)}`);
        console.log(`      ref =${JSON.stringify(ref)}`);
        console.log(`      wasm=${JSON.stringify(wasm)}`);
      }
    }
  }
  check(`fuzz: ${ITERATIONS} randomized inputs (seed ${SEED}) — JS reference and WASM agree on every one`, fuzzFailures === 0, `${fuzzFailures}/${ITERATIONS} disagreed`);
  check("fuzz: exercised every denial code plus both allow outcomes", codeCoverage.size >= 15, `${codeCoverage.size} distinct outcomes: ${[...codeCoverage].sort().join(", ")}`);

  console.log(`\n${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
