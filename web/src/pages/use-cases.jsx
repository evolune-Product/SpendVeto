import "../styles/pages.css";
import "./use-cases.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "AI Agent Spend Governance Use Cases — Procurement, Compliance, Agent-to-Agent Payments",
  "description": "Where AI agent spend governance actually earns its keep: procurement bots, compliance lookups, support triage, analytics copilots, agent-to-agent data buying over x402, and CI/coding agents that pay for tools.",
  "path": "/use-cases",
  "keywords": "AI agent use cases, agent-to-agent payments, AI procurement agent, x402 use cases, autonomous agent spend control",
  "jsonLd": [
    {
      "@context": "https://schema.org",
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
          "name": "Use cases",
          "item": "https://spendveto.com/use-cases"
        }
      ]
    }
  ]
};

// Behaviour lives in use-cases.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

export default function UseCasesPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="uc-wrap">
        <div className="uc-head">
          <p className="counter"><b>USE CASES</b> where governance earns its keep</p>
          <h1>Every one of these is an agent spending money you can't watch in real time.</h1>
          <p className="lede">
            A single agent conversation can trigger hundreds of sub-cent purchases — API calls, data pulls, model inference, other agents' tools. That's exactly where an unbounded wallet turns a bug into an invoice. Here's who's spending, what goes wrong without a governor, and the SpendVeto controls that stop it.
          </p>
        </div>
        <div className="uc-grid">
          <div className="uc reveal">
            <svg className="ico" viewBox="0 0 48 48" fill="none" stroke="#46d68c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="7" y="14" width="34" height="24" rx="2"></rect>
              <path d="M7 20h34"></path>
              <path d="M16 14v-4h16v4"></path>
              <circle cx="24" cy="29" r="3"></circle>
            </svg>
            <div className="who">Procurement bot</div>
            <h2>Autonomous purchasing &amp; restocking</h2>
            <p>
              An inventory agent predicts a shortage and places supplier orders on its own, settling in stablecoins.{" "}
              <span className="risk">
                A bad forecast or a retry loop can order ten times what's needed before anyone looks.
              </span>
            </p>
            <div className="controls">
              <span className="tag">per-call cap</span>
              <span className="tag">hourly budget</span>
              <span className="tag">payee allowlist</span>
              <span className="tag">approval &gt; $X</span>
            </div>
          </div>
          <div className="uc reveal">
            <svg className="ico" viewBox="0 0 48 48" fill="none" stroke="#46d68c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M24 6l14 6v9c0 9-6 15-14 18-8-3-14-9-14-18v-9z"></path>
              <path d="M18 24l4 4 8-9"></path>
            </svg>
            <div className="who">Compliance agent</div>
            <h3>Sanctions &amp; risk-score lookups</h3>
            <p>
              A compliance bot pings a paid sanctions database and buys supplier-risk scores per check.{" "}
              <span className="risk">
                Charged per query, a mis-scoped batch job can rack up thousands of paid lookups overnight.
              </span>
            </p>
            <div className="controls">
              <span className="tag">rate limit</span>
              <span className="tag">category cap</span>
              <span className="tag">tool scope</span>
              <span className="tag">runaway auto-freeze</span>
            </div>
          </div>
          <div className="uc reveal">
            <svg className="ico" viewBox="0 0 48 48" fill="none" stroke="#46d68c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 34V12a2 2 0 012-2h28a2 2 0 012 2v22"></path>
              <path d="M6 34h36l-4 6H10z"></path>
              <path d="M18 18h12M18 24h8"></path>
            </svg>
            <div className="who">Support triage agent</div>
            <h3>Tier-1 tickets, priced per interaction</h3>
            <p>
              A triage agent resolves common tickets and escalates hard ones, paying per model call and per tool.{" "}
              <span className="risk">
                A prompt-injected ticket can steer it into paying an attacker or looping a premium tool.
              </span>
            </p>
            <div className="controls">
              <span className="tag">payee allowlist</span>
              <span className="tag">human approval</span>
              <span className="tag">per-agent budget</span>
              <span className="tag">kill switch</span>
            </div>
          </div>
          <div className="uc reveal">
            <svg className="ico" viewBox="0 0 48 48" fill="none" stroke="#46d68c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 40V22M18 40V10M28 40V26M38 40V16"></path>
              <path d="M6 40h36"></path>
            </svg>
            <div className="who">Analytics copilot</div>
            <h3>Scoped data pulls, billed per query</h3>
            <p>
              A copilot runs data pulls and summaries against metered datasets, billed by the query.{" "}
              <span className="risk">
                "Analyze everything" becomes an unbounded fan-out of paid queries — precise consumption, no ceiling.
              </span>
            </p>
            <div className="controls">
              <span className="tag">hourly budget</span>
              <span className="tag">API-spend rail</span>
              <span className="tag">shadow-test limits</span>
              <span className="tag">audit trail</span>
            </div>
          </div>
          <div className="uc reveal">
            <svg className="ico" viewBox="0 0 48 48" fill="none" stroke="#46d68c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="13" cy="24" r="6"></circle>
              <circle cx="35" cy="13" r="6"></circle>
              <circle cx="35" cy="35" r="6"></circle>
              <path d="M18.5 21l11-5M18.5 27l11 5"></path>
            </svg>
            <div className="who">Agent-to-agent</div>
            <h3>Buying datasets &amp; tools from other agents</h3>
            <p>
              Agents pay other agents for data and API access in real time, at machine velocity.{" "}
              <span className="risk">
                A chain of micro-payments across untrusted counterparties is impossible to reconcile after the fact — or to stop mid-chain.
              </span>
            </p>
            <div className="controls">
              <span className="tag">nested budgets</span>
              <span className="tag">payee scope</span>
              <span className="tag">signed receipts</span>
              <span className="tag">trust score</span>
            </div>
          </div>
          <div className="uc reveal">
            <svg className="ico" viewBox="0 0 48 48" fill="none" stroke="#46d68c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 16l-8 8 8 8M30 16l8 8-8 8"></path>
            </svg>
            <div className="who">Coding &amp; CI agents</div>
            <h3>Fleets that buy compute &amp; premium tools</h3>
            <p>
              Claude Code / LangChain / CrewAI fleets call paid models, review tools, and sandboxes across many parallel sub-agents.{" "}
              <span className="risk">
                One runaway parent can fan a budget out across dozens of children before a human notices.
              </span>
            </p>
            <div className="controls">
              <span className="tag">delegation tree</span>
              <span className="tag">MCP-native</span>
              <span className="tag">concurrency-safe caps</span>
              <span className="tag">trading-hours</span>
            </div>
          </div>
        </div>
        <div className="uc-cta reveal">
          <h2>See the decision happen — no install.</h2>
          <p>
            The playground runs SpendVeto's real policy logic in your browser: set a budget, fire agent spend at it, and watch each attempt pass, pause for approval, or get blocked with a reason.
          </p>
          <div className="row-btns">
            <a className="pill pill-primary" href="/playground">Open the playground →</a>
            {" "}
            <a className="pill pill-ghost" href="/docs#quickstart">Run it locally in 60s</a>
          </div>
        </div>
      </div>
    </Page>
  );
}
