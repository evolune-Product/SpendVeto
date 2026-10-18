import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactAptosScheme } from "@x402/aptos/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { MODE, PORT, TOOLS, CHAINS, FACILITATOR_URL, findChain, DEFAULT_CHAIN, dataPath, PACKAGE_DATA_DIR } from "../shared-config.js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createSimulateGate, receiptMessage, signDecision, signUpiDecision, signEuDecision, signUkDecision, signBrDecision, signUsDecision, consentMessage, instanceSigner } from "./simulate.js";
import { decisionEvents, toJSONL } from "./events.js";
import { checkPolicy, policyHash } from "../client/policy.js";
import { verifyMessage } from "viem";
import { runTool } from "./agent.js";
import { getLedger, getBalances, appendLedgerEntry, creditSimBalance, verifyLedgerChain } from "./ledger.js";
import { createApproval, getApproval, decideApproval, listApprovals, findApprovableFor } from "./approvals.js";
import { worldIdConfigured, verifyWorldIdProof, rpContextFor, WORLD_ACTION } from "./worldid.js";
import { listDelegations, createDelegation, revokeDelegation } from "./delegations.js";
import { listFreezes, findActiveFreeze, createFreeze, unfreeze } from "./freezes.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readdirSync, existsSync } from "node:fs";
import { account as mainAccount } from "../client/wallet.js";
import { maybeFreezeForBurst, analyzeAnomalies } from "./anomaly.js";
import { trustScoreFor, trustGraph, payeeReputation } from "./trust.js";
import { sendAlert } from "./alerts.js";
import { railsCatalog } from "../rails/index.js";
import { setShadowPolicy, clearShadowPolicy, shadowReport } from "./shadow.js";
import { requireAuth } from "./auth.js";
import { recordConsent, consentsForDelegation } from "./consents.js";
import { toVerifiableCredential } from "./vc.js";
import { normalizeReceipt } from "./receipts.js";
import { checkCartAgainstIntent, reconcileHumanNotPresent } from "./ap2.js";
import { toBazaarResources, governCatalog } from "./discovery.js";
import { checkSessionAgainstToken } from "./acp.js";
import { evaluateUpiMandate, maskVpa, UPI_REGULATORY_BASIS, UPI_DISCLAIMER } from "./upi.js";
import { evaluateSepaDebit, maskIban, EU_REGULATORY_BASIS, EU_DISCLAIMER } from "./eu-sepa.js";
import { evaluateUkPushPayment, maskAccountNumber as maskAccountNumberUk, UK_REGULATORY_BASIS, UK_DISCLAIMER } from "./uk-fps.js";
import { evaluatePixPayment, maskPixKey, BR_REGULATORY_BASIS, BR_DISCLAIMER } from "./br-pix.js";
import { evaluateAchDebit, maskAccountNumber as maskAccountNumberUs, US_REGULATORY_BASIS, US_DISCLAIMER } from "./us-ach.js";
import { catalogOpenApiSpec } from "./openapi.js";
import { authorize as uptoAuthorize, settleAuthorization, voidAuthorization, getAuthorizations, openHoldUSD, uptoSummary } from "./upto.js";
import { bindAuthorization, verifyBinding, getBinding, requestDigest } from "./integrity.js";
import { evaluateRequirements as evaluateAuthCapture, recordCollect, capturePayment, chargePayment, voidPayment, refundPayment, markReclaimed, reclaimable, authCaptureHoldUSD, authCaptureSummary, getPayments as getAuthCapturePayments, findPayment as findAuthCapturePayment } from "./authcapture.js";
import { buildEvidencePack, checkEvidencePack } from "./disputes.js";
import { decisionSpans, toOtlpPayload, exportSpans } from "./otel.js";
import { createLlmGuard, pseudoAddress } from "./llmguard.js";
import { createCardRouter, cardSettings } from "./cards.js";
import { createPayouts } from "./payouts.js";
import { costReport, focusRows, toFocusCsv, createRebiller, rebillingSettings } from "./finops.js";
import { mintAttestation, verifyAttestation, ATTESTATION_PREFIX, ATTESTATION_HEADER, ATTESTATION_MESSAGE_PREFIX, ATTESTATION_DEFAULT_TTL_SECONDS, ATTESTATION_MAX_TTL_SECONDS, ATTESTATION_RAILS } from "./attestations.js";
import { createReputation, reputationSettings, FEED_SPEC, FEED_MESSAGE_PREFIX } from "./reputation.js";
import { validatePolicy, POLICY_SCHEMA_ID, POLICY_SCHEMA_PATH } from "./policyspec.js";

dotenv.config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)), quiet: true });

const app = express();
// Behind any reverse proxy (a tunnel for testing, a real deploy behind a CDN
// or load balancer) the socket Express sees is plain HTTP even when the
// actual client connection was HTTPS — without this, req.protocol always
// reports "http", which leaks into every self-referential URL this server
// generates (discovery.js's Bazaar resource list, openapi.js's servers[].url)
// and would advertise a scheme a real client can't necessarily reach.
app.set("trust proxy", true);

// The LLM spend guard (server/llmguard.js) is mounted BEFORE the JSON body
// parser: it needs the raw request bytes — Anthropic bodies are forwarded
// exactly as received, and Claude Code requests run to megabytes, far past
// express.json()'s 100 KB default.
const readJsonFile = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};
const childAddressFor = (label) => {
  const child = readJsonFile(dataPath("children.json"), []).find((c) => c.label === label || String(c.address).toLowerCase() === String(label).toLowerCase());
  return child ? child.address : null;
};
// Rebilling (server/finops.js): customer-tagged model spend → Stripe Billing meter events.
const rebiller = createRebiller({ dataPath, loadPolicy: () => readJsonFile(dataPath("policy.json"), {}) });
const llmGuard = createLlmGuard({
  loadPolicy: () => readJsonFile(dataPath("policy.json"), {}),
  checkPolicy,
  policyHash: () => policyHash(),
  appendLedgerEntry,
  getLedger,
  findActiveFreeze,
  createFreeze,
  listDelegations,
  sendAlert,
  createApproval,
  getApproval,
  readAgents: () => readJsonFile(dataPath("agents.json"), []),
  childAddress: (label) => childAddressFor(label),
  onCharge: (entry) => rebiller.onCharge(entry),
});
app.use(llmGuard.router);

// Federated counterparty reputation (server/reputation.js), consulted by the
// policy engine, payouts and card authorizations alike.
const reputation = createReputation({ dataPath, loadPolicy: () => readJsonFile(dataPath("policy.json"), {}), signer: instanceSigner });

// Card authorization webhooks (server/cards.js) need raw bytes too — the
// Stripe and Lithic signatures are computed over the exact body received.
app.use(createCardRouter({
  loadPolicy: () => readJsonFile(dataPath("policy.json"), {}),
  checkPolicy,
  policyHash: () => policyHash(),
  appendLedgerEntry,
  getLedger,
  findActiveFreeze,
  listDelegations,
  readCards: () => readJsonFile(dataPath("cards.json"), []),
  pseudoAddress,
  childAddress: childAddressFor,
  reputationCheck: (subjects) => reputation.check(subjects),
}));

app.use(express.json());
// Local-tool CORS: lets the marketing site (:8403) show live governance stats.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
});
app.use(express.static(fileURLToPath(new URL("../dashboard", import.meta.url))));

async function serveAgentResult(toolId, res, settlement) {
  const result = await runTool(toolId);
  res.json({ result, settlement: settlement ?? null });
}

// Chains with real on-chain settlement live RIGHT NOW on this instance —
// facilitator-truth in testnet mode, empty in simulate mode (where every
// registry chain settles locally). Surfaced on /api/chains.
let liveSettlementChains = [];

if (MODE === "testnet") {
  const payTo = process.env.SERVER_PAYOUT_ADDRESS;
  if (!payTo) {
    console.error("SPENDVETO_MODE=testnet requires SERVER_PAYOUT_ADDRESS in .env.local — run `npm run gen-wallets` first, then fund CLIENT_PRIVATE_KEY's address via https://faucet.circle.com (Base Sepolia).");
    process.exit(1);
  }
  // Every non-EVM family has its own address shape (an EVM 0x address is
  // meaningless as an XRPL r-address or a Hedera 0.0.x account), so each gets
  // its own optional payout address. A family with none configured simply
  // never enters liveSettlementChains below — a chain the facilitator
  // supports but we have nowhere of our own to receive it on stays "ready",
  // never advertised in a 402 with a payTo that would misroute funds.
  const payToFor = {
    undefined: payTo,
    svm: process.env.SERVER_PAYOUT_ADDRESS_SVM,
    aptos: process.env.SERVER_PAYOUT_ADDRESS_APTOS,
    stellar: process.env.SERVER_PAYOUT_ADDRESS_STELLAR,
    hedera: process.env.SERVER_PAYOUT_ADDRESS_HEDERA,
    xrpl: process.env.SERVER_PAYOUT_ADDRESS_XRPL,
  };
  // Per chain, not per family: a chain that is real money behind an explicit
  // opt-in (XRPL mainnet, `mainnetOptIn` in the registry) takes its payout
  // address ONLY from its own variable — so enabling the XRPL testnet with
  // SERVER_PAYOUT_ADDRESS_XRPL can never also switch mainnet on.
  // An empty value counts as unset — a blank SERVER_PAYOUT_ADDRESS_XRPL_MAINNET=
  // line in a .env file must not read as "opted in to real money".
  const payoutFor = (c) => (c.mainnetOptIn ? process.env[c.mainnetOptIn] : payToFor[c.family]) || undefined;
  // x402 v2, registry-driven: ask the configured facilitator what it can
  // actually settle (GET /supported) and bring every registry chain it names
  // live — schemes registered and 402s advertising one accepts entry per live
  // chain. The chain set is the FACILITATOR's truth, not this file's bravado:
  // the public facilitator settles base-sepolia today; point FACILITATOR_URL
  // at a CDP facilitator (with an API key) and its mainnet chains go live with
  // zero code changes. If /supported is unreachable, fall back to base-sepolia
  // rather than refusing to boot.
  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  let supportedNetworks;
  try {
    const { kinds } = await facilitatorClient.getSupported();
    supportedNetworks = new Set(kinds.filter((k) => k.scheme === "exact").map((k) => k.network));
  } catch (err) {
    console.error(`[testnet] facilitator /supported unreachable (${err.message}) — falling back to base-sepolia only`);
    supportedNetworks = new Set([findChain("base-sepolia").caip2]);
  }
  liveSettlementChains = CHAINS.filter((c) => supportedNetworks.has(c.caip2) && payoutFor(c) != null).map((c) => c.id);
  if (liveSettlementChains.length === 0) liveSettlementChains = ["base-sepolia"];
  console.log(`[testnet] live settlement chains via ${FACILITATOR_URL}: ${liveSettlementChains.join(", ")}`);

  const schemeFor = (c) => {
    switch (c.family) {
      case "svm":
        return new ExactSvmScheme();
      case "aptos":
        return new ExactAptosScheme();
      case "stellar":
        return new ExactStellarScheme();
      case "hedera":
        return new ExactHederaScheme();
      case "xrpl":
        return new ExactXrplScheme();
      // A registered family with no published client scheme package (algorand,
      // cardano today) must never fall through to the EVM scheme: signing a
      // non-EVM payment with a secp256k1 EVM signature would produce a
      // signature the facilitator rejects at best, and at worst one that
      // means something else. payToFor has no entry for either, so this is
      // unreachable unless someone adds one — which is exactly when it should
      // throw.
      case "algorand":
        throw new Error(`no x402 client scheme package published for family "${c.family}" (${c.id}) — the facilitator settles it, this instance cannot sign it`);
      case "cardano":
        throw new Error(`no x402 client scheme package published for family "${c.family}" (${c.id}) — neither the facilitator nor this instance can settle it yet`);
      default:
        return new ExactEvmScheme();
    }
  };
  let resourceServer = new x402ResourceServer(facilitatorClient);
  for (const id of liveSettlementChains) resourceServer = resourceServer.register(findChain(id).caip2, schemeFor(findChain(id)));
  // Price as an explicit AssetAmount per chain (atomic units + the registry's
  // canonical stablecoin contract/token id) rather than the "$0.01" shorthand
  // — the shorthand needs each package's built-in default-asset table, which
  // doesn't cover every chain we register, and every non-EVM family has its
  // own atomic-unit convention (decimals) and asset-address shape. XRPL is
  // the one exception: it has no atomic USDC unit at all (IOU amounts are
  // decimal ledger values), so it gets a plain decimal Money string and the
  // scheme's own default conversion prices it in RLUSD.
  const usdcAmount = (tool, id) => {
    const c = findChain(id);
    const atomic = (decimals) => ({ amount: String(Math.round(Number(tool.price) * 10 ** decimals)), asset: c.usdc });
    switch (c.family) {
      case "svm":
      case "aptos":
      case "hedera":
        return atomic(6);
      case "stellar":
        return atomic(7);
      case "xrpl":
        return String(tool.price);
      // The token's own EIP-712 domain, per chain (registry `eip712`, checked
      // live): Circle's mainnet USDC signs as "USD Coin", testnet as "USDC".
      // A hardcoded name here signs every mainnet authorization against a
      // domain the token contract doesn't have — rejected at settlement.
      default:
        return { amount: String(Math.round(Number(tool.price) * 1e6)), asset: c.usdc, extra: { ...(c.eip712 || { name: "USDC", version: "2" }) } };
    }
  };
  // Every paid route is gated for GET *and* HEAD. Express answers a HEAD with
  // the GET handler (body stripped), so a rule that names only GET leaves the
  // paid handler — and whatever it costs to run — reachable unpaid by HEAD.
  // Found by probing this gate after x402 fixed the same class upstream
  // (#3796, 2026-10-13; not yet in a published @x402/express) — pinned by an
  // assertion in scripts/verify.mjs.
  const paidRule = (tool) => ({
    accepts: liveSettlementChains.map((id) => {
      const c = findChain(id);
      return { scheme: "exact", price: usdcAmount(tool, id), network: c.caip2, payTo: payoutFor(c) };
    }),
    description: `SpendVeto demo — ${tool.label}`,
  });
  const routes = Object.fromEntries(TOOLS.flatMap((tool) => [[`GET ${tool.path}`, paidRule(tool)], [`HEAD ${tool.path}`, paidRule(tool)]]));
  app.use(paymentMiddleware(routes, resourceServer));
  // x402-express already verified + settled payment before these handlers run.
  // Ledger accounting for testnet mode happens client-side (see client/pay-and-call.js) —
  // the client is the one party that reliably knows its own address and outcome.
  for (const tool of TOOLS) {
    app.get(tool.path, (req, res) => serveAgentResult(tool.id, res));
  }
} else {
  for (const tool of TOOLS) {
    app.get(tool.path, createSimulateGate(tool), (req, res) => serveAgentResult(tool.id, res, res.locals.settlement));
  }
  // Dynamic marketplace tools share the same 402 gate; static routes above
  // win first, so this only catches registered dynamic ids.
  app.get("/api/agent/:dynId", (req, res) => {
    const tool = readDynTools().find((t) => t.id === req.params.dynId);
    if (!tool) return res.status(404).json({ error: `unknown tool "${req.params.dynId}"` });
    createSimulateGate(tool)(req, res, async () => {
      let text;
      let real = false;
      if (tool.upstreamUrl) {
        try {
          // The caller already paid for THIS specific call, not a fixed canned resource — a
          // registered marketplace tool with no way to pass per-call input is a static page
          // wearing a price tag. Query params on the incoming request forward onto the
          // upstream URL (merged, so an upstreamUrl that already carries its own params, e.g.
          // an API key, keeps them); the request line is the only per-call channel this proxy
          // has, since it's a plain GET behind x402, not a tunnel.
          const target = new URL(tool.upstreamUrl);
          for (const [k, v] of Object.entries(req.query || {})) {
            if (typeof v === "string") target.searchParams.set(k, v);
          }
          text = await fetch(target, { signal: AbortSignal.timeout(8000) }).then((r) => r.text());
          real = true;
        } catch (err) {
          text = `(upstream unreachable: ${err.message})`;
        }
      } else {
        text = `(paid response from marketplace tool "${tool.id}" — no upstreamUrl configured)`;
      }
      res.json({ result: { text: text.slice(0, 4000), real }, settlement: res.locals.settlement ?? null });
    });
  });
}

