import "../styles/pages.css";
import "./br.css";
import Page from "../components/Page.jsx";
import Island from "../components/Island.jsx";
import { PixEvaluator } from "../islands/RegionEvaluator.jsx";

export const head = {
  "title": "Brazil Agent Payments Governance — Pix Nighttime Limit + Pix Automático | SpendVeto",
  "description": "Deterministic governance for AI-agent Pix payments — the BCB nighttime transfer limit and Pix Automático's scheduling/retry rules. Agents cannot raise their own limit. Evaluator only.",
  "path": "/br",
  "ogDescription": "Deterministic governance for AI-agent Pix payments — the BCB nighttime limit and Pix Automático's scheduling/retry rules. Evaluator only."
};

// Behaviour lives in br.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

export default function BrPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="pg">
        <h1>Brazil agent payments, governed — day and night.</h1>
        <p className="lede">
          Every Pix-enabled account defaults to a BRL 1,000 ceiling overnight, and Pix Automático — Brazil's recurring-Pix scheme, mandatory since October 2025 — runs on its own BCB scheduling and retry rules. SpendVeto enforces both, and an agent can never raise its own nighttime limit or authorise its own recurring mandate.
        </p>
        <div className="regions">
          <a href="/upi">India · UPI</a>
          {" "}
          <a href="/eu">EU · SCA</a>
          {" "}
          <a href="/uk">UK · Faster Payments</a>
          {" "}
          <a href="/br" className="here">Brazil · Pix</a>
          {" "}
          <a href="/us">US · ACH</a>
        </div>
        <h2>What's real, with sources</h2>
        <div className="card">
          <b>Nighttime limit ("horário noturno")</b>
          : every Pix-enabled account defaults to a{" "}
          <b>BRL 1,000</b>
          {" "}ceiling on transfers made during the customer's chosen nighttime window (20:00–06:00 by default, or 22:00–06:00) — raising it requires a minimum 24-hour cooling-off period the institution must enforce.{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://tecnoblog.net/534093/banco-central-muda-faixa-horario-periodo-noturno-transfererencias-pix/" target="_blank" rel="noopener">
              Tecnoblog — BC nighttime window rules
            </a>
          </p>
        </div>
        <div className="card">
          <b>Pix Automático</b>
          {" "}(BCB's recurring-Pix scheme, mandatory for payer-side institutions since October 2025): the payer authorises once, in their own banking app; a business then pulls against it under BCB's own rules — each charge created 2–10 days before its due date, at most 3 charge attempts (including dunning retries) in any rolling 7-day window. Cancellation takes effect only once BCB confirms it.{" "}
          <p className="src">
            Sources:{" "}
            <a href="https://juspay.io/en-br/blog/pix-automatico-vs-recurring-cards-vs-debito-em-conta" target="_blank" rel="noopener">
              Juspay — Pix Automático rules
            </a>
          </p>
        </div>
        <h2>Try the rules</h2>
        <p>
          This runs SpendVeto's actual Brazil evaluator in your browser — the same file the server uses. Change a payment and watch the verdict.
        </p>
        <Island name="evaluator" component={PixEvaluator} />
        <div className="card warn">
          <b>What this is not.</b>
          {" "}SpendVeto{" "}
          <b>does not initiate, collect or settle</b>
          {" "}any Pix payment, is not a Pix participant (PSP), and claims no BCB authorisation. "Requires approval" means the{" "}
          <b>payer acts in their own banking app</b>
          {" "}— an agent cannot raise its own nighttime limit or authorise its own Pix Automático mandate. MED (Mecanismo Especial de Devolução) is a post-hoc dispute process, not something this evaluator can invoke. Pix keys are masked in every decision (LGPD data minimisation). Self-hosting keeps all data on your own infrastructure, in the region you choose.
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/ai-spend">AI spend quickstart</a>
        </div>
      </div>
    </Page>
  );
}
