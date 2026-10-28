import "../styles/pages.css";
import "./uk.css";
import Page from "../components/Page.jsx";
import Island from "../components/Island.jsx";
import { FpsEvaluator } from "../islands/RegionEvaluator.jsx";

export const head = {
  "title": "UK Agent Payments Governance — Confirmation of Payee + APP Fraud Reimbursement | SpendVeto",
  "description": "Deterministic governance for AI-agent Faster Payments push payments — Confirmation of Payee results and the PSR's APP fraud reimbursement cap. Agents cannot weigh a no-match payee. Evaluator only.",
  "path": "/uk",
  "ogDescription": "Deterministic governance for AI-agent Faster Payments push payments — Confirmation of Payee + the PSR's APP fraud reimbursement cap. Evaluator only."
};

// Behaviour lives in uk.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

export default function UkPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="pg">
        <h1>UK agent payments, governed — Confirmation of Payee, every time.</h1>
        <p className="lede">
          Faster Payments has no recurring-pull equivalent — an agent paying in the UK PUSHES money to a payee it names, once. That's exactly the fact pattern UK Authorised Push Payment fraud exists for. SpendVeto checks the Confirmation of Payee result and the reimbursement exposure before the agent can proceed, and an agent can never wave through a no-match on its own.
        </p>
        <div className="regions">
          <a href="/upi">India · UPI</a>
          {" "}
          <a href="/eu">EU · SCA</a>
          {" "}
          <a href="/uk" className="here">UK · Faster Payments</a>
          {" "}
          <a href="/br">Brazil · Pix</a>
          {" "}
          <a href="/us">US · ACH</a>
        </div>
        <h2>What's real, with sources</h2>
        <div className="card">
          <b>Confirmation of Payee</b>
          {" "}(Payment Systems Regulator Specific Direction 17, successor to SD10): before a push payment settles, the sending PSP checks the payee name against the account and returns{" "}
          <code>match</code>
          ,{" "}
          <code>close_match</code>
          ,{" "}
          <code>no_match</code>
          , or{" "}
          <code>unavailable</code>
          . Proceeding past a no-match or unavailable result is the single most-cited UK APP fraud pattern.{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://www.ukfinance.org.uk/policy-and-guidance/guidance/confirmation-payee" target="_blank" rel="noopener">
              UK Finance — Confirmation of Payee
            </a>
            {" "}·{" "}
            <a href="https://www.psr.org.uk/media/vnunbnuf/psr-ps194-sd10-confirmation-of-payee.pdf" target="_blank" rel="noopener">
              PSR — Specific Direction 10/17
            </a>
          </p>
        </div>
        <div className="card">
          <b>APP fraud reimbursement</b>
          {" "}(PSR PS23/4 + PS24/4, in force 7 October 2024): mandatory reimbursement on Faster Payments and CHAPS, cap reduced to{" "}
          <b>£85,000</b>
          {" "}(aligned to the FSCS limit) under the PSR's 2025 policy update, a £100 claim excess (waived for vulnerable customers), 50:50 cost split between sending and receiving PSPs. Above the cap, there is no reimbursement backstop at all.{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://www.hlc.com/en/publications/app-fraud-uk-psr-confirms-introduction-of-world-first-reimbursement-requirement" target="_blank" rel="noopener">
              Hogan Lovells — APP fraud reimbursement
            </a>
            {" "}·{" "}
            <a href="https://cityam.com/?p=2093991" target="_blank" rel="noopener">City AM — reimbursement cap</a>
          </p>
        </div>
        <h2>Try the rules</h2>
        <p>
          This runs SpendVeto's actual UK evaluator in your browser — the same file the server uses. Change a payment and watch the verdict.
        </p>
        <Island name="evaluator" component={FpsEvaluator} />
        <div className="card warn">
          <b>What this is not.</b>
          {" "}SpendVeto{" "}
          <b>does not initiate, collect or settle</b>
          {" "}any Faster Payments transaction, is not a PSP, and claims no PSR/FCA authorisation. "Requires approval" means the{" "}
          <b>payer makes the call themselves</b>
          {" "}— on a Confirmation of Payee mismatch, a new payee, or exposure above the reimbursement cap, an agent cannot weigh that risk on the payer's behalf. Payee account numbers are masked in every decision (UK GDPR / DPA 2018). Self-hosting keeps all data on your own infrastructure, in the region you choose.
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/ai-spend">AI spend quickstart</a>
        </div>
      </div>
    </Page>
  );
}
