#!/usr/bin/env node
// spendveto — one command to put a budget in front of your AI agents.
//
//   npx spendveto                               # start (console + LLM spend guard)
//   spendveto budget 10                         # $10/day per agent
//   spendveto status                            # what every agent spent today
//   spendveto observe | enforce                 # watch-only vs blocking
//   spendveto freeze <agent> | unfreeze <agent> # the kill switch
//   spendveto connect                           # print the one-line setup again
//   spendveto mcp                               # run the MCP server (stdio)
//   spendveto validate [policy.json] [--strict] # lint a policy file against the open schema (CI)
//   spendveto rails                             # which x402 chain SDKs are installed, and how to add the rest
//   spendveto guard <razorpay|stripe|paypal|…>  # put SpendVeto in front of a payment provider's MCP server
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || "8402";
// Loopback by default: this process can hold a team provider key and answers
// for an agent's budget — exposing it to the network is an explicit choice
// (HOST=0.0.0.0), not a default.
const HOST = process.env.HOST || "127.0.0.1";
const BASE = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
// A git checkout keeps its state in ./data like `npm run server` always has;
// an installed copy never writes into its own package directory.
const DATA_DIR = process.env.SPENDVETO_DATA_DIR || (existsSync(join(ROOT, ".git")) ? join(ROOT, "data") : join(homedir(), ".spendveto"));
const POLICY = join(DATA_DIR, "policy.json");

