import "../styles/pages.css";
import "./us.css";
import Page from "../components/Page.jsx";
import Island from "../components/Island.jsx";
import { AchEvaluator } from "../islands/RegionEvaluator.jsx";

export const head = {
  "title": "US Agent Payments Governance — Nacha WEB Debit + Regulation E | SpendVeto",
  "description": "Deterministic governance for AI-agent ACH debits — Nacha's WEB debit account validation (a system fraud gate) and Regulation E's consumer authorization rights. Evaluator only.",
  "path": "/us",
  "ogDescription": "Deterministic governance for AI-agent ACH debits — Nacha WEB debit account validation + Regulation E consumer rights. Evaluator only."
};

// Behaviour lives in us.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

export default function UsPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="pg">
        <h1>US agent payments, governed — two different rules, not one.</h1>
        <p className="lede">
          An unvalidated bank account is a Nacha system problem — a flat refusal, not a question for a human. A missing consumer authorization is a Regulation E problem — exactly the kind of decision only the consumer can make. SpendVeto keeps them separate, the way the rules actually do.
        </p>
        <div className="regions">
          <a href="/upi">India · UPI</a>
          {" "}
          <a href="/eu">EU · SCA</a>
          {" "}
          <a href="/uk">UK · Faster Payments</a>
          {" "}
          <a href="/br">Brazil · Pix</a>
          {" "}
          <a href="/us" className="here">US · ACH</a>
        </div>
        <h2>What's real, with sources</h2>
        <div className="card">
          <b>Nacha WEB debit account validation</b>
          {" "}(effective 19 March 2021): the FIRST use of a payee's account number, or any change to it, must be validated (prenotification, micro-deposit, or a validation service) before it's debited — a system control for fraud detection, not a consumer-authorization step. Same Day ACH entries are additionally capped at{" "}
          <b>USD 1,000,000</b>
          {" "}per transaction, unconditionally.{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://www.nacha.org/rules/supplementing-fraud-detection-standards-web-debits" target="_blank" rel="noopener">
              Nacha — WEB debit account validation rule
            </a>
          </p>
        </div>
        <div className="card">
          <b>Regulation E</b>
          {" "}(12 CFR 1005, implementing the EFTA): a preauthorized recurring debit needs the consumer's written (or similarly authenticated) authorization on file; a varying debit amount needs at least 10 days' notice; a consumer's oral stop-payment order is immediately binding and lapses 14 days after the request unless confirmed in writing.{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://www.federalreserve.gov/supervisionreg/regecg.htm" target="_blank" rel="noopener">
              Federal Reserve — Regulation E compliance guide
            </a>
          </p>
        </div>
        <h2>Try the rules</h2>
        <p>
          This runs SpendVeto's actual US evaluator in your browser — the same file the server uses. Change a debit and watch the verdict.
        </p>
        <Island name="evaluator" component={AchEvaluator} />
        <div className="card warn">
          <b>What this is not.</b>
          {" "}SpendVeto{" "}
          <b>does not originate, collect or settle</b>
          {" "}any ACH entry, is not an ODFI/RDFI or payment processor, and claims no Nacha or Federal Reserve authorization. An unvalidated account is a hard{" "}
          <b>DENY</b>
          , not a pause — Nacha's rule is a system control, not a human-authorization gate. "Requires approval" is reserved for the consumer's own authorization and notice rights under Regulation E. Account numbers are masked in every decision (GLBA nonpublic personal information). Self-hosting keeps all data on your own infrastructure, in the region you choose.
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/ai-spend">AI spend quickstart</a>
        </div>
      </div>
    </Page>
  );
}