// The tool marketplace: anyone can register a paid endpoint behind the same
// governance gate — the catalog stops being a fixed demo and becomes supply.
// Durable in data/tools.json (runtime state, gitignored).
const DYN_TOOLS_PATH = dataPath("tools.json");
function readDynTools() {
  try {
    return JSON.parse(readFileSync(DYN_TOOLS_PATH, "utf8"));
  } catch {
    return [];
  }
}
const allTools = () => [...TOOLS, ...readDynTools()];

app.get("/api/catalog", (req, res) => {
  res.json({ tools: allTools() });
});

app.post("/api/catalog/tools", requireAuth("admin"), (req, res) => {
  const { id, price, label, description, upstreamUrl, category, payTo } = req.body || {};
  if (!/^[a-z0-9-]{2,40}$/.test(id || "")) return res.status(400).json({ error: "id must be 2-40 chars of a-z, 0-9, -" });
  if (!(Number(price) > 0)) return res.status(400).json({ error: "a positive price (USD) is required" });
  if (payTo != null && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) return res.status(400).json({ error: "payTo, if given, must be a 0x-prefixed 20-byte address" });
  if (allTools().some((t) => t.id === id)) return res.status(409).json({ error: `tool "${id}" already exists` });
  const list = readDynTools();
  const record = {
    id,
    path: `/api/agent/${id}`,
    price: String(price),
    label: (label || id).slice(0, 60),
    description: (description || "").slice(0, 200),
    category: /^[a-z-]{2,30}$/.test(category || "") ? category : "marketplace",
    // The recipient this tool's payments settle to. When set, the payee
    // allowlist (policy.allowedPayees / delegated payee scope) governs it.
    ...(payTo ? { payTo } : {}),
    ...(upstreamUrl && /^https?:\/\//.test(upstreamUrl) ? { upstreamUrl } : {}),
    dynamic: true,
    createdAt: new Date().toISOString(),
  };
  list.push(record);
  writeFileSync(DYN_TOOLS_PATH, JSON.stringify(list, null, 2));
  res.status(201).json(record);
});

// Simulated top-up: fund a wallet's per-chain balance (simulate mode only —
// on-chain balances come from real faucets/transfers, never from an API).
app.post("/api/balances/topup", requireAuth("admin"), (req, res) => {
  if (MODE !== "simulate") return res.status(400).json({ error: "top-ups exist only in simulate mode" });
  const { address, amount, chain } = req.body || {};
  if (!address || !(Number(amount) > 0)) return res.status(400).json({ error: "address and a positive amount are required" });
  const balance = creditSimBalance(address, Number(amount), chain || "base-sepolia");
  res.json({ address, chain: chain || "base-sepolia", balance });
});

app.get("/api/chains", (req, res) => {
  // settlement: how a payment on this chain would settle on THIS instance —
  // "live" (real on-chain via the facilitator, testnet mode), "simulated"
  // (local ledger, simulate mode), or "ready" (full v2 wiring in place; goes
  // live the moment the configured facilitator supports it).
  const chains = CHAINS.map((c) => ({
    ...c,
    settlement:
      MODE === "testnet"
        ? liveSettlementChains.includes(c.id)
          ? "live"
          : "ready"
        : c.family
          ? "unsupported-in-simulate"
          : "simulated",
  }));
  res.json({ chains, mode: MODE, liveSettlementChains });
});

// The rail adapter registry: one pay() contract, x402 live today, the other
// rails as declared (honest) slots — see rails/index.js.
app.get("/api/rails", (req, res) => {
  res.json({ rails: railsCatalog() });
});

// Receipts as first-class audit objects: look one up by id, or hand the whole
// receipt back and have its ECDSA signature verified independently of the
// ledger file — an auditor doesn't have to trust our storage.
// Registered before /api/receipts/:id so "normalized" isn't swallowed as an id param.
app.get("/api/receipts/normalized", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ receipts: getLedger().slice(-limit).map(normalizeReceipt) });
});

app.get("/api/receipts/:id", (req, res) => {
  const entry = getLedger().find((e) => e.receiptId === req.params.id);
  if (!entry) return res.status(404).json({ error: "no receipt with that id" });
  res.json({ receipt: entry });
});

app.post("/api/receipts/verify", async (req, res) => {
  const { receiptId, payer, resource, price, chain, signedBy, signature } = req.body || {};
  if (!receiptId || !payer || !resource || !price || !chain || !signedBy || !signature) {
    return res.status(400).json({ error: "receiptId, payer, resource, price, chain, signedBy, signature are all required" });
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address: signedBy, message: receiptMessage({ receiptId, payer, resource, price, chain }), signature });
  } catch {
    valid = false;
  }
  res.json({ valid });
});

// Waitlist for the hosted platform. Durable, append-only; GET exposes only
// the count — never the emails/addresses.
const WAITLIST_PATH = dataPath("waitlist.json");
function readWaitlist() {
  try {
    return JSON.parse(readFileSync(WAITLIST_PATH, "utf8"));
  } catch {
    return [];
  }
}
app.post("/api/waitlist", (req, res) => {
  const { email, wallet, chains, notes } = req.body || {};
  if (!email && !wallet) return res.status(400).json({ error: "email or wallet is required" });
  const list = readWaitlist();
  const entry = {
    id: randomUUID(),
    email: email || null,
    wallet: wallet || null,
    chains: Array.isArray(chains) ? chains.slice(0, 10) : [],
    notes: typeof notes === "string" ? notes.slice(0, 500) : null,
    ts: new Date().toISOString(),
  };
  list.push(entry);
  writeFileSync(WAITLIST_PATH, JSON.stringify(list, null, 2));
  sendAlert("waitlist", { email: entry.email, wallet: entry.wallet, chains: entry.chains });
  res.status(201).json({ ok: true, position: list.length });
});
app.get("/api/waitlist", (req, res) => {
  res.json({ count: readWaitlist().length });
});

app.get("/api/ledger", (req, res) => {
  res.json({ entries: getLedger(), balances: getBalances(), mode: MODE });
});

// Tamper-evidence (issue #11): confirm the hash chain over the whole ledger is
// intact. An auditor (or a nightly job) hits this to prove no historical entry
// was edited, deleted, or reordered since it was written — brokenAt names the
// first bad row if the chain is broken.
app.get("/api/ledger/verify-chain", (req, res) => {
  res.json(verifyLedgerChain());
});

app.post("/api/ledger/event", (req, res) => {
  const { address, resource, price, chain, category, status, reason } = req.body || {};
  if (!address || !status) return res.status(400).json({ error: "address and status are required" });
  appendLedgerEntry({ address, resource, amount: price, ...(chain ? { chain } : {}), ...(category ? { category } : {}), status, reason });
  if (status === "blocked") sendAlert("blocked", { address, resource, price, chain, reason });
  maybeFreezeForBurst(address);
  res.status(204).end();
});

// Audit export: the full ledger as CSV for accounting/compliance workflows.
app.get("/api/export.csv", (req, res) => {
  const quote = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const rows = getLedger().map((e) => [e.ts, e.address, e.resource, e.amount, e.chain, e.status, e.mode, e.reason].map(quote).join(","));
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", `attachment; filename="spendveto-ledger-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(["ts,address,resource,amount,chain,status,mode,reason", ...rows].join("\n"));
});

// Structured decision events — the SIEM-ready evidence surface over the
// hash-chained ledger: one stable schema (spendveto.decision.v1) carrying the
// decision, the policy version in force (policyHash), and the chain-of-custody
// hashes. JSON for dashboards; JSONL export for log shippers (Splunk/Datadog/
// Elastic ingest one-event-per-line without any envelope parsing).
app.get("/api/events", (req, res) => {
  const { since, until, status, address, limit } = req.query;
  res.json({ events: decisionEvents({ since, until, status, address, limit }) });
});

app.get("/api/events/export", (req, res) => {
  const { since, until, status, address, limit } = req.query;
  res.set("Content-Type", "application/x-ndjson");
  res.set("Content-Disposition", `attachment; filename="spendveto-decisions-${new Date().toISOString().slice(0, 10)}.jsonl"`);
  res.send(toJSONL(decisionEvents({ since, until, status, address, limit })));
});

