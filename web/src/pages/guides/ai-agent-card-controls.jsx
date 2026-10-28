import "../../styles/pages.css";
import "./ai-agent-card-controls.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "AI Agent Virtual Card Controls: Stripe Issuing, Lithic | SpendVeto",
  "description": "Decide every agent card swipe in real time: per-authorization caps, rolling daily budgets, velocity, merchant-category blocks and a kill switch.",
  "path": "/guides/ai-agent-card-controls",
  "ogTitle": "How to control what an AI agent can buy with a virtual card",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/ai-agent-card-controls#article",
          "headline": "How to control what an AI agent can buy with a virtual card",
          "description": "Decide every agent card swipe in real time: per-authorization caps, rolling daily budgets, velocity, merchant-category blocks and a kill switch.",
          "url": "https://spendveto.com/guides/ai-agent-card-controls",
          "datePublished": "2026-10-18",
          "dateModified": "2026-10-18",
          "author": {
            "@type": "Organization",
            "@id": "https://spendveto.com/#org",
            "name": "SpendVeto"
          },
          "publisher": {
            "@type": "Organization",
            "@id": "https://spendveto.com/#org",
            "name": "SpendVeto"
          },
          "about": [
            "virtual cards",
            "Stripe Issuing",
            "Lithic",
            "agent payments"
          ],
          "proficiencyLevel": "Beginner"
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "name": "SpendVeto",
              "item": "https://spendveto.com/"
            },
            {
              "@type": "ListItem",
              "position": 2,
              "name": "Guides",
              "item": "https://spendveto.com/guides"
            },
            {
              "@type": "ListItem",
              "position": 3,
              "name": "AI agent card controls",
              "item": "https://spendveto.com/guides/ai-agent-card-controls"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to control what an AI agent can buy with a virtual card",
          "description": "Point Stripe Issuing's real-time authorization webhook (or Lithic's Auth Stream Access) at SpendVeto and every swipe on an agent's card is decided by policy: a per-authorization cap, a rolling daily budget, hourly velocity, merchant-category blocks, the kill switch and merchant reputation — answered in the provider's own format.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto"
            },
            {
              "@type": "HowToTool",
              "name": "Stripe Issuing or Lithic"
            }
          ],
          "step": [
            {
              "@type": "HowToStep",
              "position": 1,
              "name": "Configure the webhook",
              "text": "Stripe: POST /api/cards/stripe/authorization with STRIPE_ISSUING_WEBHOOK_SECRET. Lithic: POST /api/cards/lithic/asa with LITHIC_ASA_SECRET."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Register the card",
              "text": "POST /api/cards { cardId, label, child?, tags? } ties a card to an agent (and optionally a delegated budget)."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Set card policy",
              "text": "policy.cards: maxAuthorizationUSD, dailyBudgetUSD, maxAuthorizationsPerHour, blockedMccs, allowedMccs."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Freeze when needed",
              "text": "Freezing the agent declines every authorization on its card."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "Can I give an AI agent a virtual card safely?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes, if every authorization is decided by policy in real time: caps, a rolling budget, velocity, merchant-category blocks and a kill switch. Stripe Issuing and Lithic both let a webhook approve or decline each swipe."
              }
            },
            {
              "@type": "Question",
              "name": "What does the agent's card do when the budget is used up?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "The next authorization is declined in the issuer's own format, with the SpendVeto code in the decision metadata."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function AiAgentCardControlsPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs"><a href="/">SpendVeto</a> / <a href="/guides">Guides</a> / AI agent card controls</p>
        <h1>How to control what an AI agent can buy with a virtual card</h1>
        <p className="answer">
          Point Stripe Issuing's real-time authorization webhook (or Lithic's Auth Stream Access) at SpendVeto and every swipe on an agent's card is decided by policy: a per-authorization cap, a rolling daily budget, hourly velocity, merchant-category blocks, the kill switch and merchant reputation — answered in the provider's own format.
        </p>
        <h2>Defaults</h2>
        <table className="t">
          <tbody>
            <tr><th>Control</th><th>Default</th></tr>
            <tr><td>Per authorization</td><td>$500</td></tr>
            <tr><td>Rolling 24-hour budget per card</td><td>$1,000</td></tr>
            <tr><td>Authorizations per hour</td><td>30</td></tr>
            <tr>
              <td>Blocked merchant categories</td>
              <td>7995 gambling · 6051 quasi-cash / crypto · 4829 money transfer · 6540 stored-value loads</td>
            </tr>
            <tr>
              <td>Currency</td>
              <td>USD only. Other currencies are declined rather than compared with a guessed exchange rate</td>
            </tr>
          </tbody>
        </table>
        <pre className="term">
          {"{\n  \"$schema\": \"https://spendveto.com/schemas/policy-v1.json\",\n  \"cards\": { \"maxAuthorizationUSD\": 200, \"dailyBudgetUSD\": 400, \"maxAuthorizationsPerHour\": 10, \"allowedMccs\": [\"5734\", \"7372\"] }\n}"}
        </pre>
        <h2>What it adds to the issuer's own controls</h2>
        <p>
          Stripe Issuing's{" "}
          <a className="inline" href="https://docs.stripe.com/issuing/controls/spending-controls" rel="noopener">
            spending controls
          </a>
          {" "}block merchant categories, countries or merchants, and limit spend per authorization or per month. SpendVeto decides each authorization against{" "}
          <b>rolling</b>
          {" "}daily budgets and hourly velocity, the agent's{" "}
          <b>shared</b>
          {" "}budget across its model, x402 and payout spend, a kill switch, and merchant reputation shared across companies (
          <code>card-merchant:&lt;network id&gt;</code>
          ). An authorization is answered within the issuer's window. A merchant flagged for review is declined, because the swipe can't wait for a human.
        </p>
        <div className="card warn">
          <b>Honest limits.</b>
          {" "}SpendVeto decides authorizations; captures, reversals and refunds are not consumed yet, and an approved authorization is booked as committed spend.
        </div>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>Can I give an AI agent a virtual card safely?</summary>
            <p>
              Yes, if every authorization is decided by policy in real time: caps, a rolling budget, velocity, merchant-category blocks and a kill switch. Stripe Issuing and Lithic both let a webhook approve or decline each swipe.
            </p>
          </details>
          <details>
            <summary>What does the agent's card do when the budget is used up?</summary>
            <p>
              The next authorization is declined in the issuer's own format, with the SpendVeto code in the decision metadata.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/human-approval-agent-payments">
            Human approval for agent payments
            <span>
              Threshold and new-payee approvals that fail closed, are single-use, and can require two approvers.
            </span>
          </a>
          <a href="/guides/verify-governed-ai-agents">
            Verify governed agents (sellers)
            <span>
              Sellers verify a signed attestation that the buyer's policy allowed the payment — offline, one middleware.
            </span>
          </a>
          <a href="/guides/claude-code-spending-limit">
            Claude Code spending limit
            <span>
              Daily, hourly, per-request and per-session caps for interactive Claude Code, with one environment variable.
            </span>
          </a>
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/console/">Open the console demo</a>
        </div>
        <p className="meta">Updated 2026-10-18 · SpendVeto v0.29.0</p>
      </article>
    </Page>
  );
}
