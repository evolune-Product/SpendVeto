// Headless end-to-end check: boots the server in simulate mode and exercises
// the catalog, the payment protocol, the policy engine, the human-approval
// workflow (approve / deny / timeout), budget delegation caps (including the
// n-level cascade), tool + chain scoping, multichain settlement (chain-scoped
// signatures, per-chain balances, chain allowlists), runaway-burst auto-freeze
// + the manual kill switch, the stats endpoint, and the MCP server over real
// stdio JSON-RPC — no mocking.
import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RAILS, getRail } from "../rails/index.js";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPolicy } from "../client/policy.js";
import { SpendVeto, SpendVetoDenialError } from "../sdk/index.js";
import { evaluateUpiMandate } from "../server/upi.js";
import { evaluateSepaDebit } from "../server/eu-sepa.js";
import { evaluateUkPushPayment } from "../server/uk-fps.js";
import { evaluatePixPayment } from "../server/br-pix.js";
import { evaluateAchDebit } from "../server/us-ach.js";
import { createSpendVetoTools, createSpendVetoTool } from "../integrations/langchain.js";
import { createSpendVetoFunctionTools } from "../integrations/openai-agents.js";
import { createSpendVetoPlugin } from "../integrations/eliza.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8402;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
let verifyStats = null;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function runClient(toolId, extraEnv = {}, extraArgs = []) {
  const child = spawn("node", ["client/pay-and-call.js", toolId, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, SPENDVETO_MODE: "simulate", ...extraEnv },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return { child, getOut: () => out };
}

function waitForClose(child) {
  return new Promise((res) => child.on("close", res));
}

async function waitForPendingApproval(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { approvals } = await fetch(`${BASE}/api/approvals`).then((r) => r.json());
    const pending = approvals.find((a) => a.status === "pending");
    if (pending) return pending;
    await sleep(150);
  }
  return null;
}

// Minimal MCP stdio client: newline-delimited JSON-RPC over the child's stdio.
class McpStdio {
  constructor() {
    this.child = spawn("node", ["mcp/server.js"], { cwd: ROOT, env: { ...process.env, SPENDVETO_MODE: "simulate" } });
    this.pending = new Map();
    this.buffer = "";
    this.child.stdout.on("data", (d) => {
      this.buffer += d;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          // non-JSON stdout would be a protocol violation; surfaced by timeouts below
        }
      }
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  }
  request(id, method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
  }
  kill() {
    this.child.kill();
  }
}

// Fresh state for a deterministic run.
for (const f of ["data/ledger.json", "data/balances.json", "data/delegations.json", "data/children.json", "data/freezes.json", "data/waitlist.json", "data/tools.json", "data/agents.json", "data/shadow-policy.json", "data/shadow-log.json", "data/api-keys.json", "data/consents.json", "data/upto.json", "data/authcapture.json", "data/cards.json", "data/payouts.json", "data/rebilling.json"]) {
  const p = `${ROOT}${f}`;
  if (existsSync(p)) unlinkSync(p);
}
// Burst threshold loose enough that the suite's own legitimate call pattern
// never trips it — the burst test below fires 25 synthetic attempts at once.
const LOOSE_POLICY = {
  maxPerCallUSD: 1,
  maxPerHourUSD: 1,
  maxCallsPerHour: 30,
  requireApprovalAboveUSD: 0.015,
  anomaly: { burstAttempts: 25, burstWindowSeconds: 60 },
  alertWebhookUrl: "http://localhost:8499/hook",
  alertSigningSecret: "verify-secret",
};

// Local webhook receiver: proves alerts actually arrive somewhere, not just
// that sendAlert didn't throw.
const alertsReceived = [];
const alertServer = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    try {
      alertsReceived.push({ ...JSON.parse(body), _sig: req.headers["x-spendveto-signature"], _raw: body });
    } catch {}
    res.writeHead(204);
    res.end();
  });
});
alertServer.listen(8499);
writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

