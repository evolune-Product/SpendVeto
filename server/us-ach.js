// US payment governance (ACH / Nacha + Regulation E), buyer side.
//
// Two different kinds of control apply to an agent debiting a US bank account over ACH, and they don't both reduce
// to "ask a human":
//
//   - Nacha's WEB debit account validation supplement (effective 19 March 2021, to the existing "commercially
//     reasonable fraudulent transaction detection system" requirement for WEB-code debits): the FIRST use of a
//     payee's account number, or any change to it, must be validated (prenotification, micro-deposit, or a
//     validation service) before it's debited. This is a system control, not a consumer-authorization gate — Nacha
//     doesn't ask the consumer anything here, it asks the Originator to prove the account is real. So an
//     unvalidated first-use account is a DENY, not a pause for a human.
//   - Regulation E (12 CFR 1005, implementing the EFTA): a preauthorized recurring debit needs the consumer's
//     written (or similarly authenticated) authorization on file; if the debit amount varies from the amount
//     previously authorized, the payee must have notified the consumer at least 10 days before the scheduled date
//     (Sec. 1005.10(c)); and an oral stop-payment order is immediately binding but lapses 14 days after the oral
//     request unless the consumer confirms it in writing within that window.
//
// Same Day ACH entries are additionally capped by Nacha's own network rule at USD 1,000,000 per transaction —
// unconditionally, not something an operator's policy can raise.
//
// What it is NOT: it does not originate, collect or settle an ACH entry, is not an ODFI/RDFI or payment processor,
// and claims no Nacha or Federal Reserve authorization. Currency is USD end to end.

export const SAME_DAY_ACH_LIMIT_USD = 1_000_000;
export const REG_E_VARIABLE_AMOUNT_NOTICE_DAYS = 10;
export const REG_E_STOP_PAYMENT_WRITTEN_CONFIRM_DAYS = 14;

const ROUTING_NUMBER = /^[0-9]{9}$/;
const ACCOUNT_NUMBER = /^[0-9]{4,17}$/;

const fail = (code, reason, suggestion) => ({ decision: "deny", code, reason, suggestion });
const needsHuman = (code, reason) => ({ decision: "requires_approval", code, reason, authorization: { required: true, by: "human" } });

// Account number is nonpublic personal information under the Gramm-Leach-Bliley Act: decisions and logs carry a
// masked form, never the raw account number.
export function maskAccountNumber(accountNumber) {
  if (typeof accountNumber !== "string" || accountNumber.length < 4) return null;
  return `****${accountNumber.slice(-4)}`;
}