// AP2-style mandate evaluation: SpendVeto as the policy evaluator for an
// AP2-shaped mandate (agent, amount, payee, category, expiry). This is the
// governance half of the AP2 story, real and testable today: the full policy
// pipeline runs against the mandate and the verdict comes back ECDSA-signed by
// the server's receipt key, so the decision is portable evidence. AP2
// *settlement* remains an honest roadmap rail slot (rails/index.js) — this
// endpoint decides; it does not move money.
app.post("/api/ap2/evaluate", async (req, res) => {
  const { id, agent, amountUSD, payee, category, tool, chain, expiresAt } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });
  const amount = Number(amountUSD);
  if (!(amount > 0)) return res.status(400).json({ error: "amountUSD must be a positive number" });

  const ts = new Date().toISOString();
  let verdict;
  if (expiresAt && Date.parse(expiresAt) < Date.now()) {
    verdict = { allowed: false, code: "mandate_expired", reason: `mandate expired at ${expiresAt}` };
  } else {
    verdict = await checkPolicy(agent, amount, tool || "ap2-mandate", chain || DEFAULT_CHAIN, category, payee);
  }
  const decision = verdict.allowed ? (verdict.requiresApproval ? "requires_approval" : "allow") : "deny";
  const signed = await signDecision({ id, agent, amountUSD: amount, payee, verdict: decision, ts });
  const mandate = { id: id || null, agent, amountUSD: amount, payee: payee || null, category: category || null, tool: tool || null, chain: chain || DEFAULT_CHAIN, expiresAt: expiresAt || null };
  const body = {
    mandate,
    decision,
    reason: verdict.reason || "within policy",
    ...(verdict.code ? { code: verdict.code } : {}),
    ts,
    ...signed, // message, signature, signer — verify with any ECDSA library
  };
  // ?format=vc: same signed verdict, re-shaped as a portable VC envelope
  // (AP2 itself is built on W3C Verifiable Credentials — see server/vc.js).
  if (req.query.format === "vc") {
    return res.json(toVerifiableCredential({ mandate, decision, reason: body.reason, code: verdict.code, ts, ...signed }));
  }
  res.json(body);
});

// AP2 mandate CHAIN evaluation: judge the cart against the intent it claims to
// come from, not just its dollar amount. /api/ap2/evaluate above sees one
// number and so cannot catch the failure the chain exists to expose — a cart
// that drifted off the intent the human actually signed (wrong merchant,
// out-of-scope category, a total that doesn't match its own line items).
app.post("/api/ap2/mandate-chain", async (req, res) => {
  const { agent, intent, cart, chain } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });

  const ts = new Date().toISOString();
  const drift = checkCartAgainstIntent(intent, cart);

  // Structural drift is decided before policy: an unauthorized cart is not a
  // budget question, and running the spend pipeline on a total the cart can't
  // justify would be checking the wrong number anyway.
  if (!drift.ok) {
    const signed = await signDecision({ id: cart?.id, agent, amountUSD: Number(cart?.totalUSD) || 0, payee: null, verdict: "deny", ts });
    return res.json({
      decision: "deny",
      stage: "mandate_chain",
      code: drift.code,
      reason: drift.reason,
      suggestion: drift.suggestion,
      intentId: intent?.id ?? null,
      cartId: cart?.id ?? null,
      ts,
      ...signed,
    });
  }

  const payee = cart.payee || null;
  const category = cart.items.find((it) => it.category)?.category || null;
  let verdict = await checkPolicy(agent, drift.totalUSD, "ap2-cart", chain || DEFAULT_CHAIN, category, payee);

  // Human-not-present: a "pause for approval" verdict has no one to answer it,
  // so the signed intent's ceiling decides instead — see server/ap2.js.
  const hnp = reconcileHumanNotPresent({ verdict, intent, totalUSD: drift.totalUSD });
  verdict = hnp.verdict;

  const decision = verdict.allowed ? (verdict.requiresApproval ? "requires_approval" : "allow") : "deny";
  const signed = await signDecision({ id: cart.id, agent, amountUSD: drift.totalUSD, payee, verdict: decision, ts });
  res.json({
    decision,
    stage: "policy",
    reason: hnp.note || verdict.reason || "cart matches its intent and is within policy",
    ...(verdict.code ? { code: verdict.code } : {}),
    ...(verdict.suggestion ? { suggestion: verdict.suggestion } : {}),
    humanPresent: intent?.humanPresent !== false,
    preAuthorizedByIntent: hnp.preAuthorized,
    intentId: intent?.id ?? null,
    cartId: cart.id ?? null,
    totalUSD: drift.totalUSD,
    merchants: drift.merchants,
    itemCount: drift.itemCount,
    ts,
    ...signed,
  });
});

// Bazaar (x402 v2 discovery), publish side: SpendVeto's governed catalog in the
// schema a Bazaar-aware buyer already speaks.
// OpenAPI description of the catalog above — a standard machine-readable
// shape for platforms (Bazantic's gateway registration, API directories,
// codegen tools) that expect OpenAPI rather than the Bazaar-shaped resource
// list discovery.js publishes. Generated from the same TOOLS array, so it
// can't drift from what a call actually costs or where it actually lives.
app.get("/openapi.json", (req, res) => {
  res.json(catalogOpenApiSpec({ baseUrl: `${req.protocol}://${req.get("host")}`, tools: allTools() }));
});

app.get("/api/discovery/resources", (req, res) => {
  const type = req.query.type;
  if (type && type !== "http") return res.json({ resources: [] });
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json({ resources: toBazaarResources(allTools(), { baseUrl, chain: req.query.chain }) });
});

// Bazaar, consume side — the control that matters. Discovery lets an agent find
// and pay a service nobody vetted, so a payee allowlist consulted at settlement
// learns about it far too late. This filters a discovered catalog through the
// live policy BEFORE the agent sees it: what it cannot be allowed to pay for,
// it never gets to name. A pre-filter, not a replacement for the gate — the
// resource it does pick still runs the full pipeline at call time.
app.post("/api/discovery/govern", (req, res) => {
  const { resources } = req.body || {};
  if (!Array.isArray(resources)) return res.status(400).json({ error: "resources must be an array of Bazaar listings" });
  let policy;
  try {
    policy = JSON.parse(readFileSync(dataPath("policy.json"), "utf8"));
  } catch {
    policy = { maxPerCallUSD: 0.05, maxPerHourUSD: 0.2, maxCallsPerHour: 10, requireApprovalAboveUSD: 0.015 };
  }
  const { allowed, filtered } = governCatalog(resources, policy);
  res.json({ considered: resources.length, allowed, filtered, policyVersion: policyHash(policy) });
});

// Spend analytics: where the money went and where it was stopped.
app.get("/api/analytics", (req, res) => {
  const entries = getLedger();
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const roll = (keyOf) => {
    const map = new Map();
    for (const e of entries) {
      const key = keyOf(e);
      if (!key) continue;
      const row = map.get(key) || { paidCount: 0, paidUSD: 0, blockedCount: 0, blockedUSD: 0 };
      if (e.status === "paid") {
        row.paidCount++;
        row.paidUSD = round(row.paidUSD + Number(e.amount || 0));
      } else if (e.status === "blocked") {
        row.blockedCount++;
        row.blockedUSD = round(row.blockedUSD + Number(e.amount || 0));
      }
      map.set(key, row);
    }
    return [...map.entries()]
      .map(([key, row]) => ({ key, ...row }))
      .sort((a, b) => b.paidUSD - a.paidUSD);
  };
  res.json({
    byTool: roll((e) => e.resource),
    byWallet: roll((e) => e.address?.toLowerCase()),
    // Entries from before the multichain ledger have no chain field; they all
    // settled on the default chain.
    byChain: roll((e) => e.chain || "base-sepolia"),
  });
});

// The spend report: the artifact you forward to whoever owns the budget.
// Pure ledger math over a window — totals, what governance stopped, and the
// breakdowns that answer "where did it go and who tried to overspend?".
app.get("/api/report", (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const cutoff = Date.now() - days * 86400000;
  const entries = getLedger().filter((e) => new Date(e.ts).getTime() >= cutoff);
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const sum = (list) => round(list.reduce((s, e) => s + Number(e.amount || 0), 0));
  const paid = entries.filter((e) => e.status === "paid");
  const blocked = entries.filter((e) => e.status === "blocked");
  const failed = entries.filter((e) => e.status === "failed");
  const rollBy = (keyOf) => {
    const map = new Map();
    for (const e of paid) {
      const k = keyOf(e) || "uncategorized";
      map.set(k, round((map.get(k) || 0) + Number(e.amount || 0)));
    }
    return [...map.entries()].map(([key, usd]) => ({ key, usd })).sort((a, b) => b.usd - a.usd);
  };
  const reasons = new Map();
  for (const e of blocked) {
    const k = (e.reason || "").split(" (")[0].slice(0, 80);
    reasons.set(k, (reasons.get(k) || 0) + 1);
  }
  res.json({
    windowDays: days,
    paid: { count: paid.length, usd: sum(paid) },
    blocked: { count: blocked.length, usd: sum(blocked) },
    failed: { count: failed.length, usd: sum(failed) },
    byCategory: rollBy((e) => e.category),
    byChain: rollBy((e) => e.chain || "base-sepolia"),
    topWallets: rollBy((e) => e.address?.toLowerCase()).slice(0, 8),
    topBlockReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    frozenWallets: listFreezes().filter((f) => !f.unfrozen).length,
    headline: `Governance stopped $${sum(blocked)} across ${blocked.length} attempts in the last ${days}d, while $${sum(paid)} moved under policy.`,
  });
});

// The headline number: dollars the governance layer stopped from moving.
app.get("/api/stats", (req, res) => {
  const entries = getLedger();
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const bucket = (status) => {
    const mine = entries.filter((e) => e.status === status);
    return { count: mine.length, usd: round(mine.reduce((s, e) => s + Number(e.amount || 0), 0)) };
  };
  res.json({
    paid: bucket("paid"),
    blocked: bucket("blocked"),
    failed: bucket("failed"),
    frozenWallets: listFreezes().filter((f) => !f.unfrozen).length,
    totalAttempts: entries.length,
  });
});

