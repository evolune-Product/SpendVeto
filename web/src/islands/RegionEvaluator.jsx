import { useEffect, useState } from "react";

// One form + verdict for every regional playground. The evaluator itself is
// the published byte-identical copy of the server's module (/assets/<file>,
// asserted by verify), loaded as-is at runtime — never bundled — so the page
// runs exactly the code the server runs.
//
// field: [id, label, type, default, options?] — type is number|text|select|check.
function RegionEvaluator({ src, fn, fields, build, who, whoLabel }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(([id, , , value]) => [id, value])));
  const [evaluate, setEvaluate] = useState(null);
  useEffect(() => {
    import(/* @vite-ignore */ new URL(src, location.href).href).then((m) => setEvaluate(() => m[fn]));
  }, [src, fn]);
  const set = (id, value) => setValues((v) => ({ ...v, [id]: value }));
  // Computed only once the module has loaded, i.e. never during the prerender.
  const v = evaluate ? evaluate(...build(values, Date.now())) : null;

  return (
    <>
      <div className="form" id="f">
        {fields.map(([id, label, type, , options]) =>
          type === "check" ? (
            <label key={id} className="chk"><input type="checkbox" id={id} checked={values[id]} onChange={(e) => set(id, e.target.checked)} /> {label}</label>
          ) : type === "select" ? (
            <label key={id}>{label}<select id={id} value={values[id]} onChange={(e) => set(id, e.target.value)}>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
          ) : (
            <label key={id}>{label}<input type={type} id={id} value={values[id]} onChange={(e) => set(id, e.target.value)} {...(type === "number" ? { min: id === "amt" ? "0.01" : "0", step: id === "amt" ? "0.01" : undefined } : {})} /></label>
          ),
        )}
      </div>
      <div className="verdict" id="out">
        {v && (
          <>
            <span className={`badge b-${v.decision}`}>{v.decision.replace("_", " ")}</span>
            {v.code && <> <code>{v.code}</code></>}
            <p>{v.reason}</p>
            {v.suggestion && <p><b>Fix:</b> {v.suggestion}</p>}
            <p><b>{whoLabel}:</b> {who(v)}</p>
          </>
        )}
      </div>
    </>
  );
}

const iso = (t) => new Date(t).toISOString();
const opt = (...values) => values.map((v) => (Array.isArray(v) ? v : [v, v]));

const UPI = {
  src: "/assets/upi.js", fn: "evaluateUpiMandate", whoLabel: "Authentication",
  fields: [
    ["amt", "Amount (₹)", "number", "499"],
    ["cat", "Category", "select", "entertainment", opt("entertainment", "insurance", ["mutual_fund", "mutual fund"], ["credit_card_bill", "credit card bill"], ["fastag", "FASTag"], "groceries")],
    ["vpa", "Payee VPA", "text", "netflix@okhdfc"],
    ["notice", "Customer notified (hours before debit)", "number", "30"],
    ["rec", "Recurring mandate", "check", true],
    ["first", "First debit of this mandate", "check", false],
    ["rev", "Customer withdrew the mandate", "check", false],
    ["pol", "Operator policy: cap ₹1,000/debit, allowlist netflix only", "check", false],
  ],
  build: (f, now) => [
    { id: "demo", payeeVpa: f.vpa.trim(), category: f.cat, amountINR: Number(f.amt), recurring: f.rec, firstDebit: f.first, revoked: f.rev, debitAt: iso(now), notifiedAt: iso(now - Number(f.notice) * 3600e3) },
    { policy: f.pol ? { maxPerTxnINR: 1000, allowedPayeeVpas: ["netflix@okhdfc"] } : {}, now },
  ],
  who: (v) => (v.afa ? "A human completes the customer's authentication — the agent cannot." : v.decision === "allow" ? "No further authentication needed under the framework." : "Debit refused."),
};

const SEPA = {
  src: "/assets/eu-sepa.js", fn: "evaluateSepaDebit", whoLabel: "Authentication",
  fields: [
    ["amt", "Amount (€)", "number", "9.99"],
    ["cat", "Category", "select", "entertainment", opt("entertainment", "utilities", "insurance", "groceries")],
    ["iban", "Payee IBAN", "text", "DE89370400440532013000"],
    ["notice", "Payer notified (days before collection)", "number", "15"],
    ["rec", "Recurring mandate (unchecked = one-off payment)", "check", true],
    ["first", "First debit of this mandate", "check", false],
    ["changed", "Amount changed from the original mandate", "check", false],
    ["rev", "Payer withdrew the mandate", "check", false],
    ["pol", "Operator policy: cap €20/debit, allowlist this IBAN only", "check", false],
  ],
  build: (f, now) => [
    { id: "demo", payeeIban: f.iban.trim(), category: f.cat, amountEUR: Number(f.amt), recurring: f.rec, firstDebit: f.first, amountChangedFromMandate: f.changed, revoked: f.rev, debitAt: iso(now), notifiedAt: iso(now - Number(f.notice) * 24 * 3600e3) },
    { policy: f.pol ? { maxPerTxnEUR: 20, allowedPayeeIbans: [f.iban.trim().toUpperCase()] } : {}, now },
  ],
  who: (v) => (v.sca ? "The payer completes Strong Customer Authentication themselves — the agent cannot." : v.decision === "allow" ? "No further authentication needed under this exemption." : "Debit refused."),
};

