// Card authorization governance — the same policy brain, on the card rail.
//
// Agents increasingly pay with cards: Visa Intelligent Commerce, Mastercard
// Agent Pay, Stripe Issuing for agents, single-use virtual cards. The card
// networks give the issuer a moment, at authorization time, to say yes or no.
// Stripe Issuing calls a synchronous webhook (issuing_authorization.request,
// answer within 2 seconds); Lithic calls Auth Stream Access (answer within 6).
// This file is that endpoint: point either at SpendVeto and every swipe by an
// agent's card is decided by the same rules that decide its x402 payments and
// its model tokens — kill switch, per-authorization cap, rolling daily
// budget, velocity, a merchant-category (MCC) allow/block list, and, for a
// card bound to a delegated wallet, the cascading delegation caps.
//
// Formats (from the providers' own docs, 2026-10):
//   Stripe — POST with header `Stripe-Signature: t=…,v1=…` (HMAC-SHA256 over
//     "<t>.<raw body>" with the endpoint secret). Respond 200 with header
//     `Stripe-Version` and JSON { approved: boolean, metadata?: {…} }.
//   Lithic — POST with Standard Webhooks headers `webhook-id`,
//     `webhook-timestamp`, `webhook-signature: v1,<base64>` (HMAC-SHA256 over
//     "<id>.<timestamp>.<raw body>", key = base64 secret after "whsec_").
//     Respond 200 with { result: "APPROVED" | <decline code>, token }.
//
// What this is NOT: a card issuer, a processor, or a ledger of captures —
// it decides authorizations. Captures, reversals and refunds arrive later as
// separate events that this endpoint doesn't consume yet; an approved
// authorization is booked as committed spend, which is what a budget must
// count at the moment it decides. Amounts are governed in USD only: a card
// authorization in another currency is declined rather than compared across
// currencies with a guessed exchange rate.
import express from "express";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export const CARD_DEFAULTS = {
  maxAuthorizationUSD: 500,
  dailyBudgetUSD: 1000, // rolling 24h, per card identity
  maxAuthorizationsPerHour: 30,
  // High-risk merchant categories an agent card should rarely touch:
  // 7995 gambling, 6051 quasi-cash / crypto purchases, 4829 money transfer,
  // 6540 stored-value card loads. Operators override with policy.cards.
  blockedMccs: ["7995", "6051", "4829", "6540"],
  allowedMccs: null,
  allowedCurrencies: ["usd"],
};

export function cardSettings(policy) {
  return { ...CARD_DEFAULTS, ...(policy?.cards || {}) };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Stripe: Stripe-Signature: t=1492774577,v1=5257a869e7…[,v1=…]
export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret) return { ok: false, reason: "no Stripe webhook secret configured" };
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] === "t"));
  const t = Number(parts.t);
  const v1s = header.split(",").map((kv) => kv.trim()).filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!Number.isFinite(t) || !v1s.length) return { ok: false, reason: "malformed Stripe-Signature header" };
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: "Stripe-Signature timestamp outside tolerance (replay protection)" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody.toString("utf8")}`).digest("hex");
  return v1s.some((sig) => safeEqual(sig, expected)) ? { ok: true } : { ok: false, reason: "Stripe signature mismatch" };
}

// Standard Webhooks (Lithic): webhook-signature may carry several
// space-separated "v1,<base64>" entries during secret rotation.
export function verifyStandardWebhook(rawBody, headers, secret, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  const id = headers["webhook-id"];
  const ts = Number(headers["webhook-timestamp"]);
  const sigHeader = headers["webhook-signature"];
  if (!id || !Number.isFinite(ts) || !sigHeader) return { ok: false, reason: "missing webhook-id / webhook-timestamp / webhook-signature headers" };
  if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: "webhook timestamp outside tolerance (replay protection)" };
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody.toString("utf8")}`).digest("base64");
  const sigs = String(sigHeader).split(" ").map((s) => s.trim()).filter((s) => s.startsWith("v1,")).map((s) => s.slice(3));
  return sigs.some((sig) => safeEqual(sig, expected)) ? { ok: true } : { ok: false, reason: "webhook signature mismatch" };
}

