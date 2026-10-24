// MCP guard — SpendVeto in front of a payment provider's MCP server.
//
// Razorpay, Stripe, PayPal, Cashfree and Square all publish MCP servers, so an
// AI agent holding a merchant key can refund, transfer and charge with a tool
// call — and nothing between the model and the money sets a budget, asks a
// human, or refuses a recipient. `spendveto guard <provider>` (mcp/guard.js)
// sits between the agent and that server: the agent sees the provider's own
// tools, and every call that isn't a read is decided here first.
//
//   read     fetch / get / list / search — passed straight through
//   collect  money comes IN: payment links, orders, invoices, QR codes, captures — allowed by default
//   spend    money goes OUT: refunds, payouts, transfers — priced in USD and governed: per-call cap,
//            rolling daily budget, hourly velocity, kill switch, reputation, delegation caps, and
//            a human above the approval line or for a recipient that isn't on the allowlist
//   change   a state change with no money moving (notes, closing a QR code) — allowed by default
//   risky    a change that costs money or trust (accepting a dispute, cancelling a subscription,
//            revoking a saved card, sweeping the balance to the bank) — a human signs off by default
//   unknown  a tool the profile doesn't know and that doesn't read — refused by default: a guard
//            that can't tell what a tool does doesn't guess
//
// Tool names come from each provider's docs (checked 2026-10-23); argument
// shapes are mostly undocumented and drift between versions, so amounts are
// read from several likely fields, and a spend whose amount or currency can't
// be read goes to a human rather than through. Amounts in another currency
// count against the USD budgets only at the operator's declared rate
// (policy.payouts.fxRates, shared with payouts) — no rate, no spend.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { toMinor, payoutSettings } from "./payouts.js";

export const MCP_GUARD_DEFAULTS = {
  maxPerCallUSD: 500,
  dailyBudgetUSD: 2000, // rolling 24h, per identity
  maxSpendCallsPerHour: 20,
  requireApprovalAboveUSD: 100,
  collect: "allow",
  change: "allow",
  risky: "approve",
  unknown: "deny",
  allowedRecipients: [], // transfer recipients that skip the new-recipient approval
  defaultCurrency: null, // e.g. "USD" for a Stripe account whose refunds name no currency
  tools: {}, // per-tool overrides: { "razorpay:create_qr_code": "deny", "update_order": "risky" }
  requireAgentToken: false,
};

const ACTIONS = new Set(["allow", "approve", "deny"]);
const KIND_OVERRIDES = new Set(["read", "collect", "spend", "change", "risky"]);

export function mcpGuardSettings(policy) {
  const g = policy?.mcpGuard || {};
  const action = (v, d) => (ACTIONS.has(v) ? v : d);
  return {
    ...MCP_GUARD_DEFAULTS,
    ...g,
    collect: action(g.collect, MCP_GUARD_DEFAULTS.collect),
    change: action(g.change, MCP_GUARD_DEFAULTS.change),
    risky: action(g.risky, MCP_GUARD_DEFAULTS.risky),
    unknown: action(g.unknown, MCP_GUARD_DEFAULTS.unknown),
    allowedRecipients: Array.isArray(g.allowedRecipients) ? g.allowedRecipients.map(String) : [],
    tools: g.tools && typeof g.tools === "object" ? g.tools : {},
  };
}

// ---- Reading arguments ----