const FPS = {
  src: "/assets/uk-fps.js", fn: "evaluateUkPushPayment", whoLabel: "Authorisation",
  fields: [
    ["amt", "Amount (£)", "number", "9.99"],
    ["cat", "Category", "select", "entertainment", opt("entertainment", "utilities", "rent", "groceries")],
    ["sort", "Payee sort code", "text", "123456"],
    ["acct", "Payee account number", "text", "87654321"],
    ["cop", "Confirmation of Payee result", "select", "match", opt("match", "close_match", "no_match", "unavailable")],
    ["first", "First payment ever made to this payee", "check", false],
    ["rev", "Payment instruction withdrawn", "check", false],
    ["pol", "Operator policy: cap £20/payment, allowlist this payee only", "check", false],
  ],
  build: (f, now) => [
    { id: "demo", payeeSortCode: f.sort.trim(), payeeAccountNumber: f.acct.trim(), category: f.cat, amountGBP: Number(f.amt), copResult: f.cop, firstPaymentToPayee: f.first, revoked: f.rev },
    { policy: f.pol ? { maxPerTxnGBP: 20, allowedPayeeAccounts: [`${f.sort.trim()}:${f.acct.trim()}`] } : {}, now },
  ],
  who: (v) => (v.authorisation ? "The payer makes this call themselves — the agent cannot weigh the risk." : v.decision === "allow" ? "No further sign-off needed under this result." : "Payment refused."),
};

const PIX = {
  src: "/assets/br-pix.js", fn: "evaluatePixPayment", whoLabel: "Authorisation",
  fields: [
    ["amt", "Amount (R$)", "number", "49.90"],
    ["cat", "Category", "select", "food", opt("food", "entertainment", "utilities", "groceries")],
    ["key", "Payee Pix key", "text", "contato@ifood.com.br"],
    ["night", "Simulate a nighttime transfer (20:00–06:00)", "check", false],
    ["rec", "Pix Automático (recurring authorisation)", "check", false],
    ["first", "First charge under this authorisation", "check", false],
    ["cxl", "Authorisation cancelled", "check", false],
    ["pol", "Operator policy: cap R$20/payment, allowlist this key only", "check", false],
  ],
  build: (f, realNow) => {
    // The night toggle moves "now" to 23:00 UTC today rather than waiting for it.
    const now = f.night ? new Date(iso(realNow).slice(0, 10) + "T23:00:00Z").getTime() : realNow;
    return [
      { id: "demo", payeeKey: f.key.trim(), category: f.cat, amountBRL: Number(f.amt), recurring: f.rec, firstCharge: f.first, cancelled: f.cxl },
      { policy: f.pol ? { maxPerTxnBRL: 20, allowedPayeeKeys: [f.key.trim()] } : {}, attemptsInWindow: 0, now },
    ];
  },
  who: (v) => (v.authorisation ? "The payer acts in their own banking app — the agent cannot." : v.decision === "allow" ? "No further confirmation needed under this result." : "Payment refused."),
};

const ACH = {
  src: "/assets/us-ach.js", fn: "evaluateAchDebit", whoLabel: "Note",
  fields: [
    ["amt", "Amount ($)", "number", "9.99"],
    ["cat", "Category", "select", "entertainment", opt("entertainment", "utilities", "rent", "groceries")],
    ["rtn", "Payee routing number", "text", "021000021"],
    ["acct", "Payee account number", "text", "123456789"],
    ["val", "Account validated (Nacha WEB debit rule)", "check", true],
    ["auth", "Consumer authorization on record (Reg E)", "check", true],
    ["vary", "Amount varies from what was authorized", "check", false],
    ["stop", "Consumer requested a stop-payment", "check", false],
    ["pol", "Operator policy: cap $20/debit, allowlist this account only", "check", false],
  ],
  build: (f, now) => [
    { id: "demo", payeeRoutingNumber: f.rtn.trim(), payeeAccountNumber: f.acct.trim(), category: f.cat, amountUSD: Number(f.amt), accountValidated: f.val, authorizationOnRecord: f.auth, amountVariesFromAuthorized: f.vary, stopPaymentRequested: f.stop, stopPaymentRequestedAt: iso(now) },
    { policy: f.pol ? { maxPerTxnUSD: 20, allowedPayeeAccounts: [`${f.rtn.trim()}:${f.acct.trim()}`] } : {}, now },
  ],
  who: (v) => (v.authorization ? "This is the consumer's own call under Regulation E — the agent cannot make it."
    : v.decision === "deny" && v.code === "web_debit_account_validation_required" ? "A system fraud-detection gate, not a human decision — validate the account first."
    : v.decision === "allow" ? "No further action needed." : "Debit refused."),
};

export const UpiEvaluator = () => <RegionEvaluator {...UPI} />;
export const SepaEvaluator = () => <RegionEvaluator {...SEPA} />;
export const FpsEvaluator = () => <RegionEvaluator {...FPS} />;
export const PixEvaluator = () => <RegionEvaluator {...PIX} />;
export const AchEvaluator = () => <RegionEvaluator {...ACH} />;
