// Brazil payment governance (Pix), buyer side.
//
// Two real, Banco Central do Brasil (BCB)-mandated controls govern an agent's Pix activity, and they apply to
// different shapes of payment:
//
//   - Nighttime limit ("horário noturno"): every Pix-enabled account defaults to a BRL 1,000 ceiling on transfers
//     made during a nighttime window the customer chooses (20:00-06:00 by default, or 22:00-06:00) — raising it
//     takes a minimum 24-hour cooling-off period the institution must enforce. This applies to an ordinary, one-off
//     Pix transfer, so it governs the non-recurring path here.
//   - Pix Automático (BCB's recurring-Pix scheme, mandatory for payer-side institutions since October 2025): the
//     payer authorises once, in their own banking app — an agent cannot supply that authorisation — after which a
//     business can pull against it under BCB's own scheduling and retry rules: each charge must be created 2-10
//     days before its due date, and at most 3 charge attempts (including dunning retries) are allowed in any
//     rolling 7-day window. Cancellation takes effect only once BCB confirms it; past charges are unaffected.
//
// MED (Mecanismo Especial de Devolução) is Pix's special fraud-return mechanism — a post-hoc dispute process, not
// a pre-debit gate, so it is disclosed here, not enforced.
//
// What it is NOT: it does not initiate, collect or settle a Pix payment, is not a Pix participant (PSP), and
// claims no BCB authorisation. Currency is BRL end to end.

export const NIGHTTIME_LIMIT_BRL = 1000;
export const NIGHTTIME_WINDOWS = {
  "20-6": { start: 20, end: 6 },
  "22-6": { start: 22, end: 6 },
};
export const PIX_AUTO_SCHEDULE_MIN_DAYS = 2;
export const PIX_AUTO_SCHEDULE_MAX_DAYS = 10;
export const PIX_AUTO_MAX_ATTEMPTS_PER_7D = 3;

