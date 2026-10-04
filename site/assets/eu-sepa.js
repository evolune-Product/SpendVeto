// EU payment governance (PSD2 Strong Customer Authentication + SEPA Direct Debit), buyer side.
//
// PSD2's Regulatory Technical Standards on Strong Customer Authentication (Commission Delegated Regulation (EU)
// 2018/389, "the RTS") require two-factor authentication for most electronic payments. An agent cannot supply SCA —
// it is, by definition, something the payer (a human) knows/has/is — so this module decides allow / requires_approval
// / deny for an agent-initiated SEPA Direct Debit mandate debit, and "requires_approval" always means the payer
// completes SCA themselves.
//
// Three RTS exemptions are modelled, each exactly as scoped in the regulation — not a generic "low value" shortcut:
//   - Article 14(1): a recurring series of transactions of a FIXED amount to the SAME payee needs SCA only on the
//     first one. The exemption is void the moment the amount changes (EBA Single Rulebook Q&A 2018_4089) —
//     SpendVeto treats a changed amount as a new first transaction, not a continuation.
//   - Article 10: a one-off, remote, low-value transaction may skip SCA up to EUR 30 per transaction, provided the
//     cumulative amount since the payer's last SCA stays under EUR 100 and no more than 5 consecutive transactions
//     have skipped it.
//   - Article 18 (Transaction Risk Analysis): a PSP with a low enough rolling fraud rate may waive SCA up to a
//     higher Exemption Threshold Value — EUR 100 / 250 / 500 for a reference fraud rate at or under 0.13% / 0.06% /
//     0.01% respectively (Annex to the RTS). The operator declares its own measured fraud rate in policy; nothing
//     here estimates or assumes one, and the default (no declared rate) is no exemption at all.
//
// SEPA Direct Debit Core Rulebook (European Payments Council): pre-notification at least 14 calendar days before
// each collection unless a shorter period is agreed with the payer, and the payer's 8-week no-questions-asked
// refund right on an authorised debit (13 months for an unauthorised one) — the refund right is informational /
// post-hoc here, not a pre-debit gate, because it cannot be exercised before the debit happens.
//
// What it is NOT: it does not initiate, collect or settle a SEPA payment, is not a PSP/PISP, and claims no
// competent-authority authorisation. Currency is EUR end to end — nothing here converts to another currency.

export const RTS_ARTICLE10_PER_TXN_EUR = 30;
export const RTS_ARTICLE10_CUMULATIVE_EUR = 100;
export const RTS_ARTICLE10_MAX_CONSECUTIVE = 5;
export const SEPA_PRENOTICE_DAYS = 14;

// Article 18 Exemption Threshold Value table (Annex to Commission Delegated Regulation (EU) 2018/389), remote
// card-based reference fraud rates; expressed in basis points of value (1 bps = 0.01%). Checked low-to-high so the
// first row the declared rate clears wins.
export const RTS_ARTICLE18_ETV_TABLE = [
  { maxFraudRateBps: 1, etvEUR: 500 },
  { maxFraudRateBps: 6, etvEUR: 250 },
  { maxFraudRateBps: 13, etvEUR: 100 },
];

const IBAN = /^[A-Z]{2}[0-9]{2}[A-Za-z0-9]{10,30}$/;

const fail = (code, reason, suggestion) => ({ decision: "deny", code, reason, suggestion });
const needsHuman = (code, reason) => ({ decision: "requires_approval", code, reason, sca: { required: true, by: "human" } });

// The IBAN is personal data (GDPR Art. 5(1)(c), data minimisation): decisions and logs carry a masked form, never
// the raw IBAN.
export function maskIban(iban) {
  if (typeof iban !== "string" || iban.length < 8) return null;
  return `${iban.slice(0, 4)}***${iban.slice(-2)}`;
}

function etvFor(fraudRateBps) {
  const bps = Number(fraudRateBps);
  if (!(bps >= 0)) return 0;
  const row = RTS_ARTICLE18_ETV_TABLE.find((r) => bps <= r.maxFraudRateBps);
  return row ? row.etvEUR : 0;
}

