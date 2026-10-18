// Governed fiat payouts — agents paying people and vendors in real money,
// not just crypto.
//
// Finance agents are the next agents to touch money: paying vendor bills,
// issuing refunds, paying contractors and marketplace sellers. Every one of
// those is an outbound push payment on a fiat rail, and every one is the kind
// of spend a business wants decided before it leaves the account. This module
// is that decision, then the execution, on four real providers:
//
//   stripe          Stripe Connect transfers (POST /v1/transfers) — to a connected account
//   razorpayx       RazorpayX payouts (POST /v1/payouts) — UPI, IMPS, NEFT, RTGS in India
//   paypal          PayPal Payouts (POST /v1/payments/payouts) — to an email, phone or PayPal ID
//   moderntreasury  Modern Treasury payment orders (POST /api/payment_orders) — US ACH, RTP, wire
//
// Each request formats come from the provider's own reference (checked
// 2026-10-18): idempotency headers (Stripe `Idempotency-Key`, RazorpayX
// `X-Payout-Idempotency`, PayPal `PayPal-Request-Id`, Modern Treasury
// `Idempotency-Key`), amounts in minor units (paise for INR), PayPal amounts
// as decimal strings. A provider with no credentials configured refuses
// honestly — a declared slot, never a pretend payout.
//
// The decision before any money moves: kill switch, per-payout cap, rolling
// daily budget, hourly velocity, purpose allowlist, delegation caps for an
// agent bound to a delegated wallet — and a NEW PAYEE (not on the operator's
// allowlist) always waits for a human, because "paid a stranger" is the
// failure mode that matters most for outbound money. Payouts above
// requireApprovalAboveUSD wait too. Waiting is asynchronous: the request
// returns 202, the payout executes the moment a human approves it in the
// Console (or never, if they deny it).
//
// Money in another currency counts against the USD budgets only at an
// exchange rate the OPERATOR declared (policy.payouts.fxRates) — no rate, no
// payout. SpendVeto never guesses an exchange rate for money leaving a
// business.
//
// What this does NOT do yet: consume providers' asynchronous status webhooks
// (a RazorpayX payout can later reverse, an ACH credit can return). The
// status recorded is what the provider said when it accepted the payout;
// POST /api/payouts/:id/status records a later status from your own webhook
// glue.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const PAYOUT_DEFAULTS = {
  maxPerPayoutUSD: 1000,
  dailyBudgetUSD: 5000, // rolling 24h, per identity
  maxPayoutsPerHour: 20,
  requireApprovalAboveUSD: 500,
  allowedPayees: [], // payee ids/emails that skip the new-payee approval
  allowedPurposes: null, // null = any
  fxRates: {}, // { INR: 0.012 } — USD per unit, operator-declared
  approvalTimeoutSeconds: 24 * 3600, // an unanswered approval expires (fails closed)
  // Money leaving the business always has an accountable identity: a
  // registered agent's tg_ token. Set false only for a single-operator setup.
  requireAgentToken: true,
};

export function payoutSettings(policy) {
  const p = policy?.payouts || {};
  return { ...PAYOUT_DEFAULTS, ...p, fxRates: { ...(p.fxRates || {}) }, allowedPayees: Array.isArray(p.allowedPayees) ? p.allowedPayees : [] };
}

// ISO 4217 currencies with no minor unit (Stripe's zero-decimal list).
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
export const toMinor = (amount, currency) => Math.round(Number(amount) * (ZERO_DECIMAL.has(String(currency).toUpperCase()) ? 1 : 100));
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