// CPF (11 digits), CNPJ (14 digits), phone (+ and 10-15 digits), email, or a random EVP key (UUID-shaped).
const PIX_KEY = /^([0-9]{11}|[0-9]{14}|\+?[0-9]{10,15}|[^\s@]+@[^\s@]+\.[^\s@]+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

const fail = (code, reason, suggestion) => ({ decision: "deny", code, reason, suggestion });
const needsHuman = (code, reason) => ({ decision: "requires_approval", code, reason, authorisation: { required: true, by: "human" } });

// The Pix key can be a CPF/CNPJ, phone or email — personal data under the LGPD (Lei 13.709/2018): decisions and
// logs carry a masked form, never the raw key.
export function maskPixKey(key) {
  if (typeof key !== "string" || key.length < 4) return null;
  if (key.includes("@")) {
    const [name, domain] = key.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `${key.slice(0, 2)}***${key.slice(-2)}`;
}

function inNighttimeWindow(hourUTC, win) {
  return win.start <= win.end ? hourUTC >= win.start && hourUTC < win.end : hourUTC >= win.start || hourUTC < win.end;
}

// Pure and deterministic. policy = the `br` section of the policy file ({ maxPerTxnBRL, maxPerDayBRL,
// allowedPayeeKeys, allowedCategories, nighttimeWindow: "20-6"|"22-6", nighttimeLimitBRL }).
export function evaluatePixPayment(mandate, { policy = {}, spentTodayBRL = 0, attemptsInWindow = 0, now = Date.now() } = {}) {
  if (!mandate || typeof mandate !== "object") return fail("payment_missing", "no Pix payment supplied", "send the payment the agent wants to make");
  const amount = Number(mandate.amountBRL);
  if (!(amount > 0) || Math.round(amount * 100) / 100 !== amount) {
    return fail("amount_invalid", "amountBRL must be a positive real amount with at most 2 decimals (centavos)", "send the amount in BRL, e.g. 49.90");
  }
  if (!PIX_KEY.test(mandate.payeeKey || "")) return fail("payee_key_invalid", "payeeKey must be a valid Pix key (CPF, CNPJ, phone, email, or a random EVP key)", "send the payee's Pix key");

  // The payer's cancellation right is absolute: a cancelled or lapsed authorisation carries no authority.
  if (mandate.cancelled) return fail("pix_auto_cancelled", "this Pix Automático authorisation was cancelled (BCB-confirmed)", "stop — a cancelled authorisation cannot be charged; ask the payer to authorise a new one");
  if (mandate.expiresAt && Date.parse(mandate.expiresAt) < now) return fail("mandate_expired", `authorisation expired at ${mandate.expiresAt}`, "ask the payer to renew the authorisation");

  const category = mandate.category || null;
  if (Array.isArray(policy.allowedPayeeKeys) && policy.allowedPayeeKeys.length && !policy.allowedPayeeKeys.includes(mandate.payeeKey)) {
    return fail("payee_not_allowed", "this Pix key is not on the allowlist", "pay only allowlisted payees, or add this key to policy.br.allowedPayeeKeys");
  }
  if (Array.isArray(policy.allowedCategories) && policy.allowedCategories.length && !policy.allowedCategories.includes(category)) {
    return fail("category_not_allowed", `category "${category}" is outside the allowed categories`, "pay only inside allowed categories");
  }

  if (Number(policy.maxPerTxnBRL) > 0 && amount > Number(policy.maxPerTxnBRL)) {
    return fail("txn_cap", `BRL ${amount} exceeds the per-payment cap of BRL ${policy.maxPerTxnBRL}`, "pay a smaller amount or raise policy.br.maxPerTxnBRL");
  }
  if (Number(policy.maxPerDayBRL) > 0 && spentTodayBRL + amount > Number(policy.maxPerDayBRL)) {
    return fail("day_cap", `BRL ${amount} would take today's total to BRL ${spentTodayBRL + amount}, over the BRL ${policy.maxPerDayBRL} daily cap`, "wait for the daily window or raise policy.br.maxPerDayBRL");
  }

  const recurring = mandate.recurring === true; // ordinary Pix is one-off by default; Pix Automático is opt-in per mandate
  if (recurring) {
    if (mandate.firstCharge) return needsHuman("pix_auto_first_authorization", "the first charge under a Pix Automático authorisation always needs the payer's own in-app authorisation (BCB rule, mandatory since October 2025)");
    if (attemptsInWindow >= PIX_AUTO_MAX_ATTEMPTS_PER_7D) {
      return fail("pix_auto_retry_limit_exceeded", `this would be charge attempt ${attemptsInWindow + 1} in the current 7-day window — BCB allows at most ${PIX_AUTO_MAX_ATTEMPTS_PER_7D}`, "wait for the 7-day window to roll over before retrying");
    }
    if (mandate.scheduledAt && mandate.dueAt) {
      const daysBefore = (Date.parse(mandate.dueAt) - Date.parse(mandate.scheduledAt)) / (24 * 60 * 60 * 1000);
      if (daysBefore < PIX_AUTO_SCHEDULE_MIN_DAYS || daysBefore > PIX_AUTO_SCHEDULE_MAX_DAYS) {
        return fail("pix_auto_scheduling_window", `this charge was scheduled ${daysBefore.toFixed(1)} days before its due date — BCB requires between ${PIX_AUTO_SCHEDULE_MIN_DAYS} and ${PIX_AUTO_SCHEDULE_MAX_DAYS}`, "reschedule the charge inside the BCB window");
      }
    }
    return { decision: "allow", reason: "within Pix Automático's BCB scheduling and retry rules, already authorised by the payer" };
  }

  // Ordinary one-off Pix transfer: the nighttime ceiling applies unless the operator or customer raised it.
  const win = NIGHTTIME_WINDOWS[policy.nighttimeWindow] || NIGHTTIME_WINDOWS["20-6"];
  const limit = Number(policy.nighttimeLimitBRL) > 0 ? Number(policy.nighttimeLimitBRL) : NIGHTTIME_LIMIT_BRL;
  const hourUTC = new Date(now).getUTCHours();
  if (inNighttimeWindow(hourUTC, win) && amount > limit) {
    return needsHuman("pix_nighttime_limit", `BRL ${amount} exceeds the BRL ${limit} nighttime limit (${win.start}:00-${win.end}:00) — the payer must confirm in their own banking app to raise it`);
  }
  return { decision: "allow", reason: "within the nighttime limit (or outside the nighttime window) and inside operator policy" };
}

export const BR_REGULATORY_BASIS = [
  "BCB nighttime-limit rule (horário noturno): BRL 1,000 default ceiling on ordinary Pix transfers during the customer's chosen nighttime window (20:00-06:00 or 22:00-06:00); raising it requires a minimum 24-hour cooling-off period",
  "Pix Automático (BCB recurring-Pix scheme, mandatory for payer-side institutions since October 2025): first charge needs the payer's own in-app authorisation; each charge scheduled 2-10 days before its due date; at most 3 charge attempts per rolling 7-day window; cancellation effective only once BCB-confirmed",
];

export const BR_DISCLAIMER =
  "Evaluator only: SpendVeto does not initiate, collect or settle Pix payments, is not a Pix participant (PSP), and claims no BCB authorisation. 'Requires approval' means the payer acts in their own banking app — an agent cannot raise its own nighttime limit or authorise its own Pix Automático mandate. MED (Mecanismo Especial de Devolução) is a post-hoc dispute process, not something this evaluator can invoke.";
