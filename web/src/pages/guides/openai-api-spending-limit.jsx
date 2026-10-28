import "../../styles/pages.css";
import "./openai-api-spending-limit.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "OpenAI API Spending Limit Per Agent, Per Day | SpendVeto",
  "description": "OpenAI's limits are monthly, per org or project. Add per-agent daily and hourly caps for Codex and the OpenAI SDKs with one base URL.",
  "path": "/guides/openai-api-spending-limit",
  "ogTitle": "How to set an OpenAI API spending limit per agent, per day",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/openai-api-spending-limit#article",
          "headline": "How to set an OpenAI API spending limit per agent, per day",
          "description": "OpenAI's limits are monthly, per org or project. Add per-agent daily and hourly caps for Codex and the OpenAI SDKs with one base URL.",
          "url": "https://spendveto.com/guides/openai-api-spending-limit",
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
            "OpenAI API",
            "Codex",
            "LLM cost control"
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
              "name": "OpenAI API spending limit",
              "item": "https://spendveto.com/guides/openai-api-spending-limit"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to set an OpenAI API spending limit per agent, per day",
          "description": "Set OPENAI_BASE_URL=http://127.0.0.1:8402/v1 and SpendVeto checks every Chat Completions and Responses request against a per-agent daily, hourly and per-request budget before it reaches OpenAI. OpenAI's own limits are monthly, per organization or project: alerts are soft, the hard limit returns a 429, and OpenAI notes recorded spend can slightly exceed it.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto"
            },
            {
              "@type": "HowToTool",
              "name": "OpenAI SDK or Codex CLI"
            }
          ],
          "step": [
            {
              "@type": "HowToStep",
              "position": 1,
              "name": "Start SpendVeto",
              "text": "Run npx spendveto (local server on 127.0.0.1:8402)."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Change the base URL",
              "text": "Codex: OPENAI_BASE_URL=http://127.0.0.1:8402/v1 codex. SDKs: pass base_url / baseURL. The API key passes through."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Name each agent",
              "text": "Send an x-spendveto-agent header (default_headers in Python, defaultHeaders in Node) so each agent gets its own budget."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Set budgets",
              "text": "spendveto budget 20 for $20/day per agent, or set llm.dailyBudgetUSD, hourlyBudgetUSD and maxRequestUSD in the policy file."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "Can I set a daily spending limit on the OpenAI API?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "OpenAI's documented limits are monthly, per organization or project. A gateway in front of the API, such as SpendVeto, adds rolling daily and hourly caps per agent, checked before each request."
              }
            },
            {
              "@type": "Question",
              "name": "Why does my OpenAI spend go over the hard limit?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "OpenAI notes that recorded spend can slightly exceed the limit, because usage is recorded after requests complete. SpendVeto decides before each request on a worst-case estimate and holds that estimate while the request runs, so parallel requests can't all pass the same remaining budget."
              }
            },
            {
              "@type": "Question",
              "name": "Does it work with Codex?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes: OPENAI_BASE_URL=http://127.0.0.1:8402/v1 codex."
              }
            },
            {
              "@type": "Question",
              "name": "Can different agents have different budgets?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes. Name each agent with the x-spendveto-agent header, or give each a tg_ token in team mode, and every identity gets its own daily, hourly and per-request limits."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function OpenaiApiSpendingLimitPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs">
          <a href="/">SpendVeto</a>
          {" "}/{" "}
          <a href="/guides">Guides</a>
          {" "}/ OpenAI API spending limit
        </p>
        <h1>How to set an OpenAI API spending limit per agent, per day</h1>
        <p className="answer">
          Set{" "}
          <code>OPENAI_BASE_URL=http://127.0.0.1:8402/v1</code>
          {" "}and SpendVeto checks every Chat Completions and Responses request against a per-agent daily, hourly and per-request budget before it reaches OpenAI. OpenAI's own limits are monthly, per organization or project: alerts are soft, the hard limit returns a 429, and OpenAI notes recorded spend can slightly exceed it.
        </p>
        <h2>OpenAI's limits versus a per-agent budget</h2>
        <table className="t">
          <tbody>
            <tr><th></th><th>OpenAI spend limits</th><th>SpendVeto</th></tr>
            <tr><td>Window</td><td>Monthly</td><td>Rolling hour and 24 hours, per request, per session</td></tr>
            <tr>
              <td>Scope</td>
              <td>Organization or project</td>
              <td>Each agent, and each team or customer tag across agents</td>
            </tr>
            <tr>
              <td>Enforcement</td>
              <td>
                Alerts are soft; the hard limit returns 429; recorded spend can slightly exceed it (
                <a className="inline" href="https://developers.openai.com/api/docs/guides/spend-limits" rel="noopener">
                  OpenAI docs
                </a>
                )
              </td>
              <td>Checked before the request using a worst-case estimate; actual cost booked from OpenAI's usage</td>
            </tr>
            <tr><td>Loops</td><td>—</td><td>Repeated identical tool call + result freezes the agent</td></tr>
          </tbody>
        </table>
        <h2>Codex CLI</h2>
        <pre className="term">{"npx spendveto\nOPENAI_BASE_URL=http://127.0.0.1:8402/v1 codex"}</pre>
        <h2>Python and Node SDKs</h2>
        <pre className="term">
          {"# Python\nfrom openai import OpenAI\nclient = OpenAI(base_url=\"http://127.0.0.1:8402/v1\", default_headers={\"x-spendveto-agent\": \"research-bot\"})\n\n// Node\nimport OpenAI from \"openai\";\nconst client = new OpenAI({ baseURL: \"http://127.0.0.1:8402/v1\", defaultHeaders: { \"x-spendveto-agent\": \"research-bot\" } });"}
        </pre>
        <p>
          Chat Completions and the Responses API both work, streamed or not. For streams, SpendVeto asks OpenAI to include usage so the cost is booked from OpenAI's own numbers, priced from OpenAI's published sheet (as of 2026-10-18). A model the sheet doesn't know is priced at the flagship rate and flagged, never guessed low. Override prices with{" "}
          <code>llm.prices</code>
          , or set{" "}
          <code>llm.unknownModelRates</code>
          .
        </p>
        <h2>Budgets</h2>
        <pre className="term">
          {"{\n  \"$schema\": \"https://spendveto.com/schemas/policy-v1.json\",\n  \"llm\": {\n    \"dailyBudgetUSD\": 20, \"hourlyBudgetUSD\": 5, \"maxRequestUSD\": 2, \"maxRequestsPerMinute\": 60,\n    \"tagBudgets\": { \"customer=cus_123\": { \"dailyUSD\": 5 } }\n  }\n}"}
        </pre>
        <p>
          Over budget, the request is refused before OpenAI is called (HTTP 402, code{" "}
          <code>llm_daily_budget</code>
          {" "}and friends). Over the per-minute limit it gets a real 429 with an integer{" "}
          <code>retry-after</code>
          , so the SDK's own retry logic slows down. Validate the file with{" "}
          <code>spendveto validate</code>
          {" "}before you deploy it.
        </p>
        <div className="card warn">
          <b>Honest limits.</b>
          {" "}The pre-check is an estimate (input sized from the request, output from its max tokens), so the last allowed request can overshoot a budget by that request's difference. Endpoints SpendVeto can't meter yet, such as batch jobs, are refused rather than passed through ungoverned.
        </div>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>Can I set a daily spending limit on the OpenAI API?</summary>
            <p>
              OpenAI's documented limits are monthly, per organization or project. A gateway in front of the API, such as SpendVeto, adds rolling daily and hourly caps per agent, checked before each request.
            </p>
          </details>
          <details>
            <summary>Why does my OpenAI spend go over the hard limit?</summary>
            <p>
              OpenAI notes that recorded spend can slightly exceed the limit, because usage is recorded after requests complete. SpendVeto decides before each request on a worst-case estimate and holds that estimate while the request runs, so parallel requests can't all pass the same remaining budget.
            </p>
          </details>
          <details>
            <summary>Does it work with Codex?</summary>
            <p>Yes: <code>OPENAI_BASE_URL=http://127.0.0.1:8402/v1 codex</code>.</p>
          </details>
          <details>
            <summary>Can different agents have different budgets?</summary>
            <p>
              Yes. Name each agent with the{" "}
              <code>x-spendveto-agent</code>
              {" "}header, or give each a{" "}
              <code>tg_</code>
              {" "}token in team mode, and every identity gets its own daily, hourly and per-request limits.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/stop-runaway-ai-agent-loop">
            Stop runaway agent loops
            <span>
              Freeze an agent that repeats the same tool call, plus a kill switch, rate limits and budgets as backstops.
            </span>
          </a>
          <a href="/guides/ai-agent-budget">
            AI agent budgets
            <span>
              Per-agent caps, team and customer tag budgets across agents, and one cost report across providers.
            </span>
          </a>
          <a href="/guides/x402-spending-limits">
            x402 spending limits
            <span>
              Caps, approvals, payee and chain allowlists for x402, enforced server-side before anything is signed or settled.
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