// Prometheus-style scrape target — same ledger /api/stats already summarizes,
// in text exposition format so ops can point Prometheus/Grafana at it
// directly instead of polling and reshaping the JSON themselves.
app.get("/metrics", (req, res) => {
  const entries = getLedger();
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const bucket = (status) => {
    const mine = entries.filter((e) => e.status === status);
    return { count: mine.length, usd: round(mine.reduce((s, e) => s + Number(e.amount || 0), 0)) };
  };
  const paid = bucket("paid");
  const blocked = bucket("blocked");
  const failed = bucket("failed");
  const byCategory = {};
  for (const e of entries) {
    if (!e.category || (e.status !== "paid" && e.status !== "blocked")) continue;
    byCategory[e.category] ??= { paid_usd: 0, blocked_usd: 0 };
    byCategory[e.category][`${e.status}_usd`] += Number(e.amount || 0);
  }
  const metric = (name, help, type, value) => [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`];
  const lines = [
    ...metric("spendveto_paid_usd_total", "Total USD governed spend that was paid.", "counter", paid.usd),
    ...metric("spendveto_paid_calls_total", "Total calls that were paid.", "counter", paid.count),
    ...metric("spendveto_blocked_usd_total", "Total USD governance refused to spend.", "counter", blocked.usd),
    ...metric("spendveto_blocked_calls_total", "Total calls governance blocked.", "counter", blocked.count),
    ...metric("spendveto_failed_calls_total", "Total calls that failed for a reason other than a policy block.", "counter", failed.count),
    ...metric("spendveto_frozen_wallets", "Wallets currently frozen (kill switch, manual or anomaly-triggered).", "gauge", listFreezes().filter((f) => !f.unfrozen).length),
    ...metric("spendveto_attempts_total", "All governed spend attempts seen (paid + blocked + failed).", "counter", entries.length),
    "# HELP spendveto_category_usd_total USD paid or blocked, broken down by spend category.",
    "# TYPE spendveto_category_usd_total counter",
    ...Object.entries(byCategory).flatMap(([cat, v]) => [
      `spendveto_category_usd_total{category="${cat}",status="paid"} ${round(v.paid_usd)}`,
      `spendveto_category_usd_total{category="${cat}",status="blocked"} ${round(v.blocked_usd)}`,
    ]),
  ];
  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send(lines.join("\n") + "\n");
});

// Console write-APIs: the dashboard is a real control surface, not a viewer.
// PUT /api/policy edits the live spend rules; the packs endpoints list and
// apply the committed governance presets (current policy backed up to .bak).
const POLICY_FILE = dataPath("policy.json");
const PACKS_DIR = join(PACKAGE_DATA_DIR, "policy-packs");
app.put("/api/policy", requireAuth("admin"), (req, res) => {
  const b = req.body || {};
  const nums = ["maxPerCallUSD", "maxPerHourUSD", "maxCallsPerHour", "requireApprovalAboveUSD"];
  for (const k of nums) if (b[k] != null && !(Number(b[k]) > 0)) return res.status(400).json({ error: `${k} must be a positive number` });
  let current = {};
  try { current = JSON.parse(readFileSync(POLICY_FILE, "utf8")); } catch {}
  const next = { ...current };
  for (const k of nums) if (b[k] != null) next[k] = Number(b[k]);
  if (b.allowedChains !== undefined) next.allowedChains = Array.isArray(b.allowedChains) && b.allowedChains.length ? b.allowedChains.slice(0, 10) : undefined;
  if (next.allowedChains === undefined) delete next.allowedChains;
  if (b.allowedPayees !== undefined) next.allowedPayees = Array.isArray(b.allowedPayees) && b.allowedPayees.length ? b.allowedPayees.slice(0, 50) : undefined;
  if (next.allowedPayees === undefined) delete next.allowedPayees;
  if (b.anomaly?.burstAttempts > 0 && b.anomaly?.burstWindowSeconds > 0) next.anomaly = { burstAttempts: Number(b.anomaly.burstAttempts), burstWindowSeconds: Number(b.anomaly.burstWindowSeconds) };
  if (typeof b.alertWebhookUrl === "string") next.alertWebhookUrl = b.alertWebhookUrl || undefined;
  if (next.alertWebhookUrl === undefined) delete next.alertWebhookUrl;
  if (typeof b.requireWorldIdForApproval === "boolean") next.requireWorldIdForApproval = b.requireWorldIdForApproval;
  writeFileSync(POLICY_FILE, JSON.stringify(next, null, 2));
  res.json(next);
});

// Shadow mode: set a candidate policy that runs alongside the live one without
// enforcing, read the divergence report, or clear the experiment. The gate
// (server/simulate.js) records what the candidate WOULD have decided on every
// real call; the report says how much spend it would have additionally blocked
// or allowed — measure a policy change against live traffic before promoting.
app.get("/api/shadow", (req, res) => {
  res.json(shadowReport());
});

app.put("/api/shadow", requireAuth("admin"), (req, res) => {
  const b = req.body || {};
  const nums = ["maxPerCallUSD", "maxPerHourUSD", "maxCallsPerHour", "requireApprovalAboveUSD"];
  for (const k of nums) if (b[k] != null && !(Number(b[k]) > 0)) return res.status(400).json({ error: `${k} must be a positive number` });
  res.status(201).json({ ok: true, policy: setShadowPolicy(b) });
});

app.delete("/api/shadow", requireAuth("admin"), (req, res) => {
  clearShadowPolicy();
  res.json({ ok: true, active: false });
});

app.get("/api/policy-packs", (req, res) => {
  const packs = readdirSync(PACKS_DIR).filter((f) => f.endsWith(".json")).map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(readFileSync(`${PACKS_DIR}/${f}`, "utf8")) }));
  res.json({ packs });
});

app.post("/api/policy/apply", requireAuth("admin"), (req, res) => {
  const { pack } = req.body || {};
  const file = `${PACKS_DIR}/${String(pack).replace(/[^a-z-]/g, "")}.json`;
  if (!pack || !existsSync(file)) return res.status(404).json({ error: `unknown pack "${pack}"` });
  try { writeFileSync(`${POLICY_FILE}.bak`, readFileSync(POLICY_FILE)); } catch {}
  const next = JSON.parse(readFileSync(file, "utf8"));
  delete next.$description;
  writeFileSync(POLICY_FILE, JSON.stringify(next, null, 2));
  res.json(next);
});

// One-call budget creation for the console: generates the child wallet
// server-side (simulate-mode convenience — keys live in gitignored
// children.json exactly as the delegate script writes them), stores the
// grant, and returns the address so the CLI can spend as it immediately.
const CHILDREN_FILE = dataPath("children.json");
app.post("/api/delegations/wallet", requireAuth("admin"), async (req, res) => {
  const { capUSD, label, parent, allowedTools, allowedChains, allowedPayees, ttlSeconds, periodSeconds } = req.body || {};
  if (!(Number(capUSD) > 0)) return res.status(400).json({ error: "a positive capUSD is required" });
  let children = [];
  try { children = JSON.parse(readFileSync(CHILDREN_FILE, "utf8")); } catch {}
  let parentAddress = mainAccount.address;
  if (parent) {
    const match = children.find((c) => c.label === parent || c.address.toLowerCase() === String(parent).toLowerCase());
    if (!match) return res.status(404).json({ error: `no child wallet matching "${parent}"` });
    parentAddress = match.address;
  }
  const privateKey = generatePrivateKey();
  const child = privateKeyToAccount(privateKey);
  const record = createDelegation({ parentAddress, childAddress: child.address, capUSD, label, allowedTools, allowedChains, allowedPayees, ttlSeconds, periodSeconds });
  await recordConsent(record, "grant");
  children.push({ address: child.address, privateKey, delegationId: record.id, capUSD: Number(capUSD), label: label || null, allowedTools: record.allowedTools, allowedChains: record.allowedChains, allowedPayees: record.allowedPayees, expiresAt: record.expiresAt, createdAt: record.createdAt });
  writeFileSync(CHILDREN_FILE, JSON.stringify(children, null, 2));
  res.status(201).json({ ...record, spendWith: `npm run call -- <tool> --child="${label || child.address}"` });
});

app.get("/api/policy", (req, res) => {
  try {
    const raw = readFileSync(dataPath("policy.json"), "utf8");
    res.json(JSON.parse(raw));
  } catch {
    res.json({ maxPerCallUSD: 0.05, maxPerHourUSD: 0.2, maxCallsPerHour: 10, requireApprovalAboveUSD: 0.015, source: "built-in default" });
  }
});

// Human-in-the-loop approval queue: the client posts a pending request when its
// own policy says a price needs sign-off, then polls until someone (the dashboard,
// a human) decides it. Fails closed — see client/pay-and-call.js's timeout handling.
app.post("/api/approvals", (req, res) => {
  const { address, resource, price } = req.body || {};
  if (!address || !resource || price == null) return res.status(400).json({ error: "address, resource, price are required" });
  const record = createApproval({ address, resource, price });
  // One-click decide links: pasted into Slack/Telegram by the webhook, they
  // let an approver decide from chat — anywhere this server is reachable.
  sendAlert("approval_pending", {
    id: record.id,
    address,
    resource,
    price,
    approveUrl: `http://localhost:${PORT}/api/approvals/${record.id}/decide?decision=approved`,
    denyUrl: `http://localhost:${PORT}/api/approvals/${record.id}/decide?decision=denied`,
  });
  res.status(201).json(record);
});

function readPolicyRequiredApprovals() {
  try {
    const p = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
    return Number(p.approversRequired) > 1 ? Number(p.approversRequired) : 1;
  } catch {
    return 1;
  }
}

function readPolicyRequiresWorldId() {
  try {
    const p = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
    return Boolean(p.requireWorldIdForApproval);
  } catch {
    return false;
  }
}

app.get("/api/approvals", (req, res) => {
  res.json({ approvals: listApprovals() });
});

app.get("/api/approvals/:id", (req, res) => {
  const record = getApproval(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json(record);
});

// GET variant of decide, so the webhook's one-click links work from a chat
// message or any browser — same rules as the POST.
app.get("/api/approvals/:id/decide", (req, res) => {
  const decision = req.query.decision;
  if (decision !== "approved" && decision !== "denied") return res.status(400).send("decision must be 'approved' or 'denied'");
  // Real-money payouts are never decided by an unauthenticated link: they go
  // through the authenticated POST (approver role, World ID when required).
  if (String(getApproval(req.params.id)?.resource || "").startsWith("payout:")) return res.status(403).send("payout approvals must be decided in the SpendVeto Console");
  const record = decideApproval(req.params.id, decision, readPolicyRequiredApprovals());
  if (!record) return res.status(409).send("not pending (already decided, or unknown id)");
  res.send(`<body style="font-family:system-ui;background:#0b0f0c;color:#eef3ed;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>${decision === "approved" ? "✅ Approved" : "⛔ Denied"}</h2><p style="color:#93a094">${record.resource} · $${record.price} — recorded. You can close this tab.</p></div></body>`);
});

// The signed handshake IDKit needs before it will even open a proof
// request — proves this request really came from this server (control #33's
// World ID gate). Read-only, no side effects; safe to call from an
// unauthenticated demo page since it reveals nothing but a short-lived nonce.
app.get("/api/worldid/rp-context", (req, res) => {
  const context = rpContextFor(req.query.action || WORLD_ACTION());
  if (!context) return res.status(503).json({ error: "world_id_not_configured", reason: "WORLD_RP_ID / WORLD_RP_SIGNING_KEY not set" });
  res.json(context);
});

app.post("/api/approvals/:id/decide", requireAuth("approver"), async (req, res) => {
  const { decision, worldIdProof } = req.body || {};
  if (decision !== "approved" && decision !== "denied") return res.status(400).json({ error: "decision must be 'approved' or 'denied'" });
  // World ID gate (control #33): only an APPROVAL needs proof-of-personhood —
  // a deny never authorizes spend, so it's never gated. When the policy
  // requires it, "approved" must carry a real, independently verified human
  // proof, not just a click from whoever holds an approver key.
  if (decision === "approved" && readPolicyRequiresWorldId()) {
    if (!worldIdConfigured()) {
      return res.status(403).json({ error: "world_id_not_configured", reason: "this policy requires World ID verification on every approval, but WORLD_APP_ID is not set — refusing rather than accepting an unverified approval" });
    }
    const verdict = await verifyWorldIdProof(worldIdProof);
    if (!verdict.verified) {
      return res.status(403).json({ error: "world_id_verification_failed", reason: verdict.reason });
    }
  }
  const record = decideApproval(req.params.id, decision, readPolicyRequiredApprovals());
  if (!record) return res.status(409).json({ error: "not pending (already decided, or unknown id)" });
  // A payout waiting on this approval executes (or closes) right here.
  const payout = record.status === "approved" || record.status === "denied" ? await payouts.onApprovalDecided(record.id, record.status) : null;
  res.json(payout ? { ...record, payout } : record);
});

// Budget delegation: a parent wallet grants a child agent wallet a capped
// lifetime budget ("IAM for money"). The server is just the shared record
// store — enforcement happens in the child's own policy check (client/policy.js).
app.get("/api/delegations", (req, res) => {
  res.json({ delegations: listDelegations() });
});

app.post("/api/delegations", requireAuth("admin"), async (req, res) => {
  const { parentAddress, childAddress, capUSD, label, allowedTools, allowedChains, allowedPayees, ttlSeconds, periodSeconds } = req.body || {};
  if (!parentAddress || !childAddress || !(Number(capUSD) > 0)) {
    return res.status(400).json({ error: "parentAddress, childAddress, and a positive capUSD are required" });
  }
  const delegation = createDelegation({ parentAddress, childAddress, capUSD, label, allowedTools, allowedChains, allowedPayees, ttlSeconds, periodSeconds });
  await recordConsent(delegation, "grant");
  res.status(201).json(delegation);
});

app.post("/api/delegations/:id/revoke", requireAuth("admin"), async (req, res) => {
  const record = revokeDelegation(req.params.id);
  if (!record) return res.status(409).json({ error: "not found or already revoked" });
  await recordConsent(record, "revoke");
  res.json(record);
});

// The consent trail for one delegation: the signed grant, and — once it
// happens — the signed revoke. Each entry is independently verifiable
// (POST /api/consent/verify) without trusting this JSON file, the same way a
// settlement receipt is: the signature is over the record's own fields, not
// over "trust me, the ledger says so".
app.get("/api/consent/:delegationId", (req, res) => {
  res.json({ consents: consentsForDelegation(req.params.delegationId) });
});

app.post("/api/consent/verify", async (req, res) => {
  const { id, parentAddress, childAddress, capUSD, scope, action, ts, signedBy, signature } = req.body || {};
  if (!id || !parentAddress || !childAddress || !capUSD || !scope || !action || !ts || !signedBy || !signature) {
    return res.status(400).json({ error: "id, parentAddress, childAddress, capUSD, scope, action, ts, signedBy, signature are all required" });
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address: signedBy, message: consentMessage({ id, parentAddress, childAddress, capUSD, scope, action, ts }), signature });
  } catch {
    valid = false;
  }
  res.json({ valid });
});

