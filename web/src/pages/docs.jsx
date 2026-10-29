import "../styles/pages.css";
import "./docs.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "SpendVeto Docs — x402, MCP & API Reference for AI Agent Spend Governance",
  "description": "Quickstart, CLI commands, full API reference, policy configuration, and MCP setup for SpendVeto — the self-hosted spend controls for AI agents: model tokens, x402, cards, payouts, and the network layer.",
  "path": "/docs",
  "keywords": "x402 documentation, MCP server AI agent, AI agent spend governance API, x402 API reference, AI agent payment policy",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
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
              "name": "Docs",
              "item": "https://spendveto.com/docs"
            }
          ]
        },
        {
          "@type": "TechArticle",
          "headline": "SpendVeto Documentation",
          "about": "x402 and MCP spend governance for AI agents",
          "publisher": {
            "@id": "https://spendveto.com/#org"
          },
          "mainEntityOfPage": "https://spendveto.com/docs"
        }
      ]
    }
  ]
};

export default function DocsPage() {
  return (
    <Page note={<>Prototype — every claim covered by SpendVeto's automated test suite.</>}>
      <div className="docs-wrap">
        <aside>
          <a href="#quickstart">Quickstart</a>
          {" "}
          <a href="#commands">Commands</a>
          {" "}
          <a href="#governance">Governance model</a>
          {" "}
          <a href="#policy">policy.json</a>
          {" "}
          <a href="#delegation">Delegation &amp; scoping</a>
          {" "}
          <a href="#freezes">Kill switch</a>
          {" "}
          <a href="#mcp">MCP setup</a>
          {" "}
          <a href="#sdk">SDK &amp; integrations</a>
          {" "}
          <a href="#api">HTTP API</a>
          {" "}
          <a href="#modes">Modes</a>
          {" "}
          <a href="#verify">Verification</a>
        </aside>
        <article>
          <h1>Documentation</h1>
          <p className="lede">
            SpendVeto is a governance gate in front of a catalog of paid (x402/USDC) endpoints, reachable three ways — CLI, delegated child agents, and any MCP client. Everything on this page is exercised by the 511-assertion suite in{" "}
            <code>npm run verify</code>
            .
          </p>
          <h2 id="quickstart">Quickstart</h2>
          <pre className="block">
            <span className="p">{"$"}</span>
            {" npx spendveto              "}
            <span className="c">{"# API + console on http://127.0.0.1:8402"}</span>
            {"\n"}
            <span className="p">{"$"}</span>
            {" npx spendveto budget 10    "}
            <span className="c">{"# $10/day per agent"}</span>
            {"\n"}
            <span className="p">{"$"}</span>
            {" npx spendveto status       "}
            <span className="c">{"# what every agent spent today"}</span>
          </pre>
          <p>
            No keys, no faucets: the default{" "}
            <b>simulate</b>
            {" "}mode uses real secp256k1 keypairs and real ECDSA verification, settling against a local ledger seeded with $5.00 of simulated USDC.
          </p>
          <h2 id="commands">Commands</h2>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Command</th><th>What it does</th></tr></thead>
              <tbody>
                <tr><td><code>npm run server</code></td><td>Start the governed API + dashboard (:8402)</td></tr>
                <tr>
                  <td><code>npm run call -- &lt;tool&gt; [--child[=label]] [--chain=id] [--dry-run]</code></td>
                  <td>Governed paid call (or a zero-side-effect dry run of the verdict)</td>
                </tr>
                <tr>
                  <td>
                    <code>
                      npm run delegate -- &lt;cap&gt; [label] [--parent &lt;label&gt;] [--tools a,b] [--chains id1,id2] [--ttl 10m]
                    </code>
                  </td>
                  <td>Grant a capped budget — optionally tool-scoped, chain-scoped, and time-boxed</td>
                </tr>
                <tr><td><code>npm run mcp</code></td><td>Start the MCP stdio server exposing the paid catalog</td></tr>
                <tr>
                  <td><code>npm run proxy</code></td>
                  <td>Enforcement proxy (:8404): keyless agents POST intents; custody signs after governance</td>
                </tr>
                <tr>
                  <td><code>npm run policy [-- apply &lt;pack&gt;]</code></td>
                  <td>List or apply policy packs (cautious / standard / production)</td>
                </tr>
                <tr>
                  <td><code>npm run apikey -- [role] [label]</code></td>
                  <td>
                    Mint an admin-surface API key (role: viewer / approver / admin). First key flips the server to auth-required.
                  </td>
                </tr>
                <tr>
                  <td><code>npx spendveto</code> · <code>npm start</code></td>
                  <td>
                    The{" "}
                    <code>spendveto</code>
                    {" "}CLI: starts the server on loopback and prints the one-line setup for Claude Code, Codex and the SDKs; also{" "}
                    <code>spendveto budget &lt;usd/day&gt;</code>
                    ,{" "}
                    <code>status</code>
                    ,{" "}
                    <code>observe</code>
                    {" "}/{" "}
                    <code>enforce</code>
                    ,{" "}
                    <code>freeze</code>
                    {" "}/{" "}
                    <code>unfreeze &lt;agent&gt;</code>
                    ,{" "}
                    <code>connect</code>
                    ,{" "}
                    <code>mcp</code>
                    ,{" "}
                    <code>validate [policy.json] [--strict]</code>
                    {" "}(lint a policy against the open schema; exit 1 on errors — the same check the GitHub Action runs). State lives in{" "}
                    <code>SPENDVETO_DATA_DIR</code>
                    {" "}(default{" "}
                    <code>~/.spendveto</code>
                    {" "}for an installed copy)
                  </td>
                </tr>
                <tr><td><code>npm run verify</code></td><td>511 end-to-end assertions, headless</td></tr>
                <tr><td><code>npm run site</code></td><td>Serve this marketing site (:8403)</td></tr>
              </tbody>
            </table>
          </div>
          <h2 id="governance">Governance model</h2>
          <p>Every call runs the same pipeline, <b>before any payment happens</b>:</p>
          <ul>
            <li><b>Frozen?</b> — manual kill switch or the runaway-burst detector.</li>
            <li><b>Policy</b> — per-call cap, hourly budget, call-rate limit, checked against the live ledger.</li>
            <li><b>Delegation chain</b> — every ancestor's cap and tool scope binds the whole subtree beneath it.</li>
            <li>
              <b>Human approval</b>
              {" "}— prices above the threshold pause for Approve/Deny;{" "}
              <b>no decision in 30s fails closed</b>
              .
            </li>
            <li><b>Pay + prove</b> — x402 settles; the response carries an ECDSA-signed receipt.</li>
          </ul>
          <h2 id="policy">policy.json</h2>
          <pre className="block">
            {"{\n  \"maxPerCallUSD\": 0.05,\n  \"maxPerHourUSD\": 0.2,\n  \"maxCallsPerHour\": 10,\n  \"requireApprovalAboveUSD\": 0.015,\n  \"anomaly\": { \"burstAttempts\": 10, \"burstWindowSeconds\": 10 },\n  \"allowedChains\": [\"base-sepolia\", \"base\"],\n  \"allowedPayees\": [\"0xVendorA…\", \"0xVendorB…\"],   "}
            <span className="c">{"// optional"}</span>
            {"\n  \"alertWebhookUrl\": \"https://hooks.slack.com/…\"   "}
            <span className="c">{"// optional"}</span>
            {"\n}"}
          </pre>
          <p>
            Lives at{" "}
            <code>data/policy.json</code>
            .{" "}
            <b>anomaly</b>
            : a wallet exceeding{" "}
            <code>burstAttempts</code>
            {" "}ledger events inside{" "}
            <code>burstWindowSeconds</code>
            {" "}is frozen automatically.{" "}
            <b>alertWebhookUrl</b>
            : freezes, blocked calls, and pending approvals POST there in real time.{" "}
            <b>allowedChains</b>
            {" "}(optional): pins which chains agents may settle on — omit it to allow all fourteen registered chains.{" "}
            <b>allowedPayees</b>
            {" "}(optional): pins which recipient addresses agents may pay at all — a payment to any other address is refused before it's signed, so a compromised or prompt-injected agent can't reach an attacker's wallet.
          </p>
          <h2 id="delegation">Delegation &amp; scoping</h2>
          <pre className="block">
            <span className="p">{"$"}</span>
            {" npm run delegate -- 0.015 \"team lead\"\n"}
            <span className="p">{"$"}</span>
            {" npm run delegate -- 0.05 \"intern\" --parent \"team lead\"\n"}
            <span className="p">{"$"}</span>
            {" npm run delegate -- 0.02 \"translator\" --tools translate\n"}
            <span className="p">{"$"}</span>
            {" npm run call -- review --child=intern     "}
            <span className="c">{"# blocked when team lead's cap would be exceeded"}</span>
            {"\n"}
            <span className="p">{"$"}</span>
            {" npm run call -- review --child=translator "}
            <span className="c">{"# blocked: outside delegated scope"}</span>
            {"\n"}
            <span className="p">{"$"}</span>
            {" npm run delegate -- 0.02 \"base only\" --chains base-sepolia\n"}
            <span className="p">{"$"}</span>
            {" npm run call -- review --child=\"base only\" --chain=polygon "}
            <span className="c">{"# blocked: outside delegated chain scope"}</span>
          </pre>
          <p>
            Caps and scopes cascade: a grandchild's spend counts against its own cap{" "}
            <b>and every ancestor's</b>
            ; a revoked link (
            <code>POST /api/delegations/:id/revoke</code>
            ) kills the whole branch.
          </p>
          <div className="callout">
            <b>Note:</b>
            {" "}child private keys are stored in gitignored{" "}
            <code>data/children.json</code>
            {" "}— fine for simulate-mode demo money; use a real secret store before funding anything.
          </div>
          <h2 id="freezes">Kill switch</h2>
          <p>
            Freeze from the dashboard (per-wallet button) or the API. Frozen wallets are blocked in their own policy check{" "}
            <b>and</b>
            {" "}refused at the simulate payment gate with 403 — even with a correctly signed payment. The anomaly detector applies the same freeze automatically mid-burst.
          </p>
          <h2 id="mcp">MCP setup</h2>
          <pre className="block">
            <span className="c">{"# Claude Code (server must be running)"}</span>
            {"\n"}
            <span className="p">{"$"}</span>
            {" claude mcp add spendveto -- node /abs/path/spendveto/mcp/server.js"}
          </pre>
          <p>
            Claude sees four tools:{" "}
            <code>review</code>
            ,{" "}
            <code>summarize</code>
            ,{" "}
            <code>translate</code>
            {" "}(priced in their descriptions) and free{" "}
            <code>spendveto_status</code>
            . Every paid call silently runs the full pipeline; blocked calls come back as tool errors naming the gate.
          </p>
          <h2 id="sdk">SDK &amp; integrations</h2>
          <p>
            Two ways to call the governed proxy from code instead of the CLI — both ship in this repo (
            <code>sdk/</code>
            ,{" "}
            <code>integrations/</code>
            ), both exercised by{" "}
            <code>npm run verify</code>
            {" "}against the live proxy, not just parsed.
          </p>
          <h3>Node SDK</h3>
          <pre className="block">
            {"import { SpendVeto, SpendVetoDenialError } from \"./sdk/index.js\";\n\nconst tg = new SpendVeto({ agentToken: \"tg_…\" });  "}
            <span className="c">{"// optional — omit while no agents are registered"}</span>
            {"\ntry {\n  const result = await tg.pay(\"review\");\n} catch (err) {\n  if (err instanceof SpendVetoDenialError) {\n    console.log(err.code, err.suggestion); "}
            <span className="c">{"// e.g. \"delegation_cap\", \"pick a cheaper tool…\""}</span>
            {"\n  }\n}"}
          </pre>
          <p>
            <code>.pay(toolId, opts)</code>
            ,{" "}
            <code>.dryRun(toolId, opts)</code>
            ,{" "}
            <code>.chat(prompt, opts)</code>
            {" "}(governed LLM/API spend),{" "}
            <code>.registerAgent(label, opts)</code>
            ,{" "}
            <code>.catalog()</code>
            . A blocked call always throws{" "}
            <code>SpendVetoDenialError&#123;code, suggestion, stage&#125;</code>
            {" "}instead of silently no-oping.
          </p>
          <h3>LangChain</h3>
          <pre className="block">
            {"import { createSpendVetoTools } from \"./integrations/langchain.js\";\n\nconst tools = await createSpendVetoTools({ agentToken: \"tg_…\" });\n"}
            <span className="c">
              {"// [{ name: \"spendveto_review\", description: \"…\", func: async () => \"…\" }, …]\n// pass into tool() from \"@langchain/core/tools\" for a first-class StructuredTool"}
            </span>
          </pre>
          <p>
            Dependency-free — no{" "}
            <code>@langchain/core</code>
            {" "}install required to use these, so it doesn't force LangChain on anyone who isn't using it. One tool per live catalog entry, fetched fresh each call so marketplace tools show up automatically.
          </p>
          <h2 id="api">HTTP API (:8402)</h2>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Endpoint</th><th>Purpose</th></tr></thead>
              <tbody>
                <tr><td><code>GET /api/catalog</code></td><td>Priced tool catalog</td></tr>
                <tr>
                  <td><code>GET /api/ledger</code> · <code>POST /api/ledger/event</code></td>
                  <td>Full ledger; client-side event logging</td>
                </tr>
                <tr>
                  <td><code>GET /api/stats</code> · <code>GET /api/analytics</code></td>
                  <td>Paid/blocked totals; per-tool, per-wallet + per-chain rollups</td>
                </tr>
                <tr>
                  <td><code>GET /metrics</code></td>
                  <td>Same numbers as <code>/api/stats</code>, in Prometheus text-exposition format</td>
                </tr>
                <tr>
                  <td><code>GET /api/chains</code></td>
                  <td>
                    20-chain registry across eight signature families: status, per-chain settlement (live / ready / simulated), canonical stablecoin address, RPC
                  </td>
                </tr>
                <tr>
                  <td><code>GET /api/rails</code></td>
                  <td>
                    Rail adapter registry — one pay() contract; x402 live, AP2/ACP/MPP/Safe-AllowanceModule slots (see{" "}
                    <code>docs/safe-allowance.md</code>
                    {" "}in the repo)
                  </td>
                </tr>
                <tr>
                  <td><code>GET /api/receipts/:id</code> · <code>POST /api/receipts/verify</code></td>
                  <td>Receipt lookup + independent ECDSA verification</td>
                </tr>
                <tr>
                  <td><code>GET /api/ledger/verify-chain</code></td>
                  <td>Tamper-evidence: confirm the ledger hash-chain is intact; reports the first broken row</td>
                </tr>
                <tr>
                  <td><code>GET /api/shadow</code> · <code>PUT</code> · <code>DELETE</code></td>
                  <td>
                    Shadow mode: set a candidate policy that runs without enforcing, read the divergence report, or clear it
                  </td>
                </tr>
                <tr>
                  <td><code>POST /proxy/llm</code></td>
                  <td>API-spend rail: estimate → govern → execute → meter actual cost (:8404)</td>
                </tr>
                <tr>
                  <td><code>POST /api/catalog/tools</code></td>
                  <td>Marketplace: register a paid tool behind the governance gate</td>
                </tr>
                <tr>
                  <td><code>POST /api/balances/topup</code></td>
                  <td>Fund a per-chain balance (simulate mode only)</td>
                </tr>
                <tr>
                  <td><code>POST /proxy/agents</code></td>
                  <td>Agent identities: bearer tokens, optionally wallet-bound (:8404)</td>
                </tr>
                <tr>
                  <td><code>GET /api/report?days=N</code></td>
                  <td>Spend report: headline, category/chain breakdown, top block reasons</td>
                </tr>
                <tr>
                  <td><code>GET /api/approvals/:id/decide?decision=…&amp;token=…</code></td>
                  <td>One-click approve/deny — the links the webhook alert carries. Each token is bound to its approval and decision; a link without it is refused</td>
                </tr>
                <tr><td><code>GET /api/export.csv</code></td><td>Audit export</td></tr>
                <tr>
                  <td><code>GET/POST /api/approvals</code> · <code>POST /api/approvals/:id/decide</code></td>
                  <td>Human-in-the-loop queue</td>
                </tr>
                <tr>
                  <td><code>GET/POST /api/delegations</code> · <code>POST /api/delegations/:id/revoke</code></td>
                  <td>Budget grants (caps + scopes)</td>
                </tr>
                <tr>
                  <td><code>GET/POST /api/freezes</code> · <code>POST /api/freezes/:id/unfreeze</code></td>
                  <td>Kill switch</td>
                </tr>
                <tr>
                  <td><code>GET /api/trust/:address</code></td>
                  <td>Agent trust score (0–100 + grade) from governance history</td>
                </tr>
                <tr>
                  <td><code>POST /api/acp/checkout</code></td>
                  <td>
                    ACP: check a checkout session against the shared payment token that funds it — merchant, ceiling, category, currency, and whether the declared total matches its own line items
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/mpp/evaluate</code></td>
                  <td>
                    MPP (Stripe + Tempo): send the 402's{" "}
                    <code>WWW-Authenticate</code>
                    {" "}value (or the challenges mppx parsed); every offer is priced or refused, MPP's own rules run (splits as payees, session escrow and deposit cap, subscriptions to a human, expired or malformed challenges), then the policy engine. Returns the offer to pay plus a{" "}
                    <code>chargeId</code>
                    {" "}or{" "}
                    <code>sessionId</code>
                    {" "}— allowed money is held at once.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/mpp/charges/:id/report</code>
                    {" "}·{" "}
                    <code>POST /api/mpp/sessions/:id/voucher</code>
                    {" "}·{" "}
                    <code>/close</code>
                    {" "}·{" "}
                    <code>GET /api/mpp</code>
                  </td>
                  <td>
                    Report a charge paid (with the server's{" "}
                    <code>Payment-Receipt</code>
                    ) or failed; record cumulative vouchers (never backwards, never past the approved deposit); close a session to book what it consumed. Unreported charges are booked as paid when their challenge expires.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/outofband/scan</code>
                    {" "}·{" "}
                    <code>POST /api/outofband/transfers</code>
                    {" "}·{" "}
                    <code>GET /api/outofband</code>
                  </td>
                  <td>
                    Out-of-band spend: reconcile the governed wallets' on-chain stablecoin transfers (read from each chain's RPC, or delivered by an indexer webhook) against the ledger. A transfer SpendVeto never authorized is booked as{" "}
                    <code>unmanaged</code>
                    {" "}against the same budgets and delegation caps, alerted, and with{" "}
                    <code>outOfBand.onDetect: "freeze"</code>
                    {" "}freezes the wallet.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>spendveto guard &lt;provider&gt;</code>
                    {" "}·{" "}
                    <code>POST /api/mcpguard/evaluate</code>
                    {" "}·{" "}
                    <code>/calls/:id/report</code>
                    {" "}·{" "}
                    <code>GET /api/mcpguard</code>
                  </td>
                  <td>
                    The MCP guard: launched in place of a payment provider's MCP server (Razorpay, Stripe, PayPal, Cashfree, Square, or any server with{" "}
                    <code>generic</code>
                    ). Reads pass; every other call is classified and decided here — refunds and transfers priced and budgeted (
                    <code>policy.mcpGuard</code>
                    , FX from{" "}
                    <code>policy.payouts.fxRates</code>
                    ), risky changes to a human, unknown tools refused — and a spend is booked only when the provider confirms it.
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/integrity/bind</code> · <code>POST /api/integrity/verify</code></td>
                  <td>
                    Request integrity: bind an authorization to a canonical digest of the request, then refuse at execution if the payload changed. Single-use, TTL-bounded, agent-scoped
                  </td>
                </tr>
                <tr>
                  <td><code>GET /api/disputes/:entryHash/evidence</code> · <code>POST /api/disputes/verify</code></td>
                  <td>
                    Dispute evidence pack: the spend pinned in its hash chain, the policy in force, the approval and the signed consents — one bundle, signed over its own digest
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/upto/authorize</code></td>
                  <td>
                    x402{" "}
                    <code>upto</code>
                    {" "}scheme: record a variable-amount authorization. Policy decides on{" "}
                    <code>maxUSD</code>
                    {" "}— the ceiling the signature permits — not the price the seller quoted, and the open ceiling is held against the budget until it resolves
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/upto/settle</code> · <code>POST /api/upto/void</code></td>
                  <td>
                    Settle the amount actually charged (releasing the unused headroom back to the budget) or cancel the authorization. Settling above the maximum, twice, or after the deadline is refused:{" "}
                    <code>upto_over_settlement</code>
                    ,{" "}
                    <code>upto_already_settled</code>
                    ,{" "}
                    <code>upto_expired</code>
                  </td>
                </tr>
                <tr>
                  <td><code>GET /api/upto</code> · <code>GET /api/upto/holds/:address</code></td>
                  <td>
                    Open authorizations, released headroom, and seller utilisation — plus the single number the budget check folds in: how much this wallet has signed away but not yet spent
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>POST /v1/messages</code>
                    {" "}·{" "}
                    <code>POST /v1/chat/completions</code>
                    {" "}·{" "}
                    <code>POST /v1/responses</code>
                  </td>
                  <td>
                    The LLM spend guard: point Claude Code (
                    <code>ANTHROPIC_BASE_URL</code>
                    ), Codex or any OpenAI/Anthropic SDK (
                    <code>OPENAI_BASE_URL=…/v1</code>
                    ) at the server. Each request is checked against the agent's daily / hourly / per-request / per-session budget, requests-per-minute limit (429 +{" "}
                    <code>retry-after</code>
                    ), model allow/block list, kill switch and loop detector before it reaches the provider; the actual cost is booked from the provider's usage. Refusals: HTTP 402 with{" "}
                    <code>spendveto.code</code>
                    {" "}(
                    <code>llm_daily_budget</code>
                    ,{" "}
                    <code>llm_loop_detected</code>
                    ,{" "}
                    <code>frozen</code>
                    ,{" "}
                    <code>delegation_cap</code>
                    …). Also served under{" "}
                    <code>/anthropic/v1/*</code>
                    {" "}and{" "}
                    <code>/openai/v1/*</code>
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/llm/summary</code>
                    {" "}·{" "}
                    <code>GET /api/llm/connect</code>
                    {" "}·{" "}
                    <code>GET|PUT /api/llm/settings</code>
                  </td>
                  <td>
                    Per-agent model spend (24h, last hour, remaining, top models, sessions, freezes), recent decisions; copy-paste connection lines; the guard's settings (
                    <code>policy.llm</code>
                    : budgets,{" "}
                    <code>mode</code>
                    {" "}enforce/observe,{" "}
                    <code>loop</code>
                    ,{" "}
                    <code>allowedModels</code>
                    /
                    <code>blockedModels</code>
                    ,{" "}
                    <code>prices</code>
                    {" "}overrides,{" "}
                    <code>requireAgentToken</code>
                    )
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/cards/stripe/authorization</code> · <code>POST /api/cards/lithic/asa</code></td>
                  <td>
                    Card authorization webhooks (Stripe Issuing real-time authorizations, Lithic Auth Stream Access), signature-verified, answered in each provider's format.{" "}
                    <code>policy.cards</code>
                    :{" "}
                    <code>maxAuthorizationUSD</code>
                    ,{" "}
                    <code>dailyBudgetUSD</code>
                    ,{" "}
                    <code>maxAuthorizationsPerHour</code>
                    ,{" "}
                    <code>blockedMccs</code>
                    /
                    <code>allowedMccs</code>
                    ,{" "}
                    <code>allowedCurrencies</code>
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/payouts</code></td>
                  <td>
                    Governed fiat payout:{" "}
                    <code>
                      &#123; provider: "stripe"|"razorpayx"|"paypal"|"moderntreasury", amount, currency, payee, method, purpose, idempotencyKey, tags &#125;
                    </code>
                    {" "}with the agent's{" "}
                    <code>tg_</code>
                    {" "}token. Caps, daily budget, velocity, purpose list, delegation caps; a new payee or large amount returns 202 and waits for a human approval in the Console. Non-USD needs an operator-declared rate in{" "}
                    <code>policy.payouts.fxRates</code>
                    .{" "}
                    <code>GET /api/payouts</code>
                    {" "}lists providers (configured or not) and recent payouts
                  </td>
                </tr>
                <tr>
                  <td><code>GET /api/costs?groupBy=…</code> · <code>GET /api/costs/focus.csv</code></td>
                  <td>
                    One cost view across model tokens, x402 tools, cards and payouts, grouped by rail, any request tag (
                    <code>x-spendveto-tags: team=…,customer=…</code>
                    ), agent, model or provider; model spend exported as FOCUS v1.4 (all 21 mandatory columns)
                  </td>
                </tr>
                <tr>
                  <td><code>GET|PUT /api/rebilling</code></td>
                  <td>
                    Customer-tagged model spend → Stripe Billing meter events at your markup (micro-dollars, de-duplicated); cost, billed and margin per customer.{" "}
                    <code>policy.llm.tagBudgets</code>
                    {" "}caps a customer's or team's spend across agents
                  </td>
                </tr>
                <tr>
                  <td><code>GET|POST /api/cards</code> · <code>GET /api/cards/decisions</code></td>
                  <td>
                    Register a card to an agent label (and optionally a delegated wallet, sharing its cascading cap); recent card decisions
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/authcapture/evaluate</code> · <code>POST /api/authcapture/authorize</code></td>
                  <td>
                    x402{" "}
                    <code>auth-capture</code>
                    {" "}scheme: vet a route before signing (canonical escrow and collector, deadline order,{" "}
                    <code>policy.authCapture.maxHoldSeconds</code>
                    {" "}/{" "}
                    <code>minRefundWindowSeconds</code>
                    , fee recipient, collect-only routes that would strand funds), then decide on the authorized maximum.{" "}
                    <code>authorize</code>
                    {" "}also records the escrow hold against the budget
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/authcapture/:id/capture</code>
                    {" "}·{" "}
                    <code>/charge</code>
                    {" "}·{" "}
                    <code>/void</code>
                    {" "}·{" "}
                    <code>/refund</code>
                    {" "}·{" "}
                    <code>/reclaimed</code>
                  </td>
                  <td>
                    Seller lifecycle checked against the signed terms:{" "}
                    <code>ac_over_capture</code>
                    ,{" "}
                    <code>ac_capture_after_deadline</code>
                    ,{" "}
                    <code>ac_already_charged</code>
                    ,{" "}
                    <code>ac_over_charge</code>
                    ,{" "}
                    <code>ac_over_refund</code>
                    ,{" "}
                    <code>ac_refund_after_deadline</code>
                    . Captured or charged money enters the ledger; the maximum never does
                  </td>
                </tr>
                <tr>
                  <td><code>GET /api/authcapture</code> · <code>GET /api/authcapture/reclaimable</code></td>
                  <td>
                    Payments, held / captured / refunded totals — and money left behind: holds past their capture deadline that only the buyer's own{" "}
                    <code>reclaim</code>
                    {" "}can recover
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/attestations</code></td>
                  <td>
                    Governed-spend attestation:{" "}
                    <code>&#123; address, resource, price, payee?, rail?, chain?, toolId?, category? &#125;</code>
                    . Runs the server-side policy check first; 403 with the policy's own code on a refusal, 409{" "}
                    <code>approval_required</code>
                    {" "}above the approval line until a human has approved. Returns{" "}
                    <code>&#123; token: "sva1.…", claims &#125;</code>
                    {" "}— send the token as{" "}
                    <code>X-SpendVeto-Attestation</code>
                    {" "}with the payment (the SDK path does this automatically)
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/attestations/verify</code>
                    {" "}·{" "}
                    <code>GET /api/attestations</code>
                    {" "}·{" "}
                    <code>GET /.well-known/spendveto-issuer.json</code>
                  </td>
                  <td>
                    Check a token the way a seller would (this instance plus{" "}
                    <code>policy.attestations.trustedIssuers</code>
                    ; nothing consumed); recent attestations issued; the issuer address a seller pins. Sellers verify offline with{" "}
                    <code>integrations/seller-express.js</code>
                    {" "}→{" "}
                    <code>requireGovernedAgent(&#123; trustedIssuers, audience, price &#125;)</code>
                  </td>
                </tr>
                <tr>
                  <td><code>POST /api/reputation/reports</code> · <code>DELETE /api/reputation/reports/:id</code></td>
                  <td>
                    Report a counterparty (
                    <code>&#123; subject, kind, severity: "block"|"review", reason, share &#125;</code>
                    ) — an address, UPI VPA, IBAN, email, domain or{" "}
                    <code>card-merchant:&lt;network id&gt;</code>
                    . Enforced by the policy engine, payouts and card authorizations
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/reputation/feed</code>
                    {" "}·{" "}
                    <code>POST /api/reputation/import</code>
                    {" "}·{" "}
                    <code>PUT /api/reputation/settings</code>
                  </td>
                  <td>
                    Publish your reports as a signed feed of hashes; import another publisher's feed (only if its address is in{" "}
                    <code>trustedPublishers</code>
                    ; edited, forged and rolled-back feeds refused); set{" "}
                    <code>trustedPublishers</code>
                    ,{" "}
                    <code>importedAction</code>
                    {" "}(
                    <code>deny</code>
                    {" "}|{" "}
                    <code>review</code>
                    ),{" "}
                    <code>publisherName</code>
                  </td>
                </tr>
                <tr>
                  <td><code>GET /api/reputation</code> · <code>GET /api/reputation/check?subject=…</code></td>
                  <td>
                    Reports, imported feeds and settings; the verdict (
                    <code>block</code>
                    {" "}|{" "}
                    <code>review</code>
                    {" "}|{" "}
                    <code>clear</code>
                    ) for one or more counterparties
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/policy/validate</code>
                    {" "}·{" "}
                    <code>GET /api/policy/validate</code>
                    {" "}·{" "}
                    <code>GET /api/policy/schema</code>
                  </td>
                  <td>
                    Validate a policy (or the live one) against the open policy-v1 schema: unknown keys with did-you-mean, types, enums, registered chain ids, contradictory-limit warnings; the schema itself (also at{" "}
                    <code>https://spendveto.com/schemas/policy-v1.json</code>
                    )
                  </td>
                </tr>
                <tr>
                  <td><code>GET /api/otel/spans</code></td>
                  <td>
                    Governance decisions as OTLP spans; pass a W3C{" "}
                    <code>traceparent</code>
                    {" "}and the refusal lands inside the agent trace that caused it
                  </td>
                </tr>
                <tr><td><code>GET /api/policy</code></td><td>Active policy</td></tr>
              </tbody>
            </table>
          </div>
          <h2 id="network">The network layer</h2>
          <p>
            Three open formats, specified in{" "}
            <a href="/spec/NETWORK.md">the published specification</a>
            :{" "}
            <b>governed-spend attestations</b>
            {" "}(
            <code>sva1</code>
            {" "}tokens a seller verifies offline),{" "}
            <b>reputation feeds</b>
            {" "}(signed lists of hashed counterparties, imported only from publishers you trust), and the{" "}
            <b>policy schema</b>
            {" "}(
            <code>https://spendveto.com/schemas/policy-v1.json</code>
            ). Add{" "}
            <code>"$schema": "https://spendveto.com/schemas/policy-v1.json"</code>
            {" "}to a policy file for editor autocomplete, and lint it in CI:
          </p>
          <pre className="block">{"- run: npx spendveto validate config/agent-policy.json --strict"}</pre>
          <p>A seller that only sells to governed agents adds one middleware:</p>
          <pre className="block">
            {"import { requireGovernedAgent } from \"spendveto/integrations/seller-express.js\";\napp.get(\"/api/report\", requireGovernedAgent({ trustedIssuers: [\"0xBuyerIssuer…\"], audience: \"0xYourPayTo…\", price: 0.25 }), handler);"}
          </pre>
          <h2 id="modes">Modes</h2>
          <p>
            <b>simulate</b>
            {" "}(default): real keypairs, real signature verification, nonce replay protection, local settlement — zero setup.{" "}
            <b>testnet</b>
            : the real x402 v2 packages, facilitator-adaptive: the gate asks its facilitator what it can settle at boot and brings every supported registry chain live (multi-chain 402s, per-chain USDC). The public facilitator settles Base Sepolia — fund one wallet at faucet.circle.com and set{" "}
            <code>SPENDVETO_MODE=testnet</code>
            ; a CDP facilitator key unlocks its mainnet chains with zero code changes.
          </p>
          <h2 id="verify">Verification</h2>
          <p>
            <code>npm run verify</code>
            {" "}boots everything headlessly and runs{" "}
            <b>511 assertions</b>
            : forged-signature rejection, all three approval outcomes, cascading caps, tool + chain scoping, chain-scoped signatures with per-chain balances, burst auto-freeze, manual freeze/unfreeze, signed-receipt verification, CSV export, per-chain analytics, webhook delivery to a live receiver, and a real MCP stdio JSON-RPC session.
          </p>
        </article>
      </div>
    </Page>
  );
}