// Provider adapters: validate the payee for that rail, report whether the
// provider is configured, and execute. `base` URLs are overridable so a
// sandbox — or the verify suite's local mock — can stand in.
export const PROVIDERS = {
  stripe: {
    label: "Stripe Connect transfer",
    configured: () => Boolean(process.env.STRIPE_SECRET_KEY),
    needs: "STRIPE_SECRET_KEY",
    validate: ({ payee, currency }) => (/^acct_[A-Za-z0-9]+$/.test(payee || "") ? null : `Stripe payee must be a connected account id (acct_…), got "${payee}"`) || (/^[A-Z]{3}$/.test(currency) ? null : "currency must be a 3-letter ISO code"),
    async execute({ id, amount, currency, payee, purpose, idempotencyKey, description }) {
      const base = process.env.STRIPE_API_BASE || "https://api.stripe.com";
      const form = new URLSearchParams({ amount: String(toMinor(amount, currency)), currency: currency.toLowerCase(), destination: payee, description: (description || purpose || "SpendVeto payout").slice(0, 200), "metadata[spendveto_payout]": id, ...(purpose ? { "metadata[purpose]": purpose } : {}) });
      const r = await fetch(`${base}/v1/transfers`, { method: "POST", headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": idempotencyKey }, body: form.toString() });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: body.error?.message || `Stripe returned ${r.status}` };
      return { ok: true, providerId: body.id, providerStatus: body.reversed ? "reversed" : "paid" };
    },
  },
  razorpayx: {
    label: "RazorpayX payout (UPI / IMPS / NEFT / RTGS)",
    configured: () => Boolean(process.env.RAZORPAYX_KEY_ID && process.env.RAZORPAYX_KEY_SECRET && process.env.RAZORPAYX_ACCOUNT_NUMBER),
    needs: "RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET, RAZORPAYX_ACCOUNT_NUMBER",
    validate: ({ payee, currency, method, purpose }) =>
      (/^fa_[A-Za-z0-9]+$/.test(payee || "") ? null : `RazorpayX payee must be a fund account id (fa_…), got "${payee}"`) ||
      (currency === "INR" ? null : "RazorpayX pays out in INR only") ||
      (["UPI", "IMPS", "NEFT", "RTGS"].includes(method) ? null : 'method must be "UPI", "IMPS", "NEFT" or "RTGS" (case-sensitive, as RazorpayX requires)') ||
      (purpose ? null : 'RazorpayX requires a purpose ("vendor bill", "refund", "payout", "salary", "cashback", "utility bill" or a custom one)'),
    async execute({ id, amount, payee, method, purpose, idempotencyKey, reference }) {
      const base = process.env.RAZORPAY_API_BASE || "https://api.razorpay.com";
      const body = {
        account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
        fund_account_id: payee,
        amount: toMinor(amount, "INR"),
        currency: "INR",
        mode: method,
        purpose,
        queue_if_low_balance: false,
        reference_id: String(reference || id).slice(0, 40),
        narration: "SpendVeto payout",
        notes: { spendveto_payout: id },
      };
      const r = await fetch(`${base}/v1/payouts`, { method: "POST", headers: { Authorization: basic(process.env.RAZORPAYX_KEY_ID, process.env.RAZORPAYX_KEY_SECRET), "Content-Type": "application/json", "X-Payout-Idempotency": idempotencyKey }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: out.error?.description || `RazorpayX returned ${r.status}` };
      const failed = ["rejected", "cancelled", "failed", "reversed"].includes(out.status);
      return failed ? { ok: false, providerId: out.id, error: `RazorpayX status ${out.status}`, providerStatus: out.status } : { ok: true, providerId: out.id, providerStatus: out.status };
    },
  },
  paypal: {
    label: "PayPal Payouts",
    configured: () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    needs: "PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET",
    validate: ({ payee, currency, method }) =>
      (["EMAIL", "PHONE", "PAYPAL_ID"].includes(method || "EMAIL") ? null : 'method must be "EMAIL", "PHONE" or "PAYPAL_ID"') ||
      ((method || "EMAIL") !== "EMAIL" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payee || "") ? null : `PayPal EMAIL payee must be an email address, got "${payee}"`) ||
      (/^[A-Z]{3}$/.test(currency) ? null : "currency must be a 3-letter ISO code"),
    async execute({ id, amount, currency, payee, method, purpose, idempotencyKey }) {
      const base = process.env.PAYPAL_API_BASE || "https://api-m.paypal.com";
      const tok = await fetch(`${base}/v1/oauth2/token`, { method: "POST", headers: { Authorization: basic(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
      const token = await tok.json().catch(() => ({}));
      if (!tok.ok || !token.access_token) return { ok: false, error: `PayPal OAuth failed (${tok.status})` };
      const value = ZERO_DECIMAL.has(currency) ? String(Math.round(amount)) : Number(amount).toFixed(2);
      const r = await fetch(`${base}/v1/payments/payouts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", "PayPal-Request-Id": idempotencyKey },
        body: JSON.stringify({
          sender_batch_header: { sender_batch_id: id, email_subject: "You have a payment", email_message: (purpose || "Payment").slice(0, 120) },
          items: [{ recipient_type: method || "EMAIL", amount: { value, currency }, receiver: payee, note: (purpose || "Payment").slice(0, 120), sender_item_id: id }],
        }),
      });
      const out = await r.json().catch(() => ({}));
      const status = out.batch_header?.batch_status;
      if (!r.ok) return { ok: false, error: out.message || `PayPal returned ${r.status}` };
      if (["DENIED", "CANCELED"].includes(status)) return { ok: false, providerId: out.batch_header?.payout_batch_id, error: `PayPal batch ${status}`, providerStatus: status };
      return { ok: true, providerId: out.batch_header?.payout_batch_id, providerStatus: status };
    },
  },
  moderntreasury: {
    label: "Modern Treasury payment order (ACH / RTP / wire)",
    configured: () => Boolean(process.env.MODERN_TREASURY_ORG_ID && process.env.MODERN_TREASURY_API_KEY && process.env.MODERN_TREASURY_ORIGINATING_ACCOUNT_ID),
    needs: "MODERN_TREASURY_ORG_ID, MODERN_TREASURY_API_KEY, MODERN_TREASURY_ORIGINATING_ACCOUNT_ID",
    validate: ({ payee, method, currency }) =>
      (/^[0-9a-f-]{36}$/i.test(payee || "") ? null : `Modern Treasury payee must be a receiving account id (UUID), got "${payee}"`) ||
      (["ach", "rtp", "wire", "book"].includes(method) ? null : 'method must be "ach", "rtp", "wire" or "book"') ||
      (/^[A-Z]{3}$/.test(currency) ? null : "currency must be a 3-letter ISO code"),
    async execute({ id, amount, currency, payee, method, purpose, idempotencyKey }) {
      const base = process.env.MODERN_TREASURY_API_BASE || "https://app.moderntreasury.com";
      const r = await fetch(`${base}/api/payment_orders`, {
        method: "POST",
        headers: { Authorization: basic(process.env.MODERN_TREASURY_ORG_ID, process.env.MODERN_TREASURY_API_KEY), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ type: method, amount: toMinor(amount, currency), direction: "credit", currency, originating_account_id: process.env.MODERN_TREASURY_ORIGINATING_ACCOUNT_ID, receiving_account_id: payee, description: (purpose || "SpendVeto payout").slice(0, 200), metadata: { spendveto_payout: id } }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: out.errors?.message || `Modern Treasury returned ${r.status}` };
      return { ok: true, providerId: out.id, providerStatus: out.status };
    },
  },
};

export function createPayouts(deps) {
  const { dataPath, loadPolicy, checkPolicy, policyHash, appendLedgerEntry, getLedger, findActiveFreeze, listDelegations, createApproval, getApproval, readAgents, childAddress, pseudoAddress } = deps;
  const PATH = dataPath("payouts.json");
  const read = () => {
    try {
      return existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : [];
    } catch {
      return [];
    }
  };
  const save = (rows) => writeFileSync(PATH, JSON.stringify(rows, null, 2));
  const update = (id, patch) => {
    const rows = read();
    const row = rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    save(rows);
    return row;
  };

  // Who is paying: an agent token (team agents, possibly bound to a delegated
  // wallet), an explicit agent label, or the local operator.
  function identityFor(req, body) {
    const auth = req.get("authorization") || "";
    const bearer = (auth.match(/^Bearer\s+(.+)$/i) || [])[1] || req.get("x-api-key") || null;
    const agent = bearer ? readAgents().find((a) => a.token === bearer) : null;
    if (agent) return { address: ((agent.child && childAddress(agent.child)) || pseudoAddress(`agent:${agent.id}`)).toLowerCase(), label: agent.label, agent: true };
    const label = String(body.agent || req.get("x-spendveto-agent") || "local").replace(/[^\w .:@-]/g, "").slice(0, 64) || "local";
    return { address: pseudoAddress(label === "local" ? "local" : `label:${label}`), label, agent: false };
  }

  function spentDayUSD(address) {
    const cutoff = Date.now() - 24 * 3600e3;
    return getLedger().filter((e) => e.category === "payout" && e.status === "paid" && String(e.address).toLowerCase() === address && Date.parse(e.ts) >= cutoff).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  }
  function countHour(address) {
    const cutoff = Date.now() - 3600e3;
    return read().filter((p) => p.address === address && Date.parse(p.createdAt) >= cutoff && ["executed", "awaiting_approval", "executing"].includes(p.status)).length;
  }

  function book(p, status, extra = {}) {
    try {
      appendLedgerEntry({
        address: p.address,
        agent: p.agent,
        resource: `payout:${p.provider}:${p.payee}`.slice(0, 120),
        amount: status === "paid" ? p.amountUSD : extra.amountOverride ?? p.amountUSD,
        chain: "fiat",
        category: "payout",
        status,
        mode: `payout-${p.provider}`,
        payoutId: p.id,
        provider: p.provider,
        currency: p.currency,
        originalAmount: p.amount,
        ...(p.fx ? { fx: p.fx } : {}),
        ...(p.tags ? { tags: p.tags } : {}),
        payTo: p.payee,
        ...extra,
        policyHash: policyHash(),
      });
    } catch {}
  }

  async function execute(p) {
    const provider = PROVIDERS[p.provider];
    update(p.id, { status: "executing" });
    let result;
    try {
      result = await provider.execute(p);
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result.ok) {
      const row = update(p.id, { status: "executed", providerId: result.providerId, providerStatus: result.providerStatus, executedAt: new Date().toISOString() });
      book(row, "paid", { providerId: result.providerId, providerStatus: result.providerStatus });
      return row;
    }
    const row = update(p.id, { status: "failed", providerId: result.providerId || null, providerStatus: result.providerStatus || null, error: result.error });
    book(row, "failed", { amountOverride: 0, reason: result.error, providerStatus: result.providerStatus });
    return row;
  }

  // Human-in-the-loop: the approval Console decides; this runs the payout the
  // moment it's approved, or closes it if it's denied or expires.
  async function onApprovalDecided(approvalId, status) {
    const p = read().find((r) => r.approvalId === approvalId && r.status === "awaiting_approval");
    if (!p) return null;
    if (status === "approved") return execute(p);
    if (status === "denied") {
      const row = update(p.id, { status: "denied" });
      book(row, "blocked", { reason: "denied by a human approver", code: "payout_denied" });
      return row;
    }
    return null;
  }

  async function create(req, body) {
    const policy = loadPolicy();
    const s = payoutSettings(policy);
    const providerId = String(body.provider || "");
    const provider = PROVIDERS[providerId];
    if (!provider) return { status: 400, json: { error: `unknown provider "${providerId}" — one of ${Object.keys(PROVIDERS).join(", ")}` } };
    if (!provider.configured()) return { status: 503, json: { decision: "deny", code: "payout_provider_not_configured", reason: `${provider.label} isn't configured on this server`, suggestion: `set ${provider.needs}` } };
    const amount = Number(body.amount);
    const currency = String(body.currency || "USD").toUpperCase();
    const payee = String(body.payee || "").trim();
    const method = body.method != null ? String(body.method) : undefined;
    const purpose = body.purpose != null ? String(body.purpose).slice(0, 60) : undefined;
    if (!(amount > 0)) return { status: 400, json: { error: "amount must be a positive number in major units (e.g. 25.50)" } };
    const invalid = provider.validate({ payee, currency, method, purpose });
    if (invalid) return { status: 400, json: { error: invalid } };

    const identity = identityFor(req, body);
    const deny = (code, reason, suggestion, status = 403) => ({ status, json: { decision: "deny", code, reason, suggestion } });
    if (s.requireAgentToken && !identity.agent) return deny("agent_token_required", "payouts require a registered agent's tg_ token", "register the agent (Console → Agents) and send its token as Authorization: Bearer tg_…, or set policy.payouts.requireAgentToken to false for a single-operator setup", 401);

    // Idempotency first: an agent retrying the same payout gets the same
    // payout back — never a second transfer.
    const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey).slice(0, 120) : null;
    if (idempotencyKey) {
      const prior = read().find((r) => r.idempotencyKey === idempotencyKey && r.address === identity.address && Date.parse(r.createdAt) >= Date.now() - 24 * 3600e3);
      if (prior) return { status: 200, json: { decision: "replayed", idempotent: true, payout: prior } };
    }

    // USD for the budgets: native, or at an operator-declared rate.
    let amountUSD = amount;
    let fx = null;
    if (currency !== "USD") {
      const rate = Number(s.fxRates[currency]);
      if (!(rate > 0)) return deny("payout_fx_rate_missing", `no operator-declared USD rate for ${currency} in policy.payouts.fxRates`, `declare one (e.g. "fxRates": { "${currency}": 0.012 }) — SpendVeto never guesses an exchange rate for money leaving the business`);
      amountUSD = round6(amount * rate);
      fx = { rate, source: "policy.payouts.fxRates (operator-declared)" };
    }

    if (findActiveFreeze(identity.address)) return deny("frozen", `"${identity.label}" is frozen`, "a human must unfreeze it in the Console before it can pay anyone");
    if (Array.isArray(s.allowedPurposes) && s.allowedPurposes.length && !s.allowedPurposes.includes(purpose)) return deny("payout_purpose_not_allowed", `purpose "${purpose}" is not in policy.payouts.allowedPurposes`, `use one of: ${s.allowedPurposes.join(", ")}`);
    if (amountUSD > s.maxPerPayoutUSD) return deny("payout_cap", `$${amountUSD.toFixed(2)} exceeds maxPerPayoutUSD $${s.maxPerPayoutUSD}`, "split it only if a human agrees, or have a human raise policy.payouts.maxPerPayoutUSD");
    if (countHour(identity.address) >= s.maxPayoutsPerHour) return deny("payout_velocity", `more than ${s.maxPayoutsPerHour} payouts in the last hour`, "slow down; a burst of payouts is the shape of a compromised agent");
    const day = spentDayUSD(identity.address);
    if (day + amountUSD > s.dailyBudgetUSD) return deny("payout_daily_budget", `would exceed the daily payout budget $${s.dailyBudgetUSD} ($${day.toFixed(2)} paid out in the last 24h)`, "wait for the rolling window, or have a human raise policy.payouts.dailyBudgetUSD");
    const delegated = listDelegations().some((d) => String(d.childAddress).toLowerCase() === identity.address && !d.revoked);
    if (delegated || policy.categoryCapsUSD?.payout != null || policy.allowedHoursUTC) {
      const override = { ...policy, maxPerCallUSD: Infinity, maxPerHourUSD: Infinity, maxCallsPerHour: Infinity, requireApprovalAboveUSD: Infinity };
      const verdict = await checkPolicy(identity.address, amountUSD, `payout:${providerId}`, undefined, "payout", undefined, override);
      if (!verdict.allowed) return deny(verdict.code || "policy", verdict.reason, verdict.suggestion);
    }

    const id = `po_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const newPayee = !s.allowedPayees.includes(payee);
    const overThreshold = amountUSD > s.requireApprovalAboveUSD;
    const tags = body.tags && typeof body.tags === "object" ? Object.fromEntries(Object.entries(body.tags).slice(0, 10).map(([k, v]) => [String(k).slice(0, 32), String(v).slice(0, 64)])) : null;
    const record = {
      id, provider: providerId, payee, amount, currency, amountUSD, fx, method, purpose, reference: body.reference ? String(body.reference).slice(0, 40) : null,
      description: body.description ? String(body.description).slice(0, 200) : null, tags,
      address: identity.address, agent: identity.label, idempotencyKey: idempotencyKey || id,
      status: "pending", createdAt: new Date().toISOString(),
    };

    if (newPayee || overThreshold) {
      const reasons = [newPayee ? "a payee not on policy.payouts.allowedPayees" : null, overThreshold ? `above requireApprovalAboveUSD $${s.requireApprovalAboveUSD}` : null].filter(Boolean).join(" and ");
      const approval = createApproval({ address: identity.address, resource: `payout:${providerId}:${payee}`, price: amountUSD });
      record.status = "awaiting_approval";
      record.approvalId = approval.id;
      record.approvalReason = reasons;
      record.approvalExpiresAt = new Date(Date.now() + s.approvalTimeoutSeconds * 1000).toISOString();
      const rows = read();
      rows.push(record);
      save(rows);
      return { status: 202, json: { decision: "requires_approval", code: "payout_requires_approval", reason: `this payout needs a human: ${reasons}`, suggestion: "approve it in the SpendVeto Console (Approvals) — it executes the moment it's approved", payout: record, approvalId: approval.id } };
    }

    const rows = read();
    rows.push(record);
    save(rows);
    const done = await execute(record);
    return done.status === "executed"
      ? { status: 201, json: { decision: "paid", payout: done } }
      : { status: 502, json: { decision: "failed", code: "payout_provider_error", reason: done.error, payout: done } };
  }

  function summary() {
    const rows = read();
    return {
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, configured: p.configured(), needs: p.needs })),
      settings: payoutSettings(loadPolicy()),
      payouts: rows.slice(-100).reverse(),
      totals: {
        executedUSD: round6(rows.filter((r) => r.status === "executed").reduce((s, r) => s + r.amountUSD, 0)),
        awaitingApproval: rows.filter((r) => r.status === "awaiting_approval").length,
        failed: rows.filter((r) => r.status === "failed").length,
        denied: rows.filter((r) => r.status === "denied").length,
      },
    };
  }

  // Expire unanswered approvals (fails closed) — lazily, on reads.
  function sweep() {
    const rows = read();
    let changed = false;
    for (const r of rows) {
      if (r.status === "awaiting_approval" && r.approvalExpiresAt && Date.parse(r.approvalExpiresAt) <= Date.now()) {
        r.status = "expired";
        changed = true;
        book(r, "blocked", { reason: "approval expired — failed closed", code: "payout_approval_expired" });
      }
    }
    if (changed) save(rows);
  }

  function recordStatus(id, status, note) {
    const row = read().find((r) => r.id === id);
    if (!row) return null;
    return update(id, { providerStatus: String(status).slice(0, 40), statusNote: note ? String(note).slice(0, 200) : undefined });
  }

  return { create, onApprovalDecided, summary: () => (sweep(), summary()), list: () => (sweep(), read()), recordStatus, getApproval };
}