const dig = (obj, path) => String(path).split(".").reduce((o, k) => (o != null && typeof o === "object" ? o[k] : undefined), obj);
const firstString = (obj, paths) => {
  for (const p of paths || []) {
    const v = dig(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const majorFrom = (n, unit, currency) => (unit === "minor" ? n / toMinor(1, currency || "USD") : n);

// The first field that holds a positive number wins. Money objects
// ({ value: "50.00", currency_code }) are read through their dotted path.
function readAmount(obj, specs, currency) {
  for (const [path, unit] of specs || []) {
    const v = dig(obj, path);
    const n = typeof v === "string" && v.trim() ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n) && n > 0) return round6(majorFrom(n, unit, currency));
  }
  return null;
}

const GENERIC_AMOUNT = [["amount.value", "major"], ["amount_money.amount", "minor"], ["amount", "minor"], ["value", "major"]];
const GENERIC_CURRENCY = ["currency", "currency_code", "amount.currency_code", "amount_money.currency"];
const GENERIC_PAYEE = ["destination", "recipient", "recipient_id", "beneficiary_id", "payee", "account_number", "payment_id", "payment_intent", "charge"];

// ---- Rule builders ----

const read = { kind: "read" };
const collect = { kind: "collect" };
const change = { kind: "change" };
const risky = (label) => ({ kind: "risky", label });
const spend = (rule) => ({ kind: "spend", ...rule });

function spendFrom(body, rule, profile, settings) {
  const statedCurrency = firstString(body, rule.currency || GENERIC_CURRENCY);
  const currency = (statedCurrency || profile.defaultCurrency || settings.defaultCurrency || "").toUpperCase() || null;
  let major = null;
  if (rule.sum) {
    const list = (rule.sum.list || []).map((p) => dig(body, p)).find(Array.isArray);
    if (list && list.length) {
      const parts = list.map((item) => readAmount(item, rule.sum.amount, currency));
      major = parts.every((x) => x != null) ? round6(parts.reduce((s, x) => s + x, 0)) : null;
    }
  } else major = readAmount(body, rule.amount || GENERIC_AMOUNT, currency);
  const payee = firstString(body, rule.payee || GENERIC_PAYEE);
  const resolve = major == null && rule.resolve ? { tool: rule.resolve.tool, arguments: Object.fromEntries(rule.resolve.args.map((a) => [a, dig(body, a)]).filter(([, v]) => v != null)), amount: rule.resolve.amount, currency: rule.resolve.currency } : null;
  return {
    kind: "spend",
    label: rule.label,
    amount: major != null && currency ? { major, currency } : null,
    missing: major == null ? "amount" : !currency ? "currency" : null,
    currency,
    payee,
    recipient: Boolean(rule.recipient),
    forceApproval: Boolean(rule.forceApproval),
    resolve: resolve && Object.keys(resolve.arguments).length ? resolve : null,
  };
}

// ---- Generic tools that wrap a whole API ----

const STRIPE_COLLECT = new Set(["payment_links", "invoices", "invoiceitems", "prices", "products", "customers", "checkout", "payment_intents", "setup_intents", "subscriptions", "quotes", "coupons", "promotion_codes", "billing_portal", "tax_rates", "shipping_rates", "subscription_items"]);

function findStripePath(args) {
  for (const k of ["path", "endpoint", "url", "api_path", "operation", "resource"]) {
    const v = args[k];
    if (typeof v === "string" && /\/?v1\//.test(v)) return v.slice(v.indexOf("v1/") - (v[v.indexOf("v1/") - 1] === "/" ? 1 : 0));
  }
  for (const v of Object.values(args)) if (typeof v === "string" && /^\/?v1\/[a-z_]/.test(v)) return v;
  return null;
}

function stripeWrite(args, ctx) {
  const path = findStripePath(args);
  const method = String(args.method || args.http_method || args.verb || "POST").toUpperCase();
  const body = ["params", "body", "data", "parameters", "payload", "request", "arguments"].map((k) => args[k]).find((v) => v && typeof v === "object" && !Array.isArray(v)) || args;
  if (!path) return { kind: "unknown", label: "stripe_api_write", reason: "couldn't tell which Stripe API this write calls" };
  const [resource, id, action] = path.replace(/^\/?v1\//, "").replace(/\?.*$/, "").split("/");
  const label = `${method} ${path}`;
  if (method === "DELETE") return risky(`${label} (deletes or cancels)`);
  if (resource === "refunds" && !id) return spendFrom(body, { label: "refund", amount: [["amount", "minor"]], currency: ["currency"], payee: ["payment_intent", "charge"] }, ctx.profile, ctx.settings);
  if (resource === "transfers" && !id) return spendFrom(body, { label: "Connect transfer", amount: [["amount", "minor"]], currency: ["currency"], payee: ["destination"], recipient: true }, ctx.profile, ctx.settings);
  if (resource === "treasury" && ["outbound_payments", "outbound_transfers"].includes(id)) {
    return spendFrom(body, { label: `Treasury ${id.replace("_", " ")}`, amount: [["amount", "minor"]], currency: ["currency"], payee: ["destination_payment_method", "destination_payment_method_data.us_bank_account.account_number", "financial_account"], recipient: true }, ctx.profile, ctx.settings);
  }
  if (resource === "payouts" && !id) return risky(`${label} (sweeps the balance to your bank)`);
  if (resource === "disputes" && action === "close") return risky(`${label} (accepts the dispute: you lose the disputed amount)`);
  if (resource === "disputes") return { kind: "change", label };
  if (resource === "subscriptions" && action === "cancel") return risky(`${label} (cancels a subscription)`);
  if (resource === "invoices" && action === "void") return risky(`${label} (voids an invoice)`);
  if (resource === "invoices" && ["finalize", "send", "pay"].includes(action)) return { kind: "collect", label };
  if (STRIPE_COLLECT.has(resource)) return { kind: id ? "change" : "collect", label };
  return { kind: "unknown", label, reason: `Stripe write ${label} isn't one SpendVeto classifies` };
}

function squareRequest(args, ctx) {
  const service = String(args.service || "").toLowerCase();
  const method = String(args.method || "").toLowerCase();
  const body = args.request && typeof args.request === "object" ? args.request : {};
  const label = `${service}.${method}`;
  if (/^(list|get|retrieve|search|batch_retrieve|batch_get)/.test(method)) return { kind: "read", label };
  if (service === "refunds" && /refund/.test(method)) {
    return spendFrom(body, { label: "refund", amount: [["amount_money.amount", "minor"]], currency: ["amount_money.currency"], payee: ["payment_id"] }, ctx.profile, ctx.settings);
  }
  if (/^(delete|cancel)/.test(method)) return risky(`${label} (deletes or cancels)`);
  if (service === "payments" && /^(create|complete)/.test(method)) return { kind: "collect", label };
  if (["orders", "invoices", "catalog", "customers", "checkout", "subscriptions", "bookings"].includes(service)) {
    if (/^(create|publish|pay)/.test(method)) return { kind: "collect", label };
    if (/^(update|upsert|batch_upsert)/.test(method)) return { kind: "change", label };
  }
  return { kind: "unknown", label, reason: `Square ${label} isn't one SpendVeto classifies` };
}

// ---- Provider profiles ----

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

export const PROFILES = {
  razorpay: {
    label: "Razorpay",
    defaultCurrency: "INR",
    // Remote server: Authorization Basic base64(key:secret) — Razorpay's "merchant token".
    upstream: (env) =>
      env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
        ? { url: "https://mcp.razorpay.com/mcp", headers: { Authorization: `Basic ${b64(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}` } }
        : { error: "set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or pass -- docker run -i --rm -e RAZORPAY_KEY_ID -e RAZORPAY_KEY_SECRET razorpay/mcp" },
    tools: {
      // A refund with no amount is a full refund: priced by fetching the payment.
      create_refund: spend({ label: "refund", amount: [["amount", "minor"]], currency: ["currency"], payee: ["payment_id"], resolve: { tool: "fetch_payment", args: ["payment_id"], amount: [["amount", "minor"]], currency: ["currency"] } }),
      create_instant_settlement: risky("instant settlement: sweeps your balance to the bank, with a fee"),
      revoke_token: risky("revokes a customer's saved payment method"),
      capture_payment: collect, initiate_payment: collect, resend_otp: collect, submit_otp: collect,
      create_payment_link: collect, create_payment_link_upi: collect, send_payment_link: collect,
      create_order: collect, create_qr_code: collect, create_registration_link: collect,
      update_payment: change, update_payment_link: change, update_order: change, update_refund: change, close_qr_code: change,
      detect_stack: read, integrate_razorpay_checkout: read,
    },
  },
  stripe: {
    label: "Stripe",
    upstream: (env) => {
      const key = env.STRIPE_AGENT_KEY || env.STRIPE_API_KEY;
      return key ? { url: "https://mcp.stripe.com", headers: { Authorization: `Bearer ${key}` } } : { command: "npx", args: ["-y", "mcp-remote", "https://mcp.stripe.com"] };
    },
    tools: {
      stripe_api_search: read, stripe_api_details: read, stripe_api_read: read, get_stripe_account_info: read,
      get_balance_summary: read, search_stripe_documentation: read, stripe_implementation_planner: read, stripe_analytics: read,
      stripe_api_write: stripeWrite,
      send_money: spend({ label: "Treasury send", amount: [["amount", "minor"], ["amount.value", "minor"]], currency: ["currency", "amount.currency"], payee: ["recipient", "recipient_id", "destination"], recipient: true }),
      transfer_money: risky("moves money between your Stripe balances"),
      convert_currency: risky("converts Treasury funds"),
      setup_recipient: risky("adds a new Treasury recipient"),
      atlas_company_formation: risky("starts a company formation"),
      send_stripe_feedback: change,
    },
  },
  paypal: {
    label: "PayPal",
    upstream: (env) =>
      env.PAYPAL_ACCESS_TOKEN
        ? { command: "npx", args: ["-y", "@paypal/mcp", "--tools=all"], env: { PAYPAL_ACCESS_TOKEN: env.PAYPAL_ACCESS_TOKEN, PAYPAL_ENVIRONMENT: env.PAYPAL_ENVIRONMENT || "SANDBOX" } }
        : { command: "npx", args: ["-y", "mcp-remote", "https://mcp.paypal.com/http"] },
    tools: {
      create_refund: spend({ label: "refund", amount: [["amount.value", "major"], ["amount", "major"]], currency: ["amount.currency_code", "currency", "currency_code"], payee: ["capture_id"] }),
      checkout_cart: spend({ label: "buys the cart (gift cards)", amount: [["amount.value", "major"], ["total.value", "major"], ["total", "major"], ["amount", "major"]], currency: ["amount.currency_code", "total.currency_code", "currency", "currency_code"], payee: ["cart_id"] }),
      accept_dispute_claim: risky("accepts a dispute: the buyer keeps the money"),
      cancel_subscription: risky("cancels a customer's subscription"),
      cancel_recurring_series: risky("cancels a recurring invoice series"),
      delete_invoice: risky("deletes an invoice"),
      delete_recurring_series: risky("deletes a recurring invoice series"),
      pay_order: collect, create_order: collect, create_invoice: collect, send_invoice: collect, send_invoice_reminder: collect,
      create_product: collect, create_subscription_plan: collect, create_subscription: collect, create_recurring_series: collect,
      activate_recurring_series: collect, create_cart: collect,
      create_shipment_tracking: change, update_shipment_tracking: change, record_payment_for_invoice: change, record_refund_for_invoice: change,
      generate_invoice_number: change, update_invoicing: change, update_subscription: change, update_plan: change,
      create_conditional_rules_for_invoice: change, cancel_invoice_auto_reminder: change, cancel_sent_invoice: change,
      generate_invoice_qr_code: read, get_merchant_insights: read,
    },
  },
  cashfree: {
    label: "Cashfree",
    defaultCurrency: "INR",
    upstream: () => ({ command: "npx", args: ["-y", "mcp-remote", "https://mcp.cashfree.com/mcp"] }),
    // Names are matched with hyphens folded to underscores: the hosted server
    // uses create_refund, the local one create-refund.
    tools: {
      create_refund: spend({ label: "refund", amount: [["refund_amount", "major"], ["amount", "major"]], currency: ["refund_currency", "currency"], payee: ["order_id"] }),
      standard_transfer_v2: spend({ label: "payout", amount: [["transfer_amount", "major"], ["amount", "major"]], currency: ["transfer_currency", "currency"], payee: ["beneficiary_details.beneficiary_id", "beneficiary_id", "bene_id"], recipient: true }),
      batch_transfer_v2: spend({ label: "batch payout", sum: { list: ["transfers", "batch"], amount: [["transfer_amount", "major"], ["amount", "major"]] }, currency: ["transfer_currency", "currency"], payee: ["batch_transfer_id"], recipient: true, forceApproval: true }),
      create_cashgram: spend({ label: "cashgram", amount: [["amount", "major"]], payee: ["phone", "email", "cashgram_id", "cashgramId"], recipient: true }),
      accept_dispute_by_dispute_id: risky("accepts a dispute: the customer keeps the money"),
      create_order: collect, create_payment_link: collect, simulate_payment: collect,
      generate_kyc_link: change, generate_static_kyc_link: change, submit_evidence_to_contest_the_dispute_by_dispute_id: change,
      cancel_payment_link: change, deactivate_cashgram: change, deactivate_static_kyc_link: change,
      search: read, search_product_docs: read, get_input_source_help: read, verify_name_match: read, authorize: read,
      generate_recon_report: read, generate_summary_report: read, download_report: read,
    },
  },
  square: {
    label: "Square",
    upstream: (env) =>
      env.SQUARE_ACCESS_TOKEN
        ? { command: "npx", args: ["-y", "square-mcp-server", "start"], env: { ACCESS_TOKEN: env.SQUARE_ACCESS_TOKEN, ...(env.SQUARE_PRODUCTION === "true" ? { PRODUCTION: "true" } : { SANDBOX: "true" }) } }
        : { command: "npx", args: ["-y", "mcp-remote", "https://mcp.squareup.com/mcp"] },
    tools: { get_service_info: read, get_type_info: read, make_api_request: squareRequest },
  },
  generic: {
    label: "this MCP server",
    upstream: () => ({ error: "the generic profile needs --url (and --header) or -- <command>" }),
    tools: {},
  },
};

const READ_PREFIX = /^(fetch|get|list|search|retrieve|show|download|describe|lookup|view)(_|$)/;
const MONEY_WORDS = /(refund|payout|transfer|send_money|withdraw|disburse|cashgram|remit)/;

// What one tool call does with money. Pure: the guard process uses it for a
// fast pass-through of reads, and the server re-derives it from the raw call
// before deciding anything else.
export function classify(profileName, toolName, args = {}, settings = MCP_GUARD_DEFAULTS) {
  const profile = PROFILES[profileName] || PROFILES.generic;
  const tool = String(toolName || "");
  const norm = tool.toLowerCase().replace(/-/g, "_");
  const a = args && typeof args === "object" ? args : {};
  const ctx = { profile, settings };
  const rule = profile.tools[norm];
  let out;
  if (typeof rule === "function") out = rule(a, ctx);
  else if (rule?.kind === "spend") out = spendFrom(a, rule, profile, settings);
  else if (rule) out = { kind: rule.kind, label: rule.label || tool };
  else if (READ_PREFIX.test(norm)) out = { kind: "read", label: tool };
  else if (MONEY_WORDS.test(norm)) out = { ...spendFrom(a, { label: `${tool} (money word in the name)` }, profile, settings), byName: true };
  else out = { kind: "unknown", label: tool, reason: `${profile.label} tool "${tool}" isn't one SpendVeto knows, and it doesn't look read-only` };

  const override = settings.tools?.[`${profileName}:${tool}`] ?? settings.tools?.[tool];
  if (override === "deny" || override === "approve" || override === "allow") out = { ...out, action: override, overridden: true };
  else if (KIND_OVERRIDES.has(override) && override !== out.kind) {
    out = override === "spend" ? { ...spendFrom(a, { label: tool }, profile, settings), overridden: true } : { kind: override, label: out.label || tool, overridden: true };
  }
  return { tool, profile: PROFILES[profileName] ? profileName : "generic", ...out };
}

// A full refund names no amount: the guard fetched the object it refunds, and
// the amount is read from that result here, on the server.
export function resolveAmount(classified, text, settings = MCP_GUARD_DEFAULTS) {
  if (!classified.resolve || typeof text !== "string") return null;
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const i = text.indexOf("{");
    const j = text.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        obj = JSON.parse(text.slice(i, j + 1));
      } catch {}
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const profile = PROFILES[classified.profile] || PROFILES.generic;
  const currency = (firstString(obj, classified.resolve.currency || []) || classified.currency || profile.defaultCurrency || settings.defaultCurrency || "").toUpperCase() || null;
  const major = currency ? readAmount(obj, classified.resolve.amount, currency) : null;
  return major != null ? { major, currency } : null;
}

// ---- Governance ----

export function createMcpGuard(deps) {
  const { dataPath, loadPolicy, checkPolicy, policyHash, appendLedgerEntry, getLedger, findActiveFreeze, listDelegations, createApproval, listApprovals, findApprovableFor, consumeApproval, readAgents, childAddress, pseudoAddress, reputationCheck } = deps;
  const PATH = dataPath("mcpguard.json");
  const HOLD_TTL_MS = 10 * 60 * 1000; // a tool call that never reports back
  const read = () => {
    try {
      return existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : [];
    } catch {
      return [];
    }
  };
  const save = (rows) => writeFileSync(PATH, JSON.stringify(rows.slice(-2000), null, 2));

  function identityFor(req, body) {
    const auth = req.get("authorization") || "";
    const bearer = (auth.match(/^Bearer\s+(.+)$/i) || [])[1] || null;
    const agent = bearer ? readAgents().find((a) => a.token === bearer) : null;
    if (agent) return { address: ((agent.child && childAddress(agent.child)) || pseudoAddress(`agent:${agent.id}`)).toLowerCase(), label: agent.label, agent: true };
    const label = String(body.agent || req.get("x-spendveto-agent") || "local").replace(/[^\w .:@-]/g, "").slice(0, 64) || "local";
    return { address: pseudoAddress(label === "local" ? "local" : `label:${label}`), label, agent: false };
  }

  function book(call, status, extra = {}) {
    try {
      appendLedgerEntry({
        address: call.address, agent: call.agent, resource: `mcp:${call.profile}:${call.tool}`.slice(0, 120),
        amount: status === "paid" ? call.amountUSD : extra.amount ?? call.amountUSD ?? 0,
        chain: "fiat", category: "mcp", status, mode: `mcp-${call.profile}`, guardCallId: call.id, kind: call.kind,
        ...(call.currency ? { currency: call.currency, originalAmount: call.amount } : {}), ...(call.fx ? { fx: call.fx } : {}),
        ...(call.payee ? { payTo: call.payee } : {}), ...extra, policyHash: policyHash(),
      });
    } catch {}
  }

  // An allowed spend nobody reported is booked as done once its hold expires:
  // the guard can't see the provider's answer, and missing spend is the
  // dangerous direction.
  function sweep() {
    const rows = read();
    let changed = false;
    for (const c of rows) {
      if (c.status === "allowed" && Date.parse(c.createdAt) + HOLD_TTL_MS <= Date.now()) {
        c.status = "assumed_done";
        changed = true;
        if (c.kind === "spend") book(c, "paid", { reason: "the guard never reported the outcome; booked as spent when its hold expired" });
      }
    }
    if (changed) save(rows);
    return rows;
  }

  const spentDayUSD = (address) => {
    const cutoff = Date.now() - 24 * 3600e3;
    const booked = getLedger().filter((e) => e.category === "mcp" && e.status === "paid" && String(e.address).toLowerCase() === address && Date.parse(e.ts) >= cutoff).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const held = sweep().filter((c) => c.kind === "spend" && c.status === "allowed" && c.address === address).reduce((s, c) => s + (c.amountUSD || 0), 0);
    return round6(booked + held);
  };
  const spendCallsHour = (address) => read().filter((c) => c.kind === "spend" && c.address === address && Date.parse(c.createdAt) >= Date.now() - 3600e3 && ["allowed", "succeeded", "assumed_done"].includes(c.status)).length;

  async function evaluate(req, body) {
    const policy = loadPolicy();
    const s = mcpGuardSettings(policy);
    const profileName = String(body.profile || "generic");
    if (!PROFILES[profileName]) return { status: 400, json: { error: `unknown profile "${profileName}" — one of ${Object.keys(PROFILES).join(", ")}` } };
    const tool = String(body.tool || "").slice(0, 120);
    if (!tool) return { status: 400, json: { error: "tool is required" } };
    const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? body.arguments : {};
    const identity = identityFor(req, body);
    let c = classify(profileName, tool, args, s);
    if (c.kind === "spend" && !c.amount && c.resolve && typeof body.resolution?.text === "string") {
      const r = resolveAmount(c, body.resolution.text, s);
      if (r) c = { ...c, amount: r, currency: r.currency, missing: null, resolvedFrom: c.resolve.tool };
    }
    const target = c.payee || Object.values(args).find((v) => typeof v === "string" && /^[a-z]{2,8}_[A-Za-z0-9]{6,}$/.test(v)) || "-";
    const resource = `mcp:${profileName}:${tool}:${target}`.slice(0, 200);
    const out = { kind: c.kind, label: c.label, tool, profile: profileName };
    const deny = (code, reason, suggestion, extra = {}) => {
      book({ address: identity.address, agent: identity.label, profile: profileName, tool, kind: c.kind, amountUSD: extra.amountUSD ?? 0, currency: c.amount?.currency, amount: c.amount?.major, payee: c.payee }, "blocked", { reason, code });
      return { status: 403, json: { ...out, decision: "deny", code, reason, suggestion, ...extra } };
    };

    if (s.requireAgentToken && !identity.agent) return { status: 401, json: { ...out, decision: "deny", code: "agent_token_required", reason: "the MCP guard requires a registered agent's tg_ token", suggestion: "register the agent (Console → Agents) and set SPENDVETO_AGENT_TOKEN for the guard" } };
    if (c.kind === "read" && !c.action) return { status: 200, json: { ...out, decision: "allow" } };
    if (findActiveFreeze(identity.address)) return deny("frozen", `"${identity.label}" is frozen`, "a human must unfreeze it in the Console before it can act on the provider");

    const record = (extra) => {
      const call = { id: `mcg_${randomUUID().replace(/-/g, "").slice(0, 20)}`, address: identity.address, agent: identity.label, profile: profileName, tool, kind: c.kind, payee: c.payee || null, status: "allowed", createdAt: new Date().toISOString(), ...extra };
      const rows = read();
      rows.push(call);
      save(rows);
      return call;
    };
    // A human's yes, matched on (identity, resource, amount) and consumed by
    // the call it approved — the agent retries the same tool call afterwards.
    const approveOrAsk = (price, reason, extra = {}) => {
      const approved = findApprovableFor(identity.address, resource, price);
      if (approved) {
        consumeApproval(approved.id);
        return null;
      }
      const pending = listApprovals().find((a) => a.status === "pending" && String(a.address).toLowerCase() === identity.address.toLowerCase() && a.resource === resource && Number(a.price) === Number(price));
      const approval = pending || createApproval({ address: identity.address, resource, price });
      return { status: 202, json: { ...out, decision: "requires_approval", code: "mcp_requires_approval", reason, suggestion: "a human approves it in the SpendVeto Console (Approvals); then call the same tool again with the same arguments", approvalId: approval.id, approval: { resource, price }, ...extra } };
    };

    if (c.kind !== "spend") {
      const action = c.action || s[c.kind] || "deny";
      if (action === "deny") {
        return c.kind === "unknown"
          ? deny("mcp_tool_unclassified", c.reason || `"${tool}" isn't a tool SpendVeto can classify`, `if it's safe, a human can classify it in policy.mcpGuard.tools (e.g. "${profileName}:${tool}": "change"), or set policy.mcpGuard.unknown`)
          : deny(`mcp_${c.kind}_denied`, `${c.kind} tools are set to deny (policy.mcpGuard.${c.kind})`, "a human can change policy.mcpGuard if this is meant to be allowed");
      }
      if (action === "approve") {
        const ask = approveOrAsk(0, c.kind === "risky" ? `${c.label || tool}: a human signs off on this` : `${tool} needs a human (policy.mcpGuard)`);
        if (ask) return ask;
      }
      const call = record({});
      return { status: 200, json: { ...out, decision: "allow", callId: call.id } };
    }

    // spend
    if (!c.amount) {
      if (c.resolve && !body.resolution) return { status: 200, json: { ...out, decision: "resolve", resolve: { tool: c.resolve.tool, arguments: c.resolve.arguments }, reason: "no amount given (a full refund): the guard reads the original object to price it" } };
      if (c.action === "deny") return deny("mcp_spend_denied", "this tool is set to deny", "a human can change policy.mcpGuard.tools");
      const ask = approveOrAsk(0, `the ${c.missing || "amount"} of this ${c.label || "spend"} couldn't be read from the call, so it can't be checked against the budget — a human signs off`);
      if (ask) return ask;
      const call = record({ amountUSD: 0, unpriced: true });
      return { status: 200, json: { ...out, decision: "allow", callId: call.id, unpriced: true } };
    }

    const { major, currency } = c.amount;
    let amountUSD = major;
    let fx = null;
    if (currency !== "USD") {
      const rate = Number(payoutSettings(policy).fxRates[currency]);
      if (!(rate > 0)) return deny("mcp_fx_rate_missing", `no operator-declared USD rate for ${currency} in policy.payouts.fxRates`, `declare one (e.g. "fxRates": { "${currency}": 0.012 }) — SpendVeto never guesses an exchange rate for money leaving the business`);
      amountUSD = round6(major * rate);
      fx = { rate, source: "policy.payouts.fxRates (operator-declared)" };
    }
    const priced = { amountUSD, amount: major, currency };
    if (c.action === "deny") return deny("mcp_spend_denied", "this tool is set to deny", "a human can change policy.mcpGuard.tools", priced);
    const rep = c.payee && reputationCheck ? reputationCheck([c.payee]) : null;
    if (rep?.verdict === "block") return deny("payee_reputation_block", `the recipient is on a reputation block list (${rep.summary})`, "do not pay this counterparty; a human can review the report in the Console", priced);
    if (amountUSD > s.maxPerCallUSD) return deny("mcp_spend_cap", `$${amountUSD.toFixed(2)} (${major} ${currency}) exceeds policy.mcpGuard.maxPerCallUSD $${s.maxPerCallUSD}`, "ask a human to do it, or to raise policy.mcpGuard.maxPerCallUSD", priced);
    if (spendCallsHour(identity.address) >= s.maxSpendCallsPerHour) return deny("mcp_spend_velocity", `more than ${s.maxSpendCallsPerHour} money-moving calls in the last hour`, "slow down: a burst of refunds or transfers is the shape of a compromised agent", priced);
    const day = spentDayUSD(identity.address);
    if (day + amountUSD > s.dailyBudgetUSD) return deny("mcp_daily_budget", `would exceed policy.mcpGuard.dailyBudgetUSD $${s.dailyBudgetUSD} ($${day.toFixed(2)} already spent through the guard in 24h)`, "wait for the rolling window, or have a human raise the budget", priced);
    const delegated = listDelegations().some((d) => String(d.childAddress).toLowerCase() === identity.address && !d.revoked);
    if (delegated || policy.allowedHoursUTC) {
      const override = { ...policy, maxPerCallUSD: Infinity, maxPerHourUSD: Infinity, maxCallsPerHour: Infinity, requireApprovalAboveUSD: Infinity };
      const verdict = await checkPolicy(identity.address, amountUSD, `mcp:${profileName}`, undefined, "mcp", undefined, override);
      if (!verdict.allowed) return deny(verdict.code || "policy", verdict.reason, verdict.suggestion, priced);
    }
    const newRecipient = c.recipient && c.payee && !s.allowedRecipients.includes(c.payee);
    const reasons = [amountUSD > s.requireApprovalAboveUSD ? `above policy.mcpGuard.requireApprovalAboveUSD $${s.requireApprovalAboveUSD}` : null, newRecipient ? "a recipient not on policy.mcpGuard.allowedRecipients" : null, c.forceApproval ? "a batch to several recipients" : null, rep?.verdict === "review" ? `a recipient flagged for review (${rep.summary})` : null, c.action === "approve" ? "set to approve in policy.mcpGuard.tools" : null].filter(Boolean);
    if (reasons.length) {
      const ask = approveOrAsk(amountUSD, `this ${c.label || "spend"} of $${amountUSD.toFixed(2)} needs a human: ${reasons.join(" and ")}`, priced);
      if (ask) return ask;
    }
    const call = record({ amountUSD, amount: major, currency, fx });
    return { status: 200, json: { ...out, decision: "allow", callId: call.id, ...priced, ...(fx ? { fx } : {}), ...(c.resolvedFrom ? { resolvedFrom: c.resolvedFrom } : {}) } };
  }

  // The guard's report after the provider answered. A spend books as paid
  // only when the provider said it succeeded; a failure releases its hold.
  function report(id, body = {}) {
    const rows = sweep();
    const call = rows.find((c) => c.id === id);
    if (!call) return { status: 404, json: { error: `no guard call "${id}"` } };
    if (call.status !== "allowed") return { status: 409, json: { code: "mcp_call_resolved", reason: `call ${id} is already ${call.status}` } };
    const ok = body.outcome === "succeeded";
    if (!ok && body.outcome !== "failed") return { status: 400, json: { error: 'outcome must be "succeeded" or "failed"' } };
    call.status = ok ? "succeeded" : "failed";
    call.resolvedAt = new Date().toISOString();
    if (body.error) call.error = String(body.error).slice(0, 300);
    save(rows);
    if (ok && call.kind === "spend" && call.amountUSD > 0) book(call, "paid");
    return { status: 200, json: { call } };
  }

  function summary() {
    const rows = sweep();
    const day = Date.now() - 24 * 3600e3;
    const recent = rows.filter((c) => Date.parse(c.createdAt) >= day);
    return {
      settings: mcpGuardSettings(loadPolicy()),
      profiles: Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label, knownTools: Object.keys(p.tools).length })),
      last24h: {
        calls: recent.length,
        spendUSD: round6(recent.filter((c) => c.kind === "spend" && ["succeeded", "assumed_done"].includes(c.status)).reduce((s, c) => s + (c.amountUSD || 0), 0)),
        blocked: getLedger().filter((e) => e.category === "mcp" && e.status === "blocked" && Date.parse(e.ts) >= day).length,
      },
      recent: rows.slice(-50).reverse(),
    };
  }

  return { evaluate, report, summary };
}
