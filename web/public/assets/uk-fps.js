// UK payment governance (Faster Payments push payments), buyer side.
//
// Faster Payments has no UK equivalent of a SEPA/UPI recurring PULL mandate — recurring pull debits in the UK run
// on Bacs Direct Debit, a different scheme this module does not cover. What an AI agent actually does on Faster
// Payments is PUSH an arbitrary payment, once, to a payee it names — which is exactly the fact pattern the UK's
// Authorised Push Payment (APP) fraud regime exists for. So this module governs push payments, not mandates, using
// two real, live UK controls:
//
//   - Confirmation of Payee (CoP) — Payment Systems Regulator Specific Direction 17 (successor to SD10): before a
//     push payment settles, the sending PSP checks the payee name against the account and returns one of four
//     results (match / close_match / no_match / unavailable). Proceeding past a no-match or unavailable result is
//     the single most-cited UK APP fraud pattern, and under the PSR's reimbursement rules it is exactly the fact
//     pattern that can forfeit the payer's own reimbursement protection (the "consumer standard of caution"
//     carve-out). An agent cannot weigh that risk on the payer's behalf, so it is a human decision here, every time.
//   - APP fraud reimbursement (PSR PS23/4 and PS24/4, in force from 7 October 2024; cap reduced to GBP 85,000,
//     aligned to the FSCS limit, under the PSR's 2025 policy update): sending and receiving PSPs split
//     reimbursement 50:50, subject to a GBP 100 claim excess (waived for vulnerable customers), for claims up to
//     the cap. Above the cap there is no reimbursement backstop at all — which is exactly why this module treats
//     "above the cap" as its own, separate reason to require a human's sign-off, distinct from any ordinary cap.
//
// What it is NOT: it does not initiate, collect or settle a Faster Payments transaction, is not a PSP, and claims
// no PSR/FCA authorisation. Currency is GBP end to end.

export const APP_REIMBURSEMENT_CAP_GBP = 85000;
export const APP_CLAIM_EXCESS_GBP = 100;
export const COP_RESULTS = ["match", "close_match", "no_match", "unavailable"];

const SORT_CODE = /^[0-9]{6}$/;
const ACCOUNT_NUMBER = /^[0-9]{8}$/;

const fail = (code, reason, suggestion) => ({ decision: "deny", code, reason, suggestion });
const needsHuman = (code, reason) => ({ decision: "requires_approval", code, reason, authorisation: { required: true, by: "human" } });

// The account number is personal/financial data (UK GDPR + Data Protection Act 2018): decisions and logs carry a
// masked form, never the raw account number.
export function maskAccountNumber(accountNumber) {
  if (typeof accountNumber !== "string" || accountNumber.length < 4) return null;
  return `****${accountNumber.slice(-4)}`;
}

