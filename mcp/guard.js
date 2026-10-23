#!/usr/bin/env node
// spendveto guard — SpendVeto in front of a payment provider's MCP server.
//
//   spendveto guard razorpay              Razorpay's hosted server (RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET)
//   spendveto guard stripe                Stripe (STRIPE_AGENT_KEY, else OAuth through mcp-remote)
//   spendveto guard paypal | cashfree | square
//   spendveto guard generic --url https://… --header "Authorization: Bearer …"
//   spendveto guard <profile> -- <command that starts the provider's own server>
//
// The agent's MCP client launches this instead of the provider's server. It
// connects to the provider's server itself, lists that server's tools
// unchanged (each marked where SpendVeto decides), and sends every call to the
// SpendVeto server (POST /api/mcpguard/evaluate, server/mcpguard.js) before
// the provider sees it. If SpendVeto can't be reached, only reads go through:
// the guard fails closed.
//
// stdout is the MCP protocol — every log line goes to stderr.
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PROFILES, classify } from "../server/mcpguard.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const log = (...a) => console.error("[spendveto guard]", ...a);

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const upstreamCommand = dash >= 0 ? argv.slice(dash + 1) : [];
let profile = process.env.SPENDVETO_GUARD_PROFILE || "generic";
let url = null;
let agent = process.env.SPENDVETO_AGENT || null;
const headers = {};
for (let i = 0; i < own.length; i++) {
  const a = own[i];
  if (a === "--profile") profile = own[++i];
  else if (a === "--url") url = own[++i];
  else if (a === "--agent") agent = own[++i];
  else if (a === "--header") {
    const h = own[++i] || "";
    const k = h.indexOf(":");
    if (k > 0) headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
  } else if (!a.startsWith("-")) profile = a;
}
if (!PROFILES[profile]) {
  log(`unknown provider "${profile}" — one of: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}
const BASE = (process.env.SPENDVETO_URL || `http://127.0.0.1:${process.env.PORT || 8402}`).replace(/\/+$/, "");
const TOKEN = process.env.SPENDVETO_AGENT_TOKEN || null;
const AGENT = agent || `mcp-${profile}`;

function upstreamTransport() {
  if (upstreamCommand.length) return new StdioClientTransport({ command: upstreamCommand[0], args: upstreamCommand.slice(1), env: { ...process.env }, stderr: "inherit" });
  if (url) return new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const up = PROFILES[profile].upstream(process.env);
  if (up.error) {
    log(up.error);
    process.exit(1);
  }
  if (up.url) return new StreamableHTTPClientTransport(new URL(up.url), { requestInit: { headers: { ...(up.headers || {}), ...headers } } });
  return new StdioClientTransport({ command: up.command, args: up.args, env: { ...process.env, ...(up.env || {}) }, stderr: "inherit" });
}

async function spendveto(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spendveto-agent": AGENT, ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await r.json().catch(() => ({}));
  if (!json.decision && !json.call && r.status >= 400) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}
const evaluate = (call) => spendveto("/api/mcpguard/evaluate", { profile, agent: AGENT, ...call });
const report = (callId, outcome, error) => spendveto(`/api/mcpguard/calls/${callId}/report`, { outcome, ...(error ? { error } : {}) }).catch(() => null);
const textOf = (result) => (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// A refusal the model can act on: what was decided, why, and what to do —
// plus the same as JSON for an agent that parses it.
function refusal(v) {
  const what = v.decision === "requires_approval" ? "is waiting for a human" : "was refused";
  return {
    isError: true,
    content: [
      { type: "text", text: `SpendVeto: the ${v.tool} call ${what} (${v.code || v.decision}). ${v.reason || ""}${v.suggestion ? `\nWhat to do: ${v.suggestion}` : ""}` },
      { type: "text", text: JSON.stringify({ spendveto: { decision: v.decision, code: v.code, kind: v.kind, approvalId: v.approvalId, amountUSD: v.amountUSD } }) },
    ],
  };
}

const NOTE = {
  spend: "[SpendVeto: moves money out — priced, budgeted and approved before it runs] ",
  risky: "[SpendVeto: a human approves this before it runs] ",
  unknown: "[SpendVeto: refused unless a human classifies it] ",
  router: "[SpendVeto: governed — calls that move money are checked before they run] ",
};
function noteFor(name) {
  const rule = PROFILES[profile].tools[String(name).toLowerCase().replace(/-/g, "_")];
  if (typeof rule === "function") return NOTE.router;
  return NOTE[classify(profile, name, {}).kind] || "";
}

const upstream = new Client({ name: "spendveto-guard", version: VERSION }, { capabilities: {} });
try {
  await upstream.connect(upstreamTransport());
} catch (err) {
  log(`couldn't connect to ${PROFILES[profile].label}'s MCP server: ${err.message}`);
  process.exit(1);
}
log(`guarding ${PROFILES[profile].label} for "${AGENT}" — decisions from ${BASE}`);

const server = new Server({ name: `spendveto-guard-${profile}`, version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [];
  let cursor;
  do {
    const page = await upstream.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return { tools: tools.map((t) => ({ ...t, description: noteFor(t.name) + (t.description || "") })) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  let verdict;
  try {
    verdict = await evaluate({ tool: name, arguments: args });
    if (verdict.decision === "resolve") {
      // A full refund names no amount: read the object it refunds, let
      // SpendVeto price it, and decide on that.
      const found = await upstream.callTool({ name: verdict.resolve.tool, arguments: verdict.resolve.arguments }).catch((e) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      verdict = await evaluate({ tool: name, arguments: args, resolution: { text: found.isError ? "" : textOf(found) } });
    }
  } catch (err) {
    if (classify(profile, name, args).kind === "read") return upstream.callTool({ name, arguments: args });
    return refusal({ decision: "deny", code: "spendveto_unreachable", tool: name, reason: `SpendVeto isn't reachable at ${BASE} (${err.message}), so nothing but reads goes through.`, suggestion: "start SpendVeto (npx spendveto) and try again" });
  }
  if (verdict.decision !== "allow") return refusal(verdict);
  let result;
  try {
    result = await upstream.callTool({ name, arguments: args });
  } catch (err) {
    if (verdict.callId) await report(verdict.callId, "failed", err.message);
    return { isError: true, content: [{ type: "text", text: `${PROFILES[profile].label} returned an error: ${err.message}` }] };
  }
  if (verdict.callId) await report(verdict.callId, result.isError ? "failed" : "succeeded", result.isError ? textOf(result).slice(0, 300) : undefined);
  return result;
});

// When the agent's client goes away, take the provider's server down with us.
server.onclose = async () => {
  await upstream.close().catch(() => {});
  process.exit(0);
};
await server.connect(new StdioServerTransport());
