import "../styles/pages.css";
import "./eu.css";
import Page from "../components/Page.jsx";
import Island from "../components/Island.jsx";
import { SepaEvaluator } from "../islands/RegionEvaluator.jsx";

export const head = {
  "title": "EU Agent Payments Governance — PSD2 Strong Customer Authentication | SpendVeto",
  "description": "Deterministic governance for AI-agent SEPA Direct Debit mandates using PSD2's own Strong Customer Authentication exemption math — Art. 10, Art. 14(1), Art. 18 TRA. Agents cannot supply SCA. Evaluator only.",
  "path": "/eu",
  "ogDescription": "Deterministic governance for AI-agent SEPA Direct Debit mandates using PSD2's own SCA exemption math. Agents cannot supply SCA. Evaluator only."
};

// Behaviour lives in eu.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

export default function EuPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="pg">
        <h1>EU agent payments, governed — against PSD2's own exemption math.</h1>
        <p className="lede">
          An AI agent cannot supply Strong Customer Authentication — it is, by definition, something the payer knows, has, or is. SpendVeto decides whether an agent's SEPA Direct Debit mandate debit may proceed, using the exact exemption mechanics the RTS itself defines, and pauses for the payer whenever none of them apply.
        </p>
        <div className="regions">
          <a href="/upi">India · UPI</a>
          {" "}
          <a href="/eu" className="here">EU · SCA</a>
          {" "}
          <a href="/uk">UK · Faster Payments</a>
          {" "}
          <a href="/br">Brazil · Pix</a>
          {" "}
          <a href="/us">US · ACH</a>
        </div>
        <h2>What's real, with sources</h2>
        <div className="card">
          <b>Commission Delegated Regulation (EU) 2018/389</b>
          {" "}— the RTS on Strong Customer Authentication under PSD2. Three exemptions, each scoped exactly as the regulation defines it:{" "}
          <b>Art. 10</b>
          {" "}— a one-off remote payment skips SCA up to €30 per transaction, €100 cumulative since the last SCA, or 5 consecutive transactions.{" "}
          <b>Art. 14(1)</b>
          {" "}— a recurring series of the SAME FIXED amount to the SAME payee needs SCA only once; a changed amount voids the exemption.{" "}
          <b>Art. 18 (TRA)</b>
          {" "}— a PSP with a low enough reference fraud rate may waive SCA up to €100 / €250 / €500, depending on its own declared rate.{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32018R0389" target="_blank" rel="noopener">
              EUR-Lex — Regulation (EU) 2018/389
            </a>
            {" "}·{" "}
            <a href="https://freenance.io/fintech/psd2-strong-customer-authentication-eu-2026-sca-3ds-2-explained-exemptions-tra-30-euro-guide/" target="_blank" rel="noopener">
              Freenance 2026 SCA/TRA guide
            </a>
          </p>
        </div>
        <div className="card">
          <b>SEPA Direct Debit Core Rulebook</b>
          {" "}(European Payments Council): the creditor must notify the payer at least 14 calendar days before each collection, unless a shorter period is agreed. The payer has an 8-week no-questions-asked refund right on an authorised debit (13 months if unauthorised).{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://www.europeanpaymentscouncil.eu/document-library/rulebooks/sepa-direct-debit-core-rulebook" target="_blank" rel="noopener">
              European Payments Council — SDD Core Rulebook
            </a>
          </p>
        </div>
        <h2>Try the rules</h2>
        <p>
          This runs SpendVeto's actual EU evaluator in your browser — the same file the server uses. Change a mandate and watch the verdict.
        </p>
        <Island name="evaluator" component={SepaEvaluator} />
        <div className="card warn">
          <b>What this is not.</b>
          {" "}SpendVeto{" "}
          <b>does not initiate, collect or settle</b>
          {" "}any SEPA payment, is not a PSP/PISP under PSD2, and claims no competent-authority authorisation. "Requires approval" means the{" "}
          <b>payer completes Strong Customer Authentication themselves</b>
          . Article 18 TRA eligibility depends on the operator's own declared, accurate fraud rate — verify it against the current RTS text before production. Creditor IBANs are masked in every decision (GDPR Art. 5(1)(c) data minimisation). Self-hosting keeps all data on your own infrastructure, in the region you choose.
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/ai-spend">AI spend quickstart</a>
        </div>
      </div>
    </Page>
  );
}
