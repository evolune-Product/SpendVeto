import "../../styles/pages.css";
import "./ai-agent-budget.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "AI Agent Budgets: Per Agent, Team or Customer | SpendVeto",
  "description": "Give each AI agent a daily and hourly budget, cap a team or customer across all its agents, and see one cost report across providers.",
  "path": "/guides/ai-agent-budget",
  "ogTitle": "How to set a budget for AI agents — per agent, per team, per customer",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/ai-agent-budget#article",
          "headline": "How to set a budget for AI agents — per agent, per team, per customer",
          "description": "Give each AI agent a daily and hourly budget, cap a team or customer across all its agents, and see one cost report across providers.",
          "url": "https://spendveto.com/guides/ai-agent-budget",
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
            "AI agent budget",
            "AI FinOps",
            "cost allocation"
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
              "name": "AI agent budgets",
              "item": "https://spendveto.com/guides/ai-agent-budget"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to set a budget for AI agents — per agent, per team, per customer",
          "description": "Give each agent an identity (a header or a tg_ token), set daily, hourly and per-request caps in one policy file, and add tag budgets that cap a team or a customer across every agent carrying the tag. SpendVeto enforces them before each request and reports spend by agent, team, customer, model or rail.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto"
            }
          ],
          "step": [
            {
              "@type": "HowToStep",
              "position": 1,
              "name": "Identify agents",
              "text": "Send x-spendveto-agent: <name>, or give each agent a tg_ token in team mode."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Set per-agent caps",
              "text": "llm.dailyBudgetUSD, hourlyBudgetUSD, maxRequestUSD and sessionBudgetUSD apply to every identity."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Tag requests",
              "text": "Send x-spendveto-tags: team=search,customer=cus_123 to attribute spend."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Cap a team or customer",
              "text": "llm.tagBudgets: { \"customer=cus_123\": { \"dailyUSD\": 5 } } caps that customer across every agent."
            },
            {
              "@type": "HowToStep",
              "position": 5,
              "name": "Report",
              "text": "GET /api/costs?groupBy=customer (or team, agent, model, rail), or export FOCUS v1.4 for FinOps tools."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "How do I limit how much an AI agent can spend?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Give it an identity and a budget enforced before each request: a daily, hourly and per-request cap, plus a kill switch. With SpendVeto that is one environment variable and one policy file."
              }
            },
            {
              "@type": "Question",
              "name": "Can one customer's usage be capped across several agents?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes — tag requests with customer=… and set llm.tagBudgets; the cap counts every agent carrying that tag."
              }
            },
            {
              "@type": "Question",
              "name": "Can the same budget cover model calls and payments?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes. An agent bound to a delegated wallet spends model tokens, x402 payments and card authorizations against one cascading cap."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function AiAgentBudgetPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs"><a href="/">SpendVeto</a> / <a href="/guides">Guides</a> / AI agent budgets</p>
        <h1>How to set a budget for AI agents — per agent, per team, per customer</h1>
        <p className="answer">
          Give each agent an identity (a header or a{" "}
          <code>tg_</code>
          {" "}token), set daily, hourly and per-request caps in one policy file, and add{" "}
          <b>tag budgets</b>
          {" "}that cap a team or a customer across every agent carrying the tag. SpendVeto enforces them before each request and reports spend by agent, team, customer, model or rail.
        </p>
        <h2>Three kinds of budget</h2>
        <table className="t">
          <tbody>
            <tr><th>Budget</th><th>Applies to</th><th>Set with</th></tr>
            <tr>
              <td>Per agent</td>
              <td>Each identity: daily (rolling 24h), hourly, per request, per session</td>
              <td><code>llm.dailyBudgetUSD</code> … or <code>spendveto budget</code></td>
            </tr>
            <tr>
              <td>Per tag</td>
              <td>A team, customer or feature, across every agent that carries the tag</td>
              <td><code>llm.tagBudgets</code></td>
            </tr>
            <tr>
              <td>Delegated</td>
              <td>
                A sub-agent's lifetime or recurring allowance, counted against every ancestor's cap and shared across model tokens, x402 payments and card swipes
              </td>
              <td><code>npm run delegate</code> / <code>POST /api/delegations</code></td>
            </tr>
          </tbody>
        </table>
        <h2>Attribute spend with tags</h2>
        <pre className="term">
          {"curl http://127.0.0.1:8402/v1/messages \\\n  -H \"x-api-key: $ANTHROPIC_API_KEY\" -H \"anthropic-version: 2023-06-01\" \\\n  -H \"x-spendveto-agent: support-bot\" -H \"x-spendveto-tags: team=support,customer=cus_123\" \\\n  -d '{\"model\":\"claude-sonnet-5-5\",\"max_tokens\":512,\"messages\":[{\"role\":\"user\",\"content\":\"…\"}]}'"}
        </pre>
        <h2>One policy file</h2>
        <pre className="term">
          {"{\n  \"$schema\": \"https://spendveto.com/schemas/policy-v1.json\",\n  \"llm\": {\n    \"dailyBudgetUSD\": 25, \"hourlyBudgetUSD\": 10, \"maxRequestUSD\": 5,\n    \"tagBudgets\": { \"team=support\": { \"dailyUSD\": 40 }, \"customer=cus_123\": { \"dailyUSD\": 5, \"hourlyUSD\": 1 } }\n  }\n}"}
        </pre>
        <p>
          Check it before you deploy:{" "}
          <code>spendveto validate policy.json</code>
          {" "}rejects a misspelled key such as{" "}
          <code>dailyBudgetUsd</code>
          . The engine would never read that key, so the limit would silently not exist.
        </p>
        <h2>See where the money went</h2>
        <p>
          <code>GET /api/costs?groupBy=customer</code>
          {" "}reports spend across model tokens, x402 tools, cards and payouts, grouped by any tag, agent, model, provider or rail.{" "}
          <code>GET /api/costs/focus.csv</code>
          {" "}exports model spend in FOCUS v1.4, the FinOps Foundation's format. With rebilling on, customer-tagged spend becomes Stripe Billing meter events at your markup.
        </p>
        <p>
          LLM gateways and spend tools such as LiteLLM, Portkey, Cloudflare AI Gateway and Ramp also offer token budgets. SpendVeto adds the loop detector, one budget across model tokens, payments, cards and payouts, and a policy file that is an open, validated standard.
        </p>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>How do I limit how much an AI agent can spend?</summary>
            <p>
              Give it an identity and a budget enforced before each request: a daily, hourly and per-request cap, plus a kill switch. With SpendVeto that is one environment variable and one policy file.
            </p>
          </details>
          <details>
            <summary>Can one customer's usage be capped across several agents?</summary>
            <p>
              Yes — tag requests with{" "}
              <code>customer=…</code>
              {" "}and set{" "}
              <code>llm.tagBudgets</code>
              ; the cap counts every agent carrying that tag.
            </p>
          </details>
          <details>
            <summary>Can the same budget cover model calls and payments?</summary>
            <p>
              Yes. An agent bound to a delegated wallet spends model tokens, x402 payments and card authorizations against one cascading cap.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/x402-spending-limits">
            x402 spending limits
            <span>
              Caps, approvals, payee and chain allowlists for x402, enforced server-side before anything is signed or settled.
            </span>
          </a>
          <a href="/guides/ai-agent-card-controls">
            AI agent card controls
            <span>
              Real-time decisions on Stripe Issuing and Lithic swipes: caps, daily budgets, velocity, MCC blocks, kill switch.
            </span>
          </a>
          <a href="/guides/human-approval-agent-payments">
            Human approval for agent payments
            <span>
              Threshold and new-payee approvals that fail closed, are single-use, and can require two approvers.
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
