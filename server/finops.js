// AI FinOps and rebilling — turning governed spend into allocation and revenue.
//
// Every decision SpendVeto makes lands in one ledger: model tokens, x402
// payments, card authorizations, fiat payouts. That ledger is already the
// most complete record of what an organization's agents spend. Two things
// finance teams pay for come straight out of it:
//
//   1. ALLOCATION (FinOps showback / chargeback). Tag any request with
//      `x-spendveto-tags: team=search,customer=cus_123,feature=summarize` and
//      the cost is attributed to it. Cost reports group by any tag, agent,
//      model, provider or rail; tag budgets cap a team's or a customer's spend;
//      and the model spend exports in FOCUS v1.4 — the FinOps Foundation's
//      open billing-data format — so it lands in the cost tools a FinOps team
//      already runs next to its cloud bill. (FinOps teams now overwhelmingly
//      manage AI spend; this is where their tools read it from.)
//
//   2. MONETIZATION (rebilling). A company that embeds AI in its own product
//      bills its customers for that usage. Requests tagged with a Stripe
//      customer id are reported to Stripe Billing as meter events — cost plus
//      the operator's markup, in micro-dollars so nothing is lost to rounding —
//      and SpendVeto reports cost, billed and margin per customer. The same
//      tag budget that caps a customer's AI spend protects that margin.
//
// FOCUS scope: the export covers technology services — model tokens and paid
// x402 API tools. Card swipes and payouts are spend, not technology
// consumption, so they appear in the cost report but not in the FOCUS file.
import { readFileSync, writeFileSync, existsSync } from "./store.js";
import { csvCell } from "./csv.js";

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// x-spendveto-tags: team=search, customer=cus_123 — plus one-header shortcuts.
const TAG_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
export function parseTags(headers) {
  const tags = {};
  const add = (k, v) => {
    const key = String(k || "").trim().toLowerCase();
    const val = String(v || "").trim().replace(/[^\w .:@/-]/g, "").slice(0, 64);
    if (TAG_KEY.test(key) && val && Object.keys(tags).length < 10) tags[key] = val;
  };
  const raw = headers["x-spendveto-tags"];
  if (raw) for (const pair of String(raw).split(",")) add(...pair.split("="));
  for (const k of ["team", "customer", "feature", "project", "env"]) if (headers[`x-spendveto-${k}`]) add(k, headers[`x-spendveto-${k}`]);
  return Object.keys(tags).length ? tags : null;
}

// One cost view across every rail.
const RAIL = (e) => (e.category === "llm" ? "model tokens" : e.category === "card" ? "cards" : e.category === "payout" ? "fiat payouts" : "x402 / tools");
export function costReport(entries, { groupBy = "category", days = 30, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 3600e3;
  const keyOf = (e) => {
    if (groupBy === "category" || groupBy === "rail") return RAIL(e);
    if (groupBy === "agent") return e.agent || e.address || "unknown";
    if (groupBy === "model") return e.model || (e.category === "llm" ? "unknown" : null);
    if (groupBy === "provider") return e.provider || (e.category === "card" ? String(e.mode || "card").replace("card-", "") : e.category === "llm" ? null : "x402");
    if (groupBy === "session") return e.session || null;
    return e.tags?.[groupBy] || null;
  };
  const rows = new Map();
  let total = 0;
  let blocked = 0;
  for (const e of entries) {
    if (!(Date.parse(e.ts) >= cutoff)) continue;
    const k = keyOf(e) ?? "(untagged)";
    if (!rows.has(k)) rows.set(k, { key: k, costUSD: 0, count: 0, blockedUSD: 0, blockedCount: 0 });
    const r = rows.get(k);
    if (e.status === "paid") {
      r.costUSD += Number(e.amount) || 0;
      r.count++;
      total += Number(e.amount) || 0;
    } else if (e.status === "blocked") {
      r.blockedUSD += Number(e.amount) || 0;
      r.blockedCount++;
      blocked += Number(e.amount) || 0;
    }
  }
  const out = [...rows.values()].map((r) => ({ ...r, costUSD: round6(r.costUSD), blockedUSD: round6(r.blockedUSD) })).sort((a, b) => b.costUSD - a.costUSD);
  return { groupBy, days, totalCostUSD: round6(total), totalBlockedUSD: round6(blocked), rows: out };
}

// ---- FOCUS v1.4 export (FinOps Foundation, released 2026-06-04) ----
// All 21 Mandatory columns of the Cost and Usage dataset, then the
// Conditional ones that apply to metered AI usage.
export const FOCUS_COLUMNS = [
  "BilledCost", "BillingAccountId", "BillingAccountName", "BillingCurrency", "BillingPeriodEnd", "BillingPeriodStart",
  "ChargeCategory", "ChargeClass", "ChargeDescription", "ChargePeriodEnd", "ChargePeriodStart", "ContractedCost",
  "EffectiveCost", "HostProviderName", "InvoiceIssuerName", "ListCost", "PricingQuantity", "PricingUnit",
  "ServiceCategory", "ServiceName", "ServiceProviderName",
  "ConsumedQuantity", "ConsumedUnit", "ListUnitPrice", "ContractedUnitPrice", "PricingCategory", "ResourceId", "ResourceName", "ResourceType", "SkuId", "SkuMeter", "SubAccountId", "SubAccountName", "Tags",
];
const PROVIDER_NAMES = { anthropic: { name: "Anthropic", service: "Claude API" }, openai: { name: "OpenAI", service: "OpenAI API" } };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
function monthBounds(ms) {
  const d = new Date(ms);
  return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)];
}