// Pure and deterministic. policy = the `uk` section of the policy file ({ maxPerTxnGBP, maxPerDayGBP,
// allowedPayeeAccounts, allowedCategories, reimbursementCapGBP }); spentTodayGBP is the evaluator's own tally.
export function evaluateUkPushPayment(payment, { policy = {}, spentTodayGBP = 0, now = Date.now() } = {}) {
  if (!payment || typeof payment !== "object") return fail("payment_missing", "no push payment supplied", "send the payment the agent wants to make");
  const amount = Number(payment.amountGBP);
  if (!(amount > 0) || Math.round(amount * 100) / 100 !== amount) {
    return fail("amount_invalid", "amountGBP must be a positive sterling amount with at most 2 decimals (pence)", "send the payment amount in GBP, e.g. 49.99");
  }
  if (!SORT_CODE.test(payment.payeeSortCode || "")) return fail("payee_details_invalid", "payeeSortCode must be a 6-digit UK sort code", "send the payee's 6-digit sort code");
  if (!ACCOUNT_NUMBER.test(payment.payeeAccountNumber || "")) return fail("payee_details_invalid", "payeeAccountNumber must be an 8-digit UK account number", "send the payee's 8-digit account number");

  // Withdrawal/cancellation is absolute — a payment instruction pulled before SpendVeto governs it goes nowhere.
  if (payment.revoked) return fail("payment_revoked", "this payment instruction was withdrawn before it was governed", "stop — a withdrawn instruction cannot be paid");
  if (payment.expiresAt && Date.parse(payment.expiresAt) < now) return fail("payment_expired", `payment instruction expired at ${payment.expiresAt}`, "ask for a fresh instruction");

  const category = payment.category || null;
  const payeeKey = `${payment.payeeSortCode}:${payment.payeeAccountNumber}`;
  if (Array.isArray(policy.allowedPayeeAccounts) && policy.allowedPayeeAccounts.length && !policy.allowedPayeeAccounts.includes(payeeKey)) {
    return fail("payee_not_allowed", "this payee account is not on the allowlist", "pay only allowlisted payees, or add this one to policy.uk.allowedPayeeAccounts");
  }
  if (Array.isArray(policy.allowedCategories) && policy.allowedCategories.length && !policy.allowedCategories.includes(category)) {
    return fail("category_not_allowed", `category "${category}" is outside the allowed categories`, "pay only inside allowed categories");
  }

  if (Number(policy.maxPerTxnGBP) > 0 && amount > Number(policy.maxPerTxnGBP)) {
    return fail("txn_cap", `GBP ${amount} exceeds the per-payment cap of GBP ${policy.maxPerTxnGBP}`, "pay a smaller amount or raise policy.uk.maxPerTxnGBP");
  }
  if (Number(policy.maxPerDayGBP) > 0 && spentTodayGBP + amount > Number(policy.maxPerDayGBP)) {
    return fail("day_cap", `GBP ${amount} would take today's total to GBP ${spentTodayGBP + amount}, over the GBP ${policy.maxPerDayGBP} daily cap`, "wait for the daily window or raise policy.uk.maxPerDayGBP");
  }

  // Confirmation of Payee: the agent cannot weigh a mismatched or unverifiable payee name against its own instructions.
  const cop = payment.copResult;
  if (!COP_RESULTS.includes(cop)) return fail("cop_result_missing", "no Confirmation of Payee result on record for this payee", "run Confirmation of Payee before asking SpendVeto to govern the payment");
  if (cop === "no_match") return needsHuman("cop_no_match", "Confirmation of Payee could not match this payee's name to the account — proceeding past a clear no-match warning can forfeit APP fraud reimbursement protection");
  if (cop === "unavailable") return needsHuman("cop_unavailable", "Confirmation of Payee could not check this payee at all (timeout, opt-out, or the account may not exist)");
  if (cop === "close_match") return needsHuman("cop_close_match", "Confirmation of Payee found a similar but not exact name match — the payer should confirm the corrected name before this pays");

  if (payment.firstPaymentToPayee) return needsHuman("new_payee_review", "first payment ever made to this payee — new-payee review is the PSR's own highest-signal control against APP fraud");

  const cap = Number(policy.reimbursementCapGBP) > 0 ? Number(policy.reimbursementCapGBP) : APP_REIMBURSEMENT_CAP_GBP;
  if (amount > cap) return needsHuman("app_fraud_uncapped_exposure", `GBP ${amount} is above the GBP ${cap} APP fraud reimbursement cap — above this, there is no reimbursement backstop at all if this turns out to be fraud`);

  return { decision: "allow", reason: "Confirmation of Payee matched, payee previously paid, and within the APP fraud reimbursement cap" };
}

export const UK_REGULATORY_BASIS = [
  "PSR Specific Direction 17 (Confirmation of Payee, successor to SD10): match / close_match / no_match / unavailable results checked before a push payment proceeds",
  "PSR PS23/4 + PS24/4 Authorised Push Payment (APP) fraud reimbursement requirement, in force 7 October 2024: mandatory reimbursement on Faster Payments and CHAPS, cap reduced to GBP 85,000 (aligned to the FSCS limit) under the PSR's 2025 policy update, GBP 100 claim excess (waived for vulnerable customers), 50:50 cost split between sending and receiving PSPs",
];

export const UK_DISCLAIMER =
  "Evaluator only: SpendVeto does not initiate, collect or settle Faster Payments transactions, is not a PSP, and claims no PSR/FCA authorisation. 'Requires approval' means the payer makes the call themselves — on a Confirmation of Payee mismatch, a new payee, or exposure above the reimbursement cap, an agent cannot weigh that risk on the payer's behalf.";