// The Mastercard-Agent-Pay-style "Agentic Token": their tokenized card
// credential binds one agent + one merchant scope + one consent policy into
// a single presentable unit. SpendVeto already has every piece of that
// (delegation cap/scope + signed consent record) but scattered across two
// generic APIs; this is a thin, honest convenience wrapper — not a new
// enforcement mechanism — that requires exactly ONE payee (by construction,
// a "merchant token" that could pay more than one merchant isn't one) and
// hands back the delegation, its signed consent, and a short-lived TTL in
// one bundle. Enforcement is the same payee-allowlist + cap check every
// delegation already gets (client/policy.js).
app.post("/api/agentic-token", requireAuth("admin"), async (req, res) => {
  const { parentAddress, childAddress, capUSD, merchant, allowedTools, ttlSeconds, label } = req.body || {};
  if (!parentAddress || !childAddress || !(Number(capUSD) > 0)) {
    return res.status(400).json({ error: "parentAddress, childAddress, and a positive capUSD are required" });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(merchant || "")) {
    return res.status(400).json({ error: "merchant must be a single 0x-prefixed 20-byte payee address — an agentic token is scoped to exactly one merchant" });
  }
  const delegation = createDelegation({
    parentAddress,
    childAddress,
    capUSD,
    label: label || `agentic token → ${merchant.slice(0, 10)}`,
    allowedTools: allowedTools || null,
    allowedPayees: [merchant],
    ttlSeconds: ttlSeconds || 3600,
  });
  const consent = await recordConsent(delegation, "grant");
  res.status(201).json({ tokenId: delegation.id, merchant, delegation, consent });
});

app.get("/api/agentic-token/:id", (req, res) => {
  const delegation = listDelegations().find((d) => d.id === req.params.id);
  if (!delegation) return res.status(404).json({ error: "no agentic token with that id" });
  res.json({ tokenId: delegation.id, merchant: delegation.allowedPayees?.[0] ?? null, delegation, consents: consentsForDelegation(delegation.id) });
});

// The cross-org trust graph: every wallet a scored node, every delegation an
// edge, every delegation root an "org" with a blended sub-tree reputation. The
// flat per-wallet score, scaled out into the beginnings of an agent credit
// bureau. Registered before /api/trust/:address so "graph" isn't swallowed as
// an address param.
app.get("/api/trust/graph", (req, res) => {
  res.json(trustGraph());
});

// Counterparty bureau: reputation of a recipient address, aggregated across
// every wallet that has paid it — the "credit report on the merchant" side.
app.get("/api/trust/payee/:address", (req, res) => {
  res.json(payeeReputation(req.params.address));
});

// Agent trust score: a wallet's governance history, compressed to one number.
// Paid history earns trust; blocks, failures, and freezes burn it. The ledger
// is the credit file — the beginning of a trust graph for agents.
app.get("/api/trust/:address", (req, res) => {
  res.json(trustScoreFor(req.params.address));
});

// Advanced anomaly analysis: a panel of deterministic behavioural signals
// (block-rate spike, novel payee, category drift, amount outlier) over the
// wallet's own ledger, above and beyond the burst-rate auto-freeze. Advisory —
// surfaced for review, not an automatic block.
app.get("/api/anomaly/:address", (req, res) => {
  res.json(analyzeAnomalies(req.params.address));
});

// Kill switch: freeze a wallet (manually, or automatically via the anomaly
// detector when a runaway loop is suspected). Enforced in the client's policy
// check and, in simulate mode, at the payment gate itself.
app.get("/api/freezes", (req, res) => {
  res.json({ freezes: listFreezes() });
});

app.post("/api/freezes", requireAuth("admin"), (req, res) => {
  const { address, reason } = req.body || {};
  if (!address) return res.status(400).json({ error: "address is required" });
  if (findActiveFreeze(address)) return res.status(409).json({ error: "already frozen" });
  res.status(201).json(createFreeze({ address, reason, source: "manual" }));
});

app.post("/api/freezes/:id/unfreeze", requireAuth("admin"), (req, res) => {
  const record = unfreeze(req.params.id);
  if (!record) return res.status(409).json({ error: "not found or already unfrozen" });
  res.json(record);
});

// ACP (OpenAI/Stripe Agentic Commerce Protocol), buyer side. Same shape as the
// AP2 mandate chain above, because it is the same failure: a scoped credential
// (there, a signed intent; here, a Shared Payment Token) and an agent that
// assembled the actual purchase somewhere else. The merchant validates the
// token; nobody validates the shopping. See server/acp.js.
app.post("/api/acp/checkout", async (req, res) => {
  const { agent, token, session, chain } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });

  const ts = new Date().toISOString();
  const drift = checkSessionAgainstToken(token, session);

  // Structural drift decided before policy, for the same reason as AP2: a
  // session the token never authorized is not a budget question.
  if (!drift.ok) {
    const signed = await signDecision({ id: session?.id, agent, amountUSD: Number(session?.totalUSD) || 0, payee: null, verdict: "deny", ts });
    return res.json({
      decision: "deny",
      stage: "spt_scope",
      code: drift.code,
      reason: drift.reason,
      suggestion: drift.suggestion,
      tokenId: token?.id ?? null,
      sessionId: session?.id ?? null,
      ts,
      ...signed,
    });
  }

  const payee = session.payee || drift.merchant || null;
  const category = session.items.find((it) => it.category)?.category || null;
  const verdict = await checkPolicy(agent, drift.totalUSD, "acp-checkout", chain || DEFAULT_CHAIN, category, payee);
  const decision = verdict.allowed ? (verdict.requiresApproval ? "requires_approval" : "allow") : "deny";
  const signed = await signDecision({ id: session.id, agent, amountUSD: drift.totalUSD, payee, verdict: decision, ts });

  // An allowed session is bound to its own bytes before it leaves: the caller
  // executes with this bindingId, and a session edited in between stops
  // verifying. Denials get no binding — there is nothing to authorize.
  const binding = decision === "allow" ? await bindAuthorization({ agent, payload: session, amountUSD: drift.totalUSD, payee }) : null;

  res.json({
    decision,
    stage: "policy",
    reason: verdict.reason || "session matches its token scope and is within policy",
    ...(verdict.code ? { code: verdict.code } : {}),
    ...(verdict.suggestion ? { suggestion: verdict.suggestion } : {}),
    tokenId: token?.id ?? null,
    sessionId: session.id ?? null,
    totalUSD: drift.totalUSD,
    merchant: drift.merchant,
    currency: drift.currency,
    itemCount: drift.itemCount,
    ...(binding ? { binding: { id: binding.id, digest: binding.digest, expiresAt: binding.expiresAt } } : {}),
    ts,
    ...signed,
  });
});

// UPI mandate governance (India). Decides allow / requires_approval / deny for a UPI mandate debit with the RBI
// e-mandate framework's rules, deterministically, and signs the verdict in INR. It never initiates or settles
// anything on UPI, and "requires_approval" always means a human completes the customer's authentication (server/upi.js).
const upiSpentToday = new Map(); // agent -> { day, total } — process-lifetime tally of allow verdicts this evaluator issued
app.post("/api/upi/evaluate", async (req, res) => {
  const { agent, mandate } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });

  let upiPolicy = {};
  try {
    upiPolicy = JSON.parse(readFileSync(POLICY_FILE, "utf8")).upi || {};
  } catch {}
  const day = new Date().toISOString().slice(0, 10);
  const tally = upiSpentToday.get(agent);
  const spentTodayINR = tally && tally.day === day ? tally.total : 0;

  const ts = new Date().toISOString();
  const v = evaluateUpiMandate(mandate, { policy: upiPolicy, spentTodayINR });
  if (v.decision === "allow") upiSpentToday.set(agent, { day, total: Math.round((spentTodayINR + Number(mandate.amountINR)) * 100) / 100 });

  const payeeMasked = maskVpa(mandate?.payeeVpa);
  const signed = await signUpiDecision({ id: mandate?.id, agent, amountINR: Number(mandate?.amountINR) || 0, payeeMasked, verdict: v.decision, code: v.code, ts });
  res.json({
    decision: v.decision,
    reason: v.reason,
    ...(v.code ? { code: v.code } : {}),
    ...(v.suggestion ? { suggestion: v.suggestion } : {}),
    ...(v.afa ? { afa: v.afa } : {}),
    currency: "INR",
    mandate: { id: mandate?.id ?? null, amountINR: Number(mandate?.amountINR) || null, payee: payeeMasked, category: mandate?.category ?? null },
    regulatoryBasis: UPI_REGULATORY_BASIS,
    disclaimer: UPI_DISCLAIMER,
    ts,
    ...signed,
  });
});

// EU payment governance (PSD2 Strong Customer Authentication + SEPA Direct Debit). Decides allow / requires_approval
// / deny with the RTS's own exemption math (Art. 10 one-off low-value, Art. 14(1) recurring fixed-amount, Art. 18
// transaction-risk-analysis), and signs the verdict in EUR. Never initiates or settles anything on SEPA, and
// "requires_approval" always means the payer completes Strong Customer Authentication themselves (server/eu-sepa.js).
const euSpentToday = new Map(); // agent -> { day, total }
app.post("/api/eu/evaluate", async (req, res) => {
  const { agent, mandate } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });

  let euPolicy = {};
  try {
    euPolicy = JSON.parse(readFileSync(POLICY_FILE, "utf8")).eu || {};
  } catch {}
  const day = new Date().toISOString().slice(0, 10);
  const tally = euSpentToday.get(agent);
  const spentTodayEUR = tally && tally.day === day ? tally.total : 0;

  const ts = new Date().toISOString();
  const v = evaluateSepaDebit(mandate, { policy: euPolicy, spentTodayEUR });
  if (v.decision === "allow") euSpentToday.set(agent, { day, total: Math.round((spentTodayEUR + Number(mandate.amountEUR)) * 100) / 100 });

  const payeeMasked = maskIban(mandate?.payeeIban);
  const signed = await signEuDecision({ id: mandate?.id, agent, amountEUR: Number(mandate?.amountEUR) || 0, payeeMasked, verdict: v.decision, code: v.code, ts });
  res.json({
    decision: v.decision,
    reason: v.reason,
    ...(v.code ? { code: v.code } : {}),
    ...(v.suggestion ? { suggestion: v.suggestion } : {}),
    ...(v.sca ? { sca: v.sca } : {}),
    currency: "EUR",
    mandate: { id: mandate?.id ?? null, amountEUR: Number(mandate?.amountEUR) || null, payee: payeeMasked, category: mandate?.category ?? null },
    regulatoryBasis: EU_REGULATORY_BASIS,
    disclaimer: EU_DISCLAIMER,
    ts,
    ...signed,
  });
});

// UK payment governance (Faster Payments push payments). Decides allow / requires_approval / deny using Confirmation
// of Payee results and the PSR's APP fraud reimbursement cap, and signs the verdict in GBP. Never initiates or
// settles a Faster Payments transaction, and "requires_approval" always means the payer makes the call themselves
// (server/uk-fps.js).
const ukSpentToday = new Map(); // agent -> { day, total }
app.post("/api/uk/evaluate", async (req, res) => {
  const { agent, payment } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });

  let ukPolicy = {};
  try {
    ukPolicy = JSON.parse(readFileSync(POLICY_FILE, "utf8")).uk || {};
  } catch {}
  const day = new Date().toISOString().slice(0, 10);
  const tally = ukSpentToday.get(agent);
  const spentTodayGBP = tally && tally.day === day ? tally.total : 0;

  const ts = new Date().toISOString();
  const v = evaluateUkPushPayment(payment, { policy: ukPolicy, spentTodayGBP });
  if (v.decision === "allow") ukSpentToday.set(agent, { day, total: Math.round((spentTodayGBP + Number(payment.amountGBP)) * 100) / 100 });

  const payeeMasked = maskAccountNumberUk(payment?.payeeAccountNumber);
  const signed = await signUkDecision({ id: payment?.id, agent, amountGBP: Number(payment?.amountGBP) || 0, payeeMasked, verdict: v.decision, code: v.code, ts });
  res.json({
    decision: v.decision,
    reason: v.reason,
    ...(v.code ? { code: v.code } : {}),
    ...(v.suggestion ? { suggestion: v.suggestion } : {}),
    ...(v.authorisation ? { authorisation: v.authorisation } : {}),
    currency: "GBP",
    payment: { id: payment?.id ?? null, amountGBP: Number(payment?.amountGBP) || null, payee: payeeMasked, category: payment?.category ?? null },
    regulatoryBasis: UK_REGULATORY_BASIS,
    disclaimer: UK_DISCLAIMER,
    ts,
    ...signed,
  });
});

