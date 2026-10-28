import "../styles/pages.css";
import "./guides.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "Guides — AI Agent Budgets, Spending Limits, Loop Detection & Payment Controls | SpendVeto",
  "description": "Step-by-step guides: set a spending limit for Claude Code or Codex, stop runaway agent loops, cap x402 payments, govern agent cards, and accept payments only from governed agents.",
  "path": "/guides",
  "ogTitle": "SpendVeto guides: AI agent spend controls",
  "ogDescription": "Budgets, loop detection, kill switches and payment limits for AI agents, step by step.",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "@id": "https://spendveto.com/guides",
          "name": "SpendVeto guides: AI agent spend controls",
          "url": "https://spendveto.com/guides",
          "description": "Step-by-step guides to budgets, loop detection, kill switches, payment limits and seller verification for AI agents.",
          "publisher": {
            "@type": "Organization",
            "@id": "https://spendveto.com/#org",
            "name": "SpendVeto"
          }
        },
        {
          "@type": "ItemList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "url": "https://spendveto.com/guides/claude-code-spending-limit",
              "name": "How to set a spending limit for Claude Code"
            },
            {
              "@type": "ListItem",
              "position": 2,
              "url": "https://spendveto.com/guides/openai-api-spending-limit",
              "name": "How to set an OpenAI API spending limit per agent, per day"
            },
            {
              "@type": "ListItem",
              "position": 3,
              "url": "https://spendveto.com/guides/stop-runaway-ai-agent-loop",
              "name": "How to stop a runaway AI agent loop before it runs up a bill"
            },
            {
              "@type": "ListItem",
              "position": 4,
              "url": "https://spendveto.com/guides/ai-agent-budget",
              "name": "How to set a budget for AI agents — per agent, per team, per customer"
            },
            {
              "@type": "ListItem",
              "position": 5,
              "url": "https://spendveto.com/guides/x402-spending-limits",
              "name": "How to put spending limits on x402 agent payments"
            },
            {
              "@type": "ListItem",
              "position": 6,
              "url": "https://spendveto.com/guides/ai-agent-card-controls",
              "name": "How to control what an AI agent can buy with a virtual card"
            },
            {
              "@type": "ListItem",
              "position": 7,
              "url": "https://spendveto.com/guides/human-approval-agent-payments",
              "name": "How to require human approval for AI agent payments"
            },
            {
              "@type": "ListItem",
              "position": 8,
              "url": "https://spendveto.com/guides/verify-governed-ai-agents",
              "name": "How to accept payments only from governed AI agents"
            },
            {
              "@type": "ListItem",
              "position": 9,
              "url": "https://spendveto.com/guides/mpp-spending-controls",
              "name": "How to put spending controls on MPP agent payments"
            },
            {
              "@type": "ListItem",
              "position": 10,
              "url": "https://spendveto.com/guides/payment-mcp-guardrails",
              "name": "How to put guardrails on payment MCP servers"
            }
          ]
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
            }
          ]
        }
      ]
    }
  ]
};

export default function GuidesPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <div className="pg">
        <h1>Guides</h1>
        <p className="answer">
          How to put a budget, a loop detector and a kill switch in front of AI agents — model calls, x402 payments, cards and payouts — and how sellers can tell a governed agent from an ungoverned one. Every step uses the self-hosted SpendVeto server; every behavior is covered by its test suite.
        </p>
        <div className="glist">
          <a href="/guides/claude-code-spending-limit">
            <b>How to set a spending limit for Claude Code</b>
            <span>
              Daily, hourly, per-request and per-session caps for interactive Claude Code, with one environment variable.
            </span>
          </a>
          {" "}
          <a href="/guides/openai-api-spending-limit">
            <b>How to set an OpenAI API spending limit per agent, per day</b>
            <span>
              Per-agent daily, hourly and per-request caps for Codex and the OpenAI SDKs, enforced before each request.
            </span>
          </a>
          {" "}
          <a href="/guides/stop-runaway-ai-agent-loop">
            <b>How to stop a runaway AI agent loop before it runs up a bill</b>
            <span>
              Freeze an agent that repeats the same tool call, plus a kill switch, rate limits and budgets as backstops.
            </span>
          </a>
          {" "}
          <a href="/guides/ai-agent-budget">
            <b>How to set a budget for AI agents — per agent, per team, per customer</b>
            <span>
              Per-agent caps, team and customer tag budgets across agents, and one cost report across providers.
            </span>
          </a>
          {" "}
          <a href="/guides/x402-spending-limits">
            <b>How to put spending limits on x402 agent payments</b>
            <span>
              Caps, approvals, payee and chain allowlists for x402, enforced server-side before anything is signed or settled.
            </span>
          </a>
          {" "}
          <a href="/guides/payment-mcp-guardrails">
            <b>How to put guardrails on payment MCP servers</b>
            <span>
              Razorpay, Stripe, PayPal, Cashfree and Square MCP servers: refunds priced and budgeted, risky changes to a human, unknown tools refused.
            </span>
          </a>
          {" "}
          <a href="/guides/mpp-spending-controls">
            <b>How to put spending controls on MPP agent payments</b>
            <span>
              Stripe and Tempo's Machine Payments Protocol: offers decided inside the mppx client before it pays — deposits, splits, subscriptions.
            </span>
          </a>
          {" "}
          <a href="/guides/ai-agent-card-controls">
            <b>How to control what an AI agent can buy with a virtual card</b>
            <span>
              Real-time decisions on Stripe Issuing and Lithic swipes: caps, daily budgets, velocity, MCC blocks, kill switch.
            </span>
          </a>
          {" "}
          <a href="/guides/human-approval-agent-payments">
            <b>How to require human approval for AI agent payments</b>
            <span>
              Threshold and new-payee approvals that fail closed, are single-use, and can require two approvers.
            </span>
          </a>
          {" "}
          <a href="/guides/verify-governed-ai-agents">
            <b>How to accept payments only from governed AI agents</b>
            <span>
              Sellers verify a signed attestation that the buyer's policy allowed the payment — offline, one middleware.
            </span>
          </a>
        </div>
      </div>
    </Page>
  );
}