// Pure and deterministic. policy = the `us` section of the policy file ({ maxPerTxnUSD, maxPerDayUSD,
// allowedPayeeAccounts, allowedCategories }).
export function evaluateAchDebit(mandate, { policy = {}, spentTodayUSD = 0, now = Date.now() } = {}) {
  if (!mandate || typeof mandate !== "object") return fail("mandate_missing", "no ACH debit authorization supplied", "send the debit the agent wants to initiate");
  const amount = Number(mandate.amountUSD);
  if (!(amount > 0) || Math.round(amount * 100) / 100 !== amount) {
    return fail("amount_invalid", "amountUSD must be a positive dollar amount with at most 2 decimals (cents)", "send the debit amount in USD, e.g. 19.99");
  }
  if (!ROUTING_NUMBER.test(mandate.payeeRoutingNumber || "")) return fail("payee_details_invalid", "payeeRoutingNumber must be a 9-digit ABA routing number", "send the payee bank's 9-digit routing number");
  if (!ACCOUNT_NUMBER.test(mandate.payeeAccountNumber || "")) return fail("payee_details_invalid", "payeeAccountNumber must be a valid account number", "send the payee's account number");

  // The consumer's stop-payment and revocation rights are absolute and checked before anything else.
  if (mandate.stopPaymentRequested) {
    const confirmedInWriting = mandate.stopPaymentConfirmedInWriting === true;
    const requestedAt = mandate.stopPaymentRequestedAt ? Date.parse(mandate.stopPaymentRequestedAt) : now;
    const withinOralWindow = !confirmedInWriting && now - requestedAt < REG_E_STOP_PAYMENT_WRITTEN_CONFIRM_DAYS * 24 * 60 * 60 * 1000;
    if (confirmedInWriting || withinOralWindow) {
      return fail("reg_e_stop_payment", "the consumer requested a stop-payment on this preauthorized transfer (Reg E Sec. 1005.10(c))", "stop — do not resubmit this debit; a new authorization is required to resume");
    }
  }
  if (mandate.revoked) return fail("authorization_revoked", "the consumer withdrew this preauthorization", "stop — a revoked authorization cannot be debited; ask the consumer to authorize a new one");
  if (mandate.expiresAt && Date.parse(mandate.expiresAt) < now) return fail("authorization_expired", `authorization expired at ${mandate.expiresAt}`, "ask the consumer to renew the authorization");

  if (mandate.sameDay && amount > SAME_DAY_ACH_LIMIT_USD) {
    return fail("same_day_ach_limit_exceeded", `USD ${amount} exceeds Nacha's Same Day ACH per-entry limit of USD ${SAME_DAY_ACH_LIMIT_USD.toLocaleString("en-US")}`, "split the entry, settle it next-day instead of same-day, or use a different rail for this amount");
  }

  if (!mandate.accountValidated) {
    return fail("web_debit_account_validation_required", "this is the first use of this account number (or it changed) and has no account validation on record", "validate the account first (prenotification, micro-deposit, or a validation service) per Nacha's WEB debit account validation rule, then resubmit with accountValidated: true");
  }

  const category = mandate.category || null;
  const payeeKey = `${mandate.payeeRoutingNumber}:${mandate.payeeAccountNumber}`;
  if (Array.isArray(policy.allowedPayeeAccounts) && policy.allowedPayeeAccounts.length && !policy.allowedPayeeAccounts.includes(payeeKey)) {
    return fail("payee_not_allowed", "this payee account is not on the allowlist", "debit only allowlisted payees, or add this one to policy.us.allowedPayeeAccounts");
  }
  if (Array.isArray(policy.allowedCategories) && policy.allowedCategories.length && !policy.allowedCategories.includes(category)) {
    return fail("category_not_allowed", `category "${category}" is outside the allowed categories`, "debit only inside allowed categories");
  }

  if (Number(policy.maxPerTxnUSD) > 0 && amount > Number(policy.maxPerTxnUSD)) {
    return fail("txn_cap", `USD ${amount} exceeds the per-debit cap of USD ${policy.maxPerTxnUSD}`, "debit a smaller amount or raise policy.us.maxPerTxnUSD");
  }
  if (Number(policy.maxPerDayUSD) > 0 && spentTodayUSD + amount > Number(policy.maxPerDayUSD)) {
    return fail("day_cap", `USD ${amount} would take today's total to USD ${spentTodayUSD + amount}, over the USD ${policy.maxPerDayUSD} daily cap`, "wait for the daily window or raise policy.us.maxPerDayUSD");
  }

  // Authentication: the consumer's own preauthorization, written or similarly authenticated.
  if (!mandate.authorizationOnRecord) {
    return needsHuman("reg_e_authorization_missing", "no written (or similarly authenticated) preauthorization on record for this recurring debit (Reg E Sec. 1005.10(b)) — the consumer must authorize it themselves");
  }
  if (mandate.amountVariesFromAuthorized) {
    if (!mandate.varianceNoticeAt) {
      return needsHuman("reg_e_variable_amount_notice", `this debit's amount varies from what the consumer authorized — Reg E requires at least ${REG_E_VARIABLE_AMOUNT_NOTICE_DAYS} days' notice before a varying-amount debit, and none is on record`);
    }
    const debitAt = mandate.debitAt ? Date.parse(mandate.debitAt) : now;
    if (debitAt - Date.parse(mandate.varianceNoticeAt) < REG_E_VARIABLE_AMOUNT_NOTICE_DAYS * 24 * 60 * 60 * 1000) {
      return needsHuman("reg_e_variable_amount_notice", `the consumer was notified less than ${REG_E_VARIABLE_AMOUNT_NOTICE_DAYS} days before this varying-amount debit`);
    }
  }

  return { decision: "allow", reason: "account validated, authorization on record, and within Nacha/Reg E rules and operator policy" };
}

export const US_REGULATORY_BASIS = [
  "Nacha Operating Rules — WEB debit account validation supplement (effective 19 March 2021): first use of an account number, or any change to it, must be validated before debiting; Same Day ACH per-entry limit of USD 1,000,000",
  "Regulation E / EFTA (12 CFR 1005.10): written or similarly authenticated preauthorization required for recurring debits; at least 10 days' notice for a varying debit amount; a consumer's oral stop-payment order is binding for 14 days unless confirmed in writing",
];

export const US_DISCLAIMER =
  "Evaluator only: SpendVeto does not originate, collect or settle ACH entries, is not an ODFI/RDFI or payment processor, and claims no Nacha or Federal Reserve authorization. Account validation is a system control, not a human-authorization step; 'requires_approval' is reserved for the consumer's own authorization and notice rights under Regulation E.";