const [cmd = "start", ...args] = process.argv.slice(2);
const json = (r) => r.json();
const up = () => fetch(`${BASE}/api/llm/summary`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
const money = (n) => `$${Number(n || 0).toFixed(Number(n) < 1 ? 4 : 2)}`;

function readPolicy() {
  try {
    return JSON.parse(readFileSync(POLICY, "utf8"));
  } catch {
    return {};
  }
}

async function connectLines() {
  const lines = [
    ["Claude Code", `ANTHROPIC_BASE_URL=${BASE} claude`],
    ["Codex CLI", `OPENAI_BASE_URL=${BASE}/v1 codex`],
    ["OpenAI SDKs", `OPENAI_BASE_URL=${BASE}/v1`],
    ["Anthropic SDKs", `ANTHROPIC_BASE_URL=${BASE}`],
    ["Other tools", `OpenAI-compatible base URL ${BASE}/v1  (Cursor, LangChain, Aider, LiteLLM…)`],
  ];
  return lines.map(([name, line]) => `  ${name.padEnd(16)} ${line}`).join("\n");
}

async function banner() {
  const s = await fetch(`${BASE}/api/llm/settings`).then(json).catch(() => null);
  const st = s?.settings || {};
  console.log(`
  SpendVeto is running — every model call is checked before it reaches the provider.

  Console   ${BASE}
  Budget    ${money(st.dailyBudgetUSD)}/day · ${money(st.hourlyBudgetUSD)}/hour · ${money(st.maxRequestUSD)}/request per agent   (change: spendveto budget <usd/day>)
  Mode      ${st.mode || "enforce"}${st.mode === "observe" ? "  (recording what it would block, blocking nothing)" : ""}

  Point your agent at it. One line — your API key passes through and is never stored:
${await connectLines()}

  Data ${DATA_DIR}   ·   Stop with Ctrl+C
`);
}

async function start() {
  if (await up()) {
    console.log(`  SpendVeto is already running at ${BASE}.`);
    return banner();
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const verbose = args.includes("--verbose");
  const logPath = join(DATA_DIR, "server.log");
  const out = verbose ? "inherit" : openSync(logPath, "a");
  const child = spawn(process.execPath, [join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: { SPENDVETO_MODE: "simulate", ...process.env, PORT, HOST, SPENDVETO_DATA_DIR: DATA_DIR },
    stdio: ["ignore", out, out],
  });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await up())) {
    console.error(`  SpendVeto didn't start. Log: ${logPath}`);
    child.kill();
    process.exit(1);
  }
  await banner();
  if (!verbose) console.log(`  (server log: ${logPath})\n`);
  const stop = () => {
    child.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function setSettings(patch) {
  if (await up()) {
    const r = await fetch(`${BASE}/api/llm/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body.settings;
  }
  // Server not running: write the policy file directly (same validation as the API).
  const policy = readPolicy();
  policy.llm = { ...(policy.llm || {}), ...patch };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(POLICY, JSON.stringify(policy, null, 2));
  return policy.llm;
}

async function status() {
  if (!(await up())) return console.log(`  SpendVeto isn't running at ${BASE}. Start it with: spendveto`);
  const s = await fetch(`${BASE}/api/llm/summary`).then(json);
  console.log(`\n  Last 24h: ${money(s.totals.spentDayUSD)} across ${s.totals.requestsDay} requests · ${s.totals.blockedDay} blocked · ${s.totals.loopFreezesDay} loop freezes · mode ${s.mode}\n`);
  if (!s.identities.length) return console.log("  No agent traffic yet. Point an agent at the guard:\n" + (await connectLines()) + "\n");
  for (const i of s.identities) {
    const top = Object.entries(i.models).sort((a, b) => b[1] - a[1])[0];
    console.log(`  ${String(i.label || i.address).padEnd(22)} ${money(i.spentDayUSD).padStart(10)} today  ${money(i.remainingDayUSD).padStart(10)} left  ${String(i.requestsDay).padStart(5)} req${top ? `  mostly ${top[0]}` : ""}${i.frozen ? `  FROZEN (${i.frozen.reason})` : ""}`);
  }
  console.log("");
}

async function freeze(target, on) {
  if (!target) throw new Error(`usage: spendveto ${on ? "freeze" : "unfreeze"} <agent label or address>`);
  if (!(await up())) throw new Error(`SpendVeto isn't running at ${BASE}`);
  const s = await fetch(`${BASE}/api/llm/summary`).then(json);
  const match = s.identities.find((i) => i.label === target || i.address === target.toLowerCase());
  // An agent that hasn't sent a request yet has no row — derive its
  // identifier the same way the guard does, so a freeze set in advance holds.
  const { pseudoAddress } = await import("../server/llmguard.js");
  const address = match?.address || (/^0x[0-9a-fA-F]{40}$/.test(target) ? target.toLowerCase() : target === "local" ? pseudoAddress("local") : pseudoAddress(`label:${target}`));
  if (on) {
    const r = await fetch(`${BASE}/api/freezes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, reason: "frozen from the spendveto CLI" }) });
    if (!r.ok && r.status !== 409) throw new Error((await r.json()).error);
    console.log(`  Frozen: ${target}. Every request it makes is refused until you run: spendveto unfreeze ${target}`);
  } else {
    const { freezes } = await fetch(`${BASE}/api/freezes`).then(json);
    const f = freezes.find((x) => !x.unfrozen && x.address.toLowerCase() === address.toLowerCase());
    if (!f) return console.log(`  ${target} isn't frozen.`);
    const r = await fetch(`${BASE}/api/freezes/${f.id}/unfreeze`, { method: "POST" });
    if (!r.ok) throw new Error((await r.json()).error);
    console.log(`  Unfrozen: ${target}.`);
  }
}

try {
  switch (cmd) {
    case "start":
      await start();
      break;
    case "budget": {
      const usd = Number(args[0]);
      if (!(usd > 0)) throw new Error("usage: spendveto budget <USD per day>   e.g. spendveto budget 10");
      const s = await setSettings({ dailyBudgetUSD: usd, ...(args[1] ? { hourlyBudgetUSD: Number(args[1]) } : {}) });
      console.log(`  Daily budget per agent: ${money(s.dailyBudgetUSD)}${s.hourlyBudgetUSD ? ` · hourly ${money(s.hourlyBudgetUSD)}` : ""}`);
      break;
    }
    case "observe":
    case "enforce":
      await setSettings({ mode: cmd });
      console.log(cmd === "observe" ? "  Observe mode: SpendVeto records what it would block and blocks nothing." : "  Enforce mode: over-budget, looping and frozen agents are refused before the model is called.");
      break;
    case "status":
      await status();
      break;
    case "freeze":
    case "unfreeze":
      await freeze(args[0], cmd === "freeze");
      break;
    case "connect":
      console.log("\n" + (await connectLines()) + "\n");
      break;
    case "guard": {
      // MCP over stdio, like `spendveto mcp`: the agent's client launches this
      // in place of the provider's server (see mcp/guard.js for the options).
      const child = spawn(process.execPath, [join(ROOT, "mcp", "guard.js"), ...args], { cwd: ROOT, env: { SPENDVETO_URL: BASE, ...process.env }, stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
      break;
    }
    case "mcp": {
      const child = spawn(process.execPath, [join(ROOT, "mcp", "server.js")], { cwd: ROOT, env: { ...process.env, SPENDVETO_DATA_DIR: DATA_DIR }, stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
      break;
    }
    case "validate": {
      // Policy-as-code: the same validator as POST /api/policy/validate, so a
      // typo that would silently fail open is caught in CI, before deploy.
      const { validatePolicy } = await import("../server/policyspec.js");
      const file = args.find((a) => !a.startsWith("--")) || POLICY;
      let policy;
      try {
        policy = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        throw new Error(`can't read ${file}: ${err.message}`);
      }
      const v = validatePolicy(policy);
      for (const e of v.errors) console.log(`  error    ${e.path}  ${e.message}`);
      for (const w of v.warnings) console.log(`  warning  ${w.path}  ${w.message}`);
      const strictFail = args.includes("--strict") && v.warnings.length > 0;
      console.log(v.valid && !strictFail ? `  ${file}: valid against ${v.schema}${v.warnings.length ? ` (${v.warnings.length} warning${v.warnings.length === 1 ? "" : "s"})` : ""}` : `  ${file}: ${v.errors.length} error(s)${strictFail ? `, ${v.warnings.length} warning(s) under --strict` : ""}`);
      if (!v.valid || strictFail) process.exit(1);
      break;
    }
    case "rails": {
      // Chain SDKs are optional packages (server/optional.js): the guard, the
      // policy engine, cards and payouts need none of them. Resolution only —
      // nothing is loaded, so this answers instantly.
      const { railFamilies } = await import("../server/optional.js");
      const families = railFamilies();
      console.log("\n  x402 live settlement — one chain SDK family per row. Nothing else in SpendVeto needs these.\n");
      for (const f of families) console.log(`  ${f.family.padEnd(8)} ${f.installed ? "installed" : `missing ${f.missing.join(" ")}`}`);
      const missing = families.filter((f) => !f.installed);
      if (missing.length) {
        const all = [...new Set(missing.flatMap((f) => f.install.replace(/^npm install /, "").split(" ")))];
        console.log(`\n  Add them in the project you run spendveto from:\n    npm install spendveto ${all.join(" ")}\n`);
      } else console.log("\n  Every rail family is installed.\n");
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      break;
    default:
      throw new Error(`unknown command "${cmd}" — try: spendveto help`);
  }
} catch (err) {
  console.error(`  ${err.message}`);
  process.exit(1);
}