// Lithic decline codes, chosen per reason as their docs ask ("choose the most
// specific reason").
const LITHIC_CODE = {
  frozen: "CARD_PAUSED",
  card_mcc_blocked: "UNAUTHORIZED_MERCHANT",
  card_mcc_not_allowed: "UNAUTHORIZED_MERCHANT",
  card_currency_unsupported: "UNAUTHORIZED_MERCHANT",
  card_velocity: "VELOCITY_EXCEEDED",
};

export function createCardRouter(deps) {
  const { loadPolicy, checkPolicy, policyHash, appendLedgerEntry, getLedger, findActiveFreeze, listDelegations, readCards, pseudoAddress, childAddress } = deps;
  const router = express.Router();
  const raw = express.raw({ type: () => true, limit: "1mb" });
  const authsAt = new Map(); // address -> [ms]
  const DAY = 24 * 3600e3;

  function identityFor(rail, cardId, last4, metadataLabel) {
    const mapped = readCards().find((c) => c.cardId === cardId);
    const label = mapped?.label || metadataLabel || `card ${last4 ? "…" + last4 : String(cardId).slice(-6)}`;
    const bound = mapped?.child ? childAddress(mapped.child) : null;
    return { address: (bound || pseudoAddress(`card:${rail}:${cardId}`)).toLowerCase(), label, registered: Boolean(mapped) };
  }

  function spentDayUSD(address) {
    const cutoff = Date.now() - DAY;
    return getLedger()
      .filter((e) => e.category === "card" && e.status === "paid" && String(e.address).toLowerCase() === address && Date.parse(e.ts) >= cutoff)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  }

  async function decide({ rail, auth }) {
    const policy = loadPolicy();
    const s = cardSettings(policy);
    const deny = (code, reason) => ({ approved: false, code, reason });
    const { address } = auth.identity;
    if (findActiveFreeze(address)) return deny("frozen", `card "${auth.identity.label}" is frozen in SpendVeto`);
    if (!s.allowedCurrencies.map((c) => String(c).toLowerCase()).includes(String(auth.currency).toLowerCase())) {
      return deny("card_currency_unsupported", `authorizations in ${String(auth.currency).toUpperCase()} aren't governed (allowed: ${s.allowedCurrencies.join(", ")}) — declined rather than compared across currencies`);
    }
    if (auth.mcc && Array.isArray(s.blockedMccs) && s.blockedMccs.map(String).includes(String(auth.mcc))) {
      return deny("card_mcc_blocked", `merchant category ${auth.mcc}${auth.category ? ` (${auth.category})` : ""} is on policy.cards.blockedMccs`);
    }
    if (Array.isArray(s.allowedMccs) && s.allowedMccs.length && !s.allowedMccs.map(String).includes(String(auth.mcc))) {
      return deny("card_mcc_not_allowed", `merchant category ${auth.mcc || "unknown"} is not in policy.cards.allowedMccs`);
    }
    if (auth.amountUSD > s.maxAuthorizationUSD) {
      return deny("card_authorization_cap", `$${auth.amountUSD.toFixed(2)} exceeds maxAuthorizationUSD $${s.maxAuthorizationUSD}`);
    }
    const hour = (authsAt.get(address) || []).filter((t) => t >= Date.now() - 3600e3);
    if (hour.length >= s.maxAuthorizationsPerHour) return deny("card_velocity", `more than ${s.maxAuthorizationsPerHour} authorizations in the last hour`);
    const day = spentDayUSD(address);
    if (day + auth.amountUSD > s.dailyBudgetUSD) {
      return deny("card_daily_budget", `would exceed the daily card budget $${s.dailyBudgetUSD} ($${day.toFixed(2)} authorized in the last 24h)`);
    }
    const delegated = listDelegations().some((d) => String(d.childAddress).toLowerCase() === address && !d.revoked);
    if (delegated || policy.categoryCapsUSD?.card != null || policy.allowedHoursUTC) {
      const override = { ...policy, maxPerCallUSD: Infinity, maxPerHourUSD: Infinity, maxCallsPerHour: Infinity, requireApprovalAboveUSD: Infinity };
      const verdict = await checkPolicy(address, auth.amountUSD, `card:${auth.mcc || "unknown"}`, undefined, "card", undefined, override);
      if (!verdict.allowed) return deny(verdict.code || "policy", verdict.reason);
    }
    return { approved: true };
  }

  function book(rail, auth, decision, decisionId) {
    if (decision.approved) authsAt.set(auth.identity.address, [...(authsAt.get(auth.identity.address) || []).filter((t) => t >= Date.now() - 3600e3), Date.now()]);
    try {
      appendLedgerEntry({
        address: auth.identity.address,
        agent: auth.identity.label,
        resource: `card:${auth.mcc || "unknown"}${auth.merchant ? `:${auth.merchant}` : ""}`.slice(0, 120),
        amount: auth.amountUSD,
        chain: "card",
        category: "card",
        status: decision.approved ? "paid" : "blocked",
        mode: `card-${rail}`,
        cardId: auth.cardId,
        authorizationId: auth.authorizationId,
        mcc: auth.mcc || undefined,
        merchant: auth.merchant || undefined,
        decisionId,
        ...(decision.approved ? {} : { reason: decision.reason, code: decision.code }),
        policyHash: policyHash(),
      });
    } catch {}
  }

  // Stripe Issuing synchronous authorization webhook.
  router.post("/api/cards/stripe/authorization", raw, async (req, res) => {
    const secret = process.env.STRIPE_ISSUING_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: "card governance for Stripe isn't configured — set STRIPE_ISSUING_WEBHOOK_SECRET (the endpoint's whsec_… secret)" });
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sig = verifyStripeSignature(rawBody, req.get("stripe-signature"), secret);
    if (!sig.ok) return res.status(400).json({ error: sig.reason });
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "body is not JSON" });
    }
    if (event.type !== "issuing_authorization.request") return res.status(200).json({ received: true, ignored: event.type });
    const a = event.data?.object || {};
    const pending = a.pending_request || {};
    const card = a.card || {};
    const cents = Number(pending.amount ?? a.amount ?? 0);
    const auth = {
      cardId: card.id,
      authorizationId: a.id,
      amountUSD: Math.round(cents) / 100,
      currency: pending.currency || a.currency || "usd",
      mcc: a.merchant_data?.category_code || null,
      category: a.merchant_data?.category || null,
      merchant: a.merchant_data?.name || null,
      identity: identityFor("stripe", card.id, card.last4, card.metadata?.spendveto_agent),
    };
    const decision = await decide({ rail: "stripe", auth });
    const decisionId = randomUUID();
    book("stripe", auth, decision, decisionId);
    res.set({ "Stripe-Version": process.env.STRIPE_API_VERSION || "2025-03-31.basil", "Content-Type": "application/json" });
    res.status(200).send(JSON.stringify({
      approved: decision.approved,
      metadata: { spendveto_decision: decisionId, ...(decision.approved ? {} : { spendveto_code: String(decision.code).slice(0, 500), spendveto_reason: String(decision.reason).slice(0, 500) }) },
    }));
  });

  // Lithic Auth Stream Access.
  router.post("/api/cards/lithic/asa", raw, async (req, res) => {
    const secret = process.env.LITHIC_ASA_SECRET;
    if (!secret) return res.status(503).json({ error: "card governance for Lithic isn't configured — set LITHIC_ASA_SECRET (the ASA HMAC secret)" });
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sig = verifyStandardWebhook(rawBody, req.headers, secret);
    if (!sig.ok) return res.status(401).json({ error: sig.reason });
    let asa;
    try {
      asa = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "body is not JSON" });
    }
    const amounts = asa.amounts?.cardholder || null;
    const cents = Number(amounts?.amount ?? asa.amount ?? 0);
    const cardToken = asa.card?.token || asa.card_token;
    const auth = {
      cardId: cardToken,
      authorizationId: asa.token,
      amountUSD: Math.round(cents) / 100,
      currency: amounts?.currency || asa.cardholder_currency || asa.merchant_currency || "USD",
      mcc: asa.merchant?.mcc || null,
      category: null,
      merchant: asa.merchant?.descriptor || null,
      identity: identityFor("lithic", cardToken, asa.card?.last_four, null),
    };
    const decision = await decide({ rail: "lithic", auth });
    const decisionId = randomUUID();
    book("lithic", auth, decision, decisionId);
    const result = decision.approved ? "APPROVED" : LITHIC_CODE[decision.code] || "INSUFFICIENT_FUNDS";
    res.status(200).json({ result, token: asa.token });
  });

  return router;
}