const METERS = [
  ["input", "Input Tokens"],
  ["cacheRead", "Cache Read Tokens"],
  ["cacheWrite5m", "Cache Write Tokens (5m)"],
  ["cacheWrite1h", "Cache Write Tokens (1h)"],
  ["output", "Output Tokens"],
];

export function focusRows(entries, { days = 30, now = Date.now(), billingAccountId = "spendveto", billingAccountName = "SpendVeto" } = {}) {
  const cutoff = now - days * 24 * 3600e3;
  const rows = [];
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (!(t >= cutoff) || e.status !== "paid") continue;
    const [bs, be] = monthBounds(t);
    // Hourly charge periods (the granularity cloud FOCUS exports use): the
    // inclusive start of the hour the charge landed in, the exclusive end an
    // hour later — so ChargePeriodEnd is always after ChargePeriodStart.
    const hour = Math.floor(t / 3600e3) * 3600e3;
    const start = iso(hour);
    const end = iso(hour + 3600e3);
    const tags = { ...(e.tags || {}), ...(e.agent ? { agent: e.agent } : {}), ...(e.session ? { session: e.session } : {}) };
    const base = {
      BillingAccountId: billingAccountId, BillingAccountName: billingAccountName, BillingCurrency: "USD",
      BillingPeriodStart: iso(bs), BillingPeriodEnd: iso(be), ChargeCategory: "Usage", ChargeClass: null,
      ChargePeriodStart: start, ChargePeriodEnd: end, PricingCategory: "Standard",
      ResourceId: e.address, ResourceName: e.agent || null, ResourceType: "AI agent",
      SubAccountId: e.tags?.team || null, SubAccountName: e.tags?.team || null, Tags: Object.keys(tags).length ? tags : null,
    };
    if (e.category === "llm") {
      const p = PROVIDER_NAMES[e.provider] || { name: e.provider || "Unknown", service: "Model API" };
      const common = { ...base, HostProviderName: p.name, ServiceProviderName: p.name, InvoiceIssuerName: p.name, ServiceName: p.service, ServiceCategory: "AI and Machine Learning", SkuId: e.model };
      if (e.costBreakdown) {
        for (const [k, meter] of METERS) {
          const l = e.costBreakdown[k];
          if (!l || !l.tokens) continue;
          rows.push({ ...common, BilledCost: l.usd, EffectiveCost: l.usd, ListCost: l.usd, ContractedCost: l.usd, ChargeDescription: `${e.model} ${meter.toLowerCase()} via SpendVeto`, PricingQuantity: round6(l.tokens / 1e6), PricingUnit: "1M Tokens", ConsumedQuantity: l.tokens, ConsumedUnit: "Tokens", ListUnitPrice: l.ratePerM, ContractedUnitPrice: l.ratePerM, SkuMeter: meter });
        }
      } else {
        // Upstream-reported or estimated cost: one row, no per-token rate claimed.
        const usd = Number(e.amount) || 0;
        rows.push({ ...common, BilledCost: usd, EffectiveCost: usd, ListCost: usd, ContractedCost: usd, ChargeDescription: `${e.model} usage via SpendVeto (${e.priceSource || "reported"})`, PricingQuantity: 1, PricingUnit: "Request", ConsumedQuantity: 1, ConsumedUnit: "Requests", ListUnitPrice: usd, ContractedUnitPrice: usd, SkuMeter: "Request" });
      }
    } else if (!["card", "payout"].includes(e.category) && e.chain !== "card" && e.chain !== "fiat") {
      // A paid x402 API tool call: one priced request.
      const usd = Number(e.amount) || 0;
      rows.push({ ...base, BilledCost: usd, EffectiveCost: usd, ListCost: usd, ContractedCost: usd, ChargeDescription: `${e.resource || "paid tool"} via x402`, HostProviderName: e.payTo || "x402 seller", ServiceProviderName: e.payTo || "x402 seller", InvoiceIssuerName: e.payTo || "x402 seller", ServiceName: e.resource || "x402 tool", ServiceCategory: "AI and Machine Learning", PricingQuantity: 1, PricingUnit: "Request", ConsumedQuantity: 1, ConsumedUnit: "Requests", ListUnitPrice: usd, ContractedUnitPrice: usd, SkuId: e.resource || null, SkuMeter: "Request" });
    }
  }
  return rows;
}