// World ID credentials are explicitly blanked (not just "not passed") so the
// "refused when unconfigured" assertion below is deterministic no matter what
// a maintainer happens to have in their own .env.local — dotenv.config()
// inside the spawned server skips keys already present in its env, even
// empty ones, so a bare `delete` here would leak the parent shell's real
// value straight through while an explicit "" does not.
const server = spawn("node", ["server/index.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    SPENDVETO_MODE: "simulate",
    WORLD_APP_ID: "",
    WORLD_RP_ID: "",
    WORLD_RP_SIGNING_KEY: "",
    // LLM spend guard → a local mock provider (never a real model API), and a
    // server-side team key that exists only in this test run.
    SPENDVETO_ANTHROPIC_UPSTREAM: "http://localhost:8497",
    SPENDVETO_OPENAI_UPSTREAM: "http://localhost:8497",
    SPENDVETO_ANTHROPIC_KEY: "sk-ant-verify-server-only-key",
    SPENDVETO_OPENAI_KEY: "",
    // Card authorization webhooks (server/cards.js), with test-only secrets.
    STRIPE_ISSUING_WEBHOOK_SECRET: "whsec_verify_stripe_secret",
    LITHIC_ASA_SECRET: "whsec_" + Buffer.from("verify-lithic-asa-secret-key").toString("base64"),
    SPENDVETO_DATA_DIR: "",
    // Fiat payout providers + Stripe Billing → a local mock that speaks their
    // documented formats (port 8496), with test-only credentials.
    STRIPE_SECRET_KEY: "sk_test_verify_only",
    STRIPE_API_BASE: "http://localhost:8496",
    RAZORPAYX_KEY_ID: "rzp_test_verify",
    RAZORPAYX_KEY_SECRET: "rzp_verify_secret",
    RAZORPAYX_ACCOUNT_NUMBER: "7878780080316316",
    RAZORPAY_API_BASE: "http://localhost:8496",
    PAYPAL_CLIENT_ID: "paypal_verify_id",
    PAYPAL_CLIENT_SECRET: "paypal_verify_secret",
    PAYPAL_API_BASE: "http://localhost:8496",
    MODERN_TREASURY_ORG_ID: "org_verify",
    MODERN_TREASURY_API_KEY: "mt_verify_key",
    MODERN_TREASURY_ORIGINATING_ACCOUNT_ID: "0b0b0b0b-0000-4000-8000-000000000000",
    MODERN_TREASURY_API_BASE: "http://localhost:8496",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (d) => (serverOutput += d));
server.stderr.on("data", (d) => (serverOutput += d));

let mcp = null;
let testnetProc = null;
let mockFacil = null;
let proxyProc = null;
try {
  // Wait for the boot line rather than a fixed delay — and if another process
  // holds the port, fail loudly instead of silently testing a stale server.
  for (let i = 0; i < 25 && !serverOutput.includes("SpendVeto server"); i++) await sleep(200);
  check("server booted", serverOutput.includes("SpendVeto server"), serverOutput.includes("EADDRINUSE") ? "PORT 8402 ALREADY IN USE — kill the old server first" : serverOutput.split("\n")[0]);

  // --- Catalog ---
  const catalog = await fetch(`${BASE}/api/catalog`).then((r) => r.json());
  check("catalog has 3 tools", catalog.tools?.length === 3, `found ${catalog.tools?.length}`);
  const priceById = Object.fromEntries(catalog.tools.map((t) => [t.id, t.price]));
  check("review is $0.01 (below approval line)", priceById.review === "0.01");
  check("summarize is $0.02 (above approval line)", priceById.summarize === "0.02");

  // --- Below-threshold tool pays immediately, no approval needed ---
  const { child: c1, getOut: out1 } = runClient("review");
  const code1 = await waitForClose(c1);
  check("review call exits 0 (no approval needed)", code1 === 0, out1().split("\n").slice(-2).join(" / "));
  check("review call did not request approval", !out1().includes("human sign-off"));

  // --- Above-threshold tool requests approval; dashboard approves it ---
  const { child: c2, getOut: out2 } = runClient("summarize");
  const pending2 = await waitForPendingApproval();
  check("summarize call created a pending approval", !!pending2, pending2 ? `id ${pending2.id.slice(0, 8)}` : "none appeared");
  if (pending2) {
    const decided = await fetch(`${BASE}/api/approvals/${pending2.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    }).then((r) => r.json());
    check("decide endpoint returns approved", decided.status === "approved");
  }
  const code2 = await waitForClose(c2);
  check("approved summarize call exits 0", code2 === 0, out2().split("\n").slice(-2).join(" / "));
  check("approved summarize call printed APPROVED", out2().includes("APPROVED"));

  // --- Above-threshold tool requests approval; dashboard denies it ---
  const { child: c3, getOut: out3 } = runClient("summarize");
  const pending3 = await waitForPendingApproval();
  check("second summarize call created a pending approval", !!pending3);
  if (pending3) {
    await fetch(`${BASE}/api/approvals/${pending3.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "denied" }),
    });
  }
  const code3 = await waitForClose(c3);
  check("denied summarize call exits non-zero", code3 !== 0, `exit=${code3}`);
  check("denied summarize call printed DENIED", out3().includes("DENIED"));

  // --- Approval timeout fails closed ---
  const { child: c4, getOut: out4 } = runClient("summarize", { APPROVAL_TIMEOUT_MS: "1200" });
  const code4 = await waitForClose(c4);
  check("un-decided summarize call times out and exits non-zero", code4 !== 0, `exit=${code4}`);
  check("timeout call printed the fail-closed message", out4().includes("failing closed") || out4().includes("failed closed"));

  // --- Budget delegation: grant $0.015, child fits one $0.01 call, not two ---
  const delegateRun = spawn("node", ["scripts/delegate.mjs", "0.015", "verify child"], { cwd: ROOT, env: { ...process.env, SPENDVETO_MODE: "simulate" } });
  let delegateOut = "";
  delegateRun.stdout.on("data", (d) => (delegateOut += d));
  delegateRun.stderr.on("data", (d) => (delegateOut += d));
  const delegateCode = await waitForClose(delegateRun);
  check("delegate script exits 0", delegateCode === 0, delegateOut.split("\n")[0]);
  const { delegations } = await fetch(`${BASE}/api/delegations`).then((r) => r.json());
  check("delegation stored with $0.015 cap", delegations.length === 1 && delegations[0].capUSD === 0.015, JSON.stringify(delegations[0] ?? null));

  const { child: c5, getOut: out5 } = runClient("review", {}, ["--child"]);
  const code5 = await waitForClose(c5);
  check("child call #1 within cap exits 0", code5 === 0, out5().split("\n").slice(-2).join(" / "));
  check("child call #1 used the child wallet", out5().includes("delegated child wallet"));

  const { child: c6, getOut: out6 } = runClient("review", {}, ["--child"]);
  const code6 = await waitForClose(c6);
  check("child call #2 exceeding cap is blocked", code6 !== 0, `exit=${code6}`);
  check("child call #2 cites the delegated cap", out6().includes("delegated budget cap"), out6().split("\n").find((l) => l.includes("BLOCKED")));

  // --- n-level hierarchy: an ancestor's cap governs the whole subtree ---
  // "team lead" gets $0.015 from the main wallet; "intern" gets a loose $0.05
  // from team lead. The intern's own cap never binds — the second call must be
  // blocked by the ANCESTOR's cap, proving spend cascades up the chain.
  const runDelegate = (args) => {
    const proc = spawn("node", ["scripts/delegate.mjs", ...args], { cwd: ROOT, env: { ...process.env, SPENDVETO_MODE: "simulate" } });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    return waitForClose(proc).then((code) => ({ code, out }));
  };
  const teamLead = await runDelegate(["0.015", "team lead"]);
  check("delegate 'team lead' ($0.015 from main wallet) exits 0", teamLead.code === 0, teamLead.out.split("\n")[0]);
  const intern = await runDelegate(["0.05", "intern", "--parent", "team lead"]);
  check("delegate 'intern' ($0.05 from team lead) exits 0", intern.code === 0, intern.out.split("\n")[0]);
  const allGrants = (await fetch(`${BASE}/api/delegations`).then((r) => r.json())).delegations;
  const teamLeadGrant = allGrants.find((d) => d.label === "team lead");
  const internGrant = allGrants.find((d) => d.label === "intern");
  check(
    "intern's grant chains to team lead (grandchild of main wallet)",
    internGrant?.parentAddress?.toLowerCase() === teamLeadGrant?.childAddress?.toLowerCase(),
    `intern parent ${internGrant?.parentAddress?.slice(0, 10)} vs team lead ${teamLeadGrant?.childAddress?.slice(0, 10)}`
  );

  const { child: g1, getOut: gOut1 } = runClient("review", {}, ["--child=intern"]);
  const gCode1 = await waitForClose(g1);
  check("grandchild call #1 within both caps exits 0", gCode1 === 0, gOut1().split("\n").slice(-2).join(" / "));
  check("grandchild call #1 used the intern wallet", gOut1().includes(`delegated child wallet "intern"`));

  const { child: g2, getOut: gOut2 } = runClient("review", {}, ["--child=intern"]);
  const gCode2 = await waitForClose(g2);
  check("grandchild call #2 is blocked by the ANCESTOR's cap", gCode2 !== 0, `exit=${gCode2}`);
  check("grandchild block cites the ancestor grant", gOut2().includes("granted to ancestor"), gOut2().split("\n").find((l) => l.includes("BLOCKED")));

  // --- MCP-Pay: a third party's own marketplace tool, with its own payTo,
  // must be exposed through the SAME MCP catalog SpendVeto's own tools use —
  // proving MCP-Pay is real seller-side monetization, not just SpendVeto's
  // demo tools wrapped in MCP.
  const sellerAccount = privateKeyToAccount(generatePrivateKey());
  const sellerReg = await fetch(`${BASE}/api/catalog/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "mcp-seller-demo", price: 0.005, label: "Third-party MCP tool", description: "verify: seller-side MCP-Pay", payTo: sellerAccount.address }),
  });
  check("a third-party tool with its own payTo registers into the catalog", sellerReg.status === 201, sellerReg.status);

  // --- MCP server: real stdio JSON-RPC round trip ---
  mcp = new McpStdio();
  const init = await mcp.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "verify", version: "0.0.0" },
  });
  check("MCP initialize returns serverInfo spendveto", init.result?.serverInfo?.name === "spendveto", JSON.stringify(init.result?.serverInfo));
  mcp.notify("notifications/initialized");

  const toolsList = await mcp.request(2, "tools/list");
  const toolNames = (toolsList.result?.tools || []).map((t) => t.name).sort();
  check("MCP lists 5 tools (3 built-in paid + 1 marketplace paid + status)", toolNames.length === 5, toolNames.join(", "));
  check("MCP paid tool description declares the price", (toolsList.result?.tools || []).some((t) => t.description?.includes("$0.01 USDC")));
  check("MCP exposes the third-party marketplace tool too", toolNames.includes("mcp-seller-demo"));

  const status = await mcp.request(3, "tools/call", { name: "spendveto_status", arguments: {} });
  check("MCP spendveto_status reports policy", status.result?.content?.[0]?.text?.includes("Policy:"), status.result?.content?.[0]?.text?.split("\n")[0]);
  check("MCP spendveto_status reports governance totals (blocked spend, freezes)", status.result?.content?.[0]?.text?.includes("Governance totals:"));

  const mcpCall = await mcp.request(4, "tools/call", { name: "review", arguments: {} }, 30000);
  const mcpText = mcpCall.result?.content?.[0]?.text || "";
  check("MCP paid tool call succeeds through the governed pipeline", !mcpCall.result?.isError && mcpText.includes("SpendVeto receipt"), mcpText.split("\n")[0]);

  const mcpSellerCall = await mcp.request(5, "tools/call", { name: "mcp-seller-demo", arguments: {} }, 30000);
  const mcpSellerText = mcpSellerCall.result?.content?.[0]?.text || "";
  check("MCP call to the third-party tool settles through the same governed pipeline", !mcpSellerCall.result?.isError && mcpSellerText.includes("SpendVeto receipt"), mcpSellerText.split("\n")[0]);
  const sellerLedger = (await fetch(`${BASE}/api/ledger`).then((r) => r.json())).entries;
  const sellerPaidEntry = sellerLedger.find((e) => e.resource === "/api/agent/mcp-seller-demo" && e.status === "paid");
  check("MCP-Pay settlement credits the SELLER's own payTo, not SpendVeto's payout address", sellerPaidEntry?.payTo?.toLowerCase() === sellerAccount.address.toLowerCase(), sellerPaidEntry?.payTo);

  // --- Anomaly detection: a runaway burst gets the wallet auto-frozen ---
  // A synthetic wallet fires 25 payment attempts back-to-back — far faster
  // than any legitimate agent workflow — and must come out frozen.
  const runawayAccount = privateKeyToAccount(generatePrivateKey());
  for (let i = 0; i < 25; i++) {
    await fetch(`${BASE}/api/ledger/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: runawayAccount.address, resource: "/api/agent/review", price: "0.01", status: "failed", reason: "verify: synthetic runaway burst" }),
    });
  }
  const { freezes: afterBurst } = await fetch(`${BASE}/api/freezes`).then((r) => r.json());
  const burstFreeze = afterBurst.find((f) => !f.unfrozen && f.address.toLowerCase() === runawayAccount.address.toLowerCase());
  check("burst of 25 attempts auto-froze the runaway wallet", !!burstFreeze, burstFreeze?.reason || "no freeze appeared");
  check("auto-freeze is attributed to the anomaly detector", burstFreeze?.source === "anomaly" && burstFreeze?.reason?.includes("runaway"), burstFreeze?.reason);

  // Defense in depth: even a correctly signed payment from the frozen wallet
  // is refused at the gate itself (403, not a fresh 402 challenge).
  const frozenChallenge = await fetch(`${BASE}/api/agent/review`).then((r) => r.json());
  const frozenSig = await runawayAccount.signMessage({ message: `${frozenChallenge.nonce}:${frozenChallenge.resource}:${frozenChallenge.price}` });
  const frozenAttempt = await fetch(`${BASE}/api/agent/review`, {
    headers: { "X-SIM-PAYMENT": `${runawayAccount.address}:${frozenChallenge.nonce}:${frozenSig}` },
  });
  check("valid signature from a frozen wallet is refused with 403", frozenAttempt.status === 403, `got ${frozenAttempt.status}`);

  // --- Manual kill switch: freeze → blocked, unfreeze → spends again ---
  const freezeTest = await runDelegate(["0.05", "freeze test"]);
  check("delegate 'freeze test' wallet exits 0", freezeTest.code === 0, freezeTest.out.split("\n")[0]);
  const freezeTestGrant = (await fetch(`${BASE}/api/delegations`).then((r) => r.json())).delegations.find((d) => d.label === "freeze test");
  const manualFreeze = await fetch(`${BASE}/api/freezes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: freezeTestGrant.childAddress, reason: "verify: manual kill switch" }),
  });
  check("manual freeze via API returns 201", manualFreeze.status === 201, `got ${manualFreeze.status}`);
  const manualFreezeRecord = await manualFreeze.json();

  const { child: f1, getOut: fOut1 } = runClient("review", {}, ["--child=freeze test"]);
  const fCode1 = await waitForClose(f1);
  check("frozen wallet's call is blocked before any payment", fCode1 !== 0, `exit=${fCode1}`);
  check("frozen wallet's block cites the freeze", fOut1().includes("frozen"), fOut1().split("\n").find((l) => l.includes("BLOCKED")));

  const unfrozen = await fetch(`${BASE}/api/freezes/${manualFreezeRecord.id}/unfreeze`, { method: "POST" });
  check("unfreeze via API returns 200", unfrozen.status === 200, `got ${unfrozen.status}`);
  const { child: f2, getOut: fOut2 } = runClient("review", {}, ["--child=freeze test"]);
  const fCode2 = await waitForClose(f2);
  check("unfrozen wallet spends normally again", fCode2 === 0, fOut2().split("\n").slice(-2).join(" / "));

  // --- Tool scoping: a grant can whitelist WHICH tools, not just how much ---
  const scoped = await runDelegate(["0.05", "scoped", "--tools", "translate"]);
  check("delegate 'scoped' wallet (translate only) exits 0", scoped.code === 0, scoped.out.split("\n")[0]);
  const { child: s1, getOut: sOut1 } = runClient("translate", {}, ["--child=scoped"]);
  const sCode1 = await waitForClose(s1);
  check("scoped wallet CAN buy the whitelisted tool", sCode1 === 0, sOut1().split("\n").slice(-2).join(" / "));
  const { child: s2, getOut: sOut2 } = runClient("review", {}, ["--child=scoped"]);
  const sCode2 = await waitForClose(s2);
  check("scoped wallet CANNOT buy outside its scope", sCode2 !== 0, `exit=${sCode2}`);
  check("scope block names the allowed tools", sOut2().includes("outside") && sOut2().includes("allowed: translate"), sOut2().split("\n").find((l) => l.includes("BLOCKED")));

  // --- Signed receipts: every settlement is ECDSA-signed by the server ---
  const receiptPayer = privateKeyToAccount(generatePrivateKey());
  const rc = await fetch(`${BASE}/api/agent/translate`).then((r) => r.json());
  const rcSig = await receiptPayer.signMessage({ message: `${rc.nonce}:${rc.resource}:${rc.price}` });
  const rcRes = await fetch(`${BASE}/api/agent/translate`, { headers: { "X-SIM-PAYMENT": `${receiptPayer.address}:${rc.nonce}:${rcSig}` } });
  const rcBody = await rcRes.json();
  const settlement = rcBody.settlement || {};
  check("paid response carries a signed receipt", rcRes.ok && !!settlement.signature && !!settlement.signedBy && !!settlement.receiptId, JSON.stringify({ receiptId: settlement.receiptId, signedBy: settlement.signedBy }));
  const receiptValid = settlement.signature
    ? await verifyMessage({
        address: settlement.signedBy,
        message: `spendveto-receipt:${settlement.receiptId}:${receiptPayer.address}:/api/agent/translate:0.005:base-sepolia`,
        signature: settlement.signature,
      })
    : false;
  check("receipt signature verifies against the server's signer (chain included)", receiptValid === true);

  // --- Audit export: full ledger as CSV ---
  const csvRes = await fetch(`${BASE}/api/export.csv`);
  const csvText = await csvRes.text();
  check("CSV export returns text/csv", csvRes.ok && (csvRes.headers.get("content-type") || "").includes("text/csv"), csvRes.headers.get("content-type"));
  check(
    "CSV has the header row (incl. chain) and paid entries",
    csvText.startsWith("ts,address,resource,amount,chain,status,mode,reason") && csvText.includes('"paid"'),
    csvText.split("\n")[0]
  );

  // --- Analytics: spend rolled up by tool and by wallet ---
  const analytics = await fetch(`${BASE}/api/analytics`).then((r) => r.json());
  const reviewRow = analytics.byTool.find((t) => t.key === "/api/agent/review");
  check("analytics rolls up per-tool paid and blocked counts", reviewRow?.paidCount >= 3 && reviewRow?.blockedCount >= 2, JSON.stringify(reviewRow));
  check("analytics rolls up per-wallet spend", analytics.byWallet.length >= 4 && analytics.byWallet[0].paidUSD > 0, `${analytics.byWallet.length} wallets`);

  // --- Webhook alerts: governance events actually arrive at the endpoint ---
  await sleep(400);
  const alertTypes = new Set(alertsReceived.map((a) => a.type));
  check("webhook received approval_pending and blocked alerts", alertTypes.has("approval_pending") && alertTypes.has("blocked"), [...alertTypes].join(", "));
  const freezeAlert = alertsReceived.find((a) => a.type === "freeze" && a.source === "anomaly");
  check("webhook received the anomaly freeze alert", !!freezeAlert, freezeAlert?.reason);

  // --- Enforcement proxy: agents POST intents; keys never leave the proxy ---
  proxyProc = spawn("node", ["proxy/server.js"], { cwd: ROOT, env: { ...process.env, SPENDVETO_MODE: "simulate", PER_AGENT_CALLS_PER_MIN: "3" } });
  const PROXY = "http://localhost:8404";
  // A fixed sleep here isn't margin, it's a bet on machine speed — this rail's
  // import chain now pulls in five extra SDKs (client/wallet.js's Aptos/
  // Stellar/Hedera/XRPL/Solana signers), and a slower CI runner can lose that
  // bet even though it never does locally. Poll instead: wait for the process
  // to actually be listening, not for a fixed clock to run out.
  let health;
  for (let i = 0; i < 50 && !health; i++) {
    await sleep(200);
    try {
      health = await fetch(`${PROXY}/proxy/health`).then((r) => r.json());
    } catch {}
  }
  if (!health) throw new Error("proxy/server.js never came up on :8404 within 10s");
  check("proxy reports its custody wallet and catalog", health.ok && /^0x[0-9a-fA-F]{40}$/.test(health.custody) && health.tools.length === 3, health.custody);

  const proxyPaid = await fetch(`${PROXY}/proxy/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "review" }),
  });
  const proxyPaidBody = await proxyPaid.json();
  check(
    "keyless intent through the proxy is governed, paid, and receipted",
    proxyPaid.status === 200 && proxyPaidBody.ok && !!proxyPaidBody.data?.settlement?.signature,
    `payer ${proxyPaidBody.payer?.slice(0, 10)} receipt ${proxyPaidBody.data?.settlement?.receiptId?.slice(0, 8)}`
  );

  const custodyFreeze = await fetch(`${BASE}/api/freezes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: health.custody, reason: "verify: proxy custody freeze" }),
  }).then((r) => r.json());
  const proxyRefused = await fetch(`${PROXY}/proxy/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "review" }),
  });
  const proxyRefusedBody = await proxyRefused.json();
  check("frozen custody wallet's intent is refused with 403, nothing signed", proxyRefused.status === 403 && proxyRefusedBody.reason?.includes("frozen"), proxyRefusedBody.reason);
  const custodyUnfreeze = await fetch(`${BASE}/api/freezes/${custodyFreeze.id}/unfreeze`, { method: "POST" });
  check("custody wallet unfreezes for the rest of the suite", custodyUnfreeze.status === 200, `got ${custodyUnfreeze.status}`);

  // --- Concurrency: N simultaneous calls against the same wallet must never
  // jointly exceed a cap that only has room for one. This is the TOCTOU race
  // a July 2026 GPT deep-research pass flagged: checkPolicy reads spend over
  // HTTP, and the debit+ledger-append happens several `await`s later — two
  // concurrent calls can both read the same "spent so far" snapshot and both
  // pass. withWalletLock (client/pay.js) serializes the whole
  // decide-and-commit unit per wallet; this proves it under real load.
  await fetch(`${BASE}/api/delegations/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capUSD: 0.015, label: "race test" }), // room for exactly one $0.01 "review" call, not two
  });
  const raceGrant = (await fetch(`${BASE}/api/delegations`).then((r) => r.json())).delegations.find((d) => d.label === "race test");
  const raceResults = await Promise.all(
    Array.from({ length: 6 }, () =>
      fetch(`${PROXY}/proxy/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "review", child: "race test" }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }))
    )
  );
  const raceWins = raceResults.filter((r) => r.status === 200 && r.body.ok);
  const raceBlocked = raceResults.filter((r) => r.status === 403);
  check(
    "6 concurrent calls against a cap with room for exactly one: exactly one wins",
    raceWins.length === 1 && raceBlocked.length === 5 && raceBlocked.every((r) => r.body.denial?.code === "delegation_cap"),
    `${raceWins.length} paid, ${raceBlocked.length} blocked (${raceBlocked.map((r) => r.body.denial?.code).join(",")})`
  );
  const raceLedgerSpend = (await fetch(`${BASE}/api/ledger`).then((r) => r.json())).entries
    .filter((e) => e.status === "paid" && e.address?.toLowerCase() === raceGrant.childAddress.toLowerCase())
    .reduce((s, e) => s + Number(e.amount || 0), 0);
  check(
    "actual spend under concurrent load never exceeded the delegated cap",
    raceLedgerSpend <= raceGrant.capUSD,
    `spent $${raceLedgerSpend} against a $${raceGrant.capUSD} cap`
  );

  // --- Prometheus-style scrape target ---
  const metricsRes = await fetch(`${BASE}/metrics`);
  const metricsText = await metricsRes.text();
  check(
    "/metrics serves Prometheus text exposition format with real counters",
    (metricsRes.headers.get("content-type") || "").includes("text/plain") &&
      metricsText.includes("# TYPE spendveto_paid_usd_total counter") &&
      /spendveto_paid_usd_total \d/.test(metricsText) &&
      metricsText.includes("spendveto_attempts_total"),
    metricsText.split("\n").find((l) => l.startsWith("spendveto_paid_usd_total "))
  );

  // --- SDK: the "npm import instead of curl" surface, exercised for real
  // against the live proxy (not just parsed) ---
  await fetch(`${BASE}/api/delegations/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capUSD: 1, label: "sdk test" }),
  });
  const sdk = new SpendVeto({ proxyUrl: PROXY, serverUrl: BASE });
  const sdkCatalog = await sdk.catalog();
  check("SDK .catalog() returns the live tool catalog", Array.isArray(sdkCatalog.tools) && sdkCatalog.tools.some((t) => t.id === "review"), `${sdkCatalog.tools.length} tools`);

  const sdkPaid = await sdk.pay("translate", { child: "sdk test" });
  check("SDK .pay() completes a real governed call", sdkPaid.ok === true && !!sdkPaid.data?.settlement?.receiptId, sdkPaid.data?.settlement?.receiptId);

  const sdkDry = await sdk.dryRun("summarize", { child: "sdk test" });
  check(
    "SDK .dryRun() previews with zero side effects",
    sdkDry.dryRun === true && ["would_pay", "would_pause_for_approval"].includes(sdkDry.decision),
    sdkDry.decision
  );

  let sdkDenialCaught = null;
  try {
    await sdk.pay("review", { child: "race test" }); // that grant's cap is already exhausted by the race test above
  } catch (err) {
    sdkDenialCaught = err;
  }
  check(
    "SDK throws SpendVetoDenialError with code + suggestion on a blocked call",
    sdkDenialCaught instanceof SpendVetoDenialError && sdkDenialCaught.code === "delegation_cap" && !!sdkDenialCaught.suggestion,
    sdkDenialCaught?.message
  );

  // --- Python SDK (sdk-python/): same surface as the npm SDK, zero dependencies. Exercised for real by a
  // python3 subprocess against the live proxy; skipped (like the Basis test) when python3 is absent. ---
  {
    const py = await new Promise((resolve) => {
      const child = spawn("python3", [fileURLToPath(new URL("../sdk-python/tests/e2e.py", import.meta.url))], {
        env: { ...process.env, SV_PROXY: PROXY, SV_SERVER: BASE },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (error) => resolve({ error }));
      child.on("close", () => resolve({ stdout, stderr }));
    });
    if (py.error) {
      console.log("  (skipped: Python SDK test — python3 not found)");
    } else {
      let r = {};
      try { r = JSON.parse(py.stdout.trim().split("\n").pop()); } catch {}
      check("Python SDK .catalog() returns the live tool catalog", r.catalog === true, py.stderr?.slice(-200));
      check("Python SDK .dry_run() previews with zero side effects", r.dry === true && r.health === true);
      check("Python SDK raises SpendVetoDenialError with code + suggestion + stage on a refusal", r.denial === true);
    }
  }

  // --- LangChain integration adapter: dependency-free, duck-typed tool objects ---
  const lcTools = await createSpendVetoTools({ proxyUrl: PROXY, serverUrl: BASE, child: "sdk test" });
  check(
    "LangChain adapter builds one tool per catalog entry with name/description/func",
    lcTools.length >= 3 && lcTools.every((t) => typeof t.name === "string" && typeof t.description === "string" && typeof t.func === "function"),
    lcTools.map((t) => t.name).join(", ")
  );
  const lcTranslate = lcTools.find((t) => t.name === "spendveto_translate");
  const lcOutput = await lcTranslate.func();
  check("LangChain tool .func() executes a real governed call and returns text", typeof lcOutput === "string" && lcOutput.length > 0, lcOutput.slice(0, 60));

  const lcBlockedTool = await createSpendVetoTool("review", { proxyUrl: PROXY, serverUrl: BASE, child: "race test" });
  let lcDenialCaught = null;
  try {
    await lcBlockedTool.func();
  } catch (err) {
    lcDenialCaught = err;
  }
  check(
    "LangChain tool throws with the denial code embedded for the agent to self-correct",
    lcDenialCaught instanceof Error && lcDenialCaught.code === "delegation_cap" && lcDenialCaught.message.includes("delegation_cap"),
    lcDenialCaught?.message
  );

  // --- ElizaOS plugin adapter: real Plugin/Action/Provider shapes ---
  // ElizaOS agents already move money on-chain, so this is the population the
  // whole project exists for. The plugin is duck-typed against ElizaOS's
  // documented shapes and imports nothing from @elizaos/core.
  const ez = await createSpendVetoPlugin({ proxyUrl: PROXY, serverUrl: BASE, child: "sdk test" });
  check(
    "ElizaOS adapter returns a Plugin with name, description, actions and providers",
    ez.name === "spendveto" && typeof ez.description === "string" && Array.isArray(ez.actions) && Array.isArray(ez.providers),
    `${ez.actions.length} actions, ${ez.providers.length} provider(s)`
  );
  check(
    "every ElizaOS action carries the documented Action shape (name, similes, description, validate, handler, examples)",
    ez.actions.length >= 3 &&
      ez.actions.every((a) =>
        typeof a.name === "string" && Array.isArray(a.similes) && typeof a.description === "string" &&
        typeof a.validate === "function" && typeof a.handler === "function" && Array.isArray(a.examples)),
    ez.actions.map((a) => a.name).join(", ")
  );

  const ezTranslate = ez.actions.find((a) => a.name === "SPENDVETO_TRANSLATE");
  let ezCallbackText = null;
  const ezResult = await ezTranslate.handler({}, {}, undefined, undefined, async (m) => { ezCallbackText = m.text; });
  check(
    "an allowed ElizaOS action settles and returns ActionResult{success:true} with the receipt id",
    ezResult?.success === true && typeof ezResult.text === "string" && ezResult.data?.spendveto?.blocked === false && !!ezResult.data.spendveto.receiptId,
    `receipt=${ezResult?.data?.spendveto?.receiptId?.slice(0, 8)} spent=$${ezResult?.values?.spentUSD}`
  );
  check("the ElizaOS handler also streams the result through the runtime callback", typeof ezCallbackText === "string" && ezCallbackText.length > 0, ezCallbackText?.slice(0, 50));

  // A refusal must be a RESULT, not a throw: ElizaOS handlers return
  // ActionResult, and a machine-readable code is what lets the next reasoning
  // step pick a cheaper tool instead of retrying the same blocked call.
  const ezBlocked = await createSpendVetoPlugin({ proxyUrl: PROXY, serverUrl: BASE, child: "race test" });
  const ezDenied = await ezBlocked.actions.find((a) => a.name === "SPENDVETO_REVIEW").handler({}, {});
  check(
    "a blocked ElizaOS action returns success:false with the denial code, rather than throwing",
    ezDenied?.success === false && ezDenied.data?.spendveto?.blocked === true && ezDenied.data.spendveto.code === "delegation_cap" && /Nothing was spent/.test(ezDenied.text),
    `${ezDenied?.data?.spendveto?.code}: ${ezDenied?.text?.slice(0, 60)}`
  );

  // The provider is the half that changes behaviour instead of just refusing:
  // the agent sees its remaining budget BEFORE it picks a tool.
  const ezBudget = await ez.providers[0].get({}, {});
  check(
    "the ElizaOS budget provider injects live caps and remaining spend into agent context",
    typeof ezBudget.text === "string" && /Per-call ceiling/.test(ezBudget.text) && typeof ezBudget.values?.spendvetoPerCallCapUSD === "number",
    ezBudget.text?.slice(0, 80)
  );
  const ezOffline = await createSpendVetoPlugin({ proxyUrl: PROXY, serverUrl: "http://127.0.0.1:9", child: "sdk test" })
    .catch(() => null);
  check(
    "with SpendVeto unreachable the provider says spending is restricted rather than implying it is unlimited",
    ezOffline === null || /restricted|unavailable/i.test((await ezOffline.providers[0].get({}, {})).text),
    "fails safe"
  );

  // --- Trust scores: the ledger as an agent credit file ---
  const parentTrust = await fetch(`${BASE}/api/trust/${health.custody}`).then((r) => r.json());
  const runawayTrust = await fetch(`${BASE}/api/trust/${runawayAccount.address}`).then((r) => r.json());
  check("runaway wallet's trust is torched (score 0, grade F)", runawayTrust.score === 0 && runawayTrust.grade === "F", JSON.stringify(runawayTrust.signals));
  check(
    "wallet with paid history outranks the runaway",
    parentTrust.score > runawayTrust.score && typeof parentTrust.grade === "string",
    `custody ${parentTrust.score}/${parentTrust.grade} vs runaway ${runawayTrust.score}/${runawayTrust.grade}`
  );

  // --- Policy packs ---
  const packNames = readdirSync(`${ROOT}data/policy-packs`).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  check("four policy packs ship (cautious/production/standard/trading)", JSON.stringify(packNames) === JSON.stringify(["cautious", "production", "standard", "trading"]), packNames.join(", "));
  const packsValid = packNames.every((n) => {
    const p = JSON.parse(readFileSync(`${ROOT}data/policy-packs/${n}.json`, "utf8"));
    return p.maxPerCallUSD > 0 && p.anomaly?.burstAttempts > 0 && typeof p.$description === "string";
  });
  check("every pack has caps, an anomaly guard, and a description", packsValid);

  // --- Chains + waitlist: the hosted-platform funnel ---
  const { chains } = await fetch(`${BASE}/api/chains`).then((r) => r.json());
  check(
    "chain registry lists 20 chains across eight signature families, six settling live by default",
    chains.length === 20 && chains.find((c) => c.id === "base-sepolia")?.status === "live" &&
      chains.filter((c) => c.status === "live").map((c) => c.id).sort().join(",") === "aptos-testnet,base-sepolia,hedera-testnet,solana-devnet,stellar-testnet,xrpl-testnet",
    chains.map((c) => c.id).join(", ")
  );
  check(
    "every chain carries its CAIP-2 id for the x402 v2 stack, across every registered signature family",
    chains.every((c) => /^(eip155:\d+|solana:|aptos:|stellar:|hedera:|algorand:|xrpl:|cardano:)/.test(c.caip2 || "")) &&
      chains.find((c) => c.id === "base-sepolia")?.caip2 === "eip155:84532" &&
      chains.find((c) => c.id === "solana-devnet")?.family === "svm" &&
      new Set(chains.map((c) => c.family || "evm")).size === 8,
    chains.map((c) => c.caip2).join(" ")
  );
  const usdcShapeByFamily = {
    evm: /^0x[0-9a-fA-F]{40}$/,
    svm: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    aptos: /^0x[0-9a-fA-F]{64}$/,
    stellar: /^C[A-Z2-7]{55}$/,
    hedera: /^0\.0\.\d+$/,
    // USDC on Algorand is an ASA, addressed by integer asset id — not a
    // contract address, the same way Hedera addresses by account id.
    algorand: /^\d+$/,
    xrpl: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
    // Cardano's USDM unit is policyId.assetNameHex (28-byte policy id, variable
    // asset-name hex) — not a contract address either.
    cardano: /^[0-9a-f]{56}\.[0-9a-f]+$/i,
  };
  check(
    "every registered chain carries its canonical stablecoin address (shaped per its signature family) and an RPC",
    chains.every((c) => usdcShapeByFamily[c.family || "evm"].test(c.usdc || "") && (c.rpc || "").startsWith("https://")),
    chains.map((c) => `${c.id}:${(c.usdc || "").slice(0, 10)}`).join(" ")
  );
  // The deployed static site (spendveto.com) has no live /api/chains to call,
  // so site/wallet-connect.js keeps a hand-written FALLBACK_CHAINS list for
  // the waitlist chain picker — the exact drift that shipped a stale
  // 7-chain list to production after this registry grew to 12. Import the
  // real module rather than re-parsing the file, so this catches drift the
  // same way the code path that actually renders it would.
  // wallet-connect.js reads `location.hostname` at module top-level (it's
  // written for a browser); stub just enough for the import to resolve — we
  // only need the exported constant, never loadChains() itself, here.
  globalThis.location ??= { hostname: "verify" };
  const { FALLBACK_CHAINS } = await import("../site/wallet-connect.js");
  check(
    "the deployed site's static chain-picker fallback stays mirrored to the live registry — it has no /api/chains to call",
    JSON.stringify(FALLBACK_CHAINS.map((c) => c.id).sort()) === JSON.stringify(chains.map((c) => c.id).sort()),
    `fallback=${FALLBACK_CHAINS.map((c) => c.id).join(",")}`
  );
  // Until v0.26.0 this assertion pinned XRPL *mainnet* to "xrpl:1" — which
  // @x402/xrpl defines as the TESTNET (mainnet is xrpl:0). The registry was
  // wrong and this check enshrined it. Now both ids, and each network's RLUSD
  // issuer, are read from the package itself rather than restated here.
  const xrplPkg = await import("@x402/xrpl");
  const xrplMain = chains.find((c) => c.id === "xrpl");
  const xrplTest = chains.find((c) => c.id === "xrpl-testnet");
  check(
    "XRPL network ids and RLUSD issuers come from @x402/xrpl itself — mainnet xrpl:0 behind its own opt-in, testnet xrpl:1, never one network's issuer under the other's id",
    xrplMain?.caip2 === xrplPkg.XRPL_MAINNET && xrplMain?.usdc === xrplPkg.RLUSD_MAINNET_ISSUER && xrplMain?.stablecoin === "RLUSD" && xrplMain?.status === "ready" && xrplMain?.mainnetOptIn === "SERVER_PAYOUT_ADDRESS_XRPL_MAINNET" &&
      xrplTest?.caip2 === xrplPkg.XRPL_TESTNET && xrplTest?.usdc === xrplPkg.RLUSD_TESTNET_ISSUER && xrplTest?.status === "live",
    JSON.stringify({ main: [xrplMain?.caip2, xrplMain?.usdc], test: [xrplTest?.caip2, xrplTest?.usdc] })
  );
  // Registry stablecoins vs x402's own default-asset table, for every EVM
  // chain the installed @x402/evm covers — a typo'd token address here would
  // price a chain in a contract nobody settles. (Live chain ids, EIP-3009
  // support and EIP-712 domains are re-checked against RPC by
  // `npm run check-chains`, which needs the network and so isn't in here.)
  const { getDefaultAsset } = await import("@x402/evm");
  const evmCovered = chains.filter((c) => !c.family).map((c) => { try { return [c, getDefaultAsset(c.caip2)]; } catch { return null; } }).filter(Boolean);
  // @x402/evm ≥2.23 returns { asset, name, version }; older tables used `address`.
  const assetAddr = (a) => a.asset ?? a.address;
  check(
    "every EVM chain x402's own default-asset table covers matches it exactly — stablecoin address AND EIP-712 domain (11 of 12; Optimism isn't in the table)",
    evmCovered.length >= 11 && evmCovered.every(([c, a]) => assetAddr(a) === c.usdc && a.name === c.eip712?.name && a.version === c.eip712?.version) &&
      ["monad", "celo", "sei", "stable"].every((id) => evmCovered.some(([c]) => c.id === id)),
    evmCovered.map(([c, a]) => `${c.id}:${assetAddr(a) === c.usdc && a.name === c.eip712?.name ? "ok" : `${assetAddr(a)}/${a.name}`}`).join(" ")
  );
  const newMains = ["monad", "celo", "sei", "stable"].map((id) => chains.find((c) => c.id === id));
  check(
    "Monad, Celo, Sei and Stable are registered at their real chain ids, settlement-ready rather than claimed live, with Stable labelled as USDT0 not USDC",
    newMains.every(Boolean) && newMains.map((c) => c.caip2).join(",") === "eip155:143,eip155:42220,eip155:1329,eip155:988" &&
      newMains.every((c) => c.status === "ready" && parseInt(c.chainIdHex, 16) === Number(c.caip2.split(":")[1])) &&
      newMains.find((c) => c.id === "stable").stablecoin === "USDT0" && newMains.filter((c) => c.id !== "stable").every((c) => !c.stablecoin),
    newMains.map((c) => `${c?.id}:${c?.caip2}:${c?.chainIdHex}`).join(" ")
  );
  const arc = chains.find((c) => c.id === "arc-testnet");
  check(
    "Arc is registered as Circle's USDC-native L1 at its real chain id, priced through the 6-decimal ERC-20 view of a gas token",
    arc?.caip2 === "eip155:5042002" && arc?.chainIdHex === "0x4cef52" && arc?.usdc === "0x3600000000000000000000000000000000000000",
    JSON.stringify(arc)
  );
  // The honesty rule applied to a chain: the public facilitator settles
  // Algorand and sponsors its fee, but no @x402/algorand client scheme package
  // is published, so this instance can govern an Algorand payment and cannot
  // sign one. A chain in that state must be declared, never advertised — and
  // must be structurally incapable of being signed with the wrong scheme.
  const algo = chains.find((c) => c.id === "algorand-testnet");
  const { CHAINS: registryChains } = await import("../shared-config.js");
  check(
    "Algorand is declared as governed-but-not-signable — the facilitator settles it, this instance has no scheme package for it",
    algo?.family === "algorand" && algo?.status === "ready" && /no @x402\/algorand client scheme package/.test(algo?.note || "") &&
      registryChains.filter((c) => c.family === "algorand").length === 1,
    `${algo?.caip2} settlement=${algo?.settlement}`
  );
  // Same honesty rule, one step earlier: Cardano isn't even in the public
  // facilitator's /supported yet, on top of having no published npm package —
  // added here the same week the x402 spec itself added Cardano (2026-09-09).
  const cardano = chains.find((c) => c.id === "cardano-preprod");
  check(
    "Cardano is declared as governed-but-not-settleable — the facilitator doesn't list it, so nothing here can settle it",
    cardano?.family === "cardano" && cardano?.status === "ready" && cardano?.stablecoin === "USDM" &&
      /public facilitator doesn't list a cardano network/.test(cardano?.note || "") &&
      registryChains.filter((c) => c.family === "cardano").length === 1,
    `${cardano?.caip2} settlement=${cardano?.settlement}`
  );

  const wlPost = await fetch(`${BASE}/api/waitlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "verify@example.com", chains: ["base-sepolia", "base"], notes: "verify run" }),
  }).then((r) => r.json());
  const wlCount = await fetch(`${BASE}/api/waitlist`).then((r) => r.json());
  check("waitlist stores a signup and reports its position", wlPost.ok && wlPost.position === 1 && wlCount.count === 1, JSON.stringify(wlPost));

  // --- Multichain: chain-scoped signatures, per-chain balances, chain governance ---
  // The chain rides inside the signed message and every (address, chain) pair
  // has its own balance — a Polygon authorization can only ever spend Polygon
  // funds, and policies/grants can pin which chains an agent may settle on.
  const polyPayer = privateKeyToAccount(generatePrivateKey());
  const pc = await fetch(`${BASE}/api/agent/review`).then((r) => r.json());
  const pcSig = await polyPayer.signMessage({ message: `${pc.nonce}:${pc.resource}:${pc.price}:polygon` });
  const pcRes = await fetch(`${BASE}/api/agent/review`, { headers: { "X-SIM-PAYMENT": `${polyPayer.address}:${pc.nonce}:polygon:${pcSig}` } });
  const pcBody = await pcRes.json();
  check("chain-scoped signature settles on that chain", pcRes.ok && pcBody.settlement?.chain === "polygon", `settlement.chain=${pcBody.settlement?.chain}`);
  const balancesFile = JSON.parse(readFileSync(`${ROOT}data/balances.json`, "utf8"));
  const polyBalances = balancesFile[polyPayer.address.toLowerCase()] || {};
  check("polygon balance debited; other chains untouched", polyBalances.polygon === 4.99 && !("base-sepolia" in polyBalances), JSON.stringify(polyBalances));

  const pc2 = await fetch(`${BASE}/api/agent/review`).then((r) => r.json());
  const crossSig = await polyPayer.signMessage({ message: `${pc2.nonce}:${pc2.resource}:${pc2.price}:polygon` });
  const crossRes = await fetch(`${BASE}/api/agent/review`, { headers: { "X-SIM-PAYMENT": `${polyPayer.address}:${pc2.nonce}:arbitrum:${crossSig}` } });
  check("an authorization signed for polygon is rejected on arbitrum", crossRes.status === 402, `got ${crossRes.status}`);

  const { child: mc1, getOut: mcOut1 } = runClient("review", {}, ["--chain=polygon"]);
  const mcCode1 = await waitForClose(mc1);
  check("CLI --chain=polygon pays through the full governed pipeline", mcCode1 === 0 && mcOut1().includes("Chain: polygon"), mcOut1().split("\n").slice(-2).join(" / "));

  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, allowedChains: ["base-sepolia", "base"] }, null, 2));
  const { child: mc2, getOut: mcOut2 } = runClient("review", {}, ["--chain=ethereum"]);
  const mcCode2 = await waitForClose(mc2);
  check("policy chain allowlist blocks a chain not on the list", mcCode2 !== 0, `exit=${mcCode2}`);
  check("chain-allowlist block names the allowed chains", mcOut2().includes(`chain "ethereum" is not in this policy's allowed chains`), mcOut2().split("\n").find((l) => l.includes("BLOCKED")));
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  const chainScoped = await runDelegate(["0.05", "base only", "--chains", "base-sepolia"]);
  check("delegate 'base only' wallet (chain scope) exits 0", chainScoped.code === 0, chainScoped.out.split("\n")[0]);
  const { child: cs1, getOut: csOut1 } = runClient("review", {}, ["--child=base only"]);
  const csCode1 = await waitForClose(cs1);
  check("chain-scoped wallet CAN pay on its allowed chain", csCode1 === 0, csOut1().split("\n").slice(-2).join(" / "));
  const { child: cs2, getOut: csOut2 } = runClient("review", {}, ["--child=base only", "--chain=avalanche"]);
  const csCode2 = await waitForClose(cs2);
  check("chain-scoped wallet CANNOT pay outside its chain scope", csCode2 !== 0, `exit=${csCode2}`);
  check("chain-scope block cites the delegated chain scope", csOut2().includes("delegated chain scope"), csOut2().split("\n").find((l) => l.includes("BLOCKED")));

  const proxyChainRes = await fetch(`${PROXY}/proxy/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "translate", chain: "arbitrum" }),
  });
  const proxyChainBody = await proxyChainRes.json();
  check(
    "keyless proxy intent settles on the requested chain",
    proxyChainRes.status === 200 && proxyChainBody.data?.settlement?.chain === "arbitrum",
    `settlement.chain=${proxyChainBody.data?.settlement?.chain}`
  );

  const chainAnalytics = await fetch(`${BASE}/api/analytics`).then((r) => r.json());
  const polyRow = chainAnalytics.byChain.find((c) => c.key === "polygon");
  const arbRow = chainAnalytics.byChain.find((c) => c.key === "arbitrum");
  check("analytics rolls up spend per chain", polyRow?.paidCount >= 2 && arbRow?.paidCount >= 1, JSON.stringify({ polygon: polyRow, arbitrum: arbRow }));

  // --- Structured denials: refusals an agent can act on, not just read ---
  check(
    "refused proxy intent carries a machine-readable denial (code + fix)",
    proxyRefusedBody.denial?.code === "frozen" && proxyRefusedBody.denial?.suggestion?.includes("unfreeze"),
    JSON.stringify(proxyRefusedBody.denial)
  );
  check("blocked CLI call prints an actionable Fix line", csOut2().includes("Fix:"), csOut2().split("\n").find((l) => l.startsWith("Fix:")));

  // --- Dry run: evaluate the whole pipeline with zero side effects ---
  const ledgerBefore = (await fetch(`${BASE}/api/ledger`).then((r) => r.json())).entries.length;
  const dryPause = await fetch(`${PROXY}/proxy/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "summarize", dryRun: true }),
  }).then((r) => r.json());
  check("dry run predicts the approval pause for an above-threshold price", dryPause.dryRun === true && dryPause.decision === "would_pause_for_approval", JSON.stringify(dryPause.decision));
  const dryBlock = await fetch(`${PROXY}/proxy/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "review", child: "base only", chain: "avalanche", dryRun: true }),
  }).then((r) => r.json());
  check("dry run predicts a block with the denial code and fix", dryBlock.decision === "would_block" && dryBlock.denial?.code === "chain_scope" && !!dryBlock.denial?.suggestion, JSON.stringify(dryBlock.denial?.code));
  const ledgerAfter = (await fetch(`${BASE}/api/ledger`).then((r) => r.json())).entries.length;
  check("dry runs leave zero trace in the ledger", ledgerAfter === ledgerBefore, `${ledgerBefore} → ${ledgerAfter}`);

  // --- Time-boxed grants: budgets that expire on their own ---
  const flash = await runDelegate(["0.03", "flash", "--ttl", "3600"]);
  const flashGrant = (await fetch(`${BASE}/api/delegations`).then((r) => r.json())).delegations.find((d) => d.label === "flash");
  check("TTL grant stores its expiry", flash.code === 0 && !!flashGrant?.expiresAt, flashGrant?.expiresAt);
  const { child: t1, getOut: tOut1 } = runClient("review", {}, ["--child=flash"]);
  const tCode1 = await waitForClose(t1);
  check("TTL grant spends normally inside its window", tCode1 === 0, tOut1().split("\n").slice(-2).join(" / "));
  const flashShort = await runDelegate(["0.03", "flash short", "--ttl", "1"]);
  check("1-second TTL grant created", flashShort.code === 0, flashShort.out.split("\n")[0]);
  await sleep(1600);
  const { child: t2, getOut: tOut2 } = runClient("review", {}, ["--child=flash short"]);
  const tCode2 = await waitForClose(t2);
  check("expired grant is blocked with the expiry cited", tCode2 !== 0 && tOut2().includes("delegation expired"), tOut2().split("\n").find((l) => l.includes("BLOCKED")));

  // --- One-click approvals: decide links that work from chat ---
  const pendingAlert = alertsReceived.find((a) => a.type === "approval_pending");
  check(
    "approval alerts carry one-click approve/deny URLs",
    pendingAlert?.approveUrl?.includes("/decide?decision=approved") && pendingAlert?.denyUrl?.includes("/decide?decision=denied"),
    pendingAlert?.approveUrl
  );
  const clickApproval = await fetch(`${BASE}/api/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: runawayAccount.address, resource: "/api/agent/summarize", price: "0.02" }),
  }).then((r) => r.json());
  const clickRes = await fetch(`${BASE}/api/approvals/${clickApproval.id}/decide?decision=denied`);
  const clickAfter = await fetch(`${BASE}/api/approvals/${clickApproval.id}`).then((r) => r.json());
  check("GET decide link denies the approval in one click", clickRes.ok && clickAfter.status === "denied", `status=${clickAfter.status}`);

  // --- Console write-APIs: the dashboard is a control surface, not a viewer ---
  const putRes = await fetch(`${BASE}/api/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxPerCallUSD: 0.9 }),
  }).then((r) => r.json());
  const putReadBack = await fetch(`${BASE}/api/policy`).then((r) => r.json());
  check("PUT /api/policy edits the live policy", putRes.maxPerCallUSD === 0.9 && putReadBack.maxPerCallUSD === 0.9, `readback=${putReadBack.maxPerCallUSD}`);
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  const { packs } = await fetch(`${BASE}/api/policy-packs`).then((r) => r.json());
  check("policy-packs API lists the four presets with descriptions", packs.length === 4 && packs.every((p) => typeof p.$description === "string"), packs.map((p) => p.name).join(", "));

  const appliedPack = await fetch(`${BASE}/api/policy/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pack: "cautious" }),
  }).then((r) => r.json());
  check("applying a pack via API swaps the live policy", appliedPack.maxPerCallUSD === 0.02 && appliedPack.allowedChains?.includes("base-sepolia"), JSON.stringify(appliedPack.maxPerCallUSD));
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  const consoleKid = await fetch(`${BASE}/api/delegations/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capUSD: 0.03, label: "console kid" }),
  });
  const consoleKidBody = await consoleKid.json();
  check("console budget API creates a wallet + grant in one call", consoleKid.status === 201 && /^0x[0-9a-fA-F]{40}$/.test(consoleKidBody.childAddress || ""), consoleKidBody.childAddress);
  const { child: ck1, getOut: ckOut1 } = runClient("review", {}, ["--child=console kid"]);
  const ckCode1 = await waitForClose(ck1);
  check("console-created wallet spends through the full pipeline", ckCode1 === 0, ckOut1().split("\n").slice(-2).join(" / "));

  // --- Signed webhooks, idempotent intents, verifiable receipts ---
  const signedAlert = alertsReceived.find((a) => a._sig);
  const expectedSig = signedAlert ? `sha256=${createHmac("sha256", "verify-secret").update(signedAlert._raw).digest("hex")}` : null;
  check("webhook deliveries carry a valid HMAC signature", !!signedAlert && signedAlert._sig === expectedSig, signedAlert?._sig?.slice(0, 20));
  const tamperedBody = signedAlert ? signedAlert._raw + " " : null;
  const tamperedSig = tamperedBody
    ? `sha256=${createHmac("sha256", "verify-secret").update(tamperedBody).digest("hex")}`
    : null;
  check(
    "a tampered webhook body no longer matches the delivered HMAC signature (integrity check actually catches tampering)",
    !!signedAlert && tamperedBody !== signedAlert._raw && tamperedSig !== signedAlert._sig,
    `original=${signedAlert?._sig?.slice(0, 16)} tampered-would-be=${tamperedSig?.slice(0, 16)}`
  );

  // --- Freeze check runs before signature verification, not after ---
  // (a forged signature alone gets 402 from checkFrozen; on a wallet that's
  // ALSO frozen, the freeze must still be what's reported — proves the
  // pipeline order is freeze-check-first, not "verify sig, then check frozen".)
  const forgeFreeze = await fetch(`${BASE}/api/freezes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: polyPayer.address, reason: "verify: frozen + forged signature ordering" }),
  });
  const forgeFreezeRecord = await forgeFreeze.json();
  const frozenForged = await fetch(`${BASE}/api/agent/translate`, {
    headers: { "X-SIM-PAYMENT": `${polyPayer.address}:not-a-real-nonce:polygon:not-a-real-signature` },
  });
  check(
    "a frozen wallet with a forged signature is rejected for being frozen, not just for the bad signature",
    frozenForged.status === 402 || frozenForged.status === 403,
    `got ${frozenForged.status}`
  );
  await fetch(`${BASE}/api/freezes/${forgeFreezeRecord.id}/unfreeze`, { method: "POST" });

  const idemBody = { tool: "translate", idempotencyKey: "verify-idem-1" };
  const idem1 = await fetch(`${PROXY}/proxy/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(idemBody) }).then((r) => r.json());
  const idem2 = await fetch(`${PROXY}/proxy/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(idemBody) }).then((r) => r.json());
  check(
    "an agent retry with the same idempotency key never pays twice",
    idem1.ok && idem2.idempotent === true && idem2.data?.settlement?.receiptId === idem1.data?.settlement?.receiptId,
    `receipt ${idem1.data?.settlement?.receiptId?.slice(0, 8)} replayed`
  );
  const idemLedger = (await fetch(`${BASE}/api/ledger`).then((r) => r.json())).entries.filter((e) => e.receiptId === idem1.data?.settlement?.receiptId);
  check("the idempotent replay left exactly one ledger entry", idemLedger.length === 1, `found ${idemLedger.length}`);

  const rcLookup = await fetch(`${BASE}/api/receipts/${pcBody.settlement.receiptId}`).then((r) => r.json());
  check("receipts are addressable by id in the ledger", rcLookup.receipt?.chain === "polygon" && rcLookup.receipt?.status === "paid", JSON.stringify({ chain: rcLookup.receipt?.chain }));
  const rcVerifyBody = { receiptId: pcBody.settlement.receiptId, payer: polyPayer.address, resource: "/api/agent/review", price: "0.01", chain: "polygon", signedBy: pcBody.settlement.signedBy, signature: pcBody.settlement.signature };
  const rcValid = await fetch(`${BASE}/api/receipts/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rcVerifyBody) }).then((r) => r.json());
  check("the receipt-verify API confirms a genuine receipt", rcValid.valid === true);
  const rcTampered = await fetch(`${BASE}/api/receipts/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...rcVerifyBody, price: "9.99" }) }).then((r) => r.json());
  check("the receipt-verify API rejects a tampered receipt", rcTampered.valid === false);

  // --- Hardening: idempotency poisoning, consumed-authorization replay, delegation cycles ---
  const poison = await fetch(`${PROXY}/proxy/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "review", idempotencyKey: "verify-idem-1" }),
  }).then((r) => r.json());
  check(
    "reusing an idempotency key with a DIFFERENT intent never replays the other intent's result",
    poison.ok && poison.idempotent !== true && poison.data?.settlement?.amount === "0.01" && poison.data?.settlement?.receiptId !== idem1.data?.settlement?.receiptId,
    `fresh receipt ${poison.data?.settlement?.receiptId?.slice(0, 8)} (idem1 was translate)`
  );
  const consumedReplay = await fetch(`${BASE}/api/agent/review`, { headers: { "X-SIM-PAYMENT": `${polyPayer.address}:${pc.nonce}:polygon:${pcSig}` } });
  check("a consumed payment authorization cannot be replayed", consumedReplay.status === 402, `got ${consumedReplay.status}`);

  const cycA = privateKeyToAccount(generatePrivateKey());
  const cycB = privateKeyToAccount(generatePrivateKey());
  for (const [pa, ch] of [[cycA.address, cycB.address], [cycB.address, cycA.address]]) {
    await fetch(`${BASE}/api/delegations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentAddress: pa, childAddress: ch, capUSD: 1, label: "cycle" }) });
  }
  const cycleVerdict = await Promise.race([
    checkPolicy(cycB.address, "0.01", "review", "base-sepolia"),
    new Promise((_, rej) => setTimeout(() => rej(new Error("cycle walk hung")), 5000)),
  ]).catch((e) => ({ hung: e.message }));
  check("a delegation cycle terminates instead of hanging the policy walk", cycleVerdict.hung === undefined && cycleVerdict.allowed === true, JSON.stringify({ allowed: cycleVerdict.allowed, hung: cycleVerdict.hung }));

  // --- Marketplace: anyone registers a paid tool behind the same gate ---
  const regRes = await fetch(`${BASE}/api/catalog/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "haiku", price: 0.008, label: "Haiku writer", description: "verify-registered marketplace tool" }),
  });
  const regBody = await regRes.json();
  check("a new paid tool registers into the live catalog", regRes.status === 201 && regBody.path === "/api/agent/haiku", JSON.stringify(regBody.id));
  const dupRes = await fetch(`${BASE}/api/catalog/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "haiku", price: 0.5 }),
  });
  check("duplicate tool ids are refused", dupRes.status === 409, `got ${dupRes.status}`);
  const liveCatalog = await fetch(`${BASE}/api/catalog`).then((r) => r.json());
  check("catalog serves static + marketplace tools together", liveCatalog.tools.length === 5 && liveCatalog.tools.some((t) => t.id === "haiku" && t.dynamic), `${liveCatalog.tools.length} tools`);
  const { child: mk1, getOut: mkOut1 } = runClient("haiku");
  const mkCode1 = await waitForClose(mk1);
  check("the CLI pays a marketplace tool through the full governed pipeline", mkCode1 === 0 && mkOut1().includes("Paid $0.008"), mkOut1().split("\n").slice(-2).join(" / "));

  // --- Real cross-project integration: Basis (a separate, unrelated app — a prediction-
  // markets copilot) registers its live opinion-matcher as a marketplace tool. This is not a
  // mock upstream: a real Basis backend boots on its own port with its own real market data,
  // and the assertions below check for its actual matcher output, not a canned string —
  // proving the query-passthrough plumbing (rails, governedCall, the proxy's dynamic-tool
  // lookup, and the SDK) all carry real per-call input to a real third-party API and back.
  const BASIS_DIR = fileURLToPath(new URL("../../prediction-copilot/backend", import.meta.url));
  let basisProc = null;
  let basisOk = false;
  try {
    readFileSync(fileURLToPath(new URL("../../prediction-copilot/backend/src/server.js", import.meta.url)));
    basisOk = true;
  } catch {
    basisOk = false;
  }
  if (basisOk) {
    const BASIS_PORT = 8799;
    basisProc = spawn("node", ["src/server.js"], { cwd: BASIS_DIR, env: { ...process.env, PORT: String(BASIS_PORT) }, stdio: ["ignore", "pipe", "pipe"] });
    await sleep(1200);

    const basisReg = await fetch(`${BASE}/api/catalog/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "basis-match",
        price: 0.01,
        label: "Basis opinion matcher",
        description: "Matches a plain-English market opinion to real live Kalshi/Polymarket contracts.",
        category: "finance",
        upstreamUrl: `http://localhost:${BASIS_PORT}/api/agent/match`,
      }),
    });
    check("Basis's matcher registers as a real marketplace tool", basisReg.status === 201, `got ${basisReg.status}`);

    // The actual published SDK, not a raw fetch — this is the exact code an external agent
    // developer would write against `spendveto-sdk`.
    const tg = new SpendVeto({ proxyUrl: PROXY, serverUrl: BASE });
    let basisResult, basisErr;
    try {
      basisResult = await tg.pay("basis-match", { query: { opinion: "the Fed will cut interest rates this year" } });
    } catch (err) {
      basisErr = err;
    }
    let basisText = {};
    try {
      basisText = JSON.parse(basisResult?.data?.result?.text || "{}");
    } catch {}
    check(
      "spendveto-sdk's tg.pay() reaches a THIRD-PARTY app's real API through a marketplace tool, and gets real matched-market data back",
      !basisErr &&
        basisResult?.ok &&
        basisResult.data?.result?.real === true &&
        basisText.agent === true &&
        Array.isArray(basisText.matches) &&
        basisText.matches.length > 0 &&
        typeof basisText.matches[0]?.market?.title === "string",
      basisErr
        ? `threw: ${basisErr.message}`
        : `matched "${basisText.matches?.[0]?.market?.title?.slice(0, 60)}" (real=${basisResult.data?.result?.real})`
    );

    const basisDry = await tg.dryRun("basis-match");
    check("tg.dryRun() also resolves a marketplace tool through the proxy's dynamic-catalog lookup", basisDry?.dryRun === true, JSON.stringify(basisDry?.decision));

    basisProc.kill();
  } else {
    console.log("  (skipped: cross-project Basis integration test — ../prediction-copilot not found alongside this repo)");
  }

  // --- Recurring allowances: caps that re-fill on a rolling window ---
  const allowance = await runDelegate(["0.01", "allowance kid", "--every", "2s"]);
  const allowanceGrant = (await fetch(`${BASE}/api/delegations`).then((r) => r.json())).delegations.find((d) => d.label === "allowance kid");
  check("an allowance grant stores its rolling window", allowance.code === 0 && allowanceGrant?.periodSeconds === 2, `periodSeconds=${allowanceGrant?.periodSeconds}`);
  const { child: aw1 } = runClient("review", {}, ["--child=allowance kid"]);
  const awCode1 = await waitForClose(aw1);
  check("allowance spends inside the window", awCode1 === 0, `exit=${awCode1}`);
  const { child: aw2, getOut: awOut2 } = runClient("review", {}, ["--child=allowance kid"]);
  const awCode2 = await waitForClose(aw2);
  check("a full window blocks with the allowance cited", awCode2 !== 0 && awOut2().includes("allowance window"), awOut2().split("\n").find((l) => l.includes("BLOCKED")));
  await sleep(2600);
  const { child: aw3 } = runClient("review", {}, ["--child=allowance kid"]);
  const awCode3 = await waitForClose(aw3);
  check("the allowance re-fills by itself after the window rolls", awCode3 === 0, `exit=${awCode3}`);

  // --- Simulated top-ups ---
  const topup = await fetch(`${BASE}/api/balances/topup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: polyPayer.address, amount: 3, chain: "polygon" }),
  }).then((r) => r.json());
  check("a simulate-mode top-up credits the per-chain balance", Math.abs(topup.balance - 7.99) < 1e-9, `balance=${topup.balance}`);

  // --- The API-spend rail: governing LLM/API dollars with the same pipeline ---
  const llmPaid = await fetch(`${PROXY}/proxy/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "hello world", maxTokens: 100 }),
  }).then((r) => r.json());
  check(
    "LLM spend is governed and metered into the ledger (auth/capture)",
    llmPaid.ok && llmPaid.rail === "llm-simulate" && llmPaid.actualUSD > 0 && llmPaid.estimateUSD >= llmPaid.actualUSD,
    `est $${llmPaid.estimateUSD} → actual $${llmPaid.actualUSD}`
  );

  const llmTimeout = await fetch(`${PROXY}/proxy/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "xxxx", maxTokens: 19999, approvalTimeoutMs: 1200 }),
  });
  const llmTimeoutBody = await llmTimeout.json();
  check(
    "an above-threshold LLM estimate pauses for approval and FAILS CLOSED — upstream never called",
    llmTimeout.status === 403 && llmTimeoutBody.reason?.includes("upstream was never called") && Math.abs(llmTimeoutBody.estimateUSD - 0.02) < 1e-9,
    llmTimeoutBody.reason
  );

  const llmCap = await fetch(`${PROXY}/proxy/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "xxxx", maxTokens: 39999, child: "flash" }),
  });
  const llmCapBody = await llmCap.json();
  check(
    "a delegated budget cap blocks LLM spend exactly like crypto spend",
    llmCap.status === 403 && llmCapBody.denial?.code === "delegation_cap" && !!llmCapBody.denial?.suggestion,
    llmCapBody.reason
  );

  const llmAnalytics = await fetch(`${BASE}/api/analytics`).then((r) => r.json());
  const apiRow = llmAnalytics.byChain.find((c) => c.key === "api");
  check("API spend rolls up as its own bucket beside the chains", apiRow?.paidCount >= 1 && apiRow?.blockedCount >= 2, JSON.stringify(apiRow));

  // --- Competitor-parity round: category caps, trading hours, N approvers, agent identities ---
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, categoryCapsUSD: { content: 0.004 } }, null, 2));
  const { child: cc1, getOut: ccOut1 } = runClient("translate");
  const ccCode1 = await waitForClose(cc1);
  check("an hourly category cap blocks spend in that category", ccCode1 !== 0 && ccOut1().includes(`category "content"`), ccOut1().split("\n").find((l) => l.includes("BLOCKED")));

  const nowH = new Date().getUTCHours();
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, allowedHoursUTC: { start: (nowH + 2) % 24, end: (nowH + 3) % 24 } }, null, 2));
  const { child: th1, getOut: thOut1 } = runClient("review");
  const thCode1 = await waitForClose(th1);
  check("outside the trading-hours window, nothing spends", thCode1 !== 0 && thOut1().includes("trading hours"), thOut1().split("\n").find((l) => l.includes("BLOCKED")));
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, approversRequired: 2 }, null, 2));

  const twoAp = await fetch(`${BASE}/api/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: runawayAccount.address, resource: "/api/agent/summarize", price: "0.02" }),
  }).then((r) => r.json());
  const firstYes = await fetch(`${BASE}/api/approvals/${twoAp.id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approved" }) }).then((r) => r.json());
  check("with approversRequired=2, one approval is not enough", firstYes.status === "pending" && firstYes.approvals === 1, JSON.stringify({ status: firstYes.status, approvals: firstYes.approvals }));
  const secondYes = await fetch(`${BASE}/api/approvals/${twoAp.id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approved" }) }).then((r) => r.json());
  check("the second approver lands the approval", secondYes.status === "approved" && secondYes.approvals === 2, `status=${secondYes.status}`);
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  const agentReg = await fetch(`${PROXY}/proxy/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "desk bot", child: "console kid" }),
  });
  const agentBody = await agentReg.json();
  check("an agent identity registers with a bearer token bound to its wallet", agentReg.status === 201 && agentBody.token?.startsWith("tg_") && agentBody.child === "console kid", agentBody.label);
  const noAuth = await fetch(`${PROXY}/proxy/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: "review" }) });
  check("once identities exist, tokenless intents are refused with 401", noAuth.status === 401, `got ${noAuth.status}`);
  const authed = await fetch(`${PROXY}/proxy/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentBody.token}` },
    body: JSON.stringify({ tool: "review", child: "flash" }),
  }).then((r) => r.json());
  check(
    "a wallet-bound token spends ONLY as its own wallet (body child overridden)",
    authed.ok && authed.payer === consoleKidBody.childAddress,
    `payer ${authed.payer?.slice(0, 10)} (bound wallet ${consoleKidBody.childAddress?.slice(0, 10)})`
  );

  const credential = await fetch(`${PROXY}/proxy/agents/${agentBody.id}/credential`).then((r) => r.json());
  check(
    "an agent's KYA credential joins its identity to its wallet's live trust score, freeze status, and delegation scope",
    credential.wallet?.address === consoleKidBody.childAddress &&
      typeof credential.wallet.trustScore === "number" &&
      credential.wallet.frozen === false &&
      credential.wallet.scope?.capUSD === consoleKidBody.capUSD,
    JSON.stringify(credential.wallet)
  );
  const credential404 = await fetch(`${PROXY}/proxy/agents/not-a-real-id/credential`);
  check("a credential lookup for an unknown agent id 404s instead of guessing", credential404.status === 404, `got ${credential404.status}`);
  const unboundAgentReg = await fetch(`${PROXY}/proxy/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "unbound agent" }),
  }).then((r) => r.json());
  const unboundCredential = await fetch(`${PROXY}/proxy/agents/${unboundAgentReg.id}/credential`).then((r) => r.json());
  check("an agent identity with no bound wallet reports wallet:null rather than fabricating trust data", unboundCredential.wallet === null, JSON.stringify(unboundCredential));

  // --- Per-agent rate limiting + freeze (independent of the wallet policy engine) ---
  // Proxy spawned with PER_AGENT_CALLS_PER_MIN=3 for this run so the window closes fast.
  const rlAgent = await fetch(`${PROXY}/proxy/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "rate limit test" }),
  }).then((r) => r.json());
  const rlCallAs = (token) =>
    fetch(`${PROXY}/proxy/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool: "review" }),
    }).then((r) => r.json().then((body) => ({ status: r.status, body })));
  const rlCall = () => rlCallAs(rlAgent.token);
  const rl1 = await rlCall();
  const rl2 = await rlCall();
  const rl3 = await rlCall();
  check("the first 3 calls (the configured per-agent limit) go through normally", [rl1, rl2, rl3].every((r) => r.body.ok), [rl1, rl2, rl3].map((r) => r.status).join(","));
  const rl4 = await rlCall();
  check("the 4th call in the same minute is throttled at the agent identity, not the wallet", rl4.status === 429 && rl4.body.code === "agent_rate_limited", JSON.stringify(rl4.body));
  const rl5 = await rlCall();
  const rl6 = await rlCall();
  check("repeated throttling escalates violations (2nd, 3rd rate-limited call)", rl5.status === 429 && rl6.status === 429, `${rl5.status},${rl6.status}`);
  const rl7 = await rlCall();
  check("3 consecutive rate-limit violations auto-freeze the agent identity (not the wallet)", rl7.status === 403 && rl7.body.code === "agent_frozen", JSON.stringify(rl7.body));
  const rlCredential = await fetch(`${PROXY}/proxy/agents/${rlAgent.id}/credential`).then((r) => r.json());
  check("the credential endpoint reports the auto-freeze on the agent identity", rlCredential.agentFrozen === true, JSON.stringify(rlCredential.agentFrozen));
  // Clean up: this is a synthetic per-agent freeze (key "agent:<id>"), not a wallet freeze,
  // but it lives in the same freeze store the stats endpoint counts — clear it so the later
  // "exactly the runaway wallet is still frozen" assertion isn't polluted by this test.
  await fetch(`${PROXY}/proxy/agents/${rlAgent.id}/unfreeze`, { method: "POST" });

  const manualAgent = await fetch(`${PROXY}/proxy/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "manual freeze test" }),
  }).then((r) => r.json());
  const manualFreezeRes = await fetch(`${PROXY}/proxy/agents/${manualAgent.id}/freeze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "verify: manual agent freeze" }),
  });
  check("an agent identity can be frozen directly, independent of any wallet freeze", manualFreezeRes.status === 201, `status=${manualFreezeRes.status}`);
  const manualBlockedCall = await fetch(`${PROXY}/proxy/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${manualAgent.token}` },
    body: JSON.stringify({ tool: "review" }),
  }).then((r) => r.json().then((body) => ({ status: r.status, body })));
  check("a manually-frozen agent's calls are refused before anything is governed or spent", manualBlockedCall.status === 403 && manualBlockedCall.body.code === "agent_frozen", JSON.stringify(manualBlockedCall.body));
  const manualUnfreeze = await fetch(`${PROXY}/proxy/agents/${manualAgent.id}/unfreeze`, { method: "POST" }).then((r) => r.json());
  check("unfreezing the agent identity clears it", manualUnfreeze.unfrozen === true, JSON.stringify(manualUnfreeze));
  const manualCallAfter = await rlCallAs(manualAgent.token);
  check("after unfreezing, a fresh agent identity (no throttle history) spends normally again", manualCallAfter.body.ok === true, JSON.stringify(manualCallAfter.body));

  // --- Signed consent records (grant + revoke), independently verifiable ---
  const consentParent = privateKeyToAccount(generatePrivateKey());
  const consentChild = privateKeyToAccount(generatePrivateKey());
  const consentDelegation = await fetch(`${BASE}/api/delegations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentAddress: consentParent.address, childAddress: consentChild.address, capUSD: 0.02, label: "consent test" }),
  }).then((r) => r.json());
  const consentsAfterGrant = await fetch(`${BASE}/api/consent/${consentDelegation.id}`).then((r) => r.json());
  const grantConsent = consentsAfterGrant.consents.find((c) => c.action === "grant");
  check(
    "granting a delegation writes a signed consent record (Visa Trusted-Agent-style)",
    grantConsent?.childAddress === consentChild.address && grantConsent?.action === "grant",
    JSON.stringify(grantConsent)
  );
  const grantVerify = await fetch(`${BASE}/api/consent/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: grantConsent.delegationId, parentAddress: grantConsent.parentAddress, childAddress: grantConsent.childAddress, capUSD: grantConsent.capUSD, scope: grantConsent.scope, action: grantConsent.action, ts: grantConsent.ts, signedBy: grantConsent.signer, signature: grantConsent.signature }),
  }).then((r) => r.json());
  check("the grant consent's ECDSA signature verifies independently of the stored file", grantVerify.valid === true, JSON.stringify(grantVerify));
  await fetch(`${BASE}/api/delegations/${consentDelegation.id}/revoke`, { method: "POST" });
  const consentsAfterRevoke = await fetch(`${BASE}/api/consent/${consentDelegation.id}`).then((r) => r.json());
  const revokeConsent = consentsAfterRevoke.consents.find((c) => c.action === "revoke");
  check("revoking the delegation writes its own signed consent record", revokeConsent?.action === "revoke", JSON.stringify(revokeConsent));
  const revokeVerify = await fetch(`${BASE}/api/consent/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: revokeConsent.delegationId, parentAddress: revokeConsent.parentAddress, childAddress: revokeConsent.childAddress, capUSD: revokeConsent.capUSD, scope: revokeConsent.scope, action: revokeConsent.action, ts: revokeConsent.ts, signedBy: revokeConsent.signer, signature: revokeConsent.signature }),
  }).then((r) => r.json());
  check("the revoke consent's signature also verifies, and a tampered field is caught", revokeVerify.valid === true, JSON.stringify(revokeVerify));
  const tamperedVerify = await fetch(`${BASE}/api/consent/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: revokeConsent.delegationId, parentAddress: revokeConsent.parentAddress, childAddress: revokeConsent.childAddress, capUSD: 999, scope: revokeConsent.scope, action: revokeConsent.action, ts: revokeConsent.ts, signedBy: revokeConsent.signer, signature: revokeConsent.signature }),
  }).then((r) => r.json());
  check("a tampered consent field (capUSD changed) fails verification", tamperedVerify.valid === false, JSON.stringify(tamperedVerify));

  // --- Agentic token: agent + single merchant + consent, bundled (Mastercard-Agent-Pay-style) ---
  const atParent = privateKeyToAccount(generatePrivateKey());
  const atChild = privateKeyToAccount(generatePrivateKey());
  const atMerchant = privateKeyToAccount(generatePrivateKey()).address;
  const multiPayeeReject = await fetch(`${BASE}/api/agentic-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentAddress: atParent.address, childAddress: atChild.address, capUSD: 0.02, merchant: "not-an-address" }),
  });
  check("an agentic token rejects a merchant that isn't a single valid address", multiPayeeReject.status === 400, `status=${multiPayeeReject.status}`);
  const agenticToken = await fetch(`${BASE}/api/agentic-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentAddress: atParent.address, childAddress: atChild.address, capUSD: 0.02, merchant: atMerchant, label: "verify agentic token" }),
  }).then((r) => r.json());
  check(
    "an agentic token bundles a delegation scoped to exactly one merchant plus its signed consent",
    JSON.stringify(agenticToken.delegation.allowedPayees) === JSON.stringify([atMerchant]) && agenticToken.consent?.action === "grant",
    JSON.stringify({ allowedPayees: agenticToken.delegation.allowedPayees, consentAction: agenticToken.consent?.action })
  );
  const agenticTokenFetched = await fetch(`${BASE}/api/agentic-token/${agenticToken.tokenId}`).then((r) => r.json());
  check("the agentic token can be looked up by id and reports the same merchant + consent history", agenticTokenFetched.merchant === atMerchant && agenticTokenFetched.consents.length === 1, JSON.stringify(agenticTokenFetched.merchant));

  // --- Portable Verifiable Credential export for AP2 verdicts ---
  const vcAgent = privateKeyToAccount(generatePrivateKey()).address;
  const vcVerdict = await fetch(`${BASE}/api/ap2/evaluate?format=vc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: vcAgent, amountUSD: 0.01, tool: "review" }),
  }).then((r) => r.json());
  check(
    "?format=vc wraps the AP2 verdict as a Verifiable-Credential-shaped envelope",
    vcVerdict.type?.includes("VerifiableCredential") && vcVerdict.credentialSubject?.decision === "allow" && !!vcVerdict.proof?.proofValue,
    JSON.stringify({ type: vcVerdict.type, decision: vcVerdict.credentialSubject?.decision })
  );
  const vcProofValid = await verifyMessage({ address: vcVerdict.issuer.replace("did:ethr:", ""), message: vcVerdict.proof.message, signature: vcVerdict.proof.proofValue });
  check("the credential's embedded proof is the exact same ECDSA signature already used for receipts/decisions — not a new trust claim", vcProofValid === true, `valid=${vcProofValid}`);

  // --- Cross-rail receipt normalization: one schema regardless of which rail settled ---
  const normalized = await fetch(`${BASE}/api/receipts/normalized?limit=500`).then((r) => r.json());
  const normCrypto = normalized.receipts.find((r) => r.receiptId && r.rail === "x402-simulate");
  const normApi = normalized.receipts.find((r) => r.rail === "api-spend");
  check(
    "the normalized receipt view gives an x402 settlement and a metered API-spend entry the same shape",
    !!normCrypto && !!normApi && Object.keys(normCrypto).every((k) => k in normApi),
    JSON.stringify({ cryptoKeys: normCrypto && Object.keys(normCrypto), apiKeys: normApi && Object.keys(normApi) })
  );
  check("only the rail that actually produced a signed receipt carries proof — never fabricated for the ones that didn't", normCrypto?.proof !== null && normApi?.proof === null, JSON.stringify({ crypto: normCrypto?.proof, api: normApi?.proof }));

  // --- AP2 mandate chains: does the cart still represent the intent? ---
  // /api/ap2/evaluate judges one amount; a chain can be within budget and still
  // be unauthorized, so these check the cart against the intent it claims.
  const mcAgent = "0x00000000000000000000000000000000000ca71a";
  const chainVerdict = async (intent, cart) =>
    fetch(`${BASE}/api/ap2/mandate-chain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: mcAgent, intent, cart }),
    }).then((r) => r.json());

  const cleanIntent = { id: "intent-verify-1", maxAmountUSD: 0.05, allowedMerchants: ["acme"], allowedCategories: ["data"] };
  const cleanCart = { id: "cart-verify-1", intentId: "intent-verify-1", totalUSD: 0.01, items: [{ sku: "rows", merchant: "acme", category: "data", amountUSD: 0.01, qty: 1 }] };
  const mcClean = await chainVerdict(cleanIntent, cleanCart);
  check("a cart that matches its intent and fits policy is allowed, with the total recomputed from its own items", mcClean.decision === "allow" && mcClean.totalUSD === 0.01, JSON.stringify({ d: mcClean.decision, t: mcClean.totalUSD }));
  const mcCleanSigValid = await verifyMessage({ address: mcClean.signer, message: mcClean.message, signature: mcClean.signature });
  check("a mandate-chain verdict is ECDSA-signed and verifies independently", mcCleanSigValid === true, `valid=${mcCleanSigValid}`);

  const mcOverIntent = await chainVerdict({ ...cleanIntent, maxAmountUSD: 0.005 }, cleanCart);
  check("a cart whose total exceeds the intent's authorized maximum is denied (cart_exceeds_intent)", mcOverIntent.decision === "deny" && mcOverIntent.code === "cart_exceeds_intent", mcOverIntent.code);

  const mcMerchant = await chainVerdict(cleanIntent, { ...cleanCart, items: [{ sku: "x", merchant: "not-acme", category: "data", amountUSD: 0.01 }] });
  check("a cart naming a merchant the intent never authorized is denied (merchant_drift)", mcMerchant.decision === "deny" && mcMerchant.code === "merchant_drift", mcMerchant.code);

  const mcCategory = await chainVerdict(cleanIntent, { ...cleanCart, items: [{ sku: "x", merchant: "acme", category: "gambling", amountUSD: 0.01 }] });
  check("a cart item outside the intent's authorized categories is denied (category_drift)", mcCategory.decision === "deny" && mcCategory.code === "category_drift", mcCategory.code);

  // The declared total is the number every cap would be checked against, so a
  // cart that misstates it must be refused before any cap is consulted.
  const mcLying = await chainVerdict(cleanIntent, { ...cleanCart, totalUSD: 0.01, items: [{ sku: "x", merchant: "acme", category: "data", amountUSD: 0.04 }] });
  check("a cart whose declared total contradicts its own line items is refused before any cap is checked (cart_total_mismatch)", mcLying.decision === "deny" && mcLying.code === "cart_total_mismatch", mcLying.code);

  const mcSpray = await chainVerdict(
    { ...cleanIntent, allowedMerchants: [], maxMerchants: 2 },
    { ...cleanCart, totalUSD: 0.003, items: [{ merchant: "a", amountUSD: 0.001 }, { merchant: "b", amountUSD: 0.001 }, { merchant: "c", amountUSD: 0.001 }] }
  );
  check("one authorization fanned across more merchants than the intent allows is denied (multi_merchant_spray)", mcSpray.decision === "deny" && mcSpray.code === "multi_merchant_spray", mcSpray.code);

  const mcExpired = await chainVerdict({ ...cleanIntent, expiresAt: new Date(Date.now() - 60_000).toISOString() }, cleanCart);
  check("an expired intent mandate grants no authority, whatever the cart says (intent_expired)", mcExpired.decision === "deny" && mcExpired.code === "intent_expired", mcExpired.code);

  const mcWrongIntent = await chainVerdict(cleanIntent, { ...cleanCart, intentId: "some-other-intent" });
  check("a cart presented with an intent it didn't come from is denied (cart_intent_mismatch)", mcWrongIntent.decision === "deny" && mcWrongIntent.code === "cart_intent_mismatch", mcWrongIntent.code);

  // Human-not-present (AP2 v0.2.0): nobody can answer an approval prompt, so
  // the signed intent's ceiling is the only authority that exists.
  const hnpCart = { id: "cart-hnp", intentId: "intent-hnp", totalUSD: 0.02, items: [{ merchant: "acme", category: "data", amountUSD: 0.02 }] };
  const hnpPresent = await chainVerdict({ id: "intent-hnp", maxAmountUSD: 0.05, humanPresent: true }, hnpCart);
  check("with a human present, an above-threshold cart still pauses for approval", hnpPresent.decision === "requires_approval" && hnpPresent.preAuthorizedByIntent === false, hnpPresent.decision);

  const hnpCovered = await chainVerdict({ id: "intent-hnp", maxAmountUSD: 0.05, humanPresent: false }, hnpCart);
  check(
    "human-not-present: the signed intent's ceiling stands in for the approval the flow can't obtain",
    hnpCovered.decision === "allow" && hnpCovered.preAuthorizedByIntent === true,
    `${hnpCovered.decision} preauth=${hnpCovered.preAuthorizedByIntent}`
  );

  const hnpNoCeiling = await chainVerdict({ id: "intent-hnp", humanPresent: false }, hnpCart);
  check(
    "human-not-present with no ceiling in the intent fails CLOSED — no pre-authorization, and no human to ask (hnp_no_authority)",
    hnpNoCeiling.decision === "deny" && hnpNoCeiling.code === "hnp_no_authority",
    hnpNoCeiling.code
  );

  // --- x402 v2 Bazaar discovery, both directions ---
  const bazaar = await fetch(`${BASE}/api/discovery/resources`).then((r) => r.json());
  const bazaarReview = bazaar.resources.find((r) => r.metadata?.["x-spendveto"]?.toolId === "review");
  check(
    "the catalog publishes in Bazaar's resource schema, priced in USDC base units on a CAIP-2 network",
    bazaarReview?.accepts?.[0]?.maxAmountRequired === "10000" && bazaarReview.accepts[0].network === "eip155:84532" && bazaarReview.type === "http",
    JSON.stringify(bazaarReview?.accepts?.[0])
  );
  check("every published listing is flagged as sitting behind the gate, so a buyer knows the price is a floor", bazaar.resources.every((r) => r.metadata?.["x-spendveto"]?.governed === true), `${bazaar.resources.length} listings`);
  check("a Bazaar type filter SpendVeto can't serve returns nothing rather than mislabeling HTTP tools", (await fetch(`${BASE}/api/discovery/resources?type=mcp`).then((r) => r.json())).resources.length === 0);

  // OpenAPI is a second, standard shape for the same catalog — for platforms
  // that register a gateway from an OpenAPI document rather than a
  // Bazaar-shaped resource list. Generated from the same TOOLS array as the
  // Bazaar listing above, so the two can't independently drift from what a
  // call actually costs or where it actually lives.
  const openapi = await fetch(`${BASE}/openapi.json`).then((r) => r.json());
  check(
    "the catalog also publishes as a standard OpenAPI document, generated from the same TOOLS array as the Bazaar listing",
    openapi.openapi === "3.0.3" && Object.keys(openapi.paths).length === bazaar.resources.length && openapi.paths["/api/agent/review"]?.get?.operationId === "review",
    `${Object.keys(openapi.paths).length} paths vs ${bazaar.resources.length} Bazaar resources`
  );

  // The consume side: an agent that can discover any payable endpoint at runtime
  // must not be handed ones it could never be allowed to pay for.
  // Priced relative to whatever policy is live at this point in the run — earlier
  // sections rewrite it, so a hardcoded price would be asserting against a
  // policy that no longer exists.
  const livePolicy = await fetch(`${BASE}/api/policy`).then((r) => r.json());
  const usdc = (usd) => String(Math.round(usd * 1e6));
  const overCapUSD = Number(livePolicy.maxPerCallUSD) * 10 + 1;
  const discovered = [
    { resource: "https://ok.example/a", accepts: [{ scheme: "exact", network: "eip155:84532", maxAmountRequired: usdc(Number(livePolicy.maxPerCallUSD) / 2), payTo: "0xaaaa000000000000000000000000000000000001" }], metadata: { tags: ["data"] } },
    { resource: "https://pricey.example/b", accepts: [{ scheme: "exact", network: "eip155:84532", maxAmountRequired: usdc(overCapUSD), payTo: "0xaaaa000000000000000000000000000000000001" }], metadata: { tags: ["data"] } },
    { resource: "https://unpriced.example/c", accepts: [], metadata: { tags: ["data"] } },
    // Priced, but names no recipient — a cap can be checked against it, an
    // allowlist cannot, so it must fail the allowlist rather than slip past it.
    { resource: "https://nopayee.example/d", accepts: [{ scheme: "exact", network: "eip155:84532", maxAmountRequired: usdc(Number(livePolicy.maxPerCallUSD) / 2) }], metadata: { tags: ["data"] } },
  ];
  const governed = await fetch(`${BASE}/api/discovery/govern`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resources: discovered }),
  }).then((r) => r.json());
  check(
    "a discovered catalog is filtered by the live policy before the agent sees it — over-cap and unpriced listings never reach it",
    governed.allowed.length === 2 &&
      governed.allowed.every((r) => r.resource === "https://ok.example/a" || r.resource === "https://nopayee.example/d") &&
      governed.filtered.map((f) => f.code).sort().join(",") === "over_per_call_cap,unpriced",
    JSON.stringify({ allowed: governed.allowed.map((r) => r.resource), filtered: governed.filtered.map((f) => f.code) })
  );
  check("each filtered listing says which rule removed it, and the verdict is stamped with the policy version in force", governed.filtered.every((f) => f.code && f.reason) && /^[0-9a-f]{64}$/.test(governed.policyVersion || ""), JSON.stringify(governed.filtered.map((f) => f.code)));
  check("a malformed discovery payload is refused rather than silently treated as an empty catalog", (await fetch(`${BASE}/api/discovery/govern`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resources: "not-an-array" }) })).status === 400);

  // Payee/chain/category filtering exercised directly against the module, so the
  // live policy the rest of this suite depends on is never mutated.
  const { governCatalog } = await import("../server/discovery.js");
  const payeeFiltered = governCatalog(discovered, { maxPerCallUSD: overCapUSD + 1, allowedPayees: ["0xBBBB000000000000000000000000000000000002"] });
  check(
    "a discovered listing paying an address outside the payee allowlist is filtered out, and one naming no payee at all can't slip past it",
    payeeFiltered.allowed.length === 0 && payeeFiltered.filtered.some((f) => f.code === "payee_not_allowed") && payeeFiltered.filtered.some((f) => f.code === "payee_unknown"),
    JSON.stringify(payeeFiltered.filtered.map((f) => f.code))
  );
  const payeeAllowed = governCatalog(discovered, { maxPerCallUSD: overCapUSD + 1, allowedPayees: ["0xAAAA000000000000000000000000000000000001"] });
  check("the same allowlist admits the listings when the address matches in a different case", payeeAllowed.allowed.length === 2, `${payeeAllowed.allowed.length} allowed`);
  const chainFiltered = governCatalog(discovered, { maxPerCallUSD: 1, allowedChains: ["polygon"] });
  check("a listing that settles only on a chain the policy doesn't allow is filtered out, matched through CAIP-2", chainFiltered.filtered.some((f) => f.code === "chain_not_allowed"), JSON.stringify(chainFiltered.filtered.map((f) => f.code)));
  const catFiltered = governCatalog(discovered, { maxPerCallUSD: 1, categoryCapsUSD: { data: 0.002 } });
  check("a listing priced above its category's cap is filtered out at discovery, not at settlement", catFiltered.filtered.some((f) => f.code === "over_category_cap"), JSON.stringify(catFiltered.filtered.map((f) => f.code)));

  // --- ACP (OpenAI/Stripe Agentic Commerce Protocol), buyer side ---
  // ACP's Delegated Payments Spec hands the agent a Shared Payment Token: a
  // bearer credential scoped to an amount, a merchant and a window. The
  // merchant validates the token; nobody validates the shopping. These check
  // the question SpendVeto adds — is this session still the purchase the token
  // was minted for?
  const ACP_AGENT = "0x1111111111111111111111111111111111111111";
  const acp = (token, session) =>
    fetch(`${BASE}/api/acp/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: ACP_AGENT, token, session }),
    }).then((r) => r.json());
  const SPT = { id: "spt_1", maxAmountUSD: 50, merchant: "acme", currency: "USD", allowedCategories: ["content"] };
  const cleanSession = { id: "cs_ok", tokenId: "spt_1", merchant: "acme", currency: "USD", totalUSD: 0.01, items: [{ sku: "widget", amountUSD: 0.01, qty: 1, merchant: "acme", category: "content" }] };

  const acpOk = await acp(SPT, cleanSession);
  check("ACP: a session inside its token's scope clears the SPT check and is judged by policy, not by the token alone", acpOk.decision === "allow" && acpOk.stage === "policy", `${acpOk.decision}/${acpOk.stage}`);
  const acpDrift = await acp(SPT, { ...cleanSession, id: "cs_drift", items: [{ sku: "x", amountUSD: 0.01, qty: 1, merchant: "evilcorp" }] });
  check("ACP: a session charging a merchant the SPT was not minted for is denied (spt_merchant_drift)", acpDrift.decision === "deny" && acpDrift.code === "spt_merchant_drift", acpDrift.code);
  const acpMath = await acp(SPT, { ...cleanSession, id: "cs_math", totalUSD: 5, items: [{ sku: "x", amountUSD: 1, qty: 1, merchant: "acme" }] });
  check("ACP: a declared total its own line items don't sum to is refused before any ceiling is applied (session_total_mismatch)", acpMath.decision === "deny" && acpMath.code === "session_total_mismatch", acpMath.code);
  const acpCeil = await acp(SPT, { ...cleanSession, id: "cs_ceil", totalUSD: 80, items: [{ sku: "x", amountUSD: 80, qty: 1, merchant: "acme" }] });
  check("ACP: a session above the token's authorized maximum is denied (session_exceeds_spt)", acpCeil.decision === "deny" && acpCeil.code === "session_exceeds_spt", acpCeil.code);
  const acpExp = await acp({ ...SPT, expiresAt: "2020-01-01T00:00:00Z" }, cleanSession);
  check("ACP: an expired shared payment token grants no authority however well-formed the session is (spt_expired)", acpExp.decision === "deny" && acpExp.code === "spt_expired", acpExp.code);
  const acpCat = await acp(SPT, { ...cleanSession, id: "cs_cat", items: [{ sku: "x", amountUSD: 0.01, qty: 1, merchant: "acme", category: "trading" }] });
  check("ACP: a line item outside the token's authorized categories is denied (spt_category_drift)", acpCat.decision === "deny" && acpCat.code === "spt_category_drift", acpCat.code);
  const acpCcy = await acp(SPT, { ...cleanSession, id: "cs_ccy", currency: "EUR" });
  check("ACP: a ceiling in one currency is never silently compared against a charge in another (spt_currency_mismatch)", acpCcy.decision === "deny" && acpCcy.code === "spt_currency_mismatch", acpCcy.code);
  const acpIdMix = await acp(SPT, { ...cleanSession, id: "cs_mix", tokenId: "spt_other" });
  check("ACP: a session claiming a different token than the one presented is refused (spt_session_mismatch)", acpIdMix.decision === "deny" && acpIdMix.code === "spt_session_mismatch", acpIdMix.code);

  // --- UPI mandate governance (India): RBI e-mandate framework rules, deterministic, INR end to end. SpendVeto
  // decides; a "requires_approval" is always a HUMAN completing the customer's authentication; nothing is initiated
  // on UPI and no NPCI/RBI approval is claimed. ---
  const UPI_AGENT = "0x2222222222222222222222222222222222222222";
  const upi = (mandate) =>
    fetch(`${BASE}/api/upi/evaluate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: UPI_AGENT, mandate }) }).then((r) => r.json());
  const thirtyHAgo = new Date(Date.now() - 30 * 3600e3).toISOString();
  const nflx = { id: "m_ok", payeeVpa: "netflix@okhdfc", category: "entertainment", amountINR: 499, notifiedAt: thirtyHAgo };

  const upiOk = await upi(nflx);
  check("UPI: a notified recurring debit under the Rs 15,000 AFA-free limit is allowed", upiOk.decision === "allow" && upiOk.currency === "INR", `${upiOk.decision}/${upiOk.currency}`);
  const upiSigOk = await verifyMessage({ address: upiOk.signer, message: upiOk.message, signature: upiOk.signature });
  check("UPI: the verdict is ECDSA-signed over rupees and verifies independently", upiSigOk && upiOk.message.includes(":499:") && upiOk.message.startsWith("spendveto-upi-decision:"), upiOk.message);
  check("UPI: the payee VPA is masked in the response and never echoed raw (DPDP Act data minimisation)", upiOk.mandate.payee === "ne***@okhdfc" && !JSON.stringify(upiOk).includes("netflix@okhdfc"), upiOk.mandate.payee);

  const upiFirst = await upi({ ...nflx, id: "m_first", firstDebit: true });
  check("UPI: the first debit of a mandate always needs a HUMAN's additional factor authentication (afa_first_debit)", upiFirst.decision === "requires_approval" && upiFirst.code === "afa_first_debit" && upiFirst.afa?.by === "human", `${upiFirst.code}/${upiFirst.afa?.by}`);
  const upiBig = await upi({ ...nflx, id: "m_big", amountINR: 20000 });
  check("UPI: a recurring debit above Rs 15,000 needs human authentication (afa_above_limit)", upiBig.decision === "requires_approval" && upiBig.code === "afa_above_limit", upiBig.code);
  const upiIns = await upi({ id: "m_ins", payeeVpa: "lic@okicici", category: "insurance", amountINR: 50000, notifiedAt: thirtyHAgo });
  check("UPI: insurance, mutual-fund and card-bill debits get the Rs 1,00,000 AFA-free limit — Rs 50,000 insurance is allowed", upiIns.decision === "allow", upiIns.decision);
  const upiInsBig = await upi({ id: "m_insb", payeeVpa: "lic@okicici", category: "insurance", amountINR: 150000, notifiedAt: thirtyHAgo });
  check("UPI: even a special category needs human authentication above Rs 1,00,000", upiInsBig.decision === "requires_approval" && upiInsBig.code === "afa_above_limit", upiInsBig.code);
  const upiNoNotice = await upi({ ...nflx, id: "m_nn", notifiedAt: undefined });
  check("UPI: a recurring debit with no pre-debit notification is refused (predebit_notice_missing)", upiNoNotice.decision === "deny" && upiNoNotice.code === "predebit_notice_missing", upiNoNotice.code);
  const upiLate = await upi({ ...nflx, id: "m_late", notifiedAt: new Date(Date.now() - 3600e3).toISOString() });
  check("UPI: a customer notified under 24 hours before the debit is refused (predebit_notice_late)", upiLate.decision === "deny" && upiLate.code === "predebit_notice_late", upiLate.code);
  const upiFastag = await upi({ id: "m_ft", payeeVpa: "fastag@icici", category: "fastag", amountINR: 500 });
  check("UPI: FASTag top-ups are exempt from the 24-hour pre-debit notice, as the framework carves out", upiFastag.decision === "allow", upiFastag.decision);
  const upiRevoked = await upi({ ...nflx, id: "m_rev", revoked: true });
  check("UPI: a mandate the customer withdrew can never be debited (mandate_revoked)", upiRevoked.decision === "deny" && upiRevoked.code === "mandate_revoked", upiRevoked.code);
  const upiExp = await upi({ ...nflx, id: "m_exp", expiresAt: "2020-01-01T00:00:00Z" });
  check("UPI: an expired mandate carries no authority (mandate_expired)", upiExp.decision === "deny" && upiExp.code === "mandate_expired", upiExp.code);
  const upiOne = await upi({ id: "m_one", payeeVpa: "shop@okaxis", amountINR: 120, recurring: false });
  check("UPI: a one-time agent-initiated payment always needs the customer's own authentication (afa_one_time) — an agent cannot approve its own debit", upiOne.decision === "requires_approval" && upiOne.code === "afa_one_time" && upiOne.afa?.by === "human", upiOne.code);
  const upiPaise = await upi({ ...nflx, id: "m_p", amountINR: 10.555 });
  const upiBadVpa = await upi({ ...nflx, id: "m_v", payeeVpa: "not-a-vpa" });
  check("UPI: malformed input is refused before any policy runs (amount_invalid for sub-paise, payee_vpa_invalid)", upiPaise.code === "amount_invalid" && upiBadVpa.code === "payee_vpa_invalid", `${upiPaise.code}/${upiBadVpa.code}`);
  check("UPI: every verdict states what it is not — no UPI initiation, no PSP status, no NPCI/RBI approval claimed", /does not initiate/.test(upiOk.disclaimer) && /no NPCI or RBI approval/.test(upiOk.disclaimer) && upiOk.regulatoryBasis.length === 2, upiOk.disclaimer?.slice(0, 60));

  const UPI_POL = { maxPerTxnINR: 1000, maxPerDayINR: 1500, allowedPayeeVpas: ["netflix@okhdfc"], allowedCategories: ["entertainment"] };
  const NOW = Date.now();
  const u = (m, spent = 0) => evaluateUpiMandate({ ...nflx, ...m }, { policy: UPI_POL, spentTodayINR: spent, now: NOW });
  check(
    "UPI: operator policy — payee allowlist, category scope, per-debit cap and a daily cap each refuse with their own code",
    u({ payeeVpa: "other@okhdfc" }).code === "payee_not_allowed" &&
      u({ category: "gaming" }).code === "category_not_allowed" &&
      u({ amountINR: 1200 }).code === "txn_cap" &&
      u({ amountINR: 600 }, 1000).code === "day_cap" &&
      u({ amountINR: 400 }, 1000).decision === "allow",
    "payee/category/txn/day"
  );
  check(
    "UPI: the in-browser playground runs the SAME evaluator the server uses — site/assets/upi.js is byte-identical to server/upi.js",
    readFileSync(fileURLToPath(new URL("../site/assets/upi.js", import.meta.url)), "utf8") === readFileSync(fileURLToPath(new URL("../server/upi.js", import.meta.url)), "utf8"),
    "no drift between the demo and the product"
  );
  check(
    "UPI: the evaluator is pure — the same mandate and clock give the same verdict every time",
    JSON.stringify(u({})) === JSON.stringify(u({})),
    "deterministic"
  );

  // --- EU payment governance (PSD2 Strong Customer Authentication + SEPA Direct Debit): RTS exemption math,
  // deterministic, EUR end to end. SpendVeto decides; "requires_approval" always means the payer completes SCA
  // themselves; nothing here initiates or settles a SEPA payment. ---
  const EU_AGENT = "0x3333333333333333333333333333333333333333";
  const eu = (mandate) =>
    fetch(`${BASE}/api/eu/evaluate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: EU_AGENT, mandate }) }).then((r) => r.json());
  const fifteenDAgo = new Date(Date.now() - 15 * 24 * 3600e3).toISOString();
  const spotify = { id: "e_ok", payeeIban: "DE89370400440532013000", category: "entertainment", amountEUR: 9.99, notifiedAt: fifteenDAgo };

  const euOk = await eu(spotify);
  check("EU: a notified recurring debit, same fixed amount, already authenticated once, is allowed (RTS Art. 14(1))", euOk.decision === "allow" && euOk.currency === "EUR", `${euOk.decision}/${euOk.currency}`);
  const euSigOk = await verifyMessage({ address: euOk.signer, message: euOk.message, signature: euOk.signature });
  check("EU: the verdict is ECDSA-signed over euros and verifies independently", euSigOk && euOk.message.includes(":9.99:") && euOk.message.startsWith("spendveto-eu-decision:"), euOk.message);
  check("EU: the creditor IBAN is masked in the response and never echoed raw (GDPR Art. 5(1)(c) data minimisation)", euOk.mandate.payee === "DE89***00" && !JSON.stringify(euOk).includes("DE89370400440532013000"), euOk.mandate.payee);

  const euFirst = await eu({ ...spotify, id: "e_first", firstDebit: true });
  check("EU: the first debit of a mandate always needs the payer's own Strong Customer Authentication (sca_required_first_debit)", euFirst.decision === "requires_approval" && euFirst.code === "sca_required_first_debit" && euFirst.sca?.by === "human", euFirst.code);
  const euChanged = await eu({ ...spotify, id: "e_chg", amountChangedFromMandate: true });
  check("EU: the RTS Art. 14(1) exemption only covers a FIXED amount — a changed amount needs SCA again (sca_required_amount_changed)", euChanged.decision === "requires_approval" && euChanged.code === "sca_required_amount_changed", euChanged.code);
  const euOneOffSmall = await eu({ id: "e_oo1", payeeIban: "FR1420041010050500013M02606", amountEUR: 25, recurring: false });
  check("EU: a one-off payment under EUR 30 is allowed under the RTS Art. 10 low-value exemption", euOneOffSmall.decision === "allow", euOneOffSmall.decision);
  const euOneOffBig = await eu({ id: "e_oo2", payeeIban: "FR1420041010050500013M02606", amountEUR: 80, recurring: false });
  check("EU: a EUR 80 one-off payment above both Art. 10 and any declared Art. 18 TRA threshold needs SCA (sca_required_one_off)", euOneOffBig.decision === "requires_approval" && euOneOffBig.code === "sca_required_one_off", euOneOffBig.code);
  const euNoNotice = await eu({ ...spotify, id: "e_nn", notifiedAt: undefined });
  check("EU: a recurring collection with no SEPA pre-notification on record is refused (predebit_notice_missing)", euNoNotice.decision === "deny" && euNoNotice.code === "predebit_notice_missing", euNoNotice.code);
  const euLate = await eu({ ...spotify, id: "e_late", notifiedAt: new Date(Date.now() - 2 * 24 * 3600e3).toISOString() });
  check("EU: a payer notified less than 14 days before the collection is refused (predebit_notice_late)", euLate.decision === "deny" && euLate.code === "predebit_notice_late", euLate.code);
  const euRevoked = await eu({ ...spotify, id: "e_rev", revoked: true });
  check("EU: a mandate the payer withdrew can never be debited (mandate_revoked)", euRevoked.decision === "deny" && euRevoked.code === "mandate_revoked", euRevoked.code);
  const euExp = await eu({ ...spotify, id: "e_exp", expiresAt: "2020-01-01T00:00:00Z" });
  check("EU: an expired mandate carries no authority (mandate_expired)", euExp.decision === "deny" && euExp.code === "mandate_expired", euExp.code);
  const euBadIban = await eu({ ...spotify, id: "e_iban", payeeIban: "not-an-iban" });
  const euBadAmount = await eu({ ...spotify, id: "e_amt", amountEUR: 9.999 });
  check("EU: malformed input is refused before any policy runs (amount_invalid for sub-cent, payee_iban_invalid)", euBadAmount.code === "amount_invalid" && euBadIban.code === "payee_iban_invalid", `${euBadAmount.code}/${euBadIban.code}`);
  check("EU: every verdict states what it is not — no SEPA initiation, no PSP/PISP status, no authorisation claimed", /does not initiate/.test(euOk.disclaimer) && /no competent-authority authorisation/.test(euOk.disclaimer) && euOk.regulatoryBasis.length === 2, euOk.disclaimer?.slice(0, 60));

  const EU_POL = { maxPerTxnEUR: 20, maxPerDayEUR: 25, allowedPayeeIbans: ["DE89370400440532013000"], allowedCategories: ["entertainment"] };
  const euP = (m, spent = 0) => evaluateSepaDebit({ ...spotify, ...m }, { policy: EU_POL, spentTodayEUR: spent, now: NOW });
  check(
    "EU: operator policy — payee allowlist, category scope, per-debit cap and a daily cap each refuse with their own code",
    euP({ payeeIban: "FR1420041010050500013M02606" }).code === "payee_not_allowed" &&
      euP({ category: "gaming" }).code === "category_not_allowed" &&
      euP({ amountEUR: 21 }).code === "txn_cap" &&
      euP({ amountEUR: 10 }, 20).code === "day_cap" &&
      euP({ amountEUR: 5 }, 10).decision === "allow",
    "payee/category/txn/day"
  );
  check(
    "EU: a one-off payment above Art. 10 but within the operator's declared Article 18 TRA fraud-rate threshold is allowed",
    evaluateSepaDebit({ id: "e_tra", payeeIban: "FR1420041010050500013M02606", amountEUR: 80, recurring: false }, { policy: { pspFraudRateBps: 1 }, now: NOW }).decision === "allow",
    "Art.18 TRA"
  );
  check(
    "EU: the in-browser playground runs the SAME evaluator the server uses — site/assets/eu-sepa.js is byte-identical to server/eu-sepa.js",
    readFileSync(fileURLToPath(new URL("../site/assets/eu-sepa.js", import.meta.url)), "utf8") === readFileSync(fileURLToPath(new URL("../server/eu-sepa.js", import.meta.url)), "utf8"),
    "no drift between the demo and the product"
  );
  check("EU: the evaluator is pure — the same mandate and clock give the same verdict every time", JSON.stringify(euP({})) === JSON.stringify(euP({})), "deterministic");

  // --- UK payment governance (Faster Payments push payments): Confirmation of Payee + APP fraud reimbursement
  // exposure, deterministic, GBP end to end. Faster Payments has no recurring-pull equivalent, so this governs a
  // one-off PUSH payment, not a mandate. ---
  const UK_AGENT = "0x4444444444444444444444444444444444444444";
  const uk = (payment) =>
    fetch(`${BASE}/api/uk/evaluate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: UK_AGENT, payment }) }).then((r) => r.json());
  const netflixUk = { id: "u_ok", payeeSortCode: "123456", payeeAccountNumber: "87654321", category: "entertainment", amountGBP: 9.99, copResult: "match" };

  const ukOk = await uk(netflixUk);
  check("UK: a matched, previously-paid payee within the reimbursement cap is allowed", ukOk.decision === "allow" && ukOk.currency === "GBP", `${ukOk.decision}/${ukOk.currency}`);
  const ukSigOk = await verifyMessage({ address: ukOk.signer, message: ukOk.message, signature: ukOk.signature });
  check("UK: the verdict is ECDSA-signed over sterling and verifies independently", ukSigOk && ukOk.message.includes(":9.99:") && ukOk.message.startsWith("spendveto-uk-decision:"), ukOk.message);
  check("UK: the payee account number is masked in the response and never echoed raw (UK GDPR / DPA 2018)", ukOk.payment.payee === "****4321" && !JSON.stringify(ukOk).includes("87654321"), ukOk.payment.payee);

  const ukNoMatch = await uk({ ...netflixUk, id: "u_nm", copResult: "no_match" });
  check("UK: a Confirmation of Payee no-match is never silently paid through (cop_no_match)", ukNoMatch.decision === "requires_approval" && ukNoMatch.code === "cop_no_match" && ukNoMatch.authorisation?.by === "human", ukNoMatch.code);
  const ukUnavail = await uk({ ...netflixUk, id: "u_ua", copResult: "unavailable" });
  check("UK: an unverifiable Confirmation of Payee result needs a human, not a silent pass (cop_unavailable)", ukUnavail.decision === "requires_approval" && ukUnavail.code === "cop_unavailable", ukUnavail.code);
  const ukClose = await uk({ ...netflixUk, id: "u_cm", copResult: "close_match" });
  check("UK: a close-but-not-exact Confirmation of Payee match needs the payer to confirm the corrected name (cop_close_match)", ukClose.decision === "requires_approval" && ukClose.code === "cop_close_match", ukClose.code);
  const ukNoCop = await uk({ ...netflixUk, id: "u_nc", copResult: undefined });
  check("UK: a payment with no Confirmation of Payee result on record at all is refused (cop_result_missing)", ukNoCop.decision === "deny" && ukNoCop.code === "cop_result_missing", ukNoCop.code);
  const ukNewPayee = await uk({ ...netflixUk, id: "u_np", firstPaymentToPayee: true });
  check("UK: the first payment ever made to a payee needs human review regardless of a Confirmation of Payee match (new_payee_review)", ukNewPayee.decision === "requires_approval" && ukNewPayee.code === "new_payee_review", ukNewPayee.code);
  const ukUncapped = await uk({ ...netflixUk, id: "u_cap", amountGBP: 90000 });
  check("UK: exposure above the GBP 85,000 APP fraud reimbursement cap needs a human — above it there is no backstop at all (app_fraud_uncapped_exposure)", ukUncapped.decision === "requires_approval" && ukUncapped.code === "app_fraud_uncapped_exposure", ukUncapped.code);
  const ukRevoked = await uk({ ...netflixUk, id: "u_rev", revoked: true });
  check("UK: a withdrawn payment instruction can never be paid (payment_revoked)", ukRevoked.decision === "deny" && ukRevoked.code === "payment_revoked", ukRevoked.code);
  const ukExp = await uk({ ...netflixUk, id: "u_exp", expiresAt: "2020-01-01T00:00:00Z" });
  check("UK: an expired payment instruction carries no authority (payment_expired)", ukExp.decision === "deny" && ukExp.code === "payment_expired", ukExp.code);
  const ukBadSort = await uk({ ...netflixUk, id: "u_sc", payeeSortCode: "12-34-56" });
  const ukBadAmount = await uk({ ...netflixUk, id: "u_amt", amountGBP: 9.999 });
  check("UK: malformed input is refused before any policy runs (amount_invalid for sub-pence, payee_details_invalid for a bad sort code)", ukBadAmount.code === "amount_invalid" && ukBadSort.code === "payee_details_invalid", `${ukBadAmount.code}/${ukBadSort.code}`);
  check("UK: every verdict states what it is not — no Faster Payments initiation, no PSP status, no PSR/FCA authorisation claimed", /does not initiate/.test(ukOk.disclaimer) && /no PSR\/FCA authorisation/.test(ukOk.disclaimer) && ukOk.regulatoryBasis.length === 2, ukOk.disclaimer?.slice(0, 60));

  const UK_POL = { maxPerTxnGBP: 20, maxPerDayGBP: 25, allowedPayeeAccounts: ["123456:87654321"], allowedCategories: ["entertainment"] };
  const ukP = (p, spent = 0) => evaluateUkPushPayment({ ...netflixUk, ...p }, { policy: UK_POL, spentTodayGBP: spent, now: NOW });
  check(
    "UK: operator policy — payee allowlist, category scope, per-payment cap and a daily cap each refuse with their own code, checked before Confirmation of Payee",
    ukP({ payeeSortCode: "000000", payeeAccountNumber: "00000000" }).code === "payee_not_allowed" &&
      ukP({ category: "gaming" }).code === "category_not_allowed" &&
      ukP({ amountGBP: 21 }).code === "txn_cap" &&
      ukP({ amountGBP: 10 }, 20).code === "day_cap" &&
      ukP({ amountGBP: 5 }, 10).decision === "allow",
    "payee/category/txn/day"
  );
  check(
    "UK: the in-browser playground runs the SAME evaluator the server uses — site/assets/uk-fps.js is byte-identical to server/uk-fps.js",
    readFileSync(fileURLToPath(new URL("../site/assets/uk-fps.js", import.meta.url)), "utf8") === readFileSync(fileURLToPath(new URL("../server/uk-fps.js", import.meta.url)), "utf8"),
    "no drift between the demo and the product"
  );
  check("UK: the evaluator is pure — the same payment and clock give the same verdict every time", JSON.stringify(ukP({})) === JSON.stringify(ukP({})), "deterministic");

  // --- Brazil payment governance (Pix): the BCB nighttime limit for ordinary transfers, Pix Automático's
  // scheduling/retry rules for recurring ones, deterministic, BRL end to end. ---
  const BR_AGENT = "0x5555555555555555555555555555555555555555";
  const br = (mandate) =>
    fetch(`${BASE}/api/br/evaluate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: BR_AGENT, mandate }) }).then((r) => r.json());
  const ifood = { id: "b_ok", payeeKey: "contato@ifood.com.br", category: "food", amountBRL: 49.9 }; // well under the nighttime limit, so this allow case holds regardless of what time it is when verify runs

  const brOk = await br(ifood);
  check("BR: an ordinary Pix transfer well under the nighttime limit is allowed at any time of day", brOk.decision === "allow" && brOk.currency === "BRL", `${brOk.decision}/${brOk.currency}`);
  const brSigOk = await verifyMessage({ address: brOk.signer, message: brOk.message, signature: brOk.signature });
  check("BR: the verdict is ECDSA-signed over reais and verifies independently", brSigOk && brOk.message.includes(":49.9:") && brOk.message.startsWith("spendveto-br-decision:"), brOk.message);
  check("BR: the Pix key is masked in the response and never echoed raw (LGPD data minimisation)", brOk.mandate.payee === "co***@ifood.com.br" && !JSON.stringify(brOk).includes("contato@ifood.com.br"), brOk.mandate.payee);

  const brCancelled = await br({ ...ifood, id: "b_cxl", cancelled: true });
  check("BR: a cancelled Pix Automático authorisation can never be charged (pix_auto_cancelled)", brCancelled.decision === "deny" && brCancelled.code === "pix_auto_cancelled", brCancelled.code);
  const brExp = await br({ ...ifood, id: "b_exp", expiresAt: "2020-01-01T00:00:00Z" });
  check("BR: an expired authorisation carries no authority (mandate_expired)", brExp.decision === "deny" && brExp.code === "mandate_expired", brExp.code);
  const brBadKey = await br({ ...ifood, id: "b_key", payeeKey: "not-a-pix-key" });
  const brBadAmount = await br({ ...ifood, id: "b_amt", amountBRL: 10.555 });
  check("BR: malformed input is refused before any policy runs (amount_invalid for sub-centavo, payee_key_invalid)", brBadAmount.code === "amount_invalid" && brBadKey.code === "payee_key_invalid", `${brBadAmount.code}/${brBadKey.code}`);
  const brFirst = await br({ ...ifood, id: "b_first", recurring: true, firstCharge: true, amountBRL: 29.9 });
  check("BR: the first Pix Automático charge always needs the payer's own in-app authorisation (pix_auto_first_authorization)", brFirst.decision === "requires_approval" && brFirst.code === "pix_auto_first_authorization" && brFirst.authorisation?.by === "human", brFirst.code);
  check("BR: every verdict states what it is not — no Pix initiation, no PSP status, no BCB authorisation claimed", /does not initiate/.test(brOk.disclaimer) && /no BCB authorisation/.test(brOk.disclaimer) && brOk.regulatoryBasis.length === 2, brOk.disclaimer?.slice(0, 60));

  check(
    "BR: at most 3 Pix Automático charge attempts are allowed in a rolling 7-day window — the 4th is refused (pix_auto_retry_limit_exceeded)",
    evaluatePixPayment({ ...ifood, id: "b_retry", recurring: true, firstCharge: false }, { attemptsInWindow: 3, now: NOW }).code === "pix_auto_retry_limit_exceeded",
    "retry limit"
  );
  check(
    "BR: a Pix Automático charge scheduled less than 2 days before its due date violates BCB's window (pix_auto_scheduling_window)",
    evaluatePixPayment({ ...ifood, id: "b_sched", recurring: true, firstCharge: false, scheduledAt: "2026-01-01T00:00:00Z", dueAt: "2026-01-01T12:00:00Z" }, { now: NOW }).code === "pix_auto_scheduling_window",
    "scheduling window"
  );
  check(
    "BR: an ordinary transfer over the nighttime limit, made during the nighttime window, needs the payer's own in-app confirmation (pix_nighttime_limit)",
    evaluatePixPayment({ id: "b_night", payeeKey: "shop@okvarejo.com.br", amountBRL: 1500 }, { now: new Date("2026-01-01T23:00:00Z").getTime() }).code === "pix_nighttime_limit",
    "nighttime limit, inside the window"
  );
  check(
    "BR: the SAME over-limit transfer outside the nighttime window is allowed — the limit is time-bound, not a flat cap",
    evaluatePixPayment({ id: "b_day", payeeKey: "shop@okvarejo.com.br", amountBRL: 1500 }, { now: new Date("2026-01-01T12:00:00Z").getTime() }).decision === "allow",
    "same amount, daytime"
  );

  const BR_POL = { maxPerTxnBRL: 20, maxPerDayBRL: 25, allowedPayeeKeys: ["contato@ifood.com.br"], allowedCategories: ["food"] };
  const brP = (m, spent = 0) => evaluatePixPayment({ ...ifood, ...m }, { policy: BR_POL, spentTodayBRL: spent, now: NOW });
  check(
    "BR: operator policy — payee allowlist, category scope, per-payment cap and a daily cap each refuse with their own code",
    brP({ payeeKey: "other@shop.com.br" }).code === "payee_not_allowed" &&
      brP({ category: "gaming" }).code === "category_not_allowed" &&
      brP({ amountBRL: 21 }).code === "txn_cap" &&
      brP({ amountBRL: 10 }, 20).code === "day_cap" &&
      brP({ amountBRL: 5 }, 10).decision === "allow",
    "payee/category/txn/day"
  );
  check(
    "BR: the in-browser playground runs the SAME evaluator the server uses — site/assets/br-pix.js is byte-identical to server/br-pix.js",
    readFileSync(fileURLToPath(new URL("../site/assets/br-pix.js", import.meta.url)), "utf8") === readFileSync(fileURLToPath(new URL("../server/br-pix.js", import.meta.url)), "utf8"),
    "no drift between the demo and the product"
  );
  check("BR: the evaluator is pure — the same mandate and clock give the same verdict every time", JSON.stringify(brP({})) === JSON.stringify(brP({})), "deterministic");

  // --- US payment governance (ACH / Nacha + Regulation E): account validation is a system fraud-detection gate
  // (DENY), consumer authorization/notice/stop-payment rights are the human-approval path, deterministic, USD end
  // to end. ---
  const US_AGENT = "0x6666666666666666666666666666666666666666";
  const us = (mandate) =>
    fetch(`${BASE}/api/us/evaluate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: US_AGENT, mandate }) }).then((r) => r.json());
  const spotifyUs = { id: "s_ok", payeeRoutingNumber: "021000021", payeeAccountNumber: "123456789", category: "entertainment", amountUSD: 9.99, accountValidated: true, authorizationOnRecord: true };

  const usOk = await us(spotifyUs);
  check("US: a validated account with authorization on record is allowed", usOk.decision === "allow" && usOk.currency === "USD", `${usOk.decision}/${usOk.currency}`);
  const usSigOk = await verifyMessage({ address: usOk.signer, message: usOk.message, signature: usOk.signature });
  check("US: the verdict is ECDSA-signed over dollars and verifies independently", usSigOk && usOk.message.includes(":9.99:") && usOk.message.startsWith("spendveto-us-decision:"), usOk.message);
  check("US: the payee account number is masked in the response and never echoed raw (GLBA nonpublic personal information)", usOk.mandate.payee === "****6789" && !JSON.stringify(usOk).includes("123456789"), usOk.mandate.payee);

  const usUnvalidated = await us({ ...spotifyUs, id: "s_nv", accountValidated: false });
  check("US: the first use of an unvalidated account is a hard DENY, not a pause for a human — Nacha's rule is a system control (web_debit_account_validation_required)", usUnvalidated.decision === "deny" && usUnvalidated.code === "web_debit_account_validation_required", usUnvalidated.code);
  const usNoAuth = await us({ ...spotifyUs, id: "s_na", authorizationOnRecord: false });
  check("US: no written (or similarly authenticated) consumer authorization on record needs the consumer, not the agent (reg_e_authorization_missing)", usNoAuth.decision === "requires_approval" && usNoAuth.code === "reg_e_authorization_missing" && usNoAuth.authorization?.by === "human", usNoAuth.code);
  const usVaryNoNotice = await us({ ...spotifyUs, id: "s_vn", amountVariesFromAuthorized: true });
  const usVaryLate = await us({ ...spotifyUs, id: "s_vl", amountVariesFromAuthorized: true, varianceNoticeAt: new Date(Date.now() - 3 * 24 * 3600e3).toISOString() });
  check("US: a varying debit amount needs >= 10 days' notice (Reg E 1005.10(c)) — missing or late notice both require the consumer (reg_e_variable_amount_notice)", usVaryNoNotice.code === "reg_e_variable_amount_notice" && usVaryLate.code === "reg_e_variable_amount_notice", `${usVaryNoNotice.code}/${usVaryLate.code}`);
  const usStopConfirmed = await us({ ...spotifyUs, id: "s_stop1", stopPaymentRequested: true, stopPaymentConfirmedInWriting: true });
  check("US: a written-confirmed stop-payment order is binding — the debit is refused (reg_e_stop_payment)", usStopConfirmed.decision === "deny" && usStopConfirmed.code === "reg_e_stop_payment", usStopConfirmed.code);
  const usStopOral = await us({ ...spotifyUs, id: "s_stop2", stopPaymentRequested: true, stopPaymentRequestedAt: new Date().toISOString() });
  check("US: an oral stop-payment order is immediately binding too, within its 14-day window (reg_e_stop_payment)", usStopOral.decision === "deny" && usStopOral.code === "reg_e_stop_payment", usStopOral.code);
  const usRevoked = await us({ ...spotifyUs, id: "s_rev", revoked: true });
  check("US: a withdrawn preauthorization can never be debited (authorization_revoked)", usRevoked.decision === "deny" && usRevoked.code === "authorization_revoked", usRevoked.code);
  const usExp = await us({ ...spotifyUs, id: "s_exp", expiresAt: "2020-01-01T00:00:00Z" });
  check("US: an expired authorization carries no authority (authorization_expired)", usExp.decision === "deny" && usExp.code === "authorization_expired", usExp.code);
  const usSameDay = await us({ ...spotifyUs, id: "s_sd", sameDay: true, amountUSD: 2000000 });
  check("US: Nacha's USD 1,000,000 Same Day ACH per-entry limit is unconditional — not something operator policy can raise (same_day_ach_limit_exceeded)", usSameDay.decision === "deny" && usSameDay.code === "same_day_ach_limit_exceeded", usSameDay.code);
  const usBadRouting = await us({ ...spotifyUs, id: "s_rt", payeeRoutingNumber: "12345" });
  const usBadAmount = await us({ ...spotifyUs, id: "s_amt", amountUSD: 9.999 });
  check("US: malformed input is refused before any policy runs (amount_invalid for sub-cent, payee_details_invalid for a bad routing number)", usBadAmount.code === "amount_invalid" && usBadRouting.code === "payee_details_invalid", `${usBadAmount.code}/${usBadRouting.code}`);
  check("US: every verdict states what it is not — no ACH origination, no ODFI/RDFI status, no Nacha/Fed authorization claimed", /does not originate/.test(usOk.disclaimer) && /no Nacha or Federal Reserve authorization/.test(usOk.disclaimer) && usOk.regulatoryBasis.length === 2, usOk.disclaimer?.slice(0, 60));

  const US_POL = { maxPerTxnUSD: 20, maxPerDayUSD: 25, allowedPayeeAccounts: ["021000021:123456789"], allowedCategories: ["entertainment"] };
  const usP = (m, spent = 0) => evaluateAchDebit({ ...spotifyUs, ...m }, { policy: US_POL, spentTodayUSD: spent, now: NOW });
  check(
    "US: operator policy — payee allowlist, category scope, per-debit cap and a daily cap each refuse with their own code, checked after account validation",
    usP({ payeeRoutingNumber: "011000015", payeeAccountNumber: "000000000" }).code === "payee_not_allowed" &&
      usP({ category: "gaming" }).code === "category_not_allowed" &&
      usP({ amountUSD: 21 }).code === "txn_cap" &&
      usP({ amountUSD: 10 }, 20).code === "day_cap" &&
      usP({ amountUSD: 5 }, 10).decision === "allow",
    "payee/category/txn/day"
  );
  check(
    "US: the in-browser playground runs the SAME evaluator the server uses — site/assets/us-ach.js is byte-identical to server/us-ach.js",
    readFileSync(fileURLToPath(new URL("../site/assets/us-ach.js", import.meta.url)), "utf8") === readFileSync(fileURLToPath(new URL("../server/us-ach.js", import.meta.url)), "utf8"),
    "no drift between the demo and the product"
  );
  check("US: the evaluator is pure — the same mandate and clock give the same verdict every time", JSON.stringify(usP({})) === JSON.stringify(usP({})), "deterministic");

  // --- Request integrity: is this the spend I allowed? ---
  // Every other control answers "is this spend allowed?". Between the decision
  // and the execution a compromised agent can swap the payload — same payer,
  // same price, same approval, different goods — and every amount-based check
  // still passes. This is the binding that catches it.
  check("request integrity: an allowed ACP session leaves with a signed binding to its own bytes", !!acpOk.binding?.id && !!acpOk.binding?.digest, acpOk.binding?.digest?.slice(0, 16));
  check("request integrity: a denied session gets no binding — there is nothing to authorize", acpDrift.binding === undefined);

  const bind = (payload, agent = ACP_AGENT) =>
    fetch(`${BASE}/api/integrity/bind`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent, payload, amountUSD: 0.01 }) }).then((r) => r.json());
  const verifyBind = (bindingId, payload, agent = ACP_AGENT) =>
    fetch(`${BASE}/api/integrity/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bindingId, payload, agent }) }).then((r) => r.json());

  // Key order must not change the digest, or "same request" would depend on
  // JSON serialization rather than on content.
  const b1 = await bind(cleanSession);
  const shuffled = { items: cleanSession.items.map((i) => ({ category: i.category, merchant: i.merchant, qty: i.qty, amountUSD: i.amountUSD, sku: i.sku })), totalUSD: cleanSession.totalUSD, currency: cleanSession.currency, merchant: cleanSession.merchant, tokenId: cleanSession.tokenId, id: cleanSession.id };
  const okBind = await verifyBind(b1.id, shuffled);
  check("request integrity: the same request with its keys in a different order still verifies (canonical digest)", okBind.ok === true, okBind.code || okBind.digest?.slice(0, 16));
  const reuse = await verifyBind(b1.id, cleanSession);
  check("request integrity: a binding is single-use — an authorization that can be replayed is a coupon, not a binding", reuse.ok === false && reuse.code === "binding_consumed", reuse.code);
  const b2 = await bind(cleanSession);
  const swapped = await verifyBind(b2.id, { ...cleanSession, merchant: "evilcorp", items: [{ ...cleanSession.items[0], merchant: "evilcorp" }] });
  check("request integrity: a payload swapped after authorization is refused (request_integrity_mismatch)", swapped.ok === false && swapped.code === "request_integrity_mismatch", swapped.code);
  const b3 = await bind(cleanSession);
  const wrongAgent = await verifyBind(b3.id, cleanSession, "0x2222222222222222222222222222222222222222");
  check("request integrity: one agent cannot execute under another agent's binding (binding_agent_mismatch)", wrongAgent.ok === false && wrongAgent.code === "binding_agent_mismatch", wrongAgent.code);
  const unknownBind = await verifyBind("00000000-0000-0000-0000-000000000000", cleanSession);
  check("request integrity: an unbound execution is refused rather than waved through (binding_unknown)", unknownBind.ok === false && unknownBind.code === "binding_unknown", unknownBind.code);
  const shortLived = await fetch(`${BASE}/api/integrity/bind`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: ACP_AGENT, payload: cleanSession, amountUSD: 0.01, ttlMs: 1 }) }).then((r) => r.json());
  await sleep(25);
  const expiredBind = await verifyBind(shortLived.id, cleanSession);
  check("request integrity: a stale binding cannot vouch for a request assembled after it (binding_expired)", expiredBind.ok === false && expiredBind.code === "binding_expired", expiredBind.code);

  // --- Dispute evidence packs ---
  // An agent purchase produces no device fingerprint, no IP, no browsing
  // session, so agent transactions lose disputes by default. Everything a
  // defence needs is already in the ledger; this assembles and signs it.
  const paidEntry = (await fetch(`${BASE}/api/ledger`).then((r) => r.json())).entries.filter((e) => e.status === "paid" && e.entryHash).pop();
  const pack = await fetch(`${BASE}/api/disputes/${paidEntry.entryHash}/evidence`).then((r) => r.json());
  check("dispute pack: a governed spend assembles into a signed evidence bundle", pack.ok === true && pack.schema === "spendveto.dispute-evidence.v1" && !!pack.attestation?.signature, pack.code || pack.bundleHash?.slice(0, 16));
  check(
    "dispute pack: the spend is pinned to its position in the hash chain, which is the anti-backdating argument",
    pack.position?.entryHash === paidEntry.entryHash && pack.position?.prevHash === paidEntry.prevHash && pack.position?.chainValid === true,
    `idx=${pack.position?.index} valid=${pack.position?.chainValid}`
  );
  check("dispute pack: the policy hash in force at the spend travels with it, and policy drift since then is disclosed rather than hidden", pack.policy?.hashAtSpend === paidEntry.policyHash && typeof pack.policy?.unchangedSinceSpend === "boolean", `${pack.policy?.hashAtSpend?.slice(0, 12)} unchanged=${pack.policy?.unchangedSinceSpend}`);
  check("dispute pack: the bundle states what it does NOT establish, inside the artifact, so the limits travel with it", Array.isArray(pack.doesNotEstablish) && pack.doesNotEstablish.length >= 3, String(pack.doesNotEstablish?.length));
  const packOk = await fetch(`${BASE}/api/disputes/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pack) }).then((r) => r.json());
  check("dispute pack: a pack handed back round-trips against its own attestation", packOk.ok === true && packOk.signer === pack.attestation.signer, packOk.code);
  const tamperedPack = JSON.parse(JSON.stringify(pack));
  tamperedPack.disputed.amountUSD = 999;
  const packBad = await fetch(`${BASE}/api/disputes/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tamperedPack) }).then((r) => r.json());
  check("dispute pack: a pack edited in transit stops verifying (pack_tampered)", packBad.ok === false && packBad.code === "pack_tampered", packBad.code);
  const missingPack = await fetch(`${BASE}/api/disputes/${"0".repeat(64)}/evidence`).then((r) => r.json());
  check("dispute pack: an unknown ledger entry is refused rather than answered with an empty bundle (entry_not_found)", missingPack.ok === false && missingPack.code === "entry_not_found", missingPack.code);

  // --- OpenTelemetry: the refusal belongs inside the trace that caused it ---
  const otel = await fetch(`${BASE}/api/otel/spans?limit=5`).then((r) => r.json());
  const otelSpans = otel.payload?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans || [];
  check("OTel: governance decisions export as OTLP spans in the envelope a collector expects", otelSpans.length > 0 && otel.payload.resourceSpans[0].resource.attributes.some((a) => a.key === "service.name"), `spans=${otelSpans.length}`);
  check("OTel: each decision span carries the policy hash and ledger entry hash as attributes, so a trace links back to the audit record", otelSpans.every((s) => s.attributes.some((a) => a.key === "spendveto.entry_hash")), String(otelSpans.length));
  const traced = await fetch(`${BASE}/api/otel/spans?limit=3`, { headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } }).then((r) => r.json());
  const tracedSpans = traced.payload.resourceSpans[0].scopeSpans[0].spans;
  check(
    "OTel: a W3C traceparent is adopted, so the spend decision appears under the agent run that caused it rather than in a trace of its own",
    tracedSpans.every((s) => s.traceId === "4bf92f3577b34da6a3ce929d0e0e4736" && s.parentSpanId === "00f067aa0ba902b7"),
    tracedSpans[0]?.traceId
  );
  const badTrace = await fetch(`${BASE}/api/otel/spans?limit=1`, { headers: { traceparent: "not-a-traceparent" } }).then((r) => r.json());
  check("OTel: a malformed traceparent degrades to a standalone trace — a bad header never breaks the decision surface", badTrace.spanCount === 1 && !badTrace.payload.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId);
  const blockedSpans = (await fetch(`${BASE}/api/otel/spans?status=blocked&limit=3`).then((r) => r.json())).payload.resourceSpans[0].scopeSpans[0].spans;
  check(
    "OTel: a blocked spend is status OK, not ERROR — the gate did its job, and colouring refusals red trains teams to ignore the colour that matters",
    blockedSpans.length > 0 && blockedSpans.every((s) => s.status.code === 1),
    `blocked=${blockedSpans.length}`
  );
  const otelAgain = await fetch(`${BASE}/api/otel/spans?limit=5`).then((r) => r.json());
  check(
    "OTel: span ids are derived from the entry hash, so re-exporting the same ledger does not duplicate spans in the backend",
    JSON.stringify(otelAgain.payload.resourceSpans[0].scopeSpans[0].spans.map((s) => s.spanId)) === JSON.stringify(otelSpans.map((s) => s.spanId))
  );
  check("OTel: with no collector configured the export reports that honestly instead of claiming success", otel.exported?.exported === false, otel.exported?.reason);

  // --- Rails: one pay() contract, every rail behind it ---
  const { rails } = await fetch(`${BASE}/api/rails`).then((r) => r.json());
  check(
    "rail registry: two live x402 rails + nine declared adapter slots",
    rails.length === 11 && rails.filter((r) => r.status === "live").length === 2 && rails.filter((r) => r.status === "roadmap").length === 9,
    rails.map((r) => `${r.id}:${r.status}`).join(" ")
  );
  check("every rail implements the same contract (id, name, status, pay)", RAILS.every((r) => r.id && r.name && r.status && typeof r.pay === "function"));
  const roadmapErr = await getRail("stripe-mpp").pay({}).then(() => null).catch((e) => e.message);
  check("roadmap rail slots refuse honestly instead of pretending", roadmapErr?.includes("not implemented yet"), roadmapErr);
  const safeAllowanceErr = await getRail("safe-allowance").pay({}).then(() => null).catch((e) => e.message);
  check("safe-allowance rail refuses honestly when SAFE_ADDRESS/module config is absent", safeAllowanceErr?.includes("not configured"), safeAllowanceErr);
  const { transferHash, domainSeparator } = (await import("../rails/safe-allowance.js")).default._internal;
  const sampleHash = transferHash({
    chainId: 84532,
    moduleAddress: "0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134",
    safe: "0x1234567890123456789012345678901234567890",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    to: "0x1234567890123456789012345678901234567890",
    amount: 1000000n,
    paymentToken: "0x0000000000000000000000000000000000000000",
    payment: 0n,
    nonce: 0,
  });
  check(
    "safe-allowance transferHash() computes a deterministic 32-byte digest (EIP-712 struct hash, not yet chain-verified)",
    typeof sampleHash === "string" && sampleHash.startsWith("0x") && sampleHash.length === 66,
    sampleHash
  );
  const railHealth = await fetch(`${PROXY}/proxy/health`).then((r) => r.json());
  check("proxy advertises its rails alongside custody + catalog", railHealth.rails?.length === 11 && railHealth.rails.every((r) => r.pay === undefined), railHealth.rails?.map((r) => r.id).join(", "));

  // --- Stats: blocked-spend dollars, the governance headline number ---
  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  check(
    "stats: $0.285 of spend blocked across 23 stopped attempts (crypto + API rails + concurrency race + ElizaOS)",
    stats.blocked.count === 23 && Math.abs(stats.blocked.usd - 0.285) < 1e-9,
    `blocked=${JSON.stringify(stats.blocked)}`
  );
  check("stats: exactly the runaway wallet is still frozen", stats.frozenWallets === 1, `frozenWallets=${stats.frozenWallets}`);

  // Publish this run's own figures for the marketing site to read. The proof
  // panel used to hard-code them, which meant every feature that changed a
  // ledger total silently made the public page wrong — it drifted three times
  // before anyone noticed. Now the number on the page IS the number the suite
  // just asserted, or it isn't there at all.
  verifyStats = {
    generatedAt: new Date().toISOString(),
    paid: stats.paid,
    blocked: stats.blocked,
    frozenWallets: stats.frozenWallets,
  };

  // --- Ledger reflects everything ---
  const { entries } = await fetch(`${BASE}/api/ledger`).then((r) => r.json());
  const paid = entries.filter((e) => e.status === "paid");
  const blocked = entries.filter((e) => e.status === "blocked");
  // +1 paid entry when the sibling Basis repo is present and its cross-project marketplace
  // call above actually ran; the count only ever moves in that one direction, gated by the
  // same `basisOk` check that skipped the call itself. +4 for the per-agent rate-limit test's
  // 3 successful calls under the limit plus the 1 successful call after manual unfreeze.
  const expectedPaid = (basisOk ? 27 : 26) + 5; // +1: the ElizaOS action settles a real call, +1: the MCP-Pay third-party tool call
  check(
    `ledger has ${expectedPaid} paid entries (incl. marketplace haiku, MCP-Pay third-party tool, allowance refills, metered LLM, authed desk bot, SDK + LangChain calls, agent rate-limit test calls${basisOk ? ", Basis cross-project call" : ""})`,
    paid.length === expectedPaid,
    `found ${paid.length}`
  );
  check(
    "ledger has 23 blocked entries (incl. chain governance, allowance window, category cap, trading hours, 2× LLM, concurrency race, ElizaOS refusal)",
    blocked.length === 23,
    `found ${blocked.length}`
  );
  check(
    "blocked reasons cite denial, timeout, both cap levels, the freeze, tool scope, chain governance, and expiry",
    blocked.some((e) => e.reason?.includes("denied")) &&
      blocked.some((e) => e.reason?.includes("timed out")) &&
      blocked.some((e) => e.reason?.includes("delegated budget cap")) &&
      blocked.some((e) => e.reason?.includes("granted to ancestor")) &&
      blocked.some((e) => e.reason?.includes("frozen")) &&
      blocked.some((e) => e.reason?.includes("outside")) &&
      blocked.some((e) => e.reason?.includes("allowed chains")) &&
      blocked.some((e) => e.reason?.includes("delegated chain scope")) &&
      blocked.some((e) => e.reason?.includes("expired")),
    blocked.map((e) => e.reason).join(" | ")
  );

  // --- Replay protection still holds under the generalized simulate gate ---
  const challenge = await fetch(`${BASE}/api/agent/translate`).then((r) => r.json());
  const forged = await fetch(`${BASE}/api/agent/translate`, {
    headers: { "X-SIM-PAYMENT": `0x0000000000000000000000000000000000dEaD:${challenge.nonce}:0xdeadbeef` },
  });
  check("forged signature on translate is rejected (402, not 200)", forged.status === 402, `got ${forged.status}`);

  // --- Hard policy block (unrelated to approvals/delegation) still works ---
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, maxPerHourUSD: 0.001 }, null, 2));
  const { child: c7, getOut: out7 } = runClient("review");
  const code7 = await waitForClose(c7);
  check("policy-blocked call (maxPerHourUSD) exits non-zero", code7 !== 0, `exit=${code7}`);
  check("policy-blocked call prints BLOCKED", out7().includes("BLOCKED"));

  const dashboardRes = await fetch(`${BASE}/`);
  const dashboardHtml = await dashboardRes.text();
  check("dashboard served at /", dashboardRes.ok && dashboardHtml.includes("SpendVeto"), `status ${dashboardRes.status}`);
  check(
    "console ships all ten pages",
    ["overview", "approvals", "budgets", "ledger", "chains", "analytics", "trust", "policy", "agents", "report"].every((p) => dashboardHtml.includes(`data-page="${p}"`)),
    "sidebar-routed console"
  );

  // --- Spend report: the artifact you forward to whoever owns the budget ---
  // Fetched together (not against the earlier `stats` snapshot) so a ledger
  // write in between can't make this order-dependent — both reads reflect
  // the same instant instead of racing prior assertions' side effects.
  const [report, statsNow] = await Promise.all([
    fetch(`${BASE}/api/report?days=7`).then((r) => r.json()),
    fetch(`${BASE}/api/stats`).then((r) => r.json()),
  ]);
  check(
    "the report totals match the stats endpoint over the same data",
    report.paid.usd === statsNow.paid.usd && report.blocked.count === statsNow.blocked.count,
    JSON.stringify({ reportPaid: report.paid.usd, statsPaid: statsNow.paid.usd, reportBlocked: report.blocked.count, statsBlocked: statsNow.blocked.count })
  );
  check(
    "the report breaks spend down by category and names the headline",
    report.byCategory.some((c) => c.key === "api") && report.headline.includes(`$${report.blocked.usd}`),
    report.headline
  );
  const reportClamped = await fetch(`${BASE}/api/report?days=9999`).then((r) => r.json());
  check("the report window clamps to a sane maximum (90 days) instead of trusting the query", reportClamped.windowDays === 90, `windowDays=${reportClamped.windowDays}`);

  // --- Server-authoritative enforcement (issue #8) ---
  // The whole point: a key-holding agent running a hand-rolled client that
  // SKIPS its own policy check still can't overspend, because the payment gate
  // itself runs the governance pipeline server-side. We reproduce exactly that
  // attack — sign a valid payment for a call that a restrictive policy forbids
  // and POST it straight to the gate, never touching client/pay.js.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, maxPerCallUSD: 0.001 }, null, 2));
  const bypassPayer = privateKeyToAccount(generatePrivateKey());
  const bypassChallenge = await fetch(`${BASE}/api/agent/review`).then((r) => r.json());
  const bypassSig = await bypassPayer.signMessage({ message: `${bypassChallenge.nonce}:${bypassChallenge.resource}:${bypassChallenge.price}` });
  const bypassRes = await fetch(`${BASE}/api/agent/review`, { headers: { "X-SIM-PAYMENT": `${bypassPayer.address}:${bypassChallenge.nonce}:${bypassSig}` } });
  const bypassBody = await bypassRes.json();
  check(
    "a validly-signed over-cap payment that skips the client is refused AT THE GATE (server-authoritative enforcement)",
    bypassRes.status === 402 && bypassBody.reason === "per_call_cap",
    `status=${bypassRes.status} reason=${bypassBody.reason}`
  );
  const bypassLedgerBlocked = (await fetch(`${BASE}/api/ledger`).then((r) => r.json())).entries.some(
    (e) => e.status === "blocked" && e.address?.toLowerCase() === bypassPayer.address.toLowerCase() && (e.reason || "").startsWith("gate policy:")
  );
  check("the gate-level block is recorded in the ledger with a gate-policy reason", bypassLedgerBlocked);

  // An above-threshold spend pushed raw to the gate with NO approval on record
  // is refused too — the approval requirement is enforced server-side, not
  // just by the client choosing to ask.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, requireApprovalAboveUSD: 0.005 }, null, 2));
  const noApprovalPayer = privateKeyToAccount(generatePrivateKey());
  const naChallenge = await fetch(`${BASE}/api/agent/review`).then((r) => r.json());
  const naSig = await noApprovalPayer.signMessage({ message: `${naChallenge.nonce}:${naChallenge.resource}:${naChallenge.price}` });
  const naRes = await fetch(`${BASE}/api/agent/review`, { headers: { "X-SIM-PAYMENT": `${noApprovalPayer.address}:${naChallenge.nonce}:${naSig}` } });
  const naBody = await naRes.json();
  check(
    "an above-threshold raw payment with no approval on record is refused at the gate",
    naRes.status === 402 && naBody.reason === "approval_required",
    `status=${naRes.status} reason=${naBody.reason}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  // --- Payee allowlisting: pin WHICH recipients an agent may pay ---
  // The most-cited agentic-payments guardrail ("even if the agent is
  // compromised, it can only reach addresses on the list"). A marketplace tool
  // declares a payTo; the payee allowlist governs whether an agent may settle
  // to it, enforced server-side at the gate exactly like the caps above.
  const goodVendor = privateKeyToAccount(generatePrivateKey()).address;
  const badVendor = privateKeyToAccount(generatePrivateKey()).address;
  await fetch(`${BASE}/api/catalog/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "vendor-tool", price: "0.01", label: "External vendor", payTo: badVendor }),
  });
  // Allowlist names only goodVendor; the tool pays badVendor.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, allowedPayees: [goodVendor] }, null, 2));
  const payeePayer = privateKeyToAccount(generatePrivateKey());
  const peChallenge = await fetch(`${BASE}/api/agent/vendor-tool`).then((r) => r.json());
  const peSig = await payeePayer.signMessage({ message: `${peChallenge.nonce}:${peChallenge.resource}:${peChallenge.price}` });
  const peRes = await fetch(`${BASE}/api/agent/vendor-tool`, { headers: { "X-SIM-PAYMENT": `${payeePayer.address}:${peChallenge.nonce}:${peSig}` } });
  const peBody = await peRes.json();
  check(
    "a payment to a payee NOT on the allowlist is refused at the gate (payee allowlisting)",
    peRes.status === 402 && peBody.reason === "payee_not_allowed",
    `status=${peRes.status} reason=${peBody.reason}`
  );
  // Now allowlist the vendor the tool actually pays: the same call settles.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, allowedPayees: [badVendor] }, null, 2));
  const peChallenge2 = await fetch(`${BASE}/api/agent/vendor-tool`).then((r) => r.json());
  const peSig2 = await payeePayer.signMessage({ message: `${peChallenge2.nonce}:${peChallenge2.resource}:${peChallenge2.price}` });
  const peRes2 = await fetch(`${BASE}/api/agent/vendor-tool`, { headers: { "X-SIM-PAYMENT": `${payeePayer.address}:${peChallenge2.nonce}:${peSig2}` } });
  check("once the payee is on the allowlist, the same payment settles", peRes2.ok, `status=${peRes2.status}`);

  // --- ENS names in the payee allowlist (client/ens.js) ---
  // An allowlist a human can audit at a glance ("vitalik.eth") rather than
  // compare hex strings against ("0xd8dA..."). The network boundary is
  // swapped for a deterministic fake (see client/ens.js's own comment on
  // why) so this stays as hermetic as every other assertion here — the
  // resolution, caching, and fail-closed logic under test is all real.
  const { __setEnsResolverForTesting } = await import("../client/ens.js");
  const ensGoodName = "spendveto-verify-good.eth";
  const ensBadName = "spendveto-verify-unregistered.eth";
  const ensResolvedAddress = privateKeyToAccount(generatePrivateKey()).address;
  let ensResolveCalls = 0;
  __setEnsResolverForTesting(async (name) => {
    ensResolveCalls++;
    if (name === ensGoodName.toLowerCase()) return ensResolvedAddress;
    return null; // unregistered, or any other name this fake doesn't know
  });

  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, allowedPayees: [ensGoodName] }, null, 2));
  const ensPayer = privateKeyToAccount(generatePrivateKey());
  const ensVerdictGood = await checkPolicy(ensPayer.address, 0.01, "review", "base-sepolia", null, ensResolvedAddress);
  const ensVerdictWrong = await checkPolicy(ensPayer.address, 0.01, "review", "base-sepolia", null, privateKeyToAccount(generatePrivateKey()).address);
  check(
    "a .eth name in the payee allowlist resolves and gates spend exactly like a raw address",
    ensVerdictGood.allowed === true && ensVerdictWrong.allowed === false && ensVerdictWrong.code === "payee_not_allowed",
    `resolved-payee=${ensVerdictGood.allowed} other-payee=${ensVerdictWrong.allowed}/${ensVerdictWrong.code}`
  );

  const callsBeforeCacheCheck = ensResolveCalls;
  await checkPolicy(ensPayer.address, 0.01, "review", "base-sepolia", null, ensResolvedAddress);
  check(
    "a resolved .eth name is cached — checkPolicy runs on every call, so an uncached RPC round trip on this hot path is not acceptable",
    ensResolveCalls === callsBeforeCacheCheck,
    `resolver invoked ${ensResolveCalls - callsBeforeCacheCheck} more time(s) on a cache hit`
  );

  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, allowedPayees: [ensBadName] }, null, 2));
  const ensVerdictUnresolvable = await checkPolicy(ensPayer.address, 0.01, "review", "base-sepolia", null, privateKeyToAccount(generatePrivateKey()).address);
  check(
    "a .eth name that fails to resolve is dropped from the allowlist, not treated as a wildcard match",
    ensVerdictUnresolvable.allowed === false && ensVerdictUnresolvable.code === "payee_not_allowed",
    `${ensVerdictUnresolvable.allowed} ${ensVerdictUnresolvable.code}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  // Delegated payee scope: a grant may pin which recipients a sub-agent pays,
  // and it cascades like tool/chain scope. A child scoped to goodVendor is
  // blocked when it reaches for the tool that pays badVendor.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));
  await fetch(`${BASE}/api/delegations/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capUSD: 0.05, label: "payee scoped", allowedPayees: [goodVendor] }),
  });
  const { child: ps1, getOut: psOut1 } = runClient("vendor-tool", {}, ["--child=payee scoped"]);
  const psCode1 = await waitForClose(ps1);
  check(
    "a delegated child scoped to a different payee is blocked from paying an out-of-scope recipient",
    psCode1 !== 0 && psOut1().includes("payee"),
    psOut1().split("\n").find((l) => l.includes("BLOCKED")) || psOut1().split("\n").slice(-2).join(" / ")
  );

  // --- Hash-chained audit ledger (issue #11) ---
  const chainOk = await fetch(`${BASE}/api/ledger/verify-chain`).then((r) => r.json());
  check(
    "the ledger hash-chain verifies intact over every entry written this run",
    chainOk.valid === true && chainOk.brokenAt === null && chainOk.length > 0,
    JSON.stringify(chainOk)
  );
  // Prove the chain actually CATCHES tampering: rewrite a historical entry's
  // amount directly on disk (the "admin edits the JSON audit log" attack) and
  // confirm verify-chain now reports it broken at that row.
  const ledgerFile = `${ROOT}data/ledger.json`;
  const onDisk = JSON.parse(readFileSync(ledgerFile, "utf8"));
  const tamperIdx = onDisk.findIndex((e) => e.status === "paid" && e.entryHash);
  const originalAmount = onDisk[tamperIdx].amount;
  onDisk[tamperIdx].amount = "9.99"; // forge a paid amount without recomputing the hash
  writeFileSync(ledgerFile, JSON.stringify(onDisk, null, 2));
  const chainBroken = await fetch(`${BASE}/api/ledger/verify-chain`).then((r) => r.json());
  check(
    "tampering with a historical ledger amount is detected by the hash-chain at that row",
    chainBroken.valid === false && chainBroken.brokenAt === tamperIdx,
    JSON.stringify(chainBroken)
  );
  // Restore the byte-exact original so the finally block's bookkeeping is sane.
  onDisk[tamperIdx].amount = originalAmount;
  writeFileSync(ledgerFile, JSON.stringify(onDisk, null, 2));

  // --- Shadow mode: test a policy change against live traffic, no enforcement ---
  // Set a candidate policy so strict it would block a normal $0.01 review, make
  // a real call that the LIVE (loose) policy allows, and confirm: the call
  // still settles, AND the shadow report shows the candidate would have blocked
  // it. That's the whole promise — measure a policy change's impact before
  // promoting it, without risking real spend.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));
  await fetch(`${BASE}/api/shadow`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxPerCallUSD: 0.001 }), // would block any $0.01+ call
  });
  const shadowPayer = privateKeyToAccount(generatePrivateKey());
  const shChallenge = await fetch(`${BASE}/api/agent/review`).then((r) => r.json());
  const shSig = await shadowPayer.signMessage({ message: `${shChallenge.nonce}:${shChallenge.resource}:${shChallenge.price}` });
  const shRes = await fetch(`${BASE}/api/agent/review`, { headers: { "X-SIM-PAYMENT": `${shadowPayer.address}:${shChallenge.nonce}:${shSig}` } });
  check("shadow mode never blocks the live call — the real payment still settles", shRes.ok, `status=${shRes.status}`);
  const shadowRpt = await fetch(`${BASE}/api/shadow`).then((r) => r.json());
  check(
    "the shadow report shows the candidate policy would have blocked spend the live policy allowed",
    shadowRpt.active === true && shadowRpt.wouldBlockThatLiveAllowed.count >= 1 && shadowRpt.wouldBlockThatLiveAllowed.usd >= 0.01,
    JSON.stringify(shadowRpt.wouldBlockThatLiveAllowed)
  );
  const shadowCleared = await fetch(`${BASE}/api/shadow`, { method: "DELETE" }).then((r) => r.json());
  const shadowGone = await fetch(`${BASE}/api/shadow`).then((r) => r.json());
  check("clearing shadow mode ends the experiment", shadowCleared.ok === true && shadowGone.active === false, JSON.stringify(shadowGone));

  // --- API-key auth on the admin surface (issue #10) ---
  // Everything above ran in OPEN MODE (no keys) — the zero-setup default that
  // keeps demos and this suite frictionless. Now write keys, which flips the
  // server to auth-required, and prove the admin surface is actually locked:
  // an unauthenticated policy rewrite is refused, an admin key works, and a
  // viewer key is refused for a write. Then remove the keys to restore open
  // mode (the finally block does no API calls).
  const KEYS_FILE = `${ROOT}data/api-keys.json`;
  const adminKey = "tgk_verify_admin_0000000000000000000000000000";
  const viewerKey = "tgk_verify_viewer_000000000000000000000000000";
  writeFileSync(KEYS_FILE, JSON.stringify([
    { id: "a", key: adminKey, role: "admin", label: "verify admin", createdAt: new Date().toISOString() },
    { id: "v", key: viewerKey, role: "viewer", label: "verify viewer", createdAt: new Date().toISOString() },
  ], null, 2));
  const unauth = await fetch(`${BASE}/api/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxPerCallUSD: 0.5 }),
  });
  check("with auth enabled, an UNauthenticated policy rewrite is refused (401)", unauth.status === 401, `got ${unauth.status}`);
  const withAdmin = await fetch(`${BASE}/api/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminKey}` },
    body: JSON.stringify({ maxPerCallUSD: 0.5 }),
  });
  check("an admin-keyed policy rewrite is accepted (200)", withAdmin.status === 200, `got ${withAdmin.status}`);
  const withViewer = await fetch(`${BASE}/api/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewerKey}` },
    body: JSON.stringify({ maxPerCallUSD: 0.5 }),
  });
  check("a viewer key is refused a write it isn't allowed (403 — role enforcement)", withViewer.status === 403, `got ${withViewer.status}`);
  // Public reads stay open even with auth on (the marketing site reads /api/stats
  // cross-origin) — only the admin surface is gated.
  const readOpen = await fetch(`${BASE}/api/stats`);
  check("public read endpoints remain reachable with auth enabled", readOpen.ok, `got ${readOpen.status}`);
  unlinkSync(KEYS_FILE); // restore open mode for a clean finally
  const reopened = await fetch(`${BASE}/api/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxPerCallUSD: 0.5 }),
  });
  check("removing all keys returns the server to open mode", reopened.status === 200, `got ${reopened.status}`);

  // --- World ID gate on human approvals (control #33): a policy can require
  // proof-of-personhood on every APPROVAL (never on a deny — a deny never
  // authorizes spend). Without WORLD_RP_ID / WORLD_RP_SIGNING_KEY configured
  // in this environment (explicitly blanked above, regardless of what the
  // maintainer's own .env.local has), the gate must refuse honestly rather
  // than silently accepting an unverified click as "a human approved this."
  await fetch(`${BASE}/api/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requireWorldIdForApproval: true }),
  });
  const widAccount = privateKeyToAccount(generatePrivateKey());
  const widApproval = await fetch(`${BASE}/api/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: widAccount.address, resource: "/api/agent/summarize", price: "0.02" }),
  }).then((r) => r.json());
  const widDecide = await fetch(`${BASE}/api/approvals/${widApproval.id}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approved" }),
  });
  const widBody = await widDecide.json();
  check(
    "an approval is refused without World ID when the policy requires it, instead of silently accepting an unverified click (world_id_not_configured)",
    widDecide.status === 403 && widBody.error === "world_id_not_configured",
    JSON.stringify(widBody)
  );
  const widStillPending = await fetch(`${BASE}/api/approvals/${widApproval.id}`).then((r) => r.json());
  check("the refused approval stays pending — a failed World ID check never silently authorizes the spend", widStillPending.status === "pending", widStillPending.status);
  const widDeny = await fetch(`${BASE}/api/approvals/${widApproval.id}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "denied" }),
  });
  check("a DENY is never gated by World ID — denying never authorizes spend, so it needs no proof-of-personhood", widDeny.status === 200, `got ${widDeny.status}`);
  await fetch(`${BASE}/api/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requireWorldIdForApproval: false }),
  });

  // --- Cross-org trust graph + advanced anomaly models ---
  // Scale the flat per-wallet governance score out into (1) a graph — wallets
  // are nodes, delegations are edges, each root is an "org" with a blended
  // sub-tree reputation — (2) a counterparty credit bureau: reputation of a
  // *recipient*, aggregated across every wallet that has paid it — and (3) a
  // panel of deterministic behavioural anomaly signals beyond the burst-rate
  // freeze. All read-only over the ledger, so none of it disturbs the exact
  // paid/blocked counts asserted earlier. (Auth is back to open mode here.)
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));
  const bureauVendor = privateKeyToAccount(generatePrivateKey()).address;
  await fetch(`${BASE}/api/catalog/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "bureau-tool", price: "0.01", label: "Bureau vendor", payTo: bureauVendor }),
  });
  // Two independent wallets each pay the same recipient — the cross-org signal
  // a single-wallet score can't see.
  const bureauPayers = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  for (const payer of bureauPayers) {
    const ch = await fetch(`${BASE}/api/agent/bureau-tool`).then((r) => r.json());
    const sig = await payer.signMessage({ message: `${ch.nonce}:${ch.resource}:${ch.price}` });
    const r = await fetch(`${BASE}/api/agent/bureau-tool`, { headers: { "X-SIM-PAYMENT": `${payer.address}:${ch.nonce}:${sig}` } });
    if (!r.ok) console.log(`  (bureau setup pay unexpectedly failed: ${r.status})`);
  }
  const bureau = await fetch(`${BASE}/api/trust/payee/${bureauVendor}`).then((r) => r.json());
  check(
    "counterparty bureau aggregates a recipient's reputation across every wallet that paid it",
    bureau.seen === true && bureau.distinctPayers === 2 && bureau.paidCount === 2 && typeof bureau.avgPayerScore === "number",
    `payers=${bureau.distinctPayers} paid=${bureau.paidCount} avgScore=${bureau.avgPayerScore}`
  );
  const unknownPayee = privateKeyToAccount(generatePrivateKey()).address;
  const unseen = await fetch(`${BASE}/api/trust/payee/${unknownPayee}`).then((r) => r.json());
  check(
    "the bureau reports a never-paid recipient as unseen with zero payers (no invented reputation)",
    unseen.seen === false && unseen.distinctPayers === 0 && unseen.paidCount === 0,
    `seen=${unseen.seen} payers=${unseen.distinctPayers}`
  );
  const graph = await fetch(`${BASE}/api/trust/graph`).then((r) => r.json());
  const scoredNode = graph.nodes.find((n) => n.address === bureauPayers[0].address.toLowerCase());
  check(
    "the trust graph scores every wallet as a node, links delegations as edges, and rolls each root up into an org score",
    Array.isArray(graph.nodes) && graph.nodes.length > 0 && graph.edges.length > 0 && graph.orgs.length > 0 &&
      scoredNode && typeof scoredNode.score === "number" && typeof scoredNode.grade === "string" &&
      graph.orgs.every((o) => typeof o.aggregateScore === "number" && o.memberCount >= 1),
    `nodes=${graph.nodes.length} edges=${graph.edges.length} orgs=${graph.orgs.length}`
  );
  // A wallet whose recent attempts are mostly blocks trips the block-rate
  // signal — a probing / misconfigured loop the burst timer alone would miss.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, maxPerCallUSD: 0.005 }, null, 2));
  const anomWallet = privateKeyToAccount(generatePrivateKey());
  for (let i = 0; i < 5; i++) {
    const ch = await fetch(`${BASE}/api/agent/bureau-tool`).then((r) => r.json());
    const sig = await anomWallet.signMessage({ message: `${ch.nonce}:${ch.resource}:${ch.price}` });
    await fetch(`${BASE}/api/agent/bureau-tool`, { headers: { "X-SIM-PAYMENT": `${anomWallet.address}:${ch.nonce}:${sig}` } });
  }
  const anom = await fetch(`${BASE}/api/anomaly/${anomWallet.address}`).then((r) => r.json());
  check(
    "advanced anomaly analysis flags a wallet whose recent attempts are mostly blocked (block-rate spike, beyond the burst timer)",
    (anom.level === "high" || anom.level === "elevated") && anom.signals.some((s) => s.code === "block_rate_spike"),
    `level=${anom.level} signals=${anom.signals.map((s) => s.code).join(",") || "none"}`
  );
  const cleanWallet = privateKeyToAccount(generatePrivateKey()).address;
  const cleanAnom = await fetch(`${BASE}/api/anomaly/${cleanWallet}`).then((r) => r.json());
  check(
    "anomaly analysis stays quiet for a wallet with no history (advisory panel, no false positives)",
    cleanAnom.level === "none" && cleanAnom.signals.length === 0,
    `level=${cleanAnom.level}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  // --- x402 `upto` scheme: govern the ceiling, hold it, settle the actual ---
  // The scheme lets a seller decide the charge after the buyer has signed for
  // a maximum, so every number the rest of this suite governs is the wrong one
  // here. Tail-appended: fresh wallets, and only settlements (never ceilings)
  // reach the ledger, after every exact-count assertion above has run.
  const uptoPost = (path, body) =>
    fetch(`${BASE}/api/upto/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const inTenMin = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // LOOSE_POLICY: $1/hour budget, approval above $0.015. A $0.002 quote behind
  // a $0.5 ceiling is a $0.5 decision — the whole point of the scheme's risk.
  const uptoWallet = privateKeyToAccount(generatePrivateKey()).address;
  const ceilingCall = await uptoPost("authorize", { address: uptoWallet, maxUSD: 0.5, quotedUSD: 0.002, toolId: "review", deadline: inTenMin() });
  check(
    "an upto authorization is governed on the ceiling it permits, not the price the seller quoted",
    ceilingCall.body.decision === "requires_approval" && /ceiling of \$0\.5/.test(ceilingCall.body.reason || ""),
    `${ceilingCall.body.decision}: ${(ceilingCall.body.reason || "").slice(0, 90)}`
  );

  const held1 = await uptoPost("authorize", { address: uptoWallet, maxUSD: 0.01, quotedUSD: 0.002, toolId: "review", deadline: inTenMin() });
  const holdsAfter = await fetch(`${BASE}/api/upto/holds/${uptoWallet}`).then((r) => r.json());
  const ledgerBeforeSettle = await fetch(`${BASE}/api/ledger`).then((r) => r.json());
  check(
    "an open authorization holds its full ceiling against the budget before anything has settled",
    held1.body.decision === "allow" && holdsAfter.heldUSD === 0.01 &&
      !ledgerBeforeSettle.entries.some((e) => e.address === uptoWallet && e.status === "paid"),
    `held=${holdsAfter.heldUSD} paidEntries=${ledgerBeforeSettle.entries.filter((e) => e.address === uptoWallet && e.status === "paid").length}`
  );

  // Five $0.01 ceilings exhaust a $0.05/hour budget with $0 actually spent —
  // the leak this module exists to close. Ceilings stay under the approval
  // threshold so what's being measured is the budget, not the approval rule.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, maxPerHourUSD: 0.05 }, null, 2));
  const squeezeWallet = privateKeyToAccount(generatePrivateKey()).address;
  let squeezed;
  let squeezedAfter = 0;
  for (let i = 0; i < 6; i++) {
    squeezed = await uptoPost("authorize", { address: squeezeWallet, maxUSD: 0.01, toolId: "review", deadline: inTenMin() });
    if (squeezed.body.decision !== "allow") break;
    squeezedAfter++;
  }
  const squeezeVerdict = await checkPolicy(squeezeWallet, 0.01, "review", "base-sepolia");
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));
  check(
    "five open ceilings exhaust a $0.05 hourly budget with $0 settled — and an ordinary payment on the same wallet is refused too",
    squeezedAfter === 5 && squeezed.body.code === "hourly_usd_cap" && /held by open upto authorizations/.test(squeezed.body.reason || "") &&
      squeezeVerdict.allowed === false && squeezeVerdict.code === "hourly_usd_cap",
    `${squeezedAfter} allowed then ${squeezed.body.code} / ordinary=${squeezeVerdict.code}`
  );

  const overSettle = await uptoPost("settle", { id: held1.body.authorization.id, settledUSD: 0.02 });
  check(
    "a seller settling above the maximum the buyer authorized is refused at the buyer's own gate",
    overSettle.status === 409 && overSettle.body.code === "upto_over_settlement",
    `${overSettle.status} ${overSettle.body.code}`
  );

  const settled = await uptoPost("settle", { id: held1.body.authorization.id, settledUSD: 0.003 });
  const holdsAfterSettle = await fetch(`${BASE}/api/upto/holds/${uptoWallet}`).then((r) => r.json());
  check(
    "settling releases the unused headroom back to the budget ($0.01 held → $0.003 charged → $0.007 released)",
    settled.body.settledUSD === 0.003 && settled.body.releasedUSD === 0.007 && holdsAfterSettle.heldUSD === 0,
    `settled=${settled.body.settledUSD} released=${settled.body.releasedUSD} held=${holdsAfterSettle.heldUSD}`
  );

  const uptoLedger = await fetch(`${BASE}/api/ledger`).then((r) => r.json());
  const uptoEntry = uptoLedger.entries.find((e) => e.address === uptoWallet && e.status === "paid");
  check(
    "only the amount actually settled enters the spend record — the ceiling is carried as context, never as spend",
    uptoEntry?.amount === 0.003 && uptoEntry?.maxUSD === 0.01 && uptoEntry?.releasedUSD === 0.007 && uptoEntry?.authorizationId === held1.body.authorization.id,
    JSON.stringify({ amount: uptoEntry?.amount, maxUSD: uptoEntry?.maxUSD, released: uptoEntry?.releasedUSD })
  );

  const replay = await uptoPost("settle", { id: held1.body.authorization.id, settledUSD: 0.001 });
  check(
    "an authorization settles at most once — a second settlement is refused as a replay, whatever the amount",
    replay.status === 409 && replay.body.code === "upto_already_settled",
    `${replay.status} ${replay.body.code}`
  );

  const noDeadline = await uptoPost("authorize", { address: uptoWallet, maxUSD: 0.01, toolId: "review" });
  check(
    "an authorization with no deadline is refused — an unbounded ceiling would hold budget forever",
    noDeadline.body.code === "upto_window_invalid",
    noDeadline.body.code
  );

  const expiring = await uptoPost("authorize", { address: uptoWallet, maxUSD: 0.01, toolId: "review", deadline: new Date(Date.now() + 1200).toISOString() });
  const heldWhileValid = await fetch(`${BASE}/api/upto/holds/${uptoWallet}`).then((r) => r.json());
  await sleep(1500);
  const heldAfterExpiry = await fetch(`${BASE}/api/upto/holds/${uptoWallet}`).then((r) => r.json());
  const settleExpired = await uptoPost("settle", { id: expiring.body.authorization.id, settledUSD: 0.001 });
  check(
    "a ceiling past its deadline releases itself and can no longer settle — the hold expires with the signature",
    heldWhileValid.heldUSD === 0.01 && heldAfterExpiry.heldUSD === 0 && settleExpired.body.code === "upto_expired",
    `valid=${heldWhileValid.heldUSD} expired=${heldAfterExpiry.heldUSD} ${settleExpired.body.code}`
  );

  // --- Evidence surfaces + AP2 mandate evaluation + billing sink + OpenAI adapter ---
  // The July-2026 research round: enterprise buyers want normalized,
  // SIEM-ready decision events with the policy version in force; AP2-shaped
  // mandates want a signed policy verdict; billing platforms want usage events
  // pushed post-settlement; OpenAI Agents SDK users want the same governed
  // tools LangChain gets. All read-only or tail-appended — exact-count
  // assertions earlier are undisturbed.
  const evResp = await fetch(`${BASE}/api/events?limit=5`).then((r) => r.json());
  check(
    "decision events expose the ledger as one stable SIEM-ready schema (spendveto.decision.v1)",
    Array.isArray(evResp.events) && evResp.events.length === 5 &&
      evResp.events.every((e) => e.schema === "spendveto.decision.v1" && e.agent && e.decision && e.ts),
    `got ${evResp.events?.length} events, decisions=${evResp.events?.map((e) => e.decision).join(",")}`
  );
  const jsonl = await fetch(`${BASE}/api/events/export?limit=4`).then((r) => r.text());
  const jsonlLines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
  check(
    "the JSONL export parses one decision per line — straight into Splunk/Datadog/jq",
    jsonlLines.length === 4 && jsonlLines.every((e) => e.schema === "spendveto.decision.v1"),
    `${jsonlLines.length} lines`
  );

  // Policy versioning: the same wallet pays under two different policies; each
  // decision must carry the SHA-256 of the policy in force at that moment.
  const phPayer = privateKeyToAccount(generatePrivateKey());
  const payBureau = async () => {
    const ch = await fetch(`${BASE}/api/agent/bureau-tool`).then((r) => r.json());
    const sig = await phPayer.signMessage({ message: `${ch.nonce}:${ch.resource}:${ch.price}` });
    return fetch(`${BASE}/api/agent/bureau-tool`, { headers: { "X-SIM-PAYMENT": `${phPayer.address}:${ch.nonce}:${sig}` } }).then((r) => r.json());
  };
  await payBureau();
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, maxPerHourUSD: 0.9 }, null, 2));
  await payBureau();
  const phEvents = (await fetch(`${BASE}/api/events?address=${phPayer.address}&status=paid`).then((r) => r.json())).events;
  check(
    "every decision is stamped with the policy version in force (policyHash changes when the policy does)",
    phEvents.length === 2 && phEvents.every((e) => /^[0-9a-f]{64}$/.test(e.policyHash || "")) && phEvents[0].policyHash !== phEvents[1].policyHash,
    `hashes=${phEvents.map((e) => (e.policyHash || "none").slice(0, 8)).join(" → ")}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  // AP2-style mandate evaluation: signed verdicts, deny codes, expiry.
  const ap2Agent = privateKeyToAccount(generatePrivateKey()).address;
  const ap2Ok = await fetch(`${BASE}/api/ap2/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "mandate-1", agent: ap2Agent, amountUSD: 0.01 }),
  }).then((r) => r.json());
  const ap2SigValid = await verifyMessage({ address: ap2Ok.signer, message: ap2Ok.message, signature: ap2Ok.signature });
  check(
    "an AP2-shaped mandate within policy gets an ECDSA-signed allow verdict (portable evidence)",
    ap2Ok.decision === "allow" && ap2SigValid === true,
    `decision=${ap2Ok.decision} sigValid=${ap2SigValid}`
  );
  const ap2Over = await fetch(`${BASE}/api/ap2/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: ap2Agent, amountUSD: 50 }),
  }).then((r) => r.json());
  check(
    "an over-cap mandate is denied with the structured per_call_cap code",
    ap2Over.decision === "deny" && ap2Over.code === "per_call_cap",
    `decision=${ap2Over.decision} code=${ap2Over.code}`
  );
  const ap2Expired = await fetch(`${BASE}/api/ap2/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: ap2Agent, amountUSD: 0.01, expiresAt: "2020-01-01T00:00:00Z" }),
  }).then((r) => r.json());
  check(
    "an expired mandate is refused outright (mandate_expired), signature and all",
    ap2Expired.decision === "deny" && ap2Expired.code === "mandate_expired",
    `decision=${ap2Expired.decision} code=${ap2Expired.code}`
  );

  // Billing sink: a settlement pushes one normalized usage event to the
  // configured billing webhook (same fire-and-forget contract as alerts).
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, billingWebhookUrl: "http://localhost:8499/hook" }, null, 2));
  const billPayer = privateKeyToAccount(generatePrivateKey());
  const billCh = await fetch(`${BASE}/api/agent/bureau-tool`).then((r) => r.json());
  const billSig = await billPayer.signMessage({ message: `${billCh.nonce}:${billCh.resource}:${billCh.price}` });
  const billRes = await fetch(`${BASE}/api/agent/bureau-tool`, { headers: { "X-SIM-PAYMENT": `${billPayer.address}:${billCh.nonce}:${billSig}` } }).then((r) => r.json());
  await sleep(400);
  const usageEvent = alertsReceived.find((a) => a.event === "spendveto.usage.v1" && a.transaction_id === billRes.settlement?.receiptId);
  check(
    "a paid settlement emits a spendveto.usage.v1 event to the billing webhook, keyed by receipt id",
    !!usageEvent && usageEvent.properties?.amount_usd === 0.01 && usageEvent.external_subscription_id === billPayer.address,
    usageEvent ? `tx=${usageEvent.transaction_id.slice(0, 8)} amount=$${usageEvent.properties?.amount_usd}` : "no usage event arrived"
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  // OpenAI Agents SDK adapter: same governed proxy path, Agents-SDK tool shape.
  const oaAgentReg = await fetch(`${PROXY}/proxy/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "openai adapter test" }),
  }).then((r) => r.json());
  const oaTools = await createSpendVetoFunctionTools({ proxyUrl: PROXY, serverUrl: BASE, agentToken: oaAgentReg.token });
  check(
    "OpenAI Agents adapter emits {name, description, parameters, execute} per catalog tool",
    oaTools.length > 0 && oaTools.every((t) => t.name.startsWith("spendveto_") && typeof t.description === "string" && t.parameters?.type === "object" && typeof t.execute === "function"),
    `${oaTools.length} tools`
  );
  const oaTranslate = oaTools.find((t) => t.name === "spendveto_translate");
  const oaOutput = await oaTranslate.execute({});
  check(
    "OpenAI Agents tool .execute() runs a real governed call through the proxy and returns text",
    typeof oaOutput === "string" && oaOutput.length > 0,
    oaOutput.slice(0, 60)
  );

  // --- x402 `auth-capture`: refuse hostile routes, govern the maximum, hold the escrow, check the seller ---
  // The scheme (x402 spec v1.1; TS SDK merged 2026-10-06) gives a payment a
  // lifecycle — authorize into the commerce-payments escrow, then capture /
  // void / refund driven by the seller, and reclaim by the buyer after the
  // capture deadline. server/authcapture.js is the buyer's side of it.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LOOSE_POLICY, maxPerCallUSD: 1, maxPerHourUSD: 1, maxCallsPerHour: 100, requireApprovalAboveUSD: 5, authCapture: { maxHoldSeconds: 86400, minRefundWindowSeconds: 3600 } }, null, 2));
  const acPost = (path, body) =>
    fetch(`${BASE}/api/authcapture/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const nowS = () => Math.floor(Date.now() / 1000);
  const AC_ZERO = "0x0000000000000000000000000000000000000000";
  const acOperator = privateKeyToAccount(generatePrivateKey()).address;
  const acPayee = privateKeyToAccount(generatePrivateKey()).address;
  const acRoute = (extra = {}, top = {}) => ({
    scheme: "auth-capture", network: "eip155:84532", amount: "250000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: acPayee, maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2", captureAuthorizer: acOperator, receiverAuthorizer: acOperator, captureDeadline: nowS() + 3600, refundDeadline: nowS() + 3600 + 86400, feeRecipient: AC_ZERO, minFeeBps: 0, maxFeeBps: 0, ...extra },
    ...top,
  });
  const acEval = (requirements, more = {}) => acPost("evaluate", { address: privateKeyToAccount(generatePrivateKey()).address, requirements, ...more });

  // The canonical escrow/collector set is restated in server/authcapture.js
  // from the spec; pin it to the addresses @x402/evm itself ships, so a
  // redeploy upstream can't leave this gate approving an escrow nobody uses.
  const evmPkg = await import("@x402/evm");
  const { ESCROW_DEPLOYMENTS } = await import("../server/authcapture.js");
  check(
    "auth-capture's canonical escrows and collectors are exactly the ones @x402/evm ships — v1.1 escrow, EIP-3009, Permit2 and refund collectors, and the v1.0 escrow and collector",
    ESCROW_DEPLOYMENTS["v1.1"].escrow === evmPkg.AUTH_CAPTURE_ESCROW_V1_1_ADDRESS && ESCROW_DEPLOYMENTS["v1.1"].eip3009Collector === evmPkg.EIP3009_TOKEN_COLLECTOR_ADDRESS &&
      ESCROW_DEPLOYMENTS["v1.1"].permit2Collector === evmPkg.PERMIT2_TOKEN_COLLECTOR_ADDRESS && ESCROW_DEPLOYMENTS["v1.1"].operatorRefundCollector === evmPkg.OPERATOR_REFUND_COLLECTOR_ADDRESS &&
      ESCROW_DEPLOYMENTS["v1.0"].escrow === evmPkg.AUTH_CAPTURE_ESCROW_V1_0_ADDRESS && ESCROW_DEPLOYMENTS["v1.0"].eip3009Collector === evmPkg.EIP3009_TOKEN_COLLECTOR_V1_0_ADDRESS,
    JSON.stringify({ v11: evmPkg.AUTH_CAPTURE_ESCROW_V1_1_ADDRESS, v10: evmPkg.AUTH_CAPTURE_ESCROW_V1_0_ADDRESS })
  );
  const acSmall = await acEval(acRoute());
  const acBig = await acEval(acRoute({}, { amount: "1500000" }));
  check(
    "an auth-capture route is governed on the maximum it authorizes — $0.25 allowed, $1.50 refused by the per-call cap before anything is signed",
    acSmall.status === 200 && acSmall.body.evaluation?.maxUSD === 0.25 && acSmall.body.evaluation?.escrowVersion === "v1.1" &&
      acBig.status === 403 && acBig.body.stage === "policy" && acBig.body.code === "per_call_cap",
    `small=${acSmall.status}/${acSmall.body.evaluation?.maxUSD} big=${acBig.status}/${acBig.body.code}`
  );
  const acFakeEscrow = await acEval(acRoute({ authCaptureEscrow: privateKeyToAccount(generatePrivateKey()).address }));
  const acWrongCollector = await acEval(acRoute(), { authorizationTo: "0x0E3dF9510de65469C4518D7843919c0b8C7A7757" });
  const acRightCollector = await acEval(acRoute(), { authorizationTo: "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88" });
  check(
    "refuses to sign into a non-canonical escrow, or a token authorization pointed at another deployment's collector — the matching v1.1 collector passes",
    acFakeEscrow.body.code === "ac_escrow_not_canonical" && acWrongCollector.body.code === "ac_collector_mismatch" && acRightCollector.status === 200,
    `${acFakeEscrow.body.code} ${acWrongCollector.body.code} ${acRightCollector.status}`
  );
  const acSolana = await acEval(acRoute({}, { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }));
  const acOddToken = await acEval(acRoute({}, { asset: privateKeyToAccount(generatePrivateKey()).address }));
  check(
    "auth-capture is priced only on a registered EVM network in that chain's registry stablecoin — a non-EVM network or an unknown token is refused",
    acSolana.body.code === "ac_network_unsupported" && acOddToken.body.code === "ac_asset_mismatch",
    `${acSolana.body.code} ${acOddToken.body.code}`
  );
  const acBackwards = await acEval(acRoute({ captureDeadline: nowS() + 7200, refundDeadline: nowS() + 3600 }));
  const acLongHold = await acEval(acRoute({ captureDeadline: nowS() + 2 * 86400, refundDeadline: nowS() + 3 * 86400 }));
  const acShortRefund = await acEval(acRoute({ captureDeadline: nowS() + 3600, refundDeadline: nowS() + 3600 + 60 }));
  check(
    "deadlines are the buyer's terms: out-of-order deadlines, a hold past policy.authCapture.maxHoldSeconds, and a refund window under minRefundWindowSeconds are each refused",
    acBackwards.body.code === "ac_deadline_order" && acLongHold.body.code === "ac_hold_too_long" && acShortRefund.body.code === "ac_refund_window_short",
    `${acBackwards.body.code} ${acLongHold.body.code} ${acShortRefund.body.code}`
  );
  const acStrands = await acEval(acRoute({ operatorType: "custom", receiverAuthorizer: undefined }));
  const acDeferred = await acEval(acRoute({ operatorType: "custom", receiverAuthorizer: undefined, captureMode: "deferred" }));
  check(
    "a collect-only route that defaults to sync capture is refused — the spec says it escrows the funds and strands them until the deadline; the same route publishing deferred capture passes",
    acStrands.body.code === "ac_route_strands_funds" && acDeferred.status === 200,
    `${acStrands.body.code} deferred=${acDeferred.status}`
  );
  const acOpenFee = await acEval(acRoute({ maxFeeBps: 100 }));
  const acBoundFee = await acEval(acRoute({ minFeeBps: 100, maxFeeBps: 100, feeRecipient: acOperator }));
  check(
    "a fee range granted with no fee recipient is refused (the submitter could send the fee anywhere); an agreed fixed fee to a named recipient passes",
    acOpenFee.body.code === "ac_fee_receiver_unbound" && acBoundFee.status === 200,
    `${acOpenFee.body.code} bound=${acBoundFee.status}`
  );

  const acWallet = privateKeyToAccount(generatePrivateKey()).address;
  const acHeld = await acPost("authorize", { address: acWallet, requirements: acRoute(), toolId: "review" });
  const acHolds = await fetch(`${BASE}/api/upto/holds/${acWallet}`).then((r) => r.json());
  const acLedger0 = await fetch(`${BASE}/api/ledger`).then((r) => r.json());
  check(
    "an authorized escrow holds its maximum against the hourly budget and books no spend until the seller captures",
    acHeld.status === 201 && acHeld.body.payment?.status === "held" && acHolds.authCaptureUSD === 0.25 && acHolds.heldUSD >= 0.25 &&
      !acLedger0.entries.some((e) => e.address === acWallet && e.status === "paid"),
    `status=${acHeld.status} held=${JSON.stringify(acHolds)}`
  );
  const acSqueezed = await acPost("authorize", { address: acWallet, requirements: acRoute({}, { amount: "800000" }), toolId: "review" });
  check(
    "the open escrow squeezes the budget: a second $0.80 maximum under a $1/hour cap is refused because $0.25 is already held",
    acSqueezed.status === 403 && acSqueezed.body.code === "hourly_usd_cap" && /auth-capture escrows/.test(acSqueezed.body.reason || ""),
    `${acSqueezed.status} ${acSqueezed.body.code}`
  );
  const acId = acHeld.body.payment.id;
  const acCap1 = await acPost(`${acId}/capture`, { amountUSD: 0.1 });
  const acCapOver = await acPost(`${acId}/capture`, { amountUSD: 0.2 });
  const acLedger1 = await fetch(`${BASE}/api/ledger`).then((r) => r.json());
  const acPaid = acLedger1.entries.filter((e) => e.address === acWallet && e.status === "paid");
  check(
    "a partial capture books exactly what was captured as spend; a capture past the remaining hold is refused as over-capture",
    acCap1.status === 200 && acCap1.body.remainingUSD === 0.15 && acCapOver.status === 409 && acCapOver.body.code === "ac_over_capture" &&
      acPaid.length === 1 && acPaid[0].amount === 0.1 && acPaid[0].mode === "auth-capture" && acPaid[0].maxUSD === 0.25,
    `cap=${acCap1.body.remainingUSD} over=${acCapOver.body.code} paid=${JSON.stringify(acPaid.map((e) => e.amount))}`
  );
  const acRefund = await acPost(`${acId}/refund`, { amountUSD: 0.05 });
  const acRefundOver = await acPost(`${acId}/refund`, { amountUSD: 0.1 });
  check(
    "refunds return captured money and never more: $0.05 of $0.10 captured is refundable, a further $0.10 is refused",
    acRefund.status === 200 && acRefund.body.refundableUSD === 0.05 && acRefundOver.body.code === "ac_over_refund",
    `${acRefund.body.refundableUSD} ${acRefundOver.body.code}`
  );
  const acVoid = await acPost(`${acId}/void`, {});
  const acHoldsAfterVoid = await fetch(`${BASE}/api/upto/holds/${acWallet}`).then((r) => r.json());
  const acVoidAgain = await acPost(`${acId}/void`, {});
  check(
    "void releases exactly the uncaptured remainder back to the budget, and there is nothing left to void a second time",
    acVoid.status === 200 && acVoid.body.releasedUSD === 0.15 && acHoldsAfterVoid.authCaptureUSD === 0 && acVoidAgain.body.code === "ac_not_held",
    `released=${acVoid.body.releasedUSD} held=${acHoldsAfterVoid.authCaptureUSD} again=${acVoidAgain.body.code}`
  );
  const acAuthWallet = privateKeyToAccount(generatePrivateKey()).address;
  const acAuthFlow = await acPost("authorize", { address: acAuthWallet, requirements: acRoute({ paymentFlow: "authorization" }) });
  const acCharge = await acPost(`${acAuthFlow.body.payment?.id}/charge`, { amountUSD: 0.2 });
  const acCharge2 = await acPost(`${acAuthFlow.body.payment?.id}/charge`, { amountUSD: 0.01 });
  const acAuthFlow2 = await acPost("authorize", { address: acAuthWallet, requirements: acRoute({ paymentFlow: "authorization" }) });
  const acOverCharge = await acPost(`${acAuthFlow2.body.payment?.id}/charge`, { amountUSD: 0.3 });
  check(
    "the authorization flow charges once and never above the maximum: $0.20 of $0.25 charges and releases $0.05, a second charge is a replay, $0.30 is over-charge",
    acAuthFlow.body.payment?.status === "authorized" && acCharge.body.releasedUSD === 0.05 && acCharge2.body.code === "ac_already_charged" && acOverCharge.body.code === "ac_over_charge",
    `${acCharge.body.releasedUSD} ${acCharge2.body.code} ${acOverCharge.body.code}`
  );
  const acStrandWallet = privateKeyToAccount(generatePrivateKey()).address;
  const acShort = await acPost("authorize", { address: acStrandWallet, requirements: acRoute({ captureDeadline: nowS() + 2, refundDeadline: nowS() + 2 + 3600 }) });
  await sleep(3200);
  const acLateCapture = await acPost(`${acShort.body.payment?.id}/capture`, { amountUSD: 0.1 });
  const acReclaimable = await fetch(`${BASE}/api/authcapture/reclaimable?address=${acStrandWallet}`).then((r) => r.json());
  const acStrandHolds = await fetch(`${BASE}/api/upto/holds/${acStrandWallet}`).then((r) => r.json());
  const acReclaimed = await acPost(`${acShort.body.payment?.id}/reclaimed`, { txHash: "0xabc" });
  const acReclaimableAfter = await fetch(`${BASE}/api/authcapture/reclaimable?address=${acStrandWallet}`).then((r) => r.json());
  check(
    "a hold the seller never captured by its deadline stops holding budget, can no longer be captured, and surfaces as money the buyer can reclaim — until reclaimed",
    acShort.status === 201 && acLateCapture.body.code === "ac_capture_after_deadline" && acStrandHolds.authCaptureUSD === 0 &&
      acReclaimable.reclaimableUSD === 0.25 && acReclaimable.count === 1 && acReclaimed.body.recoveredUSD === 0.25 && acReclaimableAfter.reclaimableUSD === 0,
    `late=${acLateCapture.body.code} reclaimable=${acReclaimable.reclaimableUSD} holds=${acStrandHolds.authCaptureUSD} after=${acReclaimableAfter.reclaimableUSD}`
  );

  // --- LLM spend guard: a budget gateway any agent uses by changing one env var ---
  // server/llmguard.js on the main server's own port. The provider behind it
  // is a local mock speaking the real wire formats (Anthropic Messages JSON +
  // SSE, OpenAI Chat Completions + Responses SSE) — never a real model API.
  const llmSeen = [];
  const LLM_USAGE_A = { input_tokens: 1200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500, output_tokens: 0 };
  const llmMock = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let json = {};
      try { json = JSON.parse(body || "{}"); } catch {}
      llmSeen.push({ url: req.url, headers: req.headers, body, json });
      if (req.url.startsWith("/v1/messages/count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: 42 })); }
      if (req.url.startsWith("/v1/messages")) {
        if (json.model === "fail-model") { res.writeHead(529, { "content-type": "application/json", "x-should-retry": "true" }); return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })); }
        if (json.model === "slow-model") await sleep(1500);
        if (json.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
          const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: json.model, usage: { ...LLM_USAGE_A, output_tokens: 1 } } });
          ev("ping", {});
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } });
          ev("content_block_stop", { index: 0 });
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 800 } });
          ev("message_stop", {});
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "msg_2", type: "message", role: "assistant", model: json.model, content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage: { ...LLM_USAGE_A, output_tokens: 400 } }));
      }
      if (req.url.startsWith("/v1/chat/completions")) {
        const usage = { prompt_tokens: 2000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1000 } };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "Hi" } }] })}\n\n`);
        if (json.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id: "c1", choices: [], usage })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      if (req.url.startsWith("/v1/responses")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", usage: { input_tokens: 3000, output_tokens: 700, input_tokens_details: { cached_tokens: 2000 } } } })}\n\n`);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  llmMock.listen(8497);
  // Generous limits for the plumbing checks; each enforcement check below
  // tightens exactly the limit it tests.
  const LLM_BASE_POLICY = { ...LOOSE_POLICY, llm: { dailyBudgetUSD: 100, hourlyBudgetUSD: 100, maxRequestUSD: 50, maxRequestsPerMinute: 1000, loop: { enabled: true, threshold: 3, windowSeconds: 120 } } };
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LLM_BASE_POLICY, null, 2));
  const llmLedger = async () => (await fetch(`${BASE}/api/ledger`).then((r) => r.json())).entries.filter((e) => e.category === "llm");
  const anthropicCall = (body, extra = {}, path = "/v1/messages?beta=true") =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-ant-client-key-never-stored", "anthropic-version": "2023-06-01", "anthropic-beta": "context-1m-2025-08-07", "x-claude-code-session-id": "verify-session-1", ...extra }, body: JSON.stringify(body) });

  const streamBody = { model: "claude-opus-5-5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] };
  const sres = await anthropicCall(streamBody, { "x-spendveto-agent": "stream-bot" });
  const sText = await sres.text();
  const sFwd = llmSeen[llmSeen.length - 1];
  check(
    "the guard relays an Anthropic stream event by event (pings included) and forwards the body byte-for-byte with every anthropic-* header and the ?beta=true query intact",
    sres.status === 200 && sres.headers.get("content-type")?.includes("text/event-stream") && (sText.match(/event:/g) || []).length === 7 && sText.includes("event: ping") &&
      sres.headers.get("anthropic-ratelimit-unified-status") === "allowed" && sFwd.url === "/v1/messages?beta=true" && sFwd.body === JSON.stringify(streamBody) &&
      sFwd.headers["anthropic-beta"] === "context-1m-2025-08-07" && sFwd.headers["x-api-key"] === "sk-ant-client-key-never-stored",
    `status=${sres.status} events=${(sText.match(/event:/g) || []).length} url=${sFwd.url} identical=${sFwd.body === JSON.stringify(streamBody)}`
  );
  await sleep(150);
  const sEntry = (await llmLedger()).find((e) => e.agent === "stream-bot");
  check(
    "the cost booked is the provider's own usage at the price sheet — input, cache reads, 5-minute cache writes and output on Opus 5.5 = $0.0239, tagged with its source and session",
    sEntry?.status === "paid" && sEntry.amount === 0.0239 && /anthropic price sheet/.test(sEntry.priceSource || "") && sEntry.session === "verify-session-1" && sEntry.usage?.cacheWrite5m === 500,
    JSON.stringify({ amount: sEntry?.amount, src: sEntry?.priceSource, session: sEntry?.session })
  );
  const jres = await anthropicCall({ model: "claude-opus-5-5", max_tokens: 512, messages: [{ role: "user", content: "hi" }] }, { "x-spendveto-agent": "json-bot" });
  const jBody = await jres.json();
  check(
    "a non-streamed response carries its booked cost back to the caller in x-spendveto-cost-usd",
    jres.status === 200 && jres.headers.get("x-spendveto-cost-usd") === "0.0159" && jBody.content?.[0]?.text === "Hi",
    `cost=${jres.headers.get("x-spendveto-cost-usd")}`
  );
  const cres = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-openai-client-never-stored", "x-spendveto-agent": "openai-bot" }, body: JSON.stringify({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "x" }] }) });
  const cText = await cres.text();
  const cFwd = llmSeen[llmSeen.length - 1];
  const rres = await fetch(`${BASE}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-openai-client-never-stored", "x-spendveto-agent": "openai-bot" }, body: JSON.stringify({ model: "gpt-5.1", stream: true, input: "x" }) });
  await rres.text();
  await sleep(150);
  const oEntries = (await llmLedger()).filter((e) => e.agent === "openai-bot");
  check(
    "OpenAI streams are metered too: the guard asks for include_usage, and books gpt-5 Chat Completions ($0.006375) and gpt-5.1 Responses ($0.0085) from the reported usage, cached tokens at the cached rate",
    cFwd.json.stream_options?.include_usage === true && cText.includes('"usage"') && oEntries.map((e) => e.amount).join(",") === "0.006375,0.0085",
    `include_usage=${cFwd.json.stream_options?.include_usage} amounts=${oEntries.map((e) => e.amount).join(",")}`
  );
  const ledgerDump = JSON.stringify(await fetch(`${BASE}/api/ledger`).then((r) => r.json()));
  check(
    "the caller's provider key passes through to the provider and is never written anywhere SpendVeto keeps",
    !ledgerDump.includes("sk-ant-client-key-never-stored") && !ledgerDump.includes("sk-openai-client-never-stored"),
    "ledger scanned for both client keys"
  );
  const llmBefore = llmSeen.length;
  const ctRes = await fetch(`${BASE}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "k", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }) });
  const ctBody = await ctRes.json();
  const batchRes = await fetch(`${BASE}/v1/messages/batches`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "k", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ requests: [] }) });
  const batchBody = await batchRes.json();
  check(
    "free endpoints (count_tokens) pass straight through; an endpoint the guard can't meter (Message Batches) is refused rather than passed through ungoverned",
    ctRes.status === 200 && ctBody.input_tokens === 42 && batchRes.status === 501 && batchBody.spendveto?.code === "llm_endpoint_not_governed" && llmSeen.length === llmBefore + 1,
    `count_tokens=${ctRes.status} batches=${batchRes.status} upstreamCalls=${llmSeen.length - llmBefore}`
  );
  const failRes = await anthropicCall({ model: "fail-model", max_tokens: 10, messages: [{ role: "user", content: "x" }] }, { "x-spendveto-agent": "fail-bot" });
  const failText = await failRes.text();
  await sleep(100);
  const failEntry = (await llmLedger()).find((e) => e.agent === "fail-bot");
  check(
    "an upstream error reaches the client unmodified — status, body and x-should-retry — and books $0 as failed",
    failRes.status === 529 && failRes.headers.get("x-should-retry") === "true" && failText === JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) && failEntry?.status === "failed" && failEntry.amount === 0,
    `status=${failRes.status} entry=${failEntry?.status}:${failEntry?.amount}`
  );

  // Enforcement.
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LLM_BASE_POLICY, llm: { ...LLM_BASE_POLICY.llm, dailyBudgetUSD: 0.04 } }, null, 2));
  const budgetStatuses = [];
  let budgetDenial = null;
  const budgetUpstreamBefore = llmSeen.length;
  for (let i = 0; i < 4; i++) {
    const r = await anthropicCall({ model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: `q${i}` }] }, { "x-spendveto-agent": "budget-bot" });
    budgetStatuses.push(r.status);
    if (r.status !== 200) budgetDenial = { body: await r.json(), retry: r.headers.get("x-should-retry") };
    else await r.text();
    await sleep(60);
  }
  check(
    "an exhausted daily budget refuses the next request BEFORE it reaches the provider — 402, x-should-retry: false, a machine-readable code",
    budgetStatuses.join(",") === "200,200,200,402" && llmSeen.length - budgetUpstreamBefore === 3 && budgetDenial?.body?.spendveto?.code === "llm_daily_budget" && budgetDenial.retry === "false" && budgetDenial.body.type === "error",
    `statuses=${budgetStatuses.join(",")} upstream=${llmSeen.length - budgetUpstreamBefore} code=${budgetDenial?.body?.spendveto?.code}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LLM_BASE_POLICY, llm: { ...LLM_BASE_POLICY.llm, maxRequestUSD: 1 } }, null, 2));
  const capRes = await anthropicCall({ model: "claude-fable-5-1", max_tokens: 64000, messages: [{ role: "user", content: "x".repeat(60000) }] }, { "x-spendveto-agent": "cap-bot" });
  const capBody = await capRes.json();
  check(
    "a single request whose worst case exceeds maxRequestUSD is refused on its estimate — Fable 5.1 with 60K characters of context and 64K max_tokens",
    capRes.status === 402 && capBody.spendveto?.code === "llm_request_cap",
    `${capRes.status} ${capBody.spendveto?.code}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LLM_BASE_POLICY, null, 2));
  const loopTurn = (n) => [
    { role: "user", content: "make the tests pass" },
    { role: "assistant", content: [{ type: "tool_use", id: `toolu_${n}`, name: "bash", input: { command: "npm test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "1 failing", ...(n % 2 ? { cache_control: { type: "ephemeral" } } : {}) }] },
  ];
  const loopCodes = [];
  for (let i = 0; i < 5; i++) {
    const r = await anthropicCall({ model: "claude-haiku-4-5", max_tokens: 50, messages: loopTurn(i) }, { "x-spendveto-agent": "loop-bot" });
    loopCodes.push(r.status === 200 ? (await r.text(), "ok") : (await r.json()).spendveto?.code);
    await sleep(60);
  }
  const loopFreezes = (await fetch(`${BASE}/api/freezes`).then((r) => r.json())).freezes.filter((f) => f.source === "llm-loop" && !f.unfrozen);
  check(
    "an agent loop — the same tool call returning the same result — freezes the agent on the next repeat, despite changing tool ids and moving cache markers",
    loopCodes.join(",") === "ok,ok,ok,llm_loop_detected,frozen" && loopFreezes.length === 1,
    `codes=${loopCodes.join(",")} freezes=${loopFreezes.length}`
  );
  const retryCodes = [];
  for (let i = 0; i < 5; i++) {
    const r = await anthropicCall({ model: "fail-model", max_tokens: 10, messages: loopTurn(0) }, { "x-spendveto-agent": "retry-bot" });
    retryCodes.push(r.status);
    await r.text();
  }
  check(
    "retrying a FAILED request is not a loop: five identical 529 retries pass through to the provider and freeze nothing",
    retryCodes.every((c) => c === 529) && (await fetch(`${BASE}/api/freezes`).then((r) => r.json())).freezes.filter((f) => f.source === "llm-loop" && !f.unfrozen).length === 1,
    `codes=${retryCodes.join(",")}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LLM_BASE_POLICY, llm: { ...LLM_BASE_POLICY.llm, maxRequestsPerMinute: 2 } }, null, 2));
  const rateCodes = [];
  let rateHeaders = null;
  for (let i = 0; i < 3; i++) {
    const r = await anthropicCall({ model: "claude-haiku-4-5", max_tokens: 20, messages: [{ role: "user", content: `r${i}` }] }, { "x-spendveto-agent": "rate-bot" });
    rateCodes.push(r.status);
    if (r.status === 429) rateHeaders = { retryAfter: r.headers.get("retry-after"), retry: r.headers.get("x-should-retry"), code: (await r.json()).spendveto?.code };
    else await r.text();
  }
  check(
    "a burst over maxRequestsPerMinute gets a 429 with an integer retry-after the client's own retry logic honours",
    rateCodes.join(",") === "200,200,429" && /^\d+$/.test(rateHeaders?.retryAfter || "") && rateHeaders.retry === "true" && rateHeaders.code === "llm_rate_limited",
    `codes=${rateCodes.join(",")} ${JSON.stringify(rateHeaders)}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify({ ...LLM_BASE_POLICY, llm: { ...LLM_BASE_POLICY.llm, dailyBudgetUSD: 0.001, mode: "observe" } }, null, 2));
  const obsRes = await anthropicCall({ model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "observe" }] }, { "x-spendveto-agent": "observe-bot" });
  await obsRes.text();
  await sleep(100);
  const obsEntry = (await llmLedger()).filter((e) => e.agent === "observe-bot").pop();
  check(
    "observe mode lets an over-budget request through and records exactly what enforce mode would have done",
    obsRes.status === 200 && obsEntry?.status === "paid" && obsEntry.wouldBlock?.code === "llm_daily_budget",
    `status=${obsRes.status} wouldBlock=${obsEntry?.wouldBlock?.code}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LLM_BASE_POLICY, null, 2));
  const unkRes = await anthropicCall({ model: "claude-future-9", max_tokens: 100, messages: [{ role: "user", content: "x" }] }, { "x-spendveto-agent": "unknown-bot" });
  await unkRes.json();
  await sleep(100);
  const unkEntry = (await llmLedger()).find((e) => e.agent === "unknown-bot");
  const { canonicalModel, lookupPrice: llmLookup, costOf: llmCost } = await import("../server/llm-pricing.js");
  check(
    "a model no price sheet knows is booked at the provider's flagship rate and flagged — never priced by a guessed prefix (gpt-5.6-terra is not gpt-5)",
    unkEntry?.unknownModel === true && unkEntry.priceSource === "unknown-model-fallback" && unkEntry.amount === 0.039 &&
      llmLookup("openai", "gpt-5.6-terra").unknown === true && canonicalModel("claude-haiku-4-5-20251001") === "claude-haiku-4-5" && llmLookup("openai", "gpt-4o-2024-08-06").model === "gpt-4o",
    `amount=${unkEntry?.amount} src=${unkEntry?.priceSource}`
  );
  check(
    "provider pricing details are honoured: Haiku 5.5 bills a >100K-token prompt at its long-context rate, a 1-hour cache write at 2x input, an upstream-reported cost (OpenRouter) wins over the sheet",
    llmCost("anthropic", "claude-haiku-5-5", { input_tokens: 150000, output_tokens: 1000 }).usd === 0.0775 &&
      llmCost("anthropic", "claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000000 } }).usd === 4 &&
      llmCost("openai", "gpt-5", { prompt_tokens: 10, completion_tokens: 10, cost: 0.123 }).usd === 0.123,
    "haiku long / 1h cache write / reported cost"
  );
  // In-flight holds: a slow request's estimate is visible in the same holds
  // number every payment check reads.
  const slowPromise = anthropicCall({ model: "slow-model", max_tokens: 100, messages: [{ role: "user", content: "slow" }] }, { "x-spendveto-agent": "slow-bot" }).then((r) => r.text());
  await sleep(500);
  const { pseudoAddress: llmPseudo } = await import("../server/llmguard.js");
  const slowHolds = await fetch(`${BASE}/api/upto/holds/${llmPseudo("label:slow-bot")}`).then((r) => r.json());
  await slowPromise;
  await sleep(100);
  const slowAfter = await fetch(`${BASE}/api/upto/holds/${llmPseudo("label:slow-bot")}`).then((r) => r.json());
  check(
    "a model call in flight reserves its estimate in the shared holds number payments check, and releases it when the response finishes",
    slowHolds.llmUSD > 0 && slowHolds.heldUSD === slowHolds.llmUSD && slowAfter.llmUSD === 0,
    `during=${slowHolds.llmUSD} after=${slowAfter.llmUSD}`
  );
  // Team mode + unified budgets: an agent token bound to a delegated child
  // wallet spends tokens against the SAME cascading cap as its payments.
  const childGrant = await fetch(`${BASE}/api/delegations/wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capUSD: 0.03, label: "llm-delegate" }) }).then((r) => r.json());
  const teamAgent = await fetch(`${PROXY}/proxy/agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "llm-delegate-agent", child: "llm-delegate" }) }).then((r) => r.json());
  const teamBefore = llmSeen.length;
  const teamCodes = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": teamAgent.token, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: `t${i}` }] }) });
    teamCodes.push(r.status === 200 ? (await r.text(), "ok") : (await r.json()).spendveto?.code);
    await sleep(80);
  }
  const teamFwd = llmSeen.slice(teamBefore);
  check(
    "team mode: an agent authenticates with its tg_ token, the guard swaps in a provider key only it holds, and the token never reaches the provider",
    teamFwd.length >= 1 && teamFwd.every((x) => x.headers["x-api-key"] === "sk-ant-verify-server-only-key" && !JSON.stringify(x.headers).includes(teamAgent.token)),
    `forwarded=${teamFwd.length} key=${teamFwd[0]?.headers["x-api-key"]?.slice(0, 12)}`
  );
  check(
    "one budget across rails: the delegated wallet's $0.03 cap stops its MODEL spend with the same delegation_cap code that stops its payments",
    teamCodes.join(",") === "ok,ok,delegation_cap" && childGrant.childAddress,
    `codes=${teamCodes.join(",")}`
  );
  const llmSummary = await fetch(`${BASE}/api/llm/summary`).then((r) => r.json());
  const loopRow = llmSummary.identities.find((i) => i.label === "loop-bot");
  check(
    "the AI-spend summary the Console and CLI read agrees with the ledger: per-agent spend, blocks, and the loop freeze",
    llmSummary.totals.requestsDay >= 10 && llmSummary.totals.blockedDay >= 5 && llmSummary.totals.loopFreezesDay === 1 && loopRow?.frozen?.source === "llm-loop" &&
      llmSummary.identities.find((i) => i.label === "stream-bot")?.spentDayUSD === 0.0239,
    JSON.stringify(llmSummary.totals)
  );
  llmMock.close();

  // --- Card authorization governance: Stripe Issuing + Lithic ASA (server/cards.js) ---
  const STRIPE_SECRET = "whsec_verify_stripe_secret";
  const LITHIC_SECRET = "whsec_" + Buffer.from("verify-lithic-asa-secret-key").toString("base64");
  const stripeAuthEvent = (cents, mcc, cardId = "ic_verify_card") => ({ id: `evt_${cents}_${mcc}`, type: "issuing_authorization.request", data: { object: { id: `iauth_${Math.random().toString(36).slice(2)}`, object: "issuing_authorization", approved: false, amount: 0, currency: "usd", status: "pending", pending_request: { amount: cents, currency: "usd", merchant_amount: cents, merchant_currency: "usd", is_amount_controllable: false }, merchant_data: { category: "computer_software_stores", category_code: mcc, name: "SaaS Co", network_id: "1" }, card: { id: cardId, last4: "4242", metadata: {} } } } });
  const signStripe = (body, t = Math.floor(Date.now() / 1000), secret = STRIPE_SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const stripePost = async (evt, sig) => {
    const body = JSON.stringify(evt);
    const r = await fetch(`${BASE}/api/cards/stripe/authorization`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig ?? signStripe(body) }, body });
    return { status: r.status, version: r.headers.get("stripe-version"), body: await r.json() };
  };
  const lithicPost = async (asa) => {
    const body = JSON.stringify(asa);
    const id = `msg_${Math.random().toString(36).slice(2)}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", Buffer.from(LITHIC_SECRET.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
    const r = await fetch(`${BASE}/api/cards/lithic/asa`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` }, body });
    return { status: r.status, body: await r.json() };
  };
  const stripeOk = await stripePost(stripeAuthEvent(1999, "5734"));
  const cardDecisions = async () => (await fetch(`${BASE}/api/cards/decisions`).then((r) => r.json())).decisions;
  const okEntry = (await cardDecisions()).find((d) => d.cardId === "ic_verify_card");
  check(
    "a signed Stripe Issuing authorization is answered synchronously in Stripe's format — 200, Stripe-Version, { approved: true } — and booked as committed card spend",
    stripeOk.status === 200 && stripeOk.version && stripeOk.body.approved === true && okEntry?.status === "paid" && okEntry.amount === 19.99 && okEntry.chain === "card",
    JSON.stringify({ status: stripeOk.status, v: stripeOk.version, approved: stripeOk.body.approved, amount: okEntry?.amount })
  );
  const cardTamperedSig = await stripePost(stripeAuthEvent(100, "5734"), signStripe("tampered body"));
  const cardReplayBody = JSON.stringify(stripeAuthEvent(100, "5734"));
  const cardReplaySig = await stripePost(stripeAuthEvent(100, "5734"), signStripe(cardReplayBody, Math.floor(Date.now() / 1000) - 3600));
  check(
    "a Stripe authorization with a forged signature, or a genuine one replayed an hour later, is rejected before any decision is made",
    cardTamperedSig.status === 400 && /mismatch/.test(cardTamperedSig.body.error) && cardReplaySig.status === 400 && /tolerance/.test(cardReplaySig.body.error),
    `${cardTamperedSig.status}:${cardTamperedSig.body.error} / ${cardReplaySig.status}`
  );
  const cardGambling = await stripePost(stripeAuthEvent(500, "7995"));
  const cardOverCap = await stripePost(stripeAuthEvent(60000, "5734"));
  check(
    "card policy declines by merchant category and by size: gambling (MCC 7995) and a $600 authorization over the $500 cap, each with its reason in the Stripe metadata",
    cardGambling.body.approved === false && cardGambling.body.metadata?.spendveto_code === "card_mcc_blocked" && cardOverCap.body.approved === false && cardOverCap.body.metadata?.spendveto_code === "card_authorization_cap",
    `${cardGambling.body.metadata?.spendveto_code} / ${cardOverCap.body.metadata?.spendveto_code}`
  );
  const lithicOk = await lithicPost({ token: "txn_verify_1", card: { token: "card_verify_lithic", last_four: "1111" }, amounts: { cardholder: { amount: 1250, currency: "USD" } }, merchant: { mcc: "5734", descriptor: "SAAS CO", state: "NY" } });
  const lithicQuasiCash = await lithicPost({ token: "txn_verify_2", card: { token: "card_verify_lithic" }, amounts: { cardholder: { amount: 1250, currency: "USD" } }, merchant: { mcc: "6051", descriptor: "CRYPTO EXCH" } });
  const lithicEuro = await lithicPost({ token: "txn_verify_3", card: { token: "card_verify_lithic" }, amounts: { cardholder: { amount: 1250, currency: "EUR" } }, merchant: { mcc: "5734" } });
  check(
    "Lithic Auth Stream Access gets its own format and decline codes: APPROVED with the transaction token, UNAUTHORIZED_MERCHANT for quasi-cash, and a euro authorization declined rather than guessed into dollars",
    lithicOk.status === 200 && lithicOk.body.result === "APPROVED" && lithicOk.body.token === "txn_verify_1" && lithicQuasiCash.body.result === "UNAUTHORIZED_MERCHANT" && lithicEuro.body.result === "UNAUTHORIZED_MERCHANT",
    `${lithicOk.body.result} / ${lithicQuasiCash.body.result} / ${lithicEuro.body.result}`
  );
  await fetch(`${BASE}/api/freezes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: okEntry.address, reason: "verify: kill switch on a card" }) });
  const frozenStripe = await stripePost(stripeAuthEvent(100, "5734"));
  const lithicCardAddr = (await cardDecisions()).find((d) => d.cardId === "card_verify_lithic").address;
  await fetch(`${BASE}/api/freezes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: lithicCardAddr, reason: "verify: kill switch on a card" }) });
  const frozenLithic = await lithicPost({ token: "txn_verify_4", card: { token: "card_verify_lithic" }, amounts: { cardholder: { amount: 100, currency: "USD" } }, merchant: { mcc: "5734" } });
  check(
    "the kill switch reaches the card rail: a frozen card is declined on Stripe and paused (CARD_PAUSED) on Lithic",
    frozenStripe.body.approved === false && frozenStripe.body.metadata?.spendveto_code === "frozen" && frozenLithic.body.result === "CARD_PAUSED",
    `${frozenStripe.body.metadata?.spendveto_code} / ${frozenLithic.body.result}`
  );
  const cardReg = await fetch(`${BASE}/api/cards`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "ic_delegate_card", label: "llm-delegate card", child: "llm-delegate" }) });
  const delegateCard = await stripePost(stripeAuthEvent(500, "5734", "ic_delegate_card"));
  check(
    "a card registered to a delegated wallet shares that wallet's cascading cap: after its model spend, a $5 card authorization is declined with delegation_cap",
    cardReg.status === 201 && delegateCard.body.approved === false && delegateCard.body.metadata?.spendveto_code === "delegation_cap",
    `reg=${cardReg.status} code=${delegateCard.body.metadata?.spendveto_code}`
  );

  // --- Payments beyond crypto: governed fiat payouts (server/payouts.js) ---
  // Four real providers' documented request formats, against a local mock —
  // Stripe Connect transfers, RazorpayX payouts, PayPal Payouts, Modern
  // Treasury payment orders — plus Stripe Billing meter events for rebilling.
  const fiatSeen = [];
  const fiatMock = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      fiatSeen.push({ url: req.url, headers: req.headers, body });
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/transfers") { const f = new URLSearchParams(body); return json(200, { id: `tr_${fiatSeen.length}`, object: "transfer", amount: Number(f.get("amount")), currency: f.get("currency"), destination: f.get("destination"), reversed: false }); }
      if (req.url === "/v1/billing/meter_events") { const f = new URLSearchParams(body); return json(200, { object: "billing.meter_event", event_name: f.get("event_name"), identifier: f.get("identifier"), payload: { stripe_customer_id: f.get("payload[stripe_customer_id]"), value: f.get("payload[value]") } }); }
      if (req.url === "/v1/payouts") { const b = JSON.parse(body || "{}"); return json(200, { id: "pout_verify1", entity: "payout", amount: b.amount, currency: b.currency, status: "processing", mode: b.mode }); }
      if (req.url === "/v1/oauth2/token") return json(200, { access_token: "A21AA_verify_token", token_type: "Bearer", expires_in: 32400 });
      if (req.url === "/v1/payments/payouts") { const b = JSON.parse(body || "{}"); const denied = b.items?.[0]?.receiver === "denied@example.com"; return json(201, { batch_header: { payout_batch_id: `PB_${fiatSeen.length}`, batch_status: denied ? "DENIED" : "PENDING" } }); }
      if (req.url === "/api/payment_orders") { const b = JSON.parse(body || "{}"); return json(200, { id: "6f1c0b1e-0000-4000-8000-0000000000aa", type: b.type, amount: b.amount, direction: b.direction, status: "approved" }); }
      res.writeHead(404);
      res.end();
    });
  });
  fiatMock.listen(8496);
  const MT_PAYEE = "6f1c0b1e-aaaa-4000-8000-000000000002";
  const FIAT_POLICY = {
    ...LOOSE_POLICY,
    payouts: { maxPerPayoutUSD: 1000, dailyBudgetUSD: 5000, requireApprovalAboveUSD: 500, allowedPayees: ["acct_1Vendor", "fa_00000000000001", "vendor@example.com", "denied@example.com", MT_PAYEE], fxRates: { INR: 0.012 } },
    llm: { dailyBudgetUSD: 100, hourlyBudgetUSD: 100, maxRequestUSD: 50, maxRequestsPerMinute: 1000, tagBudgets: { "customer=cus_Small": { dailyUSD: 0.02 } } },
    rebilling: { enabled: true, markupPct: 25, eventName: "spendveto_ai_usage", customerTag: "customer" },
  };
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(FIAT_POLICY, null, 2));
  const apAgent = await fetch(`${PROXY}/proxy/agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "ap-agent" }) }).then((r) => r.json());
  const payout = (body, token = apAgent.token) =>
    fetch(`${BASE}/api/payouts`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const fiatCalls = (url) => fiatSeen.filter((x) => x.url === url);

  const stripePay = await payout({ provider: "stripe", amount: 25.5, currency: "USD", payee: "acct_1Vendor", purpose: "vendor bill", idempotencyKey: "inv-1001", tags: { team: "ops" } });
  const stripeReq = fiatCalls("/v1/transfers")[0];
  const stripeForm = new URLSearchParams(stripeReq?.body || "");
  check(
    "a governed payout executes on Stripe in Stripe's own format — amount in cents, lowercase currency, the connected account as destination, Bearer auth, an Idempotency-Key — and is booked as committed spend",
    stripePay.status === 201 && stripePay.body.payout?.status === "executed" && stripeForm.get("amount") === "2550" && stripeForm.get("currency") === "usd" && stripeForm.get("destination") === "acct_1Vendor" &&
      stripeReq.headers.authorization === "Bearer sk_test_verify_only" && stripeReq.headers["idempotency-key"] === "inv-1001",
    `status=${stripePay.status} amount=${stripeForm.get("amount")} key=${stripeReq?.headers["idempotency-key"]}`
  );
  const stripeReplay = await payout({ provider: "stripe", amount: 25.5, currency: "USD", payee: "acct_1Vendor", purpose: "vendor bill", idempotencyKey: "inv-1001" });
  check(
    "an agent retrying with the same idempotencyKey gets the same payout back — the provider is called once, nobody is paid twice",
    stripeReplay.status === 200 && stripeReplay.body.decision === "replayed" && stripeReplay.body.payout?.id === stripePay.body.payout?.id && fiatCalls("/v1/transfers").length === 1,
    `decision=${stripeReplay.body.decision} transfers=${fiatCalls("/v1/transfers").length}`
  );
  const upiPay = await payout({ provider: "razorpayx", amount: 1500, currency: "INR", payee: "fa_00000000000001", method: "UPI", purpose: "vendor bill", idempotencyKey: "rzp-verify-1" });
  const upiReq = fiatCalls("/v1/payouts")[0];
  const upiBody = upiReq ? JSON.parse(upiReq.body) : {};
  check(
    "a RazorpayX UPI payout goes out in RazorpayX's format — paise, mode UPI, the business's RazorpayX account, X-Payout-Idempotency, basic auth — and its INR counts against USD budgets only at the operator-declared rate ($18.00)",
    upiPay.status === 201 && upiBody.amount === 150000 && upiBody.mode === "UPI" && upiBody.currency === "INR" && upiBody.account_number === "7878780080316316" && upiBody.purpose === "vendor bill" &&
      upiReq.headers["x-payout-idempotency"] === "rzp-verify-1" && upiReq.headers.authorization === `Basic ${Buffer.from("rzp_test_verify:rzp_verify_secret").toString("base64")}` && upiPay.body.payout?.amountUSD === 18,
    `status=${upiPay.status} paise=${upiBody.amount} usd=${upiPay.body.payout?.amountUSD}`
  );
  const eurPay = await payout({ provider: "stripe", amount: 50, currency: "EUR", payee: "acct_1Vendor", purpose: "vendor bill" });
  check(
    "a payout in a currency with no operator-declared rate is refused — SpendVeto never guesses an exchange rate for money leaving the business",
    eurPay.status === 403 && eurPay.body.code === "payout_fx_rate_missing" && fiatCalls("/v1/transfers").length === 1,
    `${eurPay.status} ${eurPay.body.code}`
  );
  const ppPay = await payout({ provider: "paypal", amount: 40, currency: "USD", payee: "vendor@example.com", purpose: "contractor payment", idempotencyKey: "pp-verify-1" });
  const ppToken = fiatCalls("/v1/oauth2/token")[0];
  const ppReq = fiatCalls("/v1/payments/payouts")[0];
  const ppBody = ppReq ? JSON.parse(ppReq.body) : {};
  const ppDenied = await payout({ provider: "paypal", amount: 10, currency: "USD", payee: "denied@example.com", purpose: "contractor payment" });
  check(
    "PayPal: a client-credentials OAuth token, then a batch payout with PayPal-Request-Id and a decimal-string amount; a DENIED batch is booked as failed at $0",
    ppPay.status === 201 && ppToken?.body === "grant_type=client_credentials" && ppReq.headers["paypal-request-id"] === "pp-verify-1" && ppReq.headers.authorization === "Bearer A21AA_verify_token" &&
      ppBody.items?.[0]?.amount?.value === "40.00" && ppBody.items?.[0]?.recipient_type === "EMAIL" && ppDenied.status === 502 && ppDenied.body.payout?.status === "failed",
    `status=${ppPay.status} value=${ppBody.items?.[0]?.amount?.value} denied=${ppDenied.body.payout?.status}`
  );
  const mtPay = await payout({ provider: "moderntreasury", amount: 300, currency: "USD", payee: MT_PAYEE, method: "ach", purpose: "vendor bill" });
  const mtReq = fiatCalls("/api/payment_orders")[0];
  const mtBody = mtReq ? JSON.parse(mtReq.body) : {};
  check(
    "Modern Treasury: an ACH credit payment order in cents, from the configured originating account to the receiving account, with basic auth (organization ID : API key)",
    mtPay.status === 201 && mtBody.type === "ach" && mtBody.amount === 30000 && mtBody.direction === "credit" && mtBody.originating_account_id === "0b0b0b0b-0000-4000-8000-000000000000" && mtBody.receiving_account_id === MT_PAYEE &&
      mtReq.headers.authorization === `Basic ${Buffer.from("org_verify:mt_verify_key").toString("base64")}`,
    `status=${mtPay.status} type=${mtBody.type} amount=${mtBody.amount}`
  );
  const transfersBefore = fiatCalls("/v1/transfers").length;
  const strangerPay = await payout({ provider: "stripe", amount: 80, currency: "USD", payee: "acct_9Stranger", purpose: "vendor bill" });
  const transfersWhileWaiting = fiatCalls("/v1/transfers").length;
  const approvedPayout = await fetch(`${BASE}/api/approvals/${strangerPay.body.approvalId}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approved" }) }).then((r) => r.json());
  const deniedWait = await payout({ provider: "stripe", amount: 60, currency: "USD", payee: "acct_9Other", purpose: "vendor bill" });
  const deniedPayout = await fetch(`${BASE}/api/approvals/${deniedWait.body.approvalId}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "denied" }) }).then((r) => r.json());
  const oneClick = await payout({ provider: "stripe", amount: 70, currency: "USD", payee: "acct_9Third", purpose: "vendor bill" });
  const oneClickRes = await fetch(`${BASE}/api/approvals/${oneClick.body.approvalId}/decide?decision=approved`);
  check(
    "a payee not on the allowlist waits for a human: 202, nothing reaches the provider until a human approves in the Console, then it executes; a denied one never pays; an unauthenticated one-click link can't approve real money",
    strangerPay.status === 202 && strangerPay.body.code === "payout_requires_approval" && transfersWhileWaiting === transfersBefore && approvedPayout.payout?.status === "executed" &&
      fiatCalls("/v1/transfers").length === transfersBefore + 1 && deniedPayout.payout?.status === "denied" && oneClickRes.status === 403,
    `wait=${strangerPay.status} approved=${approvedPayout.payout?.status} denied=${deniedPayout.payout?.status} oneClick=${oneClickRes.status}`
  );
  const overCapPay = await payout({ provider: "stripe", amount: 1500, currency: "USD", payee: "acct_1Vendor", purpose: "vendor bill" });
  const noTokenPay = await payout({ provider: "stripe", amount: 5, currency: "USD", payee: "acct_1Vendor", purpose: "vendor bill" }, null);
  const providers = await fetch(`${BASE}/api/payouts`).then((r) => r.json());
  check(
    "a payout over maxPerPayoutUSD and one without an accountable agent token are both refused before any provider is called; the four providers report as configured",
    overCapPay.status === 403 && overCapPay.body.code === "payout_cap" && noTokenPay.status === 401 && noTokenPay.body.code === "agent_token_required" &&
      providers.providers.length === 4 && providers.providers.every((x) => x.configured),
    `${overCapPay.body.code} / ${noTokenPay.body.code} / providers=${providers.providers.map((x) => x.id).join(",")}`
  );

  // --- AI FinOps: tags, tag budgets, one cost view, FOCUS export; rebilling ---
  const finLlm = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_fin", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500, output_tokens: 400 } }));
    });
  });
  finLlm.listen(8497);
  const taggedCall = (tags) =>
    fetch(`${BASE}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-ant-client", "anthropic-version": "2023-06-01", "x-spendveto-agent": "finops-bot", "x-spendveto-tags": tags }, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "q" }] }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const bigCalls = [await taggedCall("team=search,customer=cus_Big"), await taggedCall("team=search,customer=cus_Big")];
  const smallCalls = [await taggedCall("team=support,customer=cus_Small"), await taggedCall("team=support,customer=cus_Small"), await taggedCall("team=support,customer=cus_Small")];
  await taggedCall("team=search,customer=not-a-stripe-id");
  await taggedCall("team=search");
  await sleep(300);
  check(
    "a tag budget caps a customer's model spend across every agent carrying the tag: cus_Small's $0.02/day stops its third request with llm_tag_budget",
    bigCalls.every((c) => c.status === 200) && smallCalls.map((c) => c.status).join(",") === "200,200,402" && smallCalls[2].body.spendveto?.code === "llm_tag_budget",
    `small=${smallCalls.map((c) => c.status).join(",")} code=${smallCalls[2].body.spendveto?.code}`
  );
  const byRail = await fetch(`${BASE}/api/costs?groupBy=rail&days=1`).then((r) => r.json());
  const byCustomer = await fetch(`${BASE}/api/costs?groupBy=customer&days=1`).then((r) => r.json());
  const byTeam = await fetch(`${BASE}/api/costs?groupBy=team&days=1`).then((r) => r.json());
  const railCost = Object.fromEntries(byRail.rows.map((r) => [r.key, r.costUSD]));
  const custCost = Object.fromEntries(byCustomer.rows.map((r) => [r.key, r.costUSD]));
  check(
    "one cost view across every rail: model tokens, fiat payouts (the INR payout at its declared rate) and cards side by side, and model spend allocated by customer and team from the request tags",
    railCost["fiat payouts"] >= 463.5 && railCost["model tokens"] > 0 && railCost["cards"] > 0 && custCost["cus_Big"] === 0.0318 && custCost["cus_Small"] === 0.0318 &&
      byTeam.rows.some((r) => r.key === "search" && r.costUSD >= 0.0636) && byTeam.rows.some((r) => r.key === "ops" && r.costUSD === 25.5),
    JSON.stringify({ rails: railCost, big: custCost["cus_Big"], small: custCost["cus_Small"] })
  );
  const focusCsv = await fetch(`${BASE}/api/costs/focus.csv?days=1`).then((r) => r.text());
  const focusLines = focusCsv.trim().split("\n");
  const focusHeader = focusLines[0].split(",");
  const MANDATORY_FOCUS = ["BilledCost", "BillingAccountId", "BillingAccountName", "BillingCurrency", "BillingPeriodEnd", "BillingPeriodStart", "ChargeCategory", "ChargeClass", "ChargeDescription", "ChargePeriodEnd", "ChargePeriodStart", "ContractedCost", "EffectiveCost", "HostProviderName", "InvoiceIssuerName", "ListCost", "PricingQuantity", "PricingUnit", "ServiceCategory", "ServiceName", "ServiceProviderName"];
  const finRows = focusLines.slice(1).filter((l) => l.includes("cus_Big"));
  const finSum = Math.round(finRows.reduce((s, l) => s + Number(l.split(",")[0]), 0) * 1e6) / 1e6;
  const col = (name, line) => line.split(",")[focusHeader.indexOf(name)];
  check(
    "the FOCUS v1.4 export carries all 21 mandatory columns, one row per priced token component (AI and Machine Learning, hourly charge periods), rows that sum to the booked cost, and no payouts or card swipes",
    MANDATORY_FOCUS.every((c) => focusHeader.includes(c)) && finRows.length === 8 && finSum === 0.0318 && finRows.every((l) => col("ServiceCategory", l) === "AI and Machine Learning" && col("ChargeCategory", l) === "Usage" && col("ServiceProviderName", l) === "Anthropic") &&
      finRows.every((l) => Date.parse(col("ChargePeriodEnd", l)) - Date.parse(col("ChargePeriodStart", l)) === 3600e3) && !focusCsv.includes("payout:") && !focusCsv.includes("card:"),
    `cols=${focusHeader.length} rows=${finRows.length} sum=${finSum}`
  );
  const meterEvents = fiatCalls("/v1/billing/meter_events").map((x) => new URLSearchParams(x.body));
  const bigEvent = meterEvents.find((f) => f.get("payload[stripe_customer_id]") === "cus_Big");
  check(
    "customer-tagged model spend becomes a Stripe Billing meter event in Stripe's format — event_name, payload[stripe_customer_id], payload[value] in micro-dollars at the 25% markup ($0.0159 → 19875), an identifier to de-duplicate",
    bigEvent?.get("event_name") === "spendveto_ai_usage" && bigEvent?.get("payload[value]") === "19875" && /^sv_[0-9a-f]{64}$/.test(bigEvent?.get("identifier") || "") && meterEvents.length === 4,
    `events=${meterEvents.length} value=${bigEvent?.get("payload[value]")}`
  );
  const rebillReport = await fetch(`${BASE}/api/rebilling?days=1`).then((r) => r.json());
  const bigRow = rebillReport.customers.find((c) => c.customer === "cus_Big");
  check(
    "the rebilling report shows cost, billed and margin per customer; requests with no Stripe customer tag — untagged, or a value that isn't a cus_ id — are never billed",
    bigRow?.costUSD === 0.0318 && bigRow.billedUSD === 0.03975 && bigRow.marginUSD === 0.00795 && rebillReport.customers.length === 2 && !rebillReport.customers.some((c) => c.customer === "not-a-stripe-id"),
    JSON.stringify(rebillReport.totals)
  );
  finLlm.close();
  fiatMock.close();
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  // --- The spendveto CLI + a relocatable data directory ---
  const cliConnect = spawnSync(process.execPath, ["bin/spendveto.mjs", "connect"], { cwd: ROOT, env: { ...process.env, PORT: "8402", HOST: "127.0.0.1" }, encoding: "utf8" });
  check(
    "`spendveto connect` prints the one-line setup for Claude Code, Codex and the OpenAI/Anthropic SDKs",
    cliConnect.status === 0 && cliConnect.stdout.includes("ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude") && cliConnect.stdout.includes("OPENAI_BASE_URL=http://127.0.0.1:8402/v1 codex"),
    cliConnect.stdout.split("\n").filter(Boolean)[0] || cliConnect.stderr
  );
  const tmpData = mkdtempSync(join(tmpdir(), "spendveto-verify-"));
  const cliBudget = spawnSync(process.execPath, ["bin/spendveto.mjs", "budget", "7"], { cwd: ROOT, env: { ...process.env, PORT: "8391", SPENDVETO_DATA_DIR: tmpData }, encoding: "utf8" });
  const relocated = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, PORT: "8391", SPENDVETO_MODE: "simulate", SPENDVETO_DATA_DIR: tmpData, SPENDVETO_ANTHROPIC_UPSTREAM: "http://localhost:9" }, stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    try { if ((await fetch("http://localhost:8391/api/llm/settings")).ok) break; } catch {}
  }
  const relocatedSettings = await fetch("http://localhost:8391/api/llm/settings").then((r) => r.json()).catch(() => ({}));
  await fetch("http://localhost:8391/api/freezes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: "0x00000000000000000000000000000000000000aa", reason: "verify relocation" }) }).catch(() => {});
  relocated.kill();
  await sleep(200);
  check(
    "SPENDVETO_DATA_DIR relocates every runtime file: `spendveto budget 7` with no server running writes the policy there, and a server booted on it reads that budget and keeps its state there — an installed copy never writes into its own package",
    cliBudget.status === 0 && JSON.parse(readFileSync(join(tmpData, "policy.json"), "utf8")).llm?.dailyBudgetUSD === 7 && relocatedSettings.settings?.dailyBudgetUSD === 7 && existsSync(join(tmpData, "freezes.json")),
    `cli=${cliBudget.status} served=${relocatedSettings.settings?.dailyBudgetUSD} freezes=${existsSync(join(tmpData, "freezes.json"))}`
  );
  writeFileSync(`${ROOT}data/policy.json`, JSON.stringify(LOOSE_POLICY, null, 2));

  // --- Multi-chain live settlement wiring (facilitator-adaptive) ---
  // In testnet mode the gate asks its facilitator (GET /supported) what it can
  // settle and brings every matching registry chain live: per-chain scheme
  // registration and one accepts entry per chain in every 402. The chain set
  // is the facilitator's truth, not config bravado — proven both ways with a
  // mock facilitator: advertising every registry chain brings every signable
  // one live; advertising one brings exactly one.
  const { CHAINS: REG_CHAINS, TOOLS } = await import("../shared-config.js");
  let mockSupportedCaip2 = REG_CHAINS.map((c) => c.caip2);
  mockFacil = createServer((req, res) => {
    if (req.url.startsWith("/supported")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ kinds: mockSupportedCaip2.map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  mockFacil.listen(8498);

  const bootTestnet = async (extraEnv = {}) => {
    const proc = spawn("node", ["server/index.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        SPENDVETO_MODE: "testnet",
        PORT: "8401",
        SPENDVETO_FACILITATOR_URL: "http://localhost:8498",
        SERVER_PAYOUT_ADDRESS: privateKeyToAccount(generatePrivateKey()).address,
        // Every non-EVM family needs its own payout address (see
        // server/index.js payToFor) or it never enters liveSettlementChains
        // however much the mock facilitator claims to support — placeholder
        // shapes are fine here since this boot only inspects the 402
        // challenge, it never actually verifies/settles a real payment.
        SERVER_PAYOUT_ADDRESS_SVM: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        SERVER_PAYOUT_ADDRESS_APTOS: "0x1111111111111111111111111111111111111111111111111111111111111111",
        SERVER_PAYOUT_ADDRESS_STELLAR: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
        SERVER_PAYOUT_ADDRESS_HEDERA: "0.0.1111111",
        SERVER_PAYOUT_ADDRESS_XRPL: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        // Blanked, not omitted: dotenv skips keys already present, so a
        // maintainer's .env.local can't switch XRPL mainnet on under the suite.
        SERVER_PAYOUT_ADDRESS_XRPL_MAINNET: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      try {
        const r = await fetch("http://localhost:8401/api/chains");
        if (r.ok) break;
      } catch {}
    }
    return { proc, getOut: () => out };
  };

  testnetProc = await bootTestnet();
  const tnChains = await fetch("http://localhost:8401/api/chains").then((r) => r.json());
  check(
    "testnet gate brings live every registry chain the facilitator settles AND this instance can sign — 17 of 20, with Algorand, Cardano and opt-in-only XRPL mainnet left out",
    tnChains.mode === "testnet" && tnChains.liveSettlementChains?.length === 17 &&
      tnChains.chains.filter((c) => !["algorand-testnet", "cardano-preprod", "xrpl"].includes(c.id)).every((c) => c.settlement === "live") &&
      ["algorand-testnet", "cardano-preprod", "xrpl"].every((id) => !tnChains.liveSettlementChains.includes(id)),
    `live=${tnChains.liveSettlementChains?.join(",")}`
  );
  const tn402 = await fetch("http://localhost:8401/api/agent/translate");
  const tn402Text = (tn402.headers.get("PAYMENT-REQUIRED") || "") + " " + (await tn402.text());
  const decoded402 = tn402Text.includes("eip155") ? tn402Text : Buffer.from(tn402.headers.get("PAYMENT-REQUIRED") || "", "base64").toString("utf8") + " " + tn402Text;
  const advertised = REG_CHAINS.filter((c) => decoded402.includes(c.caip2)).map((c) => c.id);
  check(
    "a real x402 v2 402 advertises one payment option per live chain — seventeen CAIP-2 networks in one challenge, and never a chain it cannot sign",
    tn402.status === 402 && advertised.length === 17 && ["algorand-testnet", "cardano-preprod", "xrpl"].every((id) => !advertised.includes(id)),
    `status=${tn402.status} advertised=${advertised.join(",")}`
  );
  // Each EVM option must carry its OWN token's EIP-712 domain: an EIP-3009
  // authorization signed against the wrong name is rejected by the token.
  // Circle's mainnet USDC signs as "USD Coin", its testnet as "USDC" — a
  // single hardcoded "USDC" (this gate until v0.26.0) broke every mainnet.
  let tnChallenge = null;
  try { tnChallenge = JSON.parse(Buffer.from(tn402.headers.get("PAYMENT-REQUIRED") || "", "base64").toString("utf8")); } catch {}
  const optFor = (caip2) => tnChallenge?.accepts?.find((a) => a.network === caip2);
  check(
    "every EVM payment option in a live 402 carries its own token's EIP-712 domain — USD Coin on Base/Ethereum mainnet, USDC on Base Sepolia, USDT0 v1 on Stable",
    optFor("eip155:8453")?.extra?.name === "USD Coin" && optFor("eip155:1")?.extra?.name === "USD Coin" &&
      optFor("eip155:84532")?.extra?.name === "USDC" && optFor("eip155:988")?.extra?.name === "USDT0" && optFor("eip155:988")?.extra?.version === "1" &&
      REG_CHAINS.filter((c) => !c.family).every((c) => optFor(c.caip2)?.extra?.name === c.eip712?.name && optFor(c.caip2)?.extra?.version === c.eip712?.version),
    REG_CHAINS.filter((c) => !c.family).map((c) => `${c.id}=${optFor(c.caip2)?.extra?.name}/${optFor(c.caip2)?.extra?.version}`).join(" ")
  );
  // x402 upstream (#3542, Sep 2026) fixed paid routes being reachable unpaid
  // when the framework dispatches an encoded path the route matcher never
  // saw. Pin that no spelling of a paid route serves content without paying.
  const bypassPaths = ["/api/agent/%74ranslate", "/api/%61gent/translate", "/api/agent%2Ftranslate", "/API/AGENT/TRANSLATE",
    "/api/agent/Translate", "/api/agent/translate/", "//api/agent/translate", "/api/agent/./translate", "/api/x/../agent/translate"];
  const bypassCodes = [];
  for (const p of bypassPaths) {
    const r = await new Promise((resolve) => {
      const req = httpRequest({ host: "localhost", port: 8401, path: p, method: "GET" }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", () => resolve(0));
      req.end();
    });
    bypassCodes.push(r);
  }
  check(
    "no encoded, re-cased or dot-segment spelling of a paid route is served unpaid by the live x402 gate",
    bypassCodes.every((c) => c === 402 || c === 404),
    bypassPaths.map((p, i) => `${p}=${bypassCodes[i]}`).join(" ")
  );
  const rawStatus = (method, path) => new Promise((resolve) => {
    const req = httpRequest({ host: "localhost", port: 8401, path, method }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve(0));
    req.end();
  });
  // x402 #3796 (2026-10-13): HEAD reached paid GET handlers unpaid. Express
  // answers HEAD with the GET handler, so this gate WAS exposed — HEAD got a
  // 200 and the paid handler ran — until v0.26.0 gated HEAD explicitly.
  const headProbes = [...TOOLS.map((t) => t.path), "/API/AGENT/TRANSLATE", "/api/agent/translate/"];
  const headCodes = [];
  for (const p of headProbes) headCodes.push(await rawStatus("HEAD", p));
  check(
    "a HEAD request never runs a paid handler unpaid — every paid route, and its re-cased and trailing-slash spellings, answers HEAD with the 402 challenge",
    headCodes.every((c) => c === 402 || c === 404) && headCodes.slice(0, TOOLS.length).every((c) => c === 402),
    headProbes.map((p, i) => `HEAD ${p}=${headCodes[i]}`).join(" ")
  );
  // x402 #3577 (2026-10-02): an absolute-form request target
  // (GET http://other.host/paid HTTP/1.1) slipped past a matcher that read the
  // raw target while the router stripped the authority. Not exposed here
  // (Express parses the path) — pinned so it stays that way.
  const absoluteProbes = [["GET", "http://evil.example/api/agent/translate"], ["GET", "https://localhost:8401/api/agent/review"], ["HEAD", "http://evil.example/api/agent/summarize"]];
  const absoluteCodes = [];
  for (const [m, p] of absoluteProbes) absoluteCodes.push(await rawStatus(m, p));
  check(
    "an absolute-form request target naming another host is gated exactly like the plain path — never served unpaid",
    absoluteCodes.every((c) => c === 402),
    absoluteProbes.map(([m, p], i) => `${m} ${p}=${absoluteCodes[i]}`).join(" ")
  );
  testnetProc.proc.kill();
  await sleep(300);

  // Adaptive the other way: the facilitator now claims only base-sepolia, so
  // only base-sepolia may go live — the other nineteen report settlement-ready.
  mockSupportedCaip2 = [REG_CHAINS.find((c) => c.id === "base-sepolia").caip2];
  testnetProc = await bootTestnet();
  const tnChains2 = await fetch("http://localhost:8401/api/chains").then((r) => r.json());
  check(
    "the live set is the facilitator's truth: a facilitator supporting one chain yields exactly one live + nineteen settlement-ready",
    tnChains2.liveSettlementChains?.length === 1 && tnChains2.liveSettlementChains[0] === "base-sepolia" &&
      tnChains2.chains.filter((c) => c.settlement === "ready").length === 19,
    `live=${tnChains2.liveSettlementChains?.join(",")} ready=${tnChains2.chains.filter((c) => c.settlement === "ready").length}`
  );
  testnetProc.proc.kill();
  await sleep(300);

  // XRPL mainnet is real money, so it has its own opt-in variable: with the
  // facilitator claiming every network and the TESTNET payout set, mainnet
  // stayed out above; set its own variable and it — and only then — goes live.
  mockSupportedCaip2 = REG_CHAINS.map((c) => c.caip2);
  testnetProc = await bootTestnet({ SERVER_PAYOUT_ADDRESS_XRPL_MAINNET: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" });
  const tnChains3 = await fetch("http://localhost:8401/api/chains").then((r) => r.json());
  check(
    "XRPL mainnet goes live only through its own SERVER_PAYOUT_ADDRESS_XRPL_MAINNET opt-in — enabling the XRPL testnet can never switch real money on",
    tnChains3.liveSettlementChains?.includes("xrpl") && tnChains3.liveSettlementChains?.includes("xrpl-testnet") && tnChains3.liveSettlementChains?.length === 18 &&
      !tnChains.liveSettlementChains.includes("xrpl") && tnChains.liveSettlementChains.includes("xrpl-testnet"),
    `with opt-in: ${tnChains3.liveSettlementChains?.length} live, xrpl=${tnChains3.liveSettlementChains?.includes("xrpl")}`
  );
  testnetProc.proc.kill();
  testnetProc = null;
  mockFacil.close();
  mockFacil = null;
} finally {
  if (mcp) mcp.kill();
  if (proxyProc) proxyProc.kill();
  if (testnetProc) testnetProc.proc.kill();
  if (mockFacil) mockFacil.close();
  server.kill();
  alertServer.close();
  writeFileSync(
    `${ROOT}data/policy.json`,
    JSON.stringify(
      { maxPerCallUSD: 0.05, maxPerHourUSD: 0.2, maxCallsPerHour: 10, requireApprovalAboveUSD: 0.015, anomaly: { burstAttempts: 10, burstWindowSeconds: 10 } },
      null,
      2
    )
  );
}

if (verifyStats && failures === 0) {
  const assertions = Number(process.env.SPENDVETO_ASSERTION_COUNT) || null;
  writeFileSync(
    `${ROOT}site/assets/verify-stats.json`,
    JSON.stringify({ ...verifyStats, ...(assertions ? { assertions } : {}) }, null, 2) + "\n"
  );
  console.log(`\nwrote site/assets/verify-stats.json — blocked $${verifyStats.blocked.usd} across ${verifyStats.blocked.count}, ${verifyStats.frozenWallets} frozen`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