// Pure and deterministic: no clock reads except through `now`, no I/O. policy = the `eu` section of the policy
// file ({ maxPerTxnEUR, maxPerDayEUR, allowedPayeeIbans, allowedCategories, pspFraudRateBps }); spentTodayEUR is
// the evaluator's own tally.
export function evaluateSepaDebit(mandate, { policy = {}, spentTodayEUR = 0, now = Date.now() } = {}) {
  if (!mandate || typeof mandate !== "object") return fail("mandate_missing", "no SEPA mandate supplied", "send the mandate the agent wants to debit");
  const amount = Number(mandate.amountEUR);
  if (!(amount > 0) || Math.round(amount * 100) / 100 !== amount) {
    return fail("amount_invalid", "amountEUR must be a positive euro amount with at most 2 decimals (cents)", "send the debit amount in EUR, e.g. 9.99");
  }
  if (!IBAN.test((mandate.payeeIban || "").toUpperCase())) {
    return fail("payee_iban_invalid", "payeeIban must be a well-formed IBAN", "send the creditor's IBAN, e.g. DE89370400440532013000");
  }

  // The payer's withdrawal right is absolute: a revoked or lapsed mandate carries no authority, whatever the amount.
  if (mandate.revoked) return fail("mandate_revoked", "the payer has withdrawn this SEPA mandate", "stop — a withdrawn mandate cannot be debited; ask the payer to sign a new one");
  if (mandate.expiresAt && Date.parse(mandate.expiresAt) < now) return fail("mandate_expired", `mandate expired at ${mandate.expiresAt}`, "ask the payer to renew the mandate");

  const category = mandate.category || null;
  if (Array.isArray(policy.allowedPayeeIbans) && policy.allowedPayeeIbans.length && !policy.allowedPayeeIbans.map((v) => v.toUpperCase()).includes((mandate.payeeIban || "").toUpperCase())) {
    return fail("payee_not_allowed", "this creditor IBAN is not on the allowlist", "debit only allowlisted creditors, or add this payee to policy.eu.allowedPayeeIbans");
  }
  if (Array.isArray(policy.allowedCategories) && policy.allowedCategories.length && !policy.allowedCategories.includes(category)) {
    return fail("category_not_allowed", `category "${category}" is outside the allowed categories`, "debit only inside allowed categories");
  }

  const recurring = mandate.recurring !== false;
  if (recurring) {
    const debitAt = mandate.debitAt ? Date.parse(mandate.debitAt) : now;
    const noticeDays = Number(mandate.shorterNoticeAgreedDays) > 0 ? Number(mandate.shorterNoticeAgreedDays) : SEPA_PRENOTICE_DAYS;
    if (!mandate.notifiedAt) return fail("predebit_notice_missing", "no SEPA pre-notification on record for this collection", `notify the payer at least ${noticeDays} days before the collection date (SEPA Direct Debit Core Rulebook)`);
    if (debitAt - Date.parse(mandate.notifiedAt) < noticeDays * 24 * 60 * 60 * 1000) {
      return fail("predebit_notice_late", `the payer was notified less than ${noticeDays} days before this collection`, "reschedule the collection to respect the agreed pre-notification period");
    }
  }

  if (Number(policy.maxPerTxnEUR) > 0 && amount > Number(policy.maxPerTxnEUR)) {
    return fail("txn_cap", `EUR ${amount} exceeds the per-debit cap of EUR ${policy.maxPerTxnEUR}`, "debit a smaller amount or raise policy.eu.maxPerTxnEUR");
  }
  if (Number(policy.maxPerDayEUR) > 0 && spentTodayEUR + amount > Number(policy.maxPerDayEUR)) {
    return fail("day_cap", `EUR ${amount} would take today's total to EUR ${spentTodayEUR + amount}, over the EUR ${policy.maxPerDayEUR} daily cap`, "wait for the daily window or raise policy.eu.maxPerDayEUR");
  }

  // Authentication: Article 18 (TRA) is a general remote-payment exemption and is checked for whichever path
  // doesn't already have its own, narrower exemption — it is not specific to recurring series.
  if (!recurring) {
    const cumulative = Number(mandate.cumulativeSinceLastScaEUR) || 0;
    const consecutive = Number(mandate.consecutiveSinceLastSca) || 0;
    const withinArt10 = amount <= RTS_ARTICLE10_PER_TXN_EUR && cumulative + amount <= RTS_ARTICLE10_CUMULATIVE_EUR && consecutive < RTS_ARTICLE10_MAX_CONSECUTIVE;
    if (withinArt10) {
      return { decision: "allow", reason: `within the RTS Article 10 low-value exemption (<= EUR ${RTS_ARTICLE10_PER_TXN_EUR}, cumulative <= EUR ${RTS_ARTICLE10_CUMULATIVE_EUR}, < ${RTS_ARTICLE10_MAX_CONSECUTIVE} consecutive since the last SCA)` };
    }
    const etv = etvFor(policy.pspFraudRateBps);
    if (etv > 0 && amount <= etv) {
      return { decision: "allow", reason: `within the RTS Article 18 transaction-risk-analysis exemption threshold (EUR ${etv} at the operator's declared fraud rate)` };
    }
    return needsHuman("sca_required_one_off", "a one-off payment above both the RTS Article 10 low-value exemption and the operator's Article 18 TRA threshold needs the payer's own Strong Customer Authentication — an agent cannot supply it");
  }

  if (mandate.firstDebit) return needsHuman("sca_required_first_debit", "the first debit of a mandate always needs Strong Customer Authentication (RTS Article 14(1))");
  if (mandate.amountChangedFromMandate) return needsHuman("sca_required_amount_changed", "the RTS Article 14(1) recurring exemption only covers a FIXED amount to the same payee — a changed amount needs SCA again, exactly as if it were a new first debit");
  return { decision: "allow", reason: "within the RTS Article 14(1) recurring-transaction exemption (same fixed amount, same payee, already authenticated once)" };
}

export const EU_REGULATORY_BASIS = [
  "Commission Delegated Regulation (EU) 2018/389 (RTS on SCA and CSC under PSD2): Art. 10 one-off low-value exemption (EUR 30 per transaction / EUR 100 cumulative / 5 consecutive), Art. 14(1) recurring fixed-amount exemption, Art. 18 transaction-risk-analysis exemption (EUR 100 / 250 / 500 Exemption Threshold Value by the PSP's declared reference fraud rate)",
  "SEPA Direct Debit Core Rulebook (European Payments Council): at least 14 calendar days' pre-notification before each collection unless a shorter period is agreed; 8-week no-questions-asked refund right on an authorised debit (13 months if unauthorised)",
];

export const EU_DISCLAIMER =
  "Evaluator only: SpendVeto does not initiate, collect or settle SEPA payments, is not a PSP/PISP under PSD2, and claims no competent-authority authorisation. 'Requires approval' means the payer completes Strong Customer Authentication themselves — an agent cannot supply SCA. Article 18 exemption eligibility depends on the operator's own declared fraud rate, which the operator must keep accurate and re-verify against the current RTS text.";
