import "../styles/pages.css";
import "./ai-spend.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "Cap Your AI Agent's Spend in One Line — Claude Code, Codex, OpenAI & Anthropic SDKs | SpendVeto",
  "description": "A budget, loop detection and a kill switch in front of every model call your agents make. Point Claude Code, Codex or any OpenAI/Anthropic SDK at SpendVeto with one environment variable — your key passes through, never stored. Free to self-host.",
  "path": "/ai-spend",
  "ogTitle": "Cap your AI agent's spend in one line | SpendVeto",
  "ogDescription": "A budget, loop detection and a kill switch in front of every model call — Claude Code, Codex, OpenAI and Anthropic SDKs. Free to self-host."
};

export default function AiSpendPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="pg">
        <h1>Cap your AI agent's spend in one line.</h1>
        <p className="lede">
          An agent in a loop can burn real money before anyone looks — one developer reported ~$6,000 of Claude usage gone overnight from a single command. SpendVeto sits between your agents and the model provider. Every request is checked against a budget{" "}
          <em>before</em>
          {" "}it reaches the model, loops freeze the agent, and the actual cost is booked from the provider's own usage numbers. Your API key passes straight through and is never stored.
        </p>
        <h2>1 · Start it</h2>
        <pre className="term">
          {"npx spendveto\n#   Console   http://127.0.0.1:8402\n#   Budget    $25.00/day · $10.00/hour · $5.00/request per agent"}
        </pre>
        <h2>2 · Point your agent at it</h2>
        <pre className="term">
          {"ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude          # Claude Code\nOPENAI_BASE_URL=http://127.0.0.1:8402/v1 codex           # Codex CLI\nOPENAI_BASE_URL=http://127.0.0.1:8402/v1                 # OpenAI SDKs, Cursor, LangChain, Aider…\nANTHROPIC_BASE_URL=http://127.0.0.1:8402                 # Anthropic SDKs"}
        </pre>
        <p>
          That's it. Set a different budget with{" "}
          <code>spendveto budget 10</code>
          {" "}($10/day), watch spend with{" "}
          <code>spendveto status</code>
          , stop an agent with{" "}
          <code>spendveto freeze &lt;agent&gt;</code>
          {" "}— or use the{" "}
          <a href="/console/">Console</a>
          's AI-spend page.
        </p>
        <div className="card">
          <b>Checked with the real client.</b>
          {" "}On 2026-10-18 Claude Code v2.1.300 ran through the guard with no other configuration: it answered, and the guard booked its main request at $0.012638 — Claude Code had written its 63,180-token system prompt to the one-hour prompt cache, which bills at 2× input, and that's what the guard charged, from the provider's own usage report. (A manual check against a live account, so it isn't in the automated suite; the suite exercises the same wire format against a local mock provider.)
        </div>
        <h2>What it stops</h2>
        <div className="grid3">
          <div className="card">
            <b>Budgets that hold</b>
            <p>
              Per agent: daily (rolling 24h), hourly, per request (worst case, estimated before the call) and per Claude Code session. Over budget → refused before the provider sees it, with a code the agent can read.
            </p>
          </div>
          <div className="card">
            <b>Agent loops</b>
            <p>
              The same tool call returning the same result, again and again, freezes the agent until a human looks. Retries of a{" "}
              <em>failed</em>
              {" "}request don't count — that's an SDK being careful, not a loop.
            </p>
          </div>
          <div className="card">
            <b>Kill switch</b>
            <p>
              Freeze any agent from the Console or the CLI; every request it makes is refused until you unfreeze it.
            </p>
          </div>
          <div className="card">
            <b>Bursts</b>
            <p>
              A per-minute request limit answers with a proper 429 and an integer{" "}
              <code>retry-after</code>
              , so the client's own retry logic slows down instead of hammering.
            </p>
          </div>
          <div className="card">
            <b>Expensive models</b>
            <p>
              Allow or block models per policy; optionally pause any request estimated above a threshold for a human's approval.
            </p>
          </div>
          <div className="card">
            <b>Observe first</b>
            <p>
              Observe mode records exactly what it{" "}
              <em>would</em>
              {" "}have blocked and blocks nothing — try a budget on real traffic with zero risk.
            </p>
          </div>
        </div>
        <h2>Built for the agents you already run</h2>
        <p>
          It speaks the Anthropic Messages and OpenAI Chat Completions / Responses formats and follows Claude Code's gateway compatibility guide to the letter: request bodies forwarded byte-for-byte, every{" "}
          <code>anthropic-*</code>
          {" "}header passed through, streams relayed event by event (keep-alive pings included), upstream errors returned unmodified. OpenAI streams are asked for their usage so the cost is the provider's number, not a guess. Prices for current Claude and OpenAI models are built in (as of 2026-10-18) and overridable; a model it doesn't know is priced at the provider's flagship rate and flagged, never guessed low.
        </p>
        <h2>For teams</h2>
        <div className="grid3">
          <div className="card">
            <b>Keys stay on the server</b>
            <p>
              Register an agent and give it a{" "}
              <code>tg_…</code>
              {" "}token instead of a provider key. The guard swaps in a key only it holds; revoking the token revokes access.
            </p>
          </div>
          <div className="card">
            <b>One budget across rails</b>
            <p>
              An agent bound to a delegated budget spends tokens, x402 payments and card authorizations against the{" "}
              <em>same</em>
              {" "}cascading cap.
            </p>
          </div>
          <div className="card">
            <b>Audit-grade record</b>
            <p>
              Every request — allowed, blocked or observed — lands in the same hash-chained ledger as every payment, with model, usage, price source and session.
            </p>
          </div>
        </div>
        <div className="card warn">
          <b>What to know.</b>
          {" "}The pre-check uses an estimate (input sized from the request, output from its{" "}
          <code>max_tokens</code>
          ), so the last request allowed under a budget can overshoot it by that one request's difference — the hold exists so parallel requests can't do the same. Traffic on a Claude subscription is metered at API-equivalent prices. Message Batches and other endpoints it can't meter are refused rather than passed through ungoverned. Self-hosted today; a hosted, multi-tenant version is the funded milestone.
        </div>
        <h2>Step-by-step guides</h2>
        <p>
          <a href="/guides/claude-code-spending-limit" style={{ color: "var(--green)" }}>
            Claude Code spending limit
          </a>
          {" "}·{" "}
          <a href="/guides/openai-api-spending-limit" style={{ color: "var(--green)" }}>
            OpenAI API limit per agent
          </a>
          {" "}·{" "}
          <a href="/guides/stop-runaway-ai-agent-loop" style={{ color: "var(--green)" }}>
            Stop runaway agent loops
          </a>
          {" "}·{" "}
          <a href="/guides/ai-agent-budget" style={{ color: "var(--green)" }}>Budgets per team or customer</a>
        </p>
        <h2>Prefer an SDK?</h2>
        <p>
          The{" "}
          <code>spendveto-sdk</code>
          {" "}client (and its Python twin in{" "}
          <code>sdk-python/</code>
          ) governs calls through SpendVeto's enforcement proxy instead —{" "}
          <code>npm run quickstart:ai</code>
          {" "}shows an agent spending a $0.0015 budget down to a refusal.
        </p>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/console/">Open the console demo</a>
        </div>
      </div>
    </Page>
  );
}