// Brazil payment governance (Pix). Decides allow / requires_approval / deny using the nighttime-limit rule for
// ordinary transfers and Pix Automático's scheduling/retry rules for recurring ones, and signs the verdict in BRL.
// Never initiates or settles a Pix payment, and "requires_approval" always means the payer acts in their own
// banking app (server/br-pix.js).
const brSpentToday = new Map(); // agent -> { day, total }
const brPixAttempts = new Map(); // mandate id -> allowed-attempt timestamps (ms), last 7 days
app.post("/api/br/evaluate", async (req, res) => {
  const { agent, mandate } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });

  let brPolicy = {};
  try {
    brPolicy = JSON.parse(readFileSync(POLICY_FILE, "utf8")).br || {};
  } catch {}
  const day = new Date().toISOString().slice(0, 10);
  const tally = brSpentToday.get(agent);
  const spentTodayBRL = tally && tally.day === day ? tally.total : 0;

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const attemptLog = (mandate?.id && brPixAttempts.get(mandate.id)) || [];
  const attemptsInWindow = attemptLog.filter((t) => t >= sevenDaysAgo).length;

  const ts = new Date().toISOString();
  const v = evaluatePixPayment(mandate, { policy: brPolicy, spentTodayBRL, attemptsInWindow });
  if (v.decision === "allow") {
    brSpentToday.set(agent, { day, total: Math.round((spentTodayBRL + Number(mandate.amountBRL)) * 100) / 100 });
    if (mandate?.id && mandate?.recurring) brPixAttempts.set(mandate.id, [...attemptLog.filter((t) => t >= sevenDaysAgo), now]);
  }

  const payeeMasked = maskPixKey(mandate?.payeeKey);
  const signed = await signBrDecision({ id: mandate?.id, agent, amountBRL: Number(mandate?.amountBRL) || 0, payeeMasked, verdict: v.decision, code: v.code, ts });
  res.json({
    decision: v.decision,
    reason: v.reason,
    ...(v.code ? { code: v.code } : {}),
    ...(v.suggestion ? { suggestion: v.suggestion } : {}),
    ...(v.authorisation ? { authorisation: v.authorisation } : {}),
    currency: "BRL",
    mandate: { id: mandate?.id ?? null, amountBRL: Number(mandate?.amountBRL) || null, payee: payeeMasked, category: mandate?.category ?? null },
    regulatoryBasis: BR_REGULATORY_BASIS,
    disclaimer: BR_DISCLAIMER,
    ts,
    ...signed,
  });
});

// US payment governance (ACH / Nacha + Regulation E). Decides allow / requires_approval / deny — account validation
// is a system fraud-detection gate (DENY, not a human pause), while consumer authorization/notice/stop-payment
// rights under Regulation E are the human-approval path — and signs the verdict in USD. Never originates or settles
// an ACH entry (server/us-ach.js).
const usSpentToday = new Map(); // agent -> { day, total }
app.post("/api/us/evaluate", async (req, res) => {
  const { agent, mandate } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });

  let usPolicy = {};
  try {
    usPolicy = JSON.parse(readFileSync(POLICY_FILE, "utf8")).us || {};
  } catch {}
  const day = new Date().toISOString().slice(0, 10);
  const tally = usSpentToday.get(agent);
  const spentTodayUSD = tally && tally.day === day ? tally.total : 0;

  const ts = new Date().toISOString();
  const v = evaluateAchDebit(mandate, { policy: usPolicy, spentTodayUSD });
  if (v.decision === "allow") usSpentToday.set(agent, { day, total: Math.round((spentTodayUSD + Number(mandate.amountUSD)) * 100) / 100 });

  const payeeMasked = maskAccountNumberUs(mandate?.payeeAccountNumber);
  const signed = await signUsDecision({ id: mandate?.id, agent, amountUSD: Number(mandate?.amountUSD) || 0, payeeMasked, verdict: v.decision, code: v.code, ts });
  res.json({
    decision: v.decision,
    reason: v.reason,
    ...(v.code ? { code: v.code } : {}),
    ...(v.suggestion ? { suggestion: v.suggestion } : {}),
    ...(v.authorization ? { authorization: v.authorization } : {}),
    currency: "USD",
    mandate: { id: mandate?.id ?? null, amountUSD: Number(mandate?.amountUSD) || null, payee: payeeMasked, category: mandate?.category ?? null },
    regulatoryBasis: US_REGULATORY_BASIS,
    disclaimer: US_DISCLAIMER,
    ts,
    ...signed,
  });
});

// x402 `upto` scheme, buyer side (server/upto.js). The scheme lets a buyer
// sign for a ceiling and the seller charge less, later — so the number to
// govern is the ceiling, and the gap between ceiling and charge has to be held
// against the budget until it resolves. Policy decides on maxUSD here for
// exactly that reason: the signature exposes the buyer to the maximum the
// moment it exists, whatever the seller quoted.
app.post("/api/upto/authorize", async (req, res) => {
  const { address, maxUSD, quotedUSD, payee, toolId, chain, category, validAfter, deadline } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) return res.status(400).json({ error: "address must be a 0x-prefixed 20-byte address" });
  if (!(Number(maxUSD) > 0)) return res.status(400).json({ error: "maxUSD must be a positive number — the ceiling the authorization permits" });

  const ts = new Date().toISOString();
  const verdict = await checkPolicy(address, Number(maxUSD), toolId, chain || DEFAULT_CHAIN, category, payee);
  if (!verdict.allowed) {
    // A refused authorization is a blocked spend at the ceiling, not at the
    // quote — recorded that way so the ledger shows the exposure that was
    // actually prevented.
    appendLedgerEntry({
      address, resource: toolId ? `upto:${toolId}` : "upto", amount: Number(maxUSD), chain: chain || DEFAULT_CHAIN,
      ...(category ? { category } : {}), ...(payee ? { payTo: payee } : {}),
      status: "blocked", mode: "upto", reason: `upto authorization: ${verdict.reason}`, policyHash: policyHash(),
    });
    return res.status(403).json({ decision: "deny", stage: "policy", code: verdict.code, reason: verdict.reason, suggestion: verdict.suggestion, maxUSD: Number(maxUSD), ts });
  }
  if (verdict.requiresApproval) {
    return res.status(403).json({
      decision: "requires_approval", stage: "policy", code: "requires_approval",
      reason: `an upto ceiling of $${Number(maxUSD)} is above requireApprovalAboveUSD $${verdict.policy.requireApprovalAboveUSD} — a human signs off on the ceiling, not the eventual charge`,
      suggestion: "request approval for this ceiling before signing the authorization, or lower the maximum",
      maxUSD: Number(maxUSD), ts,
    });
  }

  const result = uptoAuthorize({ address, maxUSD, quotedUSD, payee, toolId, chain: chain || DEFAULT_CHAIN, category, validAfter, deadline });
  if (!result.ok) return res.status(400).json({ decision: "deny", stage: "scheme", code: result.code, reason: result.reason, suggestion: result.suggestion, ts });
  res.status(201).json({ decision: "allow", stage: "policy", authorization: result.authorization, heldUSD: openHoldUSD(address), ts });
});

// Settlement: the seller reports what it actually charged. Over-settlement,
// replay, and post-deadline settlement are refused here — on the buyer's side,
// because the buyer is the party who pays for the facilitator being wrong.
app.post("/api/upto/settle", (req, res) => {
  const { id, settledUSD } = req.body || {};
  const result = settleAuthorization(id, settledUSD);
  if (!result.ok) return res.status(409).json({ decision: "deny", code: result.code, reason: result.reason, suggestion: result.suggestion });
  const a = result.authorization;
  // The settled amount — never the ceiling — is what enters the spend record:
  // held money that was released was never spent.
  appendLedgerEntry({
    address: a.address, resource: a.toolId ? `upto:${a.toolId}` : "upto", amount: a.settledUSD, chain: a.chain || DEFAULT_CHAIN,
    ...(a.category ? { category: a.category } : {}), ...(a.payee ? { payTo: a.payee } : {}),
    status: "paid", mode: "upto", authorizationId: a.id, maxUSD: a.maxUSD, releasedUSD: a.releasedUSD, policyHash: policyHash(),
  });
  res.json({ decision: "settled", authorization: a, settledUSD: a.settledUSD, releasedUSD: a.releasedUSD, heldUSD: openHoldUSD(a.address) });
});

app.post("/api/upto/void", (req, res) => {
  const { id, reason } = req.body || {};
  const result = voidAuthorization(id, reason);
  if (!result.ok) return res.status(409).json({ decision: "deny", code: result.code, reason: result.reason, suggestion: result.suggestion });
  res.json({ decision: "voided", authorization: result.authorization, releasedUSD: result.releasedUSD, heldUSD: openHoldUSD(result.authorization.address) });
});

// The hold number client/policy.js folds into the hourly budget: every open
// upto ceiling plus every live auth-capture hold (server/authcapture.js) —
// two schemes, one question: what has this wallet signed away but not spent?
app.get("/api/upto/holds/:address", (req, res) => {
  const uptoUSD = openHoldUSD(req.params.address);
  const authCaptureUSD = authCaptureHoldUSD(req.params.address);
  // In-flight LLM requests reserve their estimate too (server/llmguard.js),
  // so a payment racing a model call sees the money already committed.
  const llmUSD = llmGuard.heldUSD(req.params.address);
  res.json({ address: req.params.address, heldUSD: Math.round((uptoUSD + authCaptureUSD + llmUSD) * 1e6) / 1e6, uptoUSD, authCaptureUSD, llmUSD });
});

