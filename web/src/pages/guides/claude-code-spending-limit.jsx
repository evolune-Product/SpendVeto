import "../../styles/pages.css";
import "./claude-code-spending-limit.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "Claude Code Spending Limit: Per Agent, Per Day | SpendVeto",
  "description": "--max-budget-usd only works in non-interactive mode. Cap interactive Claude Code per agent, per day and per session with one environment variable.",
  "path": "/guides/claude-code-spending-limit",
  "ogTitle": "How to set a spending limit for Claude Code",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/claude-code-spending-limit#article",
          "headline": "How to set a spending limit for Claude Code",
          "description": "--max-budget-usd only works in non-interactive mode. Cap interactive Claude Code per agent, per day and per session with one environment variable.",
          "url": "https://spendveto.com/guides/claude-code-spending-limit",
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
            "Claude Code",
            "LLM cost control",
            "AI agent budget"
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
              "name": "Claude Code spending limit",
              "item": "https://spendveto.com/guides/claude-code-spending-limit"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to set a spending limit for Claude Code",
          "description": "Route Claude Code through SpendVeto with one environment variable — ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude — and every request is checked against a daily, hourly, per-request and per-session budget before it reaches Anthropic. Claude Code's own --max-budget-usd flag applies only in non-interactive mode, and Console limits are monthly, per organization or workspace.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto"
            },
            {
              "@type": "HowToTool",
              "name": "Claude Code"
            },
            {
              "@type": "HowToTool",
              "name": "Node.js 22+"
            }
          ],
          "step": [
            {
              "@type": "HowToStep",
              "position": 1,
              "name": "Start SpendVeto",
              "text": "Run npx spendveto. It starts a local server on 127.0.0.1:8402 with a default budget of $25/day, $10/hour and $5/request per agent."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Point Claude Code at it",
              "text": "Start Claude Code with ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude. Your Anthropic key passes through and is never stored."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Set your budget",
              "text": "Run spendveto budget 10 for $10 a day per agent (spendveto budget 10 3 also sets $3 an hour). Add a per-session cap with sessionBudgetUSD in the policy."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Watch and stop agents",
              "text": "spendveto status shows what each agent spent today; spendveto freeze <agent> refuses every request from that agent until you unfreeze it."
            },
            {
              "@type": "HowToStep",
              "position": 5,
              "name": "Give each teammate or agent its own budget",
              "text": "Register agents in the Console and give each a tg_ token as its ANTHROPIC_API_KEY; the guard swaps in a provider key only the server holds."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "Does Claude Code have a built-in spending limit?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "For non-interactive runs, --max-budget-usd caps one run, and Anthropic notes spend can pass it. The Console sets monthly limits per organization or workspace. For daily, hourly, per-session or per-agent caps on interactive sessions, route Claude Code through a gateway such as SpendVeto."
              }
            },
            {
              "@type": "Question",
              "name": "Will SpendVeto see or store my prompts?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "It runs on your machine and forwards requests unchanged. The ledger records the model, token counts, cost, agent and session — not prompts or completions. To detect loops it fingerprints the last tool call and result, and keeps only the hash."
              }
            },
            {
              "@type": "Question",
              "name": "Does it work with a Claude Pro or Max subscription?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Requests pass through and are metered at API-equivalent prices, so the budget reflects what the same usage would cost on the API."
              }
            },
            {
              "@type": "Question",
              "name": "What happens when the budget runs out mid-task?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "The next request is refused with HTTP 402 and a code such as llm_daily_budget, before Anthropic is called. Raise the budget with spendveto budget or wait for the rolling window."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function ClaudeCodeSpendingLimitPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs">
          <a href="/">SpendVeto</a>
          {" "}/{" "}
          <a href="/guides">Guides</a>
          {" "}/ Claude Code spending limit
        </p>
        <h1>How to set a spending limit for Claude Code</h1>
        <p className="answer">
          Route Claude Code through SpendVeto with one environment variable —{" "}
          <code>ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude</code>
          {" "}— and every request is checked against a daily, hourly, per-request and per-session budget{" "}
          <b>before</b>
          {" "}it reaches Anthropic. Claude Code's own{" "}
          <code>--max-budget-usd</code>
          {" "}flag applies only in non-interactive mode, and Console limits are monthly, per organization or workspace.
        </p>
        <h2>What Claude Code offers on its own</h2>
        <table className="t">
          <tbody>
            <tr><th>Control</th><th>Scope</th><th>Notes</th></tr>
            <tr>
              <td><code>--max-budget-usd</code></td>
              <td>One non-interactive (<code>-p</code>) run</td>
              <td>
                Not available in interactive sessions; Anthropic notes spend can pass the cap (
                <a className="inline" href="https://code.claude.com/docs/en/cli-reference" rel="noopener">
                  CLI reference
                </a>
                )
              </td>
            </tr>
            <tr>
              <td>Console spend limits</td>
              <td>Organization or workspace, per month</td>
              <td>
                Hard monthly caps by usage tier, with a lower limit you can set (
                <a className="inline" href="https://platform.claude.com/docs/en/api/rate-limits" rel="noopener">
                  rate limits
                </a>
                )
              </td>
            </tr>
            <tr>
              <td>Claude apps gateway</td>
              <td>Per user, daily / weekly / monthly</td>
              <td>
                Self-hosted; Anthropic describes it as "a circuit breaker rather than an invoice" (
                <a className="inline" href="https://code.claude.com/docs/en/claude-apps-gateway-spend-limits" rel="noopener">
                  docs
                </a>
                )
              </td>
            </tr>
            <tr>
              <td><b>SpendVeto</b></td>
              <td>Per agent: day, hour, request, session; per team or customer tag</td>
              <td>
                Checked before each request; loop detection; kill switch; same budget can cover x402, card and payout spend
              </td>
            </tr>
          </tbody>
        </table>
        <h2>1 · Start SpendVeto</h2>
        <pre className="term">
          {"npx spendveto\n#   Console   http://127.0.0.1:8402\n#   Budget    $25.00/day · $10.00/hour · $5.00/request per agent"}
        </pre>
        <p>
          The first run installs dependencies in under a minute. Node 22 or newer is recommended. State lives in{" "}
          <code>~/.spendveto</code>
          , on your machine.
        </p>
        <h2>2 · Point Claude Code at it</h2>
        <pre className="term">{"ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude"}</pre>
        <p>
          Request bodies are forwarded byte for byte, every{" "}
          <code>anthropic-*</code>
          {" "}header is passed through, and streams are relayed event by event, following Claude Code's gateway guidance. On 2026-10-18 Claude Code v2.1.300 ran through the guard unconfigured, and its main request was booked at $0.012638 from Anthropic's own usage report.
        </p>
        <h2>3 · Set the budget</h2>
        <pre className="term">
          {"spendveto budget 10        # $10 a day per agent\nspendveto budget 10 3      # …and $3 an hour\nspendveto observe          # try it first: record what WOULD be blocked, block nothing"}
        </pre>
        <p>
          A per-session cap (Claude Code sends a session id with each request) and a per-request ceiling live in the policy file:
        </p>
        <pre className="term">
          {"{\n  \"$schema\": \"https://spendveto.com/schemas/policy-v1.json\",\n  \"llm\": { \"dailyBudgetUSD\": 10, \"hourlyBudgetUSD\": 3, \"sessionBudgetUSD\": 2, \"maxRequestUSD\": 1 }\n}"}
        </pre>
        <p>
          When a request would exceed a budget, it is refused before it reaches Anthropic with HTTP 402 and a machine-readable code (
          <code>llm_daily_budget</code>
          ,{" "}
          <code>llm_hourly_budget</code>
          ,{" "}
          <code>llm_session_budget</code>
          ,{" "}
          <code>llm_request_cap</code>
          ) plus a suggestion the agent can read.
        </p>
        <h2>4 · Watch, and stop an agent</h2>
        <pre className="term">
          {"spendveto status           # per agent: spent today, left, requests, top model\nspendveto freeze my-agent  # the kill switch\nspendveto unfreeze my-agent"}
        </pre>
        <p>
          The Console's AI spend page shows the same, with budgets you can edit. An agent that keeps making the same tool call and getting the same result is frozen automatically. See{" "}
          <a className="inline" href="/guides/stop-runaway-ai-agent-loop">stopping runaway loops</a>
          .
        </p>
        <h2>5 · Budgets per teammate or agent</h2>
        <p>
          By default everything is one identity, "local". For a team, register each agent in the Console and give it a{" "}
          <code>tg_…</code>
          {" "}token instead of a provider key. The server holds the real Anthropic key (
          <code>SPENDVETO_ANTHROPIC_KEY</code>
          ), so revoking a token revokes access, and each token has its own budget:
        </p>
        <pre className="term">{"ANTHROPIC_API_KEY=tg_… ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude"}</pre>
        <div className="card warn">
          <b>Honest limits.</b>
          {" "}The pre-check uses an estimate (input sized from the request, output from its{" "}
          <code>max_tokens</code>
          ), so the last request allowed under a budget can overshoot it by that request's difference; the actual cost is always booked from Anthropic's usage. Traffic on a Claude subscription is metered at API-equivalent prices, not as a bill. Message Batches are refused rather than passed through ungoverned.
        </div>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>Does Claude Code have a built-in spending limit?</summary>
            <p>
              For non-interactive runs,{" "}
              <code>--max-budget-usd</code>
              {" "}caps one run, and Anthropic notes spend can pass it. The Console sets monthly limits per organization or workspace. For daily, hourly, per-session or per-agent caps on interactive sessions, route Claude Code through a gateway such as SpendVeto.
            </p>
          </details>
          <details>
            <summary>Will SpendVeto see or store my prompts?</summary>
            <p>
              It runs on your machine and forwards requests unchanged. The ledger records the model, token counts, cost, agent and session — not prompts or completions. To detect loops it fingerprints the last tool call and result, and keeps only the hash.
            </p>
          </details>
          <details>
            <summary>Does it work with a Claude Pro or Max subscription?</summary>
            <p>
              Requests pass through and are metered at API-equivalent prices, so the budget reflects what the same usage would cost on the API.
            </p>
          </details>
          <details>
            <summary>What happens when the budget runs out mid-task?</summary>
            <p>
              The next request is refused with HTTP 402 and a code such as{" "}
              <code>llm_daily_budget</code>
              , before Anthropic is called. Raise the budget with{" "}
              <code>spendveto budget</code>
              {" "}or wait for the rolling window.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/openai-api-spending-limit">
            OpenAI API spending limit
            <span>
              Per-agent daily, hourly and per-request caps for Codex and the OpenAI SDKs, enforced before each request.
            </span>
          </a>
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
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/console/">Open the console demo</a>
        </div>
        <p className="meta">Updated 2026-10-19 · SpendVeto v0.29.1</p>
      </article>
    </Page>
  );
}
