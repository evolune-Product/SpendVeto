import "../styles/pages.css";
import "./upi.css";
import Page from "../components/Page.jsx";
import Island from "../components/Island.jsx";
import { UpiEvaluator } from "../islands/RegionEvaluator.jsx";

export const head = {
  "title": "UPI Agent Payments Governance — RBI E-mandate Rules | SpendVeto",
  "description": "Deterministic governance for AI-agent UPI mandate debits using the RBI e-mandate framework thresholds. Humans authenticate; agents cannot approve themselves. Evaluator only.",
  "path": "/upi"
};

// Behaviour lives in upi.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

export default function UpiPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="pg">
        <h1>UPI agent payments, governed — deterministically.</h1>
        <p className="lede">
          India is building the rails for AI agents to pay on UPI. NPCI's position is clear:{" "}
          <em>
            "AI may recommend, but authentication and final settlement must follow deterministic auditable rules."
          </em>
          {" "}SpendVeto is that rule layer. It decides whether an agent's UPI mandate debit may proceed — using the RBI e-mandate framework's own thresholds — and the agent can never approve itself.
        </p>
        <div className="regions">
          <a href="/upi" className="here">India · UPI</a>
          {" "}
          <a href="/eu">EU · SCA</a>
          {" "}
          <a href="/uk">UK · Faster Payments</a>
          {" "}
          <a href="/br">Brazil · Pix</a>
          {" "}
          <a href="/us">US · ACH</a>
        </div>
        <h2>What's real, with sources</h2>
        <div className="card">
          <b>RBI Digital Payments E-mandate Framework, 2026</b>
          {" "}(issued 21 April 2026; cards, PPIs and UPI): additional-factor authentication at registration and first debit; recurring debits need no further authentication up to ₹15,000 (₹1,00,000 for insurance, mutual funds and credit-card bills); customers are notified at least 24 hours before each debit; mandates can be withdrawn.{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://economiclawspractice.com/new-rbi-rules-2026-complete-guide-to-digital-payments-e-mandate-framework-for-cards-upi-ppis/" target="_blank" rel="noopener">
              Economic Law Practice summary
            </a>
            {" "}·{" "}
            <a href="https://razorpay.com/blog/upi-autopay-vs-card-e-mandates/" target="_blank" rel="noopener">
              Razorpay
            </a>
          </p>
        </div>
        <div className="card">
          <b>NPCI's Unified Agent Protocol</b>
          {" "}is in development — agents would be registered, verified and given scoped, limited authority, building on UPI Circle. It needs RBI approval before launch. NPCI's chairman, at GFF 2026:{" "}
          <em>"Decision making and execution must remain separate."</em>
          <p className="src">
            Sources:{" "}
            <a href="https://www.medianama.com/2026/09/223-npci-ai-agents-upi-payments/" target="_blank" rel="noopener">
              MediaNama
            </a>
            {" "}·{" "}
            <a href="https://www.businessworld.in/article/india-eyes-ai-powered-upi-payments-as-npci-develops-protocol-for-agentic-transactions-613952" target="_blank" rel="noopener">
              BW Businessworld
            </a>
          </p>
        </div>
        <h2>Try the rules</h2>
        <p>
          This runs SpendVeto's actual UPI evaluator in your browser — the same file the server uses. Change a mandate and watch the verdict.
        </p>
        <Island name="evaluator" component={UpiEvaluator} />
        <div className="card warn">
          <b>What this is not.</b>
          {" "}SpendVeto{" "}
          <b>does not initiate, collect or settle</b>
          {" "}any UPI payment, is not a payment aggregator or PSP, and claims no NPCI or RBI approval or certification. "Requires approval" means a{" "}
          <b>human completes the customer's authentication</b>
          . The UPI settlement rail is a declared, refusing slot until NPCI's agent protocol is live and RBI-cleared. Thresholds are the framework's published defaults — verify them against the RBI text before production. Payee VPAs are masked in every decision (data minimisation under the DPDP Act, 2023). Self-hosting keeps all data on your own infrastructure, in the region you choose.
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/ai-spend">AI spend quickstart</a>
        </div>
      </div>
    </Page>
  );
}