export function toFocusCsv(rows) {
  return [FOCUS_COLUMNS.join(","), ...rows.map((r) => FOCUS_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

// ---- Rebilling to Stripe Billing ----
export const REBILLING_DEFAULTS = { enabled: false, markupPct: 20, eventName: "spendveto_ai_usage", customerTag: "customer" };
export function rebillingSettings(policy) {
  return { ...REBILLING_DEFAULTS, ...(policy?.rebilling || {}) };
}

export function createRebiller({ dataPath, loadPolicy }) {
  const PATH = dataPath("rebilling.json");
  const read = () => {
    try {
      return existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : [];
    } catch {
      return [];
    }
  };
  const append = (row) => {
    const rows = read();
    rows.push(row);
    writeFileSync(PATH, JSON.stringify(rows.slice(-5000), null, 2));
  };

  // Called for every booked model charge. Returns a promise so callers that
  // care (tests) can await it; the guard itself never waits on Stripe.
  async function onCharge(entry) {
    const s = rebillingSettings(loadPolicy());
    if (!s.enabled || entry.status !== "paid" || !(Number(entry.amount) > 0)) return null;
    const customer = entry.tags?.[s.customerTag];
    if (!/^cus_[A-Za-z0-9]+$/.test(customer || "")) return null;
    const billedUSD = round6(Number(entry.amount) * (1 + Number(s.markupPct) / 100));
    // Micro-dollars: integer, no rounding loss on sub-cent requests. Price the
    // Stripe meter at $0.000001 per unit (or $1 per 1,000,000 units).
    const value = Math.round(billedUSD * 1e6);
    const identifier = `sv_${entry.entryHash || entry.ts}`.slice(0, 100);
    const row = { at: new Date().toISOString(), customer, costUSD: Number(entry.amount), billedUSD, value, unit: "microusd", identifier, model: entry.model, status: "pending" };
    if (!process.env.STRIPE_SECRET_KEY) {
      append({ ...row, status: "skipped", error: "STRIPE_SECRET_KEY not set" });
      return null;
    }
    const base = process.env.STRIPE_API_BASE || "https://api.stripe.com";
    try {
      const form = new URLSearchParams({ event_name: s.eventName, "payload[stripe_customer_id]": customer, "payload[value]": String(value), identifier, timestamp: String(Math.floor(Date.parse(entry.ts || row.at) / 1000)) });
      const r = await fetch(`${base}/v1/billing/meter_events`, { method: "POST", headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
      const out = await r.json().catch(() => ({}));
      append({ ...row, status: r.ok ? "sent" : "failed", ...(r.ok ? {} : { error: out.error?.message || `Stripe returned ${r.status}` }) });
      return r.ok;
    } catch (err) {
      append({ ...row, status: "failed", error: err.message });
      return false;
    }
  }

  function summary({ days = 30, now = Date.now() } = {}) {
    const cutoff = now - days * 24 * 3600e3;
    const by = new Map();
    for (const r of read()) {
      if (!(Date.parse(r.at) >= cutoff)) continue;
      if (!by.has(r.customer)) by.set(r.customer, { customer: r.customer, costUSD: 0, billedUSD: 0, events: 0, failed: 0, skipped: 0 });
      const c = by.get(r.customer);
      if (r.status === "sent") {
        c.costUSD += r.costUSD;
        c.billedUSD += r.billedUSD;
        c.events++;
      } else if (r.status === "failed") c.failed++;
      else if (r.status === "skipped") c.skipped++;
    }
    const customers = [...by.values()].map((c) => ({ ...c, costUSD: round6(c.costUSD), billedUSD: round6(c.billedUSD), marginUSD: round6(c.billedUSD - c.costUSD) }));
    return { settings: rebillingSettings(loadPolicy()), days, customers, totals: { costUSD: round6(customers.reduce((s, c) => s + c.costUSD, 0)), billedUSD: round6(customers.reduce((s, c) => s + c.billedUSD, 0)), marginUSD: round6(customers.reduce((s, c) => s + c.marginUSD, 0)) } };
  }

  return { onCharge, summary };
}