// ---- AI FinOps (server/finops.js): one cost view across every rail, FOCUS export, rebilling ----
app.get("/api/costs", (req, res) => {
  const groupBy = /^[a-z][a-z0-9_-]{0,31}$/.test(req.query.groupBy || "") ? req.query.groupBy : "category";
  const days = Math.min(366, Math.max(1, Number(req.query.days) || 30));
  res.json(costReport(getLedger(), { groupBy, days }));
});
app.get("/api/costs/focus.csv", (req, res) => {
  const days = Math.min(366, Math.max(1, Number(req.query.days) || 30));
  const finops = readJsonFile(POLICY_FILE, {}).finops || {};
  const rows = focusRows(getLedger(), { days, billingAccountId: finops.billingAccountId || "spendveto", billingAccountName: finops.billingAccountName || "SpendVeto" });
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="spendveto-focus-${new Date().toISOString().slice(0, 10)}.csv"` });
  res.send(toFocusCsv(rows));
});
app.get("/api/rebilling", (req, res) => {
  res.json(rebiller.summary({ days: Math.min(366, Math.max(1, Number(req.query.days) || 30)) }));
});
app.put("/api/rebilling", requireAuth("admin"), (req, res) => {
  const b = req.body || {};
  const policy = readJsonFile(POLICY_FILE, {});
  const r = { ...(policy.rebilling || {}) };
  if (typeof b.enabled === "boolean") r.enabled = b.enabled;
  if (b.markupPct != null) {
    if (!(Number(b.markupPct) >= 0 && Number(b.markupPct) <= 1000)) return res.status(400).json({ error: "markupPct must be between 0 and 1000" });
    r.markupPct = Number(b.markupPct);
  }
  if (b.eventName != null) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(String(b.eventName))) return res.status(400).json({ error: "eventName must be 1-100 chars of letters, digits, _ . -" });
    r.eventName = String(b.eventName);
  }
  if (b.customerTag != null) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(String(b.customerTag))) return res.status(400).json({ error: "customerTag must be a lowercase tag key" });
    r.customerTag = String(b.customerTag);
  }
  policy.rebilling = r;
  writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2));
  res.json({ settings: rebillingSettings(policy) });
});

// ---- Governed fiat payouts (server/payouts.js): Stripe, RazorpayX, PayPal, Modern Treasury ----
const payouts = createPayouts({
  dataPath,
  loadPolicy: () => readJsonFile(POLICY_FILE, {}),
  checkPolicy,
  policyHash: () => policyHash(),
  appendLedgerEntry,
  getLedger,
  findActiveFreeze,
  listDelegations,
  createApproval,
  getApproval,
  readAgents: () => readJsonFile(dataPath("agents.json"), []),
  childAddress: childAddressFor,
  pseudoAddress,
  reputationCheck: (subjects) => reputation.check(subjects),
});
app.post("/api/payouts", async (req, res) => {
  const out = await payouts.create(req, req.body || {});
  res.status(out.status).json(out.json);
});
app.get("/api/payouts", (req, res) => {
  res.json(payouts.summary());
});
// Your own webhook glue reports a later provider status (a RazorpayX payout
// reversing, an ACH credit returning) — recorded, not re-decided.
app.post("/api/payouts/:id/status", requireAuth("admin"), (req, res) => {
  const row = payouts.recordStatus(req.params.id, req.body?.status, req.body?.note);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// ---- Card authorization governance: registry + decisions (server/cards.js) ----
// Map a card to an agent label (and optionally a delegated child wallet, so
// the card shares that agent's cascading budget with its x402 and LLM spend).
app.get("/api/cards", (req, res) => {
  res.json({ cards: readJsonFile(dataPath("cards.json"), []), settings: cardSettings(readJsonFile(POLICY_FILE, {})), configured: { stripe: Boolean(process.env.STRIPE_ISSUING_WEBHOOK_SECRET), lithic: Boolean(process.env.LITHIC_ASA_SECRET) } });
});
app.post("/api/cards", requireAuth("admin"), (req, res) => {
  const { cardId, label, rail, child, tags } = req.body || {};
  if (!cardId || typeof cardId !== "string") return res.status(400).json({ error: "cardId is required (Stripe ic_… or Lithic card token)" });
  if (!label || typeof label !== "string") return res.status(400).json({ error: "label is required" });
  if (child && !childAddressFor(child)) return res.status(404).json({ error: `no delegated child wallet matching "${child}"` });
  const cards = readJsonFile(dataPath("cards.json"), []).filter((c) => c.cardId !== cardId);
  const cleanTags = tags && typeof tags === "object" ? Object.fromEntries(Object.entries(tags).slice(0, 10).filter(([k]) => /^[a-z][a-z0-9_-]{0,31}$/.test(k)).map(([k, v]) => [k, String(v).slice(0, 64)])) : null;
  const record = { cardId, label: label.slice(0, 60), rail: rail === "lithic" ? "lithic" : "stripe", child: child || null, ...(cleanTags && Object.keys(cleanTags).length ? { tags: cleanTags } : {}), createdAt: new Date().toISOString() };
  cards.push(record);
  writeFileSync(dataPath("cards.json"), JSON.stringify(cards, null, 2));
  res.status(201).json(record);
});
app.get("/api/cards/decisions", (req, res) => {
  res.json({ decisions: getLedger().filter((e) => e.category === "card").slice(-50).reverse() });
});

// ---- LLM spend guard: read side + settings (server/llmguard.js) ----
app.get("/api/llm/summary", (req, res) => {
  res.json(llmGuard.summary());
});

// Copy-paste connection lines for every client the guard speaks to, built
// from the address the caller reached this server on.
app.get("/api/llm/connect", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    base,
    clients: [
      { name: "Claude Code", line: `ANTHROPIC_BASE_URL=${base} claude` },
      { name: "Codex CLI", line: `OPENAI_BASE_URL=${base}/v1 codex` },
      { name: "Anthropic SDK (Python / TypeScript)", line: `ANTHROPIC_BASE_URL=${base}` },
      { name: "OpenAI SDK (Python / TypeScript)", line: `OPENAI_BASE_URL=${base}/v1` },
      { name: "Any OpenAI-compatible tool (Cursor, LangChain, LiteLLM, Aider…)", line: `base URL: ${base}/v1` },
    ],
    note: "Your provider key passes straight through and is never stored. To give an agent a budget without giving it a key, register it on the Agents page and use its tg_… token instead.",
  });
});

app.get("/api/llm/settings", (req, res) => {
  res.json({ settings: llmGuard.settings() });
});

// Validated merge into policy.llm — numbers must be positive, lists are
// trimmed, unknown keys are ignored rather than written to the policy file.
app.put("/api/llm/settings", requireAuth("admin"), (req, res) => {
  const b = req.body || {};
  const policy = readJsonFile(POLICY_FILE, {});
  const llm = { ...(policy.llm || {}) };
  const positive = ["dailyBudgetUSD", "hourlyBudgetUSD", "maxRequestUSD", "maxRequestsPerMinute", "outputEstimateCapTokens", "approvalTimeoutMs"];
  for (const k of positive) {
    if (b[k] == null) continue;
    if (!(Number(b[k]) > 0)) return res.status(400).json({ error: `${k} must be a positive number` });
    llm[k] = Number(b[k]);
  }
  for (const k of ["sessionBudgetUSD", "approvalAboveUSD"]) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === "") llm[k] = null;
    else if (Number(b[k]) > 0) llm[k] = Number(b[k]);
    else return res.status(400).json({ error: `${k} must be a positive number or null` });
  }
  if (b.mode !== undefined) {
    if (!["enforce", "observe"].includes(b.mode)) return res.status(400).json({ error: 'mode must be "enforce" or "observe"' });
    llm.mode = b.mode;
  }
  for (const k of ["allowedModels", "blockedModels"]) {
    if (b[k] === undefined) continue;
    llm[k] = Array.isArray(b[k]) && b[k].length ? b[k].map((m) => String(m).trim()).filter(Boolean).slice(0, 50) : k === "allowedModels" ? null : [];
  }
  if (b.loop && typeof b.loop === "object") {
    const loop = { ...(llm.loop || {}) };
    if (typeof b.loop.enabled === "boolean") loop.enabled = b.loop.enabled;
    if (Number(b.loop.threshold) >= 2) loop.threshold = Math.floor(Number(b.loop.threshold));
    if (Number(b.loop.windowSeconds) > 0) loop.windowSeconds = Number(b.loop.windowSeconds);
    llm.loop = loop;
  }
  for (const k of ["requireAgentToken", "passthroughUnknown"]) if (typeof b[k] === "boolean") llm[k] = b[k];
  if (b.tagBudgets && typeof b.tagBudgets === "object") {
    const tb = { ...(llm.tagBudgets || {}) };
    for (const [key, v] of Object.entries(b.tagBudgets)) {
      if (!/^[a-z][a-z0-9_-]{0,31}=[\w .:@/-]{1,64}$/.test(key)) return res.status(400).json({ error: `tag budget key "${key}" must look like team=search or customer=cus_123` });
      if (v === null) delete tb[key];
      else if (v && (Number(v.dailyUSD) > 0 || Number(v.hourlyUSD) > 0)) tb[key] = { ...(Number(v.dailyUSD) > 0 ? { dailyUSD: Number(v.dailyUSD) } : {}), ...(Number(v.hourlyUSD) > 0 ? { hourlyUSD: Number(v.hourlyUSD) } : {}) };
      else return res.status(400).json({ error: `tag budget for ${key} needs a positive dailyUSD and/or hourlyUSD` });
    }
    llm.tagBudgets = tb;
  }
  if (b.identityFrom !== undefined) {
    if (!["local", "credential"].includes(b.identityFrom)) return res.status(400).json({ error: 'identityFrom must be "local" or "credential"' });
    llm.identityFrom = b.identityFrom;
  }
  if (b.prices && typeof b.prices === "object") {
    const prices = { ...(llm.prices || {}) };
    for (const [model, row] of Object.entries(b.prices)) {
      if (row === null) delete prices[model];
      else if (row && Number(row.inputPerM) >= 0 && Number(row.outputPerM) >= 0) prices[String(model).toLowerCase()] = { inputPerM: Number(row.inputPerM), outputPerM: Number(row.outputPerM), ...(row.cacheReadPerM != null ? { cacheReadPerM: Number(row.cacheReadPerM) } : {}) };
      else return res.status(400).json({ error: `price for ${model} needs numeric inputPerM and outputPerM (USD per million tokens)` });
    }
    llm.prices = prices;
  }
  policy.llm = llm;
  writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2));
  res.json({ settings: llmGuard.settings() });
});

app.get("/api/upto", (req, res) => {
  const { address } = req.query;
  const authorizations = getAuthorizations().filter((a) => !address || String(a.address).toLowerCase() === String(address).toLowerCase());
  res.json({ authorizations, summary: uptoSummary(address) });
});

// x402 `auth-capture` (server/authcapture.js): refuse a hostile route before
// signing, govern the maximum, hold the escrow against the budget, and hold
// the seller's lifecycle calls to the terms the buyer signed.
function readAuthCapturePolicy() {
  try {
    return JSON.parse(readFileSync(POLICY_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function governAuthCapture(body) {
  const { address, requirements, authorizationTo, toolId, category } = body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) return { status: 400, json: { error: "address must be a 0x-prefixed 20-byte address" } };
  const ts = new Date().toISOString();
  const evaluation = evaluateAuthCapture(requirements, { policy: readAuthCapturePolicy(), authorizationTo });
  if (!evaluation.ok) return { status: 403, json: { decision: "deny", stage: "scheme", code: evaluation.code, reason: evaluation.reason, suggestion: evaluation.suggestion, ts } };
  // Policy decides on the maximum: from the moment the authorization exists,
  // the maximum is what the buyer is exposed to.
  const verdict = await checkPolicy(address, evaluation.maxUSD, toolId, evaluation.chain, category, evaluation.payee);
  if (!verdict.allowed) return { status: 403, json: { decision: "deny", stage: "policy", code: verdict.code, reason: verdict.reason, suggestion: verdict.suggestion, maxUSD: evaluation.maxUSD, ts }, blocked: { evaluation, verdict } };
  if (verdict.requiresApproval) {
    return { status: 403, json: { decision: "requires_approval", stage: "policy", code: "requires_approval", reason: `an auth-capture maximum of $${evaluation.maxUSD} is above requireApprovalAboveUSD $${verdict.policy.requireApprovalAboveUSD} — a human signs off on the maximum, not the eventual capture`, suggestion: "request approval for this maximum before signing, or ask the seller for a lower one", maxUSD: evaluation.maxUSD, ts } };
  }
  return { status: 200, json: { decision: "allow", stage: "policy", evaluation, ts }, evaluation };
}

// Dry run: would SpendVeto let this wallet sign this route? No state change.
app.post("/api/authcapture/evaluate", async (req, res) => {
  const out = await governAuthCapture(req.body);
  res.status(out.status).json(out.json);
});

app.post("/api/authcapture/authorize", async (req, res) => {
  const { address, toolId, category } = req.body || {};
  const out = await governAuthCapture(req.body);
  if (out.blocked) {
    const { evaluation, verdict } = out.blocked;
    appendLedgerEntry({
      address, resource: toolId ? `auth-capture:${toolId}` : "auth-capture", amount: evaluation.maxUSD, chain: evaluation.chain,
      ...(category ? { category } : {}), ...(evaluation.payee ? { payTo: evaluation.payee } : {}),
      status: "blocked", mode: "auth-capture", reason: `auth-capture maximum: ${verdict.reason}`, policyHash: policyHash(),
    });
  }
  if (!out.evaluation) return res.status(out.status).json(out.json);
  const payment = recordCollect({ address, evaluation: out.evaluation, toolId, category });
  res.status(201).json({ decision: "allow", stage: "policy", payment, heldUSD: authCaptureHoldUSD(address), ts: out.json.ts });
});

// Seller lifecycle, re-checked against the signed terms. Captured or charged
// money — never the maximum — is what enters the spend record.
const bookCapture = (p, amountUSD, op) =>
  appendLedgerEntry({
    address: p.address, resource: p.toolId ? `auth-capture:${p.toolId}` : "auth-capture", amount: amountUSD, chain: p.chain,
    ...(p.category ? { category: p.category } : {}), ...(p.payee ? { payTo: p.payee } : {}),
    status: "paid", mode: "auth-capture", authCaptureId: p.id, op, maxUSD: p.maxUSD, policyHash: policyHash(),
  });

app.post("/api/authcapture/:id/capture", (req, res) => {
  const r = capturePayment(req.params.id, req.body?.amountUSD);
  if (!r.ok) return res.status(r.code === "ac_unknown" ? 404 : 409).json({ decision: "deny", code: r.code, reason: r.reason, suggestion: r.suggestion });
  bookCapture(r.payment, r.capturedUSD, "capture");
  res.json({ decision: "captured", payment: r.payment, capturedUSD: r.capturedUSD, remainingUSD: r.remainingUSD, heldUSD: authCaptureHoldUSD(r.payment.address) });
});

app.post("/api/authcapture/:id/charge", (req, res) => {
  const r = chargePayment(req.params.id, req.body?.amountUSD);
  if (!r.ok) return res.status(r.code === "ac_unknown" ? 404 : 409).json({ decision: "deny", code: r.code, reason: r.reason, suggestion: r.suggestion });
  bookCapture(r.payment, r.capturedUSD, "charge");
  res.json({ decision: "charged", payment: r.payment, capturedUSD: r.capturedUSD, releasedUSD: r.releasedUSD, heldUSD: authCaptureHoldUSD(r.payment.address) });
});

app.post("/api/authcapture/:id/void", (req, res) => {
  const r = voidPayment(req.params.id);
  if (!r.ok) return res.status(r.code === "ac_unknown" ? 404 : 409).json({ decision: "deny", code: r.code, reason: r.reason, suggestion: r.suggestion });
  res.json({ decision: "voided", payment: r.payment, releasedUSD: r.releasedUSD, heldUSD: authCaptureHoldUSD(r.payment.address) });
});

app.post("/api/authcapture/:id/refund", (req, res) => {
  const r = refundPayment(req.params.id, req.body?.amountUSD);
  if (!r.ok) return res.status(r.code === "ac_unknown" ? 404 : 409).json({ decision: "deny", code: r.code, reason: r.reason, suggestion: r.suggestion });
  res.json({ decision: "refunded", payment: r.payment, refundedUSD: r.refundedUSD, refundableUSD: r.refundableUSD });
});

app.post("/api/authcapture/:id/reclaimed", (req, res) => {
  const r = markReclaimed(req.params.id, req.body?.txHash);
  if (!r.ok) return res.status(r.code === "ac_unknown" ? 404 : 409).json({ decision: "deny", code: r.code, reason: r.reason, suggestion: r.suggestion });
  res.json({ decision: "reclaimed", payment: r.payment, recoveredUSD: r.recoveredUSD });
});

// Money left behind: holds past their capture deadline that only the buyer's
// own reclaim call can recover.
app.get("/api/authcapture/reclaimable", (req, res) => {
  res.json(reclaimable(req.query.address));
});

app.get("/api/authcapture", (req, res) => {
  const { address } = req.query;
  const payments = getAuthCapturePayments().filter((p) => !address || String(p.address).toLowerCase() === String(address).toLowerCase());
  res.json({ payments, summary: authCaptureSummary(address) });
});

app.get("/api/authcapture/:id", (req, res) => {
  const p = findAuthCapturePayment(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

// Request integrity (server/integrity.js): bind an authorization to the exact
// request it was granted for, then refuse at execution if the payload moved.
app.post("/api/integrity/bind", async (req, res) => {
  const { agent, payload, amountUSD, payee, ttlMs } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || "")) return res.status(400).json({ error: "agent must be a 0x-prefixed 20-byte address" });
  if (payload === undefined) return res.status(400).json({ error: "payload is required — there is nothing to bind an authorization to" });
  const record = await bindAuthorization({ agent, payload, amountUSD, payee, ...(ttlMs ? { ttlMs: Number(ttlMs) } : {}) });
  res.status(201).json({ id: record.id, digest: record.digest, agent: record.agent, expiresAt: record.expiresAt, message: record.message, signature: record.signature, signer: record.signer });
});

app.post("/api/integrity/verify", (req, res) => {
  const { bindingId, payload, agent } = req.body || {};
  if (!bindingId) return res.status(400).json({ error: "bindingId is required" });
  const result = verifyBinding({ bindingId, payload, agent });
  res.status(result.ok ? 200 : 409).json(result);
});

app.get("/api/integrity/digest", (req, res) => {
  res.json({ digest: requestDigest(req.query.payload ? JSON.parse(req.query.payload) : null) });
});

app.get("/api/integrity/:id", (req, res) => {
  const record = getBinding(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json(record);
});

// Dispute evidence packs (server/disputes.js) — the agent-side defence file
// that card-scheme evidence rules have no equivalent for yet.
app.get("/api/disputes/:entryHash/evidence", async (req, res) => {
  const pack = await buildEvidencePack(req.params.entryHash);
  res.status(pack.ok ? 200 : 404).json(pack);
});

app.post("/api/disputes/verify", (req, res) => {
  const result = checkEvidencePack(req.body?.pack ?? req.body);
  res.status(result.ok ? 200 : 409).json(result);
});

// OpenTelemetry (server/otel.js): the same decisions as /api/events, shaped as
// OTLP spans so a refusal lands inside the agent trace that caused it.
app.get("/api/otel/spans", async (req, res) => {
  const { since, until, status, address, limit, service } = req.query;
  const spans = decisionSpans({ traceparent: req.get("traceparent"), since, until, status, address, limit });
  const payload = toOtlpPayload(spans, service ? { serviceName: service } : {});
  const exported = req.query.export === "1" ? await exportSpans(payload) : { exported: false, reason: "not requested" };
  res.json({ spanCount: spans.length, traceparent: req.get("traceparent") || null, exported, payload });
});

// ---- The network layer: attestations a seller verifies, reputation shared across organizations, an open policy standard ----

// Governed-spend attestations (server/attestations.js). Minted only after the
// server-side policy check passes — and above the approval line only once a
// human approved — so holding one means this instance's policy said yes.
const ATTESTATIONS_FILE = dataPath("attestations.json");
const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
function attestationSettings() {
  const a = readJsonFile(POLICY_FILE, {}).attestations || {};
  const ttl = Number(a.ttlSeconds);
  return {
    ttlSeconds: Number.isInteger(ttl) ? Math.min(ATTESTATION_MAX_TTL_SECONDS, Math.max(30, ttl)) : ATTESTATION_DEFAULT_TTL_SECONDS,
    trustedIssuers: Array.isArray(a.trustedIssuers) ? a.trustedIssuers.filter(isEvmAddress) : [],
    requireOnCatalog: Boolean(a.requireOnCatalog),
  };
}

app.post("/api/attestations", async (req, res) => {
  const b = req.body || {};
  const address = String(b.address || "").trim();
  const resource = String(b.resource || "").trim().slice(0, 300);
  const price = Number(b.price ?? b.amountUSD);
  if (!address || !resource || !(price >= 0)) return res.status(400).json({ error: "address, resource and price (USD) are required" });
  const payee = b.payee ? String(b.payee).trim().slice(0, 200) : null;
  const chain = b.chain ? String(b.chain) : undefined;
  const rail = ATTESTATION_RAILS.includes(b.rail) ? b.rail : "x402";
  let verdict;
  try {
    verdict = await checkPolicy(address, price, b.toolId ? String(b.toolId) : undefined, chain, b.category ? String(b.category) : undefined, payee || undefined);
  } catch {
    return res.status(503).json({ error: "policy engine unavailable — no attestation without a decision" });
  }
  if (!verdict.allowed) return res.status(403).json({ error: "attestation_refused", code: verdict.code || "policy_denied", reason: verdict.reason, suggestion: verdict.suggestion });
  let approvalId = null;
  if (verdict.requiresApproval) {
    const approval = findApprovableFor(address, resource, price);
    if (!approval) {
      return res.status(409).json({ error: "attestation_refused", code: "approval_required", reason: "this spend needs a human approval first — an attestation vouches only for what was actually decided", suggestion: "request the approval (POST /api/approvals), let a human decide, then ask for the attestation" });
    }
    approvalId = approval.id; // not consumed: the payment itself still has to present it
  }
  const { ttlSeconds } = attestationSettings();
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1, iss: instanceSigner.address, sub: isEvmAddress(address) ? address.toLowerCase() : address, aud: payee, res: resource,
    amt: String(price), cur: "USD", rail, ...(chain ? { chain } : {}), pol: policyHash(), dec: approvalId ? "approved" : "allowed",
    ...(approvalId ? { apr: approvalId } : {}), iat, exp: iat + ttlSeconds, jti: randomUUID(),
  };
  const token = await mintAttestation(claims, instanceSigner.signMessage);
  const log = readJsonFile(ATTESTATIONS_FILE, []);
  log.push({ jti: claims.jti, sub: claims.sub, aud: claims.aud, res: claims.res, amt: claims.amt, rail, dec: claims.dec, iat, exp: claims.exp });
  writeFileSync(ATTESTATIONS_FILE, JSON.stringify(log.slice(-2000), null, 2));
  res.status(201).json({ token, claims, header: ATTESTATION_HEADER, issuer: instanceSigner.address, persistent: instanceSigner.persistent });
});

// Check a token the way a seller would — this instance plus the issuers its
// policy trusts. Informational: unlike a seller's own gate, nothing is consumed.
app.post("/api/attestations/verify", async (req, res) => {
  const b = req.body || {};
  if (!b.token) return res.status(400).json({ error: "token is required" });
  const { trustedIssuers } = attestationSettings();
  res.json(await verifyAttestation(b.token, { trustedIssuers: [instanceSigner.address, ...trustedIssuers], audience: b.audience, resource: b.resource, amountUSD: b.price ?? b.amountUSD, payer: b.payer }));
});

app.get("/api/attestations", (req, res) => {
  const log = readJsonFile(ATTESTATIONS_FILE, []);
  res.json({ issuer: instanceSigner.address, persistent: instanceSigner.persistent, settings: attestationSettings(), issued: log.length, recent: log.slice(-50).reverse() });
});

// The instance's public identity: what a seller pins to accept its
// attestations, and what a subscriber pins to import its reputation feed.
app.get("/.well-known/spendveto-issuer.json", (req, res) => {
  res.json({
    spec: "spendveto-issuer/v1",
    issuer: instanceSigner.address,
    persistent: instanceSigner.persistent,
    attestations: { format: `${ATTESTATION_PREFIX}.<base64url claims>.<0x signature>`, header: ATTESTATION_HEADER, messagePrefix: ATTESTATION_MESSAGE_PREFIX, signature: "EIP-191 personal_sign, secp256k1", ttlSeconds: attestationSettings().ttlSeconds, mint: "/api/attestations", verify: "/api/attestations/verify" },
    reputation: { spec: FEED_SPEC, feed: "/api/reputation/feed", messagePrefix: FEED_MESSAGE_PREFIX },
    policySchema: POLICY_SCHEMA_ID,
    docs: "https://github.com/revanthrajeev/spendveto/blob/main/docs/NETWORK.md",
  });
});

// Federated reputation (server/reputation.js).
app.get("/api/reputation", (req, res) => {
  res.json(reputation.summary());
});
app.post("/api/reputation/reports", requireAuth("admin"), (req, res) => {
  const out = reputation.report(req.body || {});
  if (!out.ok) return res.status(out.status).json({ error: out.code, reason: out.reason });
  res.status(out.created ? 201 : 200).json(out);
});
app.delete("/api/reputation/reports/:id", requireAuth("admin"), (req, res) => {
  const removed = reputation.removeReport(req.params.id);
  res.status(removed ? 200 : 404).json({ ok: removed });
});
app.get("/api/reputation/feed", async (req, res) => {
  res.json(await reputation.exportFeed());
});
app.post("/api/reputation/import", requireAuth("admin"), async (req, res) => {
  const out = await reputation.importFeed(req.body?.feed ?? req.body);
  res.status(out.ok ? 200 : out.status).json(out);
});
app.get("/api/reputation/check", (req, res) => {
  const q = req.query.subject;
  const subjects = (Array.isArray(q) ? q : q ? [q] : []).map(String).slice(0, 20);
  if (!subjects.length) return res.status(400).json({ error: "subject is required (repeat it to check several)" });
  res.json(reputation.check(subjects));
});
app.put("/api/reputation/settings", requireAuth("admin"), (req, res) => {
  const b = req.body || {};
  const policy = readJsonFile(POLICY_FILE, {});
  const r = { ...(policy.reputation || {}) };
  if (typeof b.enabled === "boolean") r.enabled = b.enabled;
  if (b.importedAction !== undefined) {
    if (!["deny", "review"].includes(b.importedAction)) return res.status(400).json({ error: 'importedAction must be "deny" or "review"' });
    r.importedAction = b.importedAction;
  }
  if (b.trustedPublishers !== undefined) {
    if (!Array.isArray(b.trustedPublishers) || !b.trustedPublishers.every(isEvmAddress)) return res.status(400).json({ error: "trustedPublishers must be a list of 0x addresses (each publisher's issuer address)" });
    r.trustedPublishers = [...new Set(b.trustedPublishers.map((a) => a.toLowerCase()))].slice(0, 100);
  }
  if (b.publisherName !== undefined) {
    const name = String(b.publisherName || "").trim().slice(0, 80);
    if (name) r.publisherName = name;
    else delete r.publisherName;
  }
  policy.reputation = r;
  writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2));
  res.json({ settings: reputationSettings(policy) });
});

// The open policy standard (spec/policy-v1.schema.json + server/policyspec.js).
app.get("/api/policy/schema", (req, res) => {
  res.type("application/schema+json").send(readFileSync(POLICY_SCHEMA_PATH));
});
app.get("/api/policy/validate", (req, res) => {
  res.json(validatePolicy(readJsonFile(POLICY_FILE, {})));
});
app.post("/api/policy/validate", (req, res) => {
  const b = req.body;
  const wrapped = b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === 1 && b.policy && typeof b.policy === "object";
  res.json(validatePolicy(wrapped ? b.policy : b));
});

app.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`SpendVeto server — mode: ${MODE}`);
  // A typo in the policy file fails open (the engine never reads the key), so say so at boot.
  const policyCheck = validatePolicy(readJsonFile(POLICY_FILE, {}));
  if (!policyCheck.valid) console.warn(`policy.json has ${policyCheck.errors.length} problem(s): ${policyCheck.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("; ")} — see GET /api/policy/validate`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Catalog:   ${TOOLS.map((t) => `${t.path} ($${t.price})`).join(", ")}`);
  if (MODE === "simulate") console.log(`Client wallets are auto-seeded with a $5.00 simulated USDC balance on first call.`);
});
