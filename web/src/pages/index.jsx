import "./index.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "SpendVeto — Spend Limits & a Kill Switch for AI Agents",
  "description": "Budgets, loop detection and a kill switch for AI agents — Claude Code, Codex, OpenAI/Anthropic SDKs, x402, cards and payouts. Self-hosted; 510 tested claims.",
  "path": "/",
  "keywords": "AI agent spending limit, AI agent budget, Claude Code cost limit, Codex budget, LLM budget proxy, AI agent kill switch, runaway agent loop, agent payments governance, x402, agentic commerce, AI FinOps, spend attestation, MCP",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": "https://spendveto.com/#org",
          "name": "SpendVeto",
          "url": "https://spendveto.com",
          "logo": "https://spendveto.com/assets/generated/og-default.png",
          "sameAs": [
            "https://www.npmjs.com/package/spendveto"
          ],
          "founder": [
            {
              "@type": "Person",
              "name": "Revanth Rajeev"
            },
            {
              "@type": "Person",
              "name": "Harshil HK"
            }
          ]
        },
        {
          "@type": "WebSite",
          "@id": "https://spendveto.com/#website",
          "url": "https://spendveto.com",
          "name": "SpendVeto",
          "description": "Spend governance for AI agents that pay for things.",
          "publisher": {
            "@id": "https://spendveto.com/#org"
          },
          "inLanguage": "en"
        },
        {
          "@type": "SoftwareApplication",
          "@id": "https://spendveto.com/#app",
          "name": "SpendVeto",
          "applicationCategory": "DeveloperApplication",
          "applicationSubCategory": "AI agent spend governance",
          "softwareVersion": "0.32.0",
          "operatingSystem": "Cross-platform (Node.js)",
          "url": "https://spendveto.com",
          "downloadUrl": "https://www.npmjs.com/package/spendveto",
          "programmingLanguage": "JavaScript",
          "description": "Buyer-side spend governance for AI agents. Payment rails move an agent's money; SpendVeto decides whether it should be allowed to move it — per-call caps, hourly budgets, rate limits, payee allowlists, human approvals that fail closed, nested budget delegation, runaway auto-freeze, a hash-chained tamper-evident ledger, request-integrity binding, ACP/AP2 mandate-scope checks, dispute evidence packs, and OpenTelemetry decision spans. Self-hosted, x402 and MCP native.",
          "featureList": [
            "Per-call caps, hourly budgets and call-rate limits enforced before payment",
            "Human-in-the-loop approvals that fail closed on timeout",
            "Nested budget delegation with cascading caps (IAM for money)",
            "Payee allowlisting and chain-scoped signatures",
            "Runaway-burst auto-freeze and a manual kill switch",
            "Hash-chained tamper-evident audit ledger with signed receipts",
            "Request integrity: authorizations bound to a canonical digest of the request",
            "ACP shared-payment-token and AP2 mandate-chain scope checks",
            "Machine Payments Protocol (Stripe + Tempo) governance inside the mppx client: charges, session deposits, subscriptions",
            "Out-of-band spend detection: payments a governed wallet makes around the gate, found on-chain and counted against the same caps",
            "spendveto guard: budgets and approvals in front of Razorpay, Stripe, PayPal, Cashfree and Square MCP servers",
            "Dispute evidence packs for agent-initiated chargebacks",
            "OpenTelemetry decision spans and Prometheus metrics",
            "MCP server, Node SDK, LangChain and OpenAI Agents adapters",
            "Regional payment-mandate governance for India (UPI), EU (SEPA/PSD2), UK (Faster Payments), Brazil (Pix) and the US (ACH)",
            "OFAC sanctions/denylist screening wired into the live policy gate",
            "LLM spend guard for Claude Code, Codex and OpenAI/Anthropic SDKs: per-agent budgets, loop detection, rate limits, kill switch",
            "Card authorization decisions for Stripe Issuing and Lithic",
            "Governed fiat payouts through Stripe, RazorpayX (UPI, IMPS, NEFT, RTGS), PayPal and Modern Treasury (ACH, RTP, wire)",
            "AI FinOps: tag allocation, tag budgets, FOCUS v1.4 export, Stripe Billing rebilling",
            "Governed-spend attestations a seller verifies offline",
            "Federated counterparty reputation feeds shared as signed hashes",
            "Open policy standard (JSON Schema) with a CLI and API validator"
          ],
          "offers": [
            {
              "@type": "Offer",
              "name": "Self-host",
              "price": "0",
              "priceCurrency": "USD",
              "description": "Free to self-host"
            },
            {
              "@type": "Offer",
              "name": "Desk",
              "price": "49",
              "priceCurrency": "USD",
              "description": "Hosted, per month"
            },
            {
              "@type": "Offer",
              "name": "Team",
              "price": "199",
              "priceCurrency": "USD",
              "description": "Hosted, per month plus 0.5% of governed spend"
            }
          ],
          "isAccessibleForFree": true,
          "publisher": {
            "@id": "https://spendveto.com/#org"
          }
        },
        {
          "@type": "FAQPage",
          "@id": "https://spendveto.com/#faq",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "Is this a real product or a demo?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Real. It runs on your machine today: real ECDSA signatures, real x402 settlement on six testnets, and a 510-assertion end-to-end suite (npm run verify) that exercises every claim on this page. Hosted SpendVeto isn't self-serve yet: we set it up directly with each team, and managed custody, orgs and SSO are still being built."
              }
            },
            {
              "@type": "Question",
              "name": "Does SpendVeto hold my keys?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Your choice of two trust models, both self-hosted. Library mode: agents hold their own wallets and the governance pipeline runs inside their own call path. Enforcement proxy: agents are keyless — they POST spending intents, and the proxy’s custody wallet signs only after freeze, policy, caps, scopes, and approvals all pass. Keys never leave your machine either way."
              }
            },
            {
              "@type": "Question",
              "name": "Which chains work today?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Twenty registered chains across eight signature families run the full governed pipeline end to end — chain-scoped signatures, per-chain balances, chain allowlists. On-chain settlement is live on six testnets (Base Sepolia, Solana devnet, Aptos, Stellar, Hedera and XRPL testnet) through x402’s public facilitator; the rest settle locally until a facilitator supports them. XRPL mainnet is wired but off unless an operator opts in."
              }
            },
            {
              "@type": "Question",
              "name": "What happens when an agent goes rogue?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "The burst detector freezes it mid-loop — by default, ten payment attempts inside ten seconds trips the freeze automatically. Every wallet also has a one-click manual kill switch. A frozen wallet is refused even when it presents a correctly signed payment (403, not a fresh challenge), and its trust score collapses to an F."
              }
            },
            {
              "@type": "Question",
              "name": "What does “simulate mode” actually simulate?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Only the settlement. Keypairs, ECDSA signing and verification, nonce replay protection, signed receipts — all real cryptography; balances just settle in a local file instead of on-chain. Forged signatures are rejected, and that rejection is one of the 510 tested assertions. Flip one env var for real x402 on Base Sepolia."
              }
            },
            {
              "@type": "Question",
              "name": "What will the hosted platform add?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "The parts a company needs to run this for a fleet: a managed custody proxy on the money path, orgs and SSO, a Postgres audit trail, alert routing, and mainnet settlement. Book a call — the chains design partners need literally decide which adapters we build first."
              }
            },
            {
              "@type": "Question",
              "name": "Is there an SDK, or just the CLI?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Both. A dependency-free Node SDK (sdk/ — .pay(), .dryRun(), .chat(), throws a typed denial with the fix attached) and a LangChain adapter (integrations/) ship in the repo alongside the CLI and MCP server — same governed pipeline underneath all four. Code samples in the docs."
              }
            },
            {
              "@type": "Question",
              "name": "How do I set a spending limit for Claude Code or Codex?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Run npx spendveto, then start Claude Code with ANTHROPIC_BASE_URL=http://127.0.0.1:8402 (Codex: OPENAI_BASE_URL=http://127.0.0.1:8402/v1). Every request is checked against a per-agent daily, hourly, per-request and per-session budget before it reaches the provider, and the actual cost is booked from the provider's own usage report. spendveto budget 10 sets $10 a day per agent. Your API key passes through and is never stored."
              }
            },
            {
              "@type": "Question",
              "name": "How do I stop a runaway AI agent loop from running up a bill?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "SpendVeto's loop detector freezes an agent that keeps making the same successful tool call and getting the same result, so the loop stops before the next model call is paid for; retries of a failed request don't count. A requests-per-minute limit answers bursts with a real 429, budgets cap the damage, and any agent can be frozen from the Console or with spendveto freeze."
              }
            },
            {
              "@type": "Question",
              "name": "Is SpendVeto tied to one payment provider?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "No. One policy and one ledger decide spend on model tokens, x402 stablecoin payments on 20 chains, Stripe Issuing and Lithic cards, and Stripe, RazorpayX, PayPal and Modern Treasury payouts. A provider's own controls see only its own rail, while an agent's budget has to cover all of them. Its attestations, reputation feeds and policy schema are open formats anyone can verify or implement."
              }
            },
            {
              "@type": "Question",
              "name": "Can a seller check that an AI agent's spending is governed?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes. When the buyer's policy allows a payment, SpendVeto signs a short-lived governed-spend attestation naming the payer, payee, resource and ceiling, and sends it with the payment. The seller verifies it offline against the issuer address it trusts, with one Express middleware and no call to SpendVeto. The seller learns which policy version governed the spend, not the buyer's limits."
              }
            },
            {
              "@type": "Question",
              "name": "Do reputation feeds share my data with other companies?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Only what you choose to publish, and only as hashes: a feed lists hashed counterparty identifiers with a kind and severity — no raw addresses, reasons, amounts or customers. Another company imports it only if it explicitly trusts your issuer address, and edited or rolled-back feeds are refused."
              }
            }
          ]
        }
      ]
    }
  ]
};

// Behaviour lives in index.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

export default function IndexPage() {
  return (
    <Page home note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>} before={<><div id="noise" aria-hidden="true"></div><div id="scroll-progress" aria-hidden="true"></div></>}>
      <header className="hero" id="top">
        <canvas id="bg" aria-hidden="true"></canvas>
        <img className="hero-grip" src="/assets/hero-grip.jpg" alt="" aria-hidden="true" />
        <div className="hero-inner">
          <div className="live-chip"><i></i><span id="live-stats">510 end-to-end checks · verified build</span></div>
          <h1>Your agents can spend.<br /><span className="accent">SpendVeto decides.</span></h1>
          <p className="hero-sub">
            {" "}AI agents now spend money on their own — model tokens, paid APIs, other agents, card checkouts — at machine speed.{" "}
            <strong>
              SpendVeto puts a budget, a loop detector and a kill switch in front of every one of them, and decides before anything is spent.
            </strong>
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="/ai-spend">Cap your agent's spend in one line</a>
            {" "}
            <a className="btn btn-ghost" href="/playground">Try the live playground</a>
            {" "}
            <a className="btn btn-ghost" href="/console/">Open the console demo</a>
          </div>
        </div>
        <div className="console-stage">
          <div className="underlight" aria-hidden="true"></div>
          <div className="horizon" aria-hidden="true"></div>
          <span className="float-chip pass chip-1"><i></i>review · <b>paid $0.01</b> · receipt ✓</span>
          {" "}
          <span className="float-chip hold chip-2"><i></i>summarize $0.02 · <b>awaiting human</b></span>
          {" "}
          <span className="float-chip stop chip-3"><i></i><b>BLOCKED</b> · ancestor cap $0.015</span>
          {" "}
          <span className="float-chip stop chip-4"><i></i>scraper · <b>auto-frozen</b> · runaway</span>
          <div className="console hud">
            <div className="console-head mono">
              <span>WALLET 0x1F45…C0Cf</span>
              <span className="mode">SIMULATE</span>
            </div>
            <div className="console-balance">$4.955 <small>USDC</small></div>
            <div className="console-sub mono">governed by spendveto policy · 4 gates active</div>
            <div className="console-policy mono">
              <div className="row"><span>per-call cap</span><span className="ok">$0.05 ✓</span></div>
              <div className="row"><span>hourly budget</span><span className="ok">$0.045 / $0.20 ✓</span></div>
              <div className="row"><span>approval line</span><span className="warn">&gt; $0.015 → human</span></div>
              <div className="row"><span>burst guard</span><span className="ok">armed · 10/10s</span></div>
            </div>
            <div className="console-actions">
              <span className="buy">review $0.01</span>
              {" "}
              <span>summarize $0.02</span>
            </div>
          </div>
        </div>
        <div className="chips-fallback" aria-hidden="true"></div>
      </header>
      <div className="ticker" aria-hidden="true">
        <div className="ticker-track" id="ticker-track">
          <span><b>169M+</b> x402 payments cleared</span>
          {" "}
          <span><b>590,000</b> buyers · 100,000 sellers</span>
          {" "}
          <span><b>$4.5T</b> stablecoin volume in Q1 2026</span>
          {" "}
          <span><b>$3–5T</b> agentic commerce by 2030 — McKinsey</span>
          {" "}
          <span><b>0</b> dollars move without a policy decision</span>
          {" "}
          <span><b>Signed</b> spend attestations · sellers verify offline</span>
          {" "}
          <span><b>Shared</b> fraud reports across companies · hashes, never data</span>
          {" "}
          <span><b>MCP</b> · governance the model can't opt out of</span>
          {" "}
          <span>
            <b>Multi-chain</b>
            {" "}· 20 chains governed, eight signature families · chain-scoped signatures · per-chain balances · six testnets live on-chain
          </span>
        </div>
      </div>
      <section id="demo">
        <div className="shell">
          <p className="counter reveal"><b>DEMO</b> 65 seconds, no narration to trust — just the product</p>
          <h2 className="reveal">Watch the whole thing work, live.</h2>
          <p className="lede reveal">
            The playground, the console, the ledger, budget delegation, multi-chain settlement — one continuous run, not slides.
          </p>
          <button className="video-frame reveal" id="demo-video" aria-label="Play the SpendVeto demo video" type="button">
            <img src="/assets/demo-poster.jpg" alt="SpendVeto console mid-demo: policy engine blocking a runaway burst" loading="lazy" />
            {" "}
            <span className="video-play">
              <span><svg viewBox="0 0 24 24" fill="#070a08"><path d="M8 5v14l11-7z"></path></svg></span>
            </span>
          </button>
        </div>
      </section>
      <section id="problem">
        <div className="shell" data-num="01">
          <p className="counter reveal"><b>01 / 06</b> The problem</p>
          <h2 className="reveal">An agent with a wallet is a corporate card with no limit — issued to software.</h2>
          <div className="split">
            <div>
              <div className="problem-points">
                <p className="point reveal">
                  <span>
                    <b>Every rail answers "how does the agent pay?"</b>
                    {" "}Coinbase, Stripe, Visa, Mastercard, Google, Cloudflare — all shipping agent payments in 2026.
                  </span>
                </p>
                <p className="point reveal">
                  <span>
                    <b>Almost nobody answers the question teams ask first:</b>
                    {" "}how do I stop it from overspending? Runaway loops don't get tired. They get invoiced.
                  </span>
                </p>
                <p className="point reveal">
                  <span>
                    <b>SpendVeto is the buyer side.</b>
                    {" "}The policy layer that sits above every rail — self-hosted, developer-first, plugged into the stack agents already use.
                  </span>
                </p>
              </div>
            </div>
            <div className="terminal mono reveal hud">
              <div className="dots"><i></i><i></i><i></i></div>
              <div><span className="t-dim">$</span>{" "}<span className="t-cmd">npm run call -- summarize</span></div>
              <div className="t-dim">Policy check passed (2 calls / $0.0150 this hour).</div>
              <div className="t-warn">
                Price $0.02 is above the $0.015 auto-approve line —
                <br />
                requesting human sign-off on the dashboard.
              </div>
              <div className="t-bad">DENIED by approver. Nothing was spent.</div>
              <div style={{ marginTop: "0.9rem" }}>
                <span className="t-dim">$</span>
                {" "}
                <span className="t-cmd">npm run call -- review --child=intern</span>
              </div>
              <div className="t-bad">
                BLOCKED: would exceed delegated budget cap $0.015
                <br />
                granted to ancestor "team lead"
              </div>
              <div style={{ marginTop: "0.9rem" }}>
                <span className="t-dim">$</span>
                {" "}
                <span className="t-cmd">npm run call -- review</span>
              </div>
              <div className="t-ok">Paid $0.01 USDC — signed receipt a41f…9c02 ✓</div>
            </div>
          </div>
        </div>
      </section>
      <section id="product" style={{ background: "var(--bg-2)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="shell" data-num="02">
          <p className="counter reveal"><b>02 / 06</b> Product — working today, not a roadmap</p>
          <h2 className="reveal">Eight controls between your agent and its money.</h2>
          <p className="lede reveal">
            Every one of them is exercised by a 510-assertion end-to-end verification suite on every change — real payments, real signatures, real JSON-RPC. Nothing below is a mockup.
          </p>
          <div className="grid8">
            <div className="cell reveal">
              <span className="mini-chip">PRE-PAYMENT</span>
              <div className="obj"><img src="/assets/obj/01-policy.jpg" alt="" loading="lazy" /></div>
              <div className="cell-body">
                <h3>Policy engine</h3>
                <p>
                  Per-call caps, hourly budgets, rate limits — the agent's own rules, checked against live spend history before it signs anything.
                </p>
              </div>
            </div>
            <div className="cell reveal">
              <span className="mini-chip">FAILS CLOSED</span>
              <div className="obj"><img src="/assets/obj/02-approvals.jpg" alt="" loading="lazy" /></div>
              <div className="cell-body">
                <h3>Human approvals</h3>
                <p>
                  Spends above your threshold pause for a real Approve / Deny. No answer in 30 seconds? It fails closed. Nothing moves.
                </p>
              </div>
            </div>
            <div className="cell reveal">
              <span className="mini-chip">N-LEVEL</span>
              <div className="obj"><img src="/assets/obj/03-budgets.jpg" alt="" loading="lazy" /></div>
              <div className="cell-body">
                <h3>Budget hierarchies</h3>
                <p>
                  Parents grant capped budgets to children, children to grandchildren. Every ancestor's cap binds its whole subtree — IAM for money.
                </p>
              </div>
            </div>
            <div className="cell reveal">
              <span className="mini-chip">LEAST-PRIV</span>
              <div className="obj"><img src="/assets/obj/04-scoping.jpg" alt="" loading="lazy" /></div>
              <div className="cell-body">
                <h3>Tool + chain scoping</h3>
                <p>
                  Grants whitelist{" "}
                  <em>which</em>
                  {" "}tools an agent may buy and{" "}
                  <em>which chains</em>
                  {" "}it may settle on — a translator pinned to Base can't quietly buy code review on Polygon.
                </p>
              </div>
            </div>
            <div className="cell reveal">
              <span className="mini-chip">AUTO-FREEZE</span>
              <div className="obj"><img src="/assets/obj/05-kill-switch.jpg" alt="" loading="lazy" /></div>
              <div className="cell-body">
                <h3>Kill switch</h3>
                <p>
                  Freeze any wallet in one click — and wallets bursting past the rate threshold freeze{" "}
                  <em>themselves</em>
                  , mid-loop.
                </p>
              </div>
            </div>
            <div className="cell reveal">
              <span className="mini-chip">MCP-NATIVE</span>
              <div className="obj"><img src="/assets/obj/06-mcp-middleware.jpg" alt="" loading="lazy" /></div>
              <div className="cell-body">
                <h3>MCP middleware</h3>
                <p>
                  Claude sees ordinary tools; every call silently runs policy → approval → payment underneath. Governance the model cannot opt out of.
                </p>
              </div>
            </div>
            <div className="cell reveal">
              <span className="mini-chip">ECDSA</span>
              <div className="obj"><img src="/assets/obj/07-signed-receipt.jpg" alt="" loading="lazy" /></div>
              <div className="cell-body">
                <h3>Signed receipts + audit</h3>
                <p>
                  Every settlement is ECDSA-signed and independently verifiable; the full ledger exports to CSV for accounting.
                </p>
              </div>
            </div>
            <div className="cell reveal">
              <span className="mini-chip">REAL-TIME</span>
              <div className="obj"><img src="/assets/obj/08-alerts.jpg" alt="" loading="lazy" /></div>
              <div className="cell-body">
                <h3>Alerts + analytics</h3>
                <p>
                  Freezes, blocks, and approvals hit your webhook in real time; spend rolls up per tool and per wallet — including blocked-spend dollars.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section id="proof">
        <div className="shell" data-num="03">
          <p className="counter reveal"><b>03 / 06</b> Proof, not promises</p>
          <h2 className="reveal">Every claim on this page is executed before it's published.</h2>
          <div className="gauge-wrap reveal">
            <div className="gauge">
              <svg viewBox="0 0 220 220">
                <defs>
                  <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#1f7a52"></stop>
                    {" "}
                    <stop offset="60%" stopColor="#46d68c"></stop>
                    {" "}
                    <stop offset="100%" stopColor="#93f2c3"></stop>
                  </linearGradient>
                </defs>
                {" "}
                <circle className="track" cx="110" cy="110" r="100" fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray="471 628">
                </circle>
                {" "}
                <circle className="arc" cx="110" cy="110" r="100" fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray="471 628">
                </circle>
              </svg>
              <div className="gauge-center">
                <div className="gauge-num"><em>402</em>/402</div>
                <div className="gauge-cap">end-to-end checks passing</div>
              </div>
            </div>
            <div className="gauge-stats">
              <div className="gstat">
                <span className="k">Governed spend (live from your local server)</span>
                <span className="v green" id="g-paid">$—</span>
              </div>
              <div className="gstat">
                <span className="k">Blocked before it moved</span>
                <span className="v copper" id="g-blocked">$—</span>
              </div>
              <div className="gstat">
                <span className="k">Wallets frozen by the anomaly detector</span>
                <span className="v rust" id="g-frozen">—</span>
              </div>
              <p style={{ color: "var(--faint)", fontSize: "0.82rem", lineHeight: "1.6" }}>
                Forged signatures rejected. Approvals that fail closed. A synthetic runaway agent frozen mid-burst. A grandchild wallet stopped by its team's cap. An authorization signed for Polygon refused on Arbitrum — the chain lives inside the signature. Agents can even run{" "}
                <b style={{ color: "var(--dim)" }}>keyless</b>
                {" "}— the enforcement proxy holds custody and signs only after the pipeline passes. All of it runs headlessly in{" "}
                <span className="mono">npm run verify</span>
                .
              </p>
            </div>
          </div>
        </div>
      </section>
      <section id="how" style={{ background: "var(--bg-2)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="shell" data-num="04">
          <p className="counter reveal"><b>04 / 06</b> How it works</p>
          <h2 className="reveal">Four gates. Every call. Before money moves.</h2>
          <div className="pipe reveal" aria-hidden="true">
            <div className="pipe-line"></div>
            <div className="pipe-node" style={{ left: "2%" }}></div>
            <div className="pipe-node gate" style={{ left: "40%" }}></div>
            <div className="pipe-node" style={{ left: "68%" }}></div>
            <div className="pipe-node" style={{ left: "98%" }}></div>
            <div className="pipe-label" style={{ left: "5%" }}><b>Agent asks</b>request</div>
            <div className="pipe-label" style={{ left: "40%" }}><b>SpendVeto</b>policy · scope · caps</div>
            <div className="pipe-label" style={{ left: "68%" }}><b>Human</b>if above threshold</div>
            <div className="pipe-label" style={{ left: "95%" }}><b>Paid</b>signed receipt</div>
            <div className="pkt" style={{ animationDelay: "0s" }}></div>
            <div className="pkt" style={{ animationDelay: "1.3s" }}></div>
            <div className="pkt blocked" style={{ animationDelay: "2.4s" }}></div>
            <div className="pkt" style={{ animationDelay: "3.5s" }}></div>
            <div className="pkt" style={{ animationDelay: "4.6s" }}></div>
            <div className="pkt blocked" style={{ animationDelay: "5.5s" }}></div>
          </div>
          <div className="flow">
            <div className="step reveal">
              <h3>Agent asks</h3>
              <p>CLI, a delegated child wallet, or Claude through MCP requests a priced tool from the catalog.</p>
            </div>
            <div className="step reveal">
              <h3>Policy decides</h3>
              <p>
                Frozen? Over a cap? Outside scope? Past its hourly budget? Blocked — with the reason written to the ledger.
              </p>
            </div>
            <div className="step reveal">
              <h3>Humans escalate</h3>
              <p>
                Big spends pause for a real person. Unanswered requests fail closed — an away-from-keyboard afternoon can't cost you.
              </p>
            </div>
            <div className="step reveal">
              <h3>Pay + prove</h3>
              <p>
                x402 settles in USDC on the chain the policy allows (simulate mode or Base Sepolia). The response carries a signed receipt naming payer, price, and chain.
              </p>
            </div>
          </div>
          <div className="dash reveal hud">
            <div className="dash-head">
              <span className="mono">spendveto · localhost:8402</span>
              {" "}
              <span className="live"><i></i>LIVE — SIMULATE MODE</span>
            </div>
            <div className="dash-body">
              <div className="dash-col">
                <div className="dash-title">Budget tree — caps bind whole subtrees</div>
                <div className="budget-row">
                  <span className="who mono">0x1F45…C0Cf <i>root</i></span>
                  <span className="meter"><span className="fill" style={{ "--w": "36%" }}></span></span>
                  <span className="amt mono">$0.045 spent</span>
                </div>
                <div className="budget-row">
                  <span className="who mono">├─ team lead</span>
                  <span className="meter"><span className="fill warn" style={{ "--w": "72%" }}></span></span>
                  <span className="amt mono">$0.011 / $0.015</span>
                </div>
                <div className="budget-row">
                  <span className="who mono">│&nbsp;&nbsp;└─ intern</span>
                  <span className="meter"><span className="fill full" style={{ "--w": "100%" }}></span></span>
                  <span className="amt mono">CAP REACHED</span>
                </div>
                <div className="budget-row">
                  <span className="who mono">├─ translator <i>scoped</i></span>
                  <span className="meter"><span className="fill" style={{ "--w": "22%" }}></span></span>
                  <span className="amt mono">$0.011 / $0.050</span>
                </div>
                <div className="budget-row">
                  <span className="who mono">└─ scraper <i>frozen</i></span>
                  <span className="meter"><span className="fill full" style={{ "--w": "100%" }}></span></span>
                  <span className="amt mono">AUTO-FROZEN</span>
                </div>
              </div>
              <div className="dash-col">
                <div className="dash-title">Needs a human — fails closed in 30s</div>
                <div className="appr">
                  <span className="q mono"><i>●</i> summarize · $0.02</span>
                  {" "}
                  <span className="acts"><button>Approve</button><button className="deny">Deny</button></span>
                </div>
                <div className="dash-title">Ledger</div>
                <div className="logline mono" style={{ transitionDelay: "0.1s" }}>
                  <span>review · 0x1F45…</span>
                  <span className="ok">paid $0.01 ✓ receipt</span>
                </div>
                <div className="logline mono" style={{ transitionDelay: "0.25s" }}>
                  <span>review · intern</span>
                  <span className="bad">blocked — ancestor cap</span>
                </div>
                <div className="logline mono" style={{ transitionDelay: "0.4s" }}>
                  <span>review · translator</span>
                  <span className="bad">blocked — out of scope</span>
                </div>
                <div className="logline mono" style={{ transitionDelay: "0.55s" }}>
                  <span>translate · scraper ×25</span>
                  <span className="worse">runaway → frozen</span>
                </div>
                <div className="logline mono" style={{ transitionDelay: "0.7s" }}>
                  <span>summarize · 0x1F45…</span>
                  <span className="bad">denied by human</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section id="compare">
        <div className="shell" data-num="05">
          <p className="counter reveal"><b>05 / 06</b> The landscape</p>
          <h2 className="reveal">Everyone builds the roads. SpendVeto is the traffic lights.</h2>
          <p className="lede reveal">
            Rails execute payments. Seller-side tools help merchants charge agents. Expense platforms govern{" "}
            <em>humans</em>
            . The paying agent itself — the side that holds the wallet — is the empty seat at the table.
          </p>
          <div className="compare-wrap reveal">
            <table className="compare">
              <thead>
                <tr>
                  <th></th>
                  <th className="hl">SpendVeto</th>
                  <th>
                    Payment rails
                    <br />
                    <span style={{ textTransform: "none", fontWeight: "400" }}>x402 · AP2 · Stripe MPP</span>
                  </th>
                  <th>
                    Seller-side tools
                    <br />
                    <span style={{ textTransform: "none", fontWeight: "400" }}>Cloudflare · Nevermined</span>
                  </th>
                  <th>
                    Expense platforms
                    <br />
                    <span style={{ textTransform: "none", fontWeight: "400" }}>Ramp · Payman · Pleo</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Buyer-side policy for AI agents</td>
                  <td className="hl yes">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">partial</td>
                </tr>
                <tr>
                  <td>Approvals that fail closed</td>
                  <td className="hl yes">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">human flows</td>
                </tr>
                <tr>
                  <td>Nested agent budgets + tool scoping</td>
                  <td className="hl yes">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>Chain-scoped budgets (multichain governance)</td>
                  <td className="hl yes">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>Runaway auto-freeze / kill switch</td>
                  <td className="hl yes">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>MCP-native (agents' actual stack)</td>
                  <td className="hl yes">✓</td>
                  <td className="no">—</td>
                  <td className="no">seller side</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>One budget across tokens, stablecoins, cards and bank payouts</td>
                  <td className="hl yes">✓</td>
                  <td className="no">own rail</td>
                  <td className="no">—</td>
                  <td className="no">tokens + cards + bills (Ramp)</td>
                </tr>
                <tr>
                  <td>Seller-verifiable proof the buyer's policy allowed the spend</td>
                  <td className="hl yes">✓ attestations</td>
                  <td className="no">user mandates (AP2) · agent identity (Visa TAP)</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>Fraud reports shared across companies</td>
                  <td className="hl yes">✓ signed hash feeds</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>Open policy standard</td>
                  <td className="hl yes">✓ JSON Schema</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>Self-hosted: your keys never leave your machine</td>
                  <td className="hl yes">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>On-chain-enforced settlement (Safe AllowanceModule)</td>
                  <td className="hl" style={{ color: "var(--copper)" }}>roadmap</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section id="chains" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="shell" style={{ paddingTop: "4.5rem", paddingBottom: "4.5rem" }}>
          <p className="counter reveal"><b>RAILS</b> Governed on twenty chains, eight signature families</p>
          <div className="logo-marquee reveal" aria-hidden="true">
            <div className="logo-track">
              <span className="logo-item">
                <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#0052FF"></circle></svg>
                <span>Base</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M16 3L6 17l10 6 10-6L16 3z" fill="#C0C7C2"></path>
                  <path d="M16 25l-10-8 10 15 10-15-10 8z" fill="#8B948C"></path>
                </svg>
                <span>Ethereum</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <defs>
                    <linearGradient id="solg1" x1="0" y1="0" x2="32" y2="32">
                      <stop offset="0" stopColor="#00FFA3"></stop>
                      <stop offset="1" stopColor="#DC1FFF"></stop>
                    </linearGradient>
                  </defs>
                  <path d="M6 22l3-3h17l-3 3H6z" fill="url(#solg1)"></path>
                  <path d="M6 14l3-3h17l-3 3H6z" fill="url(#solg1)"></path>
                  <path d="M26 18l-3-3H6l3 3h17z" fill="url(#solg1)"></path>
                </svg>
                <span>Solana</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32" fill="none" stroke="#8247E5" strokeWidth="2.4" strokeLinejoin="round">
                  <path d="M16 4l10 5.8v11.4L16 27 6 21.2V9.8L16 4z"></path>
                  <path d="M16 12l4 2.3v4.6l-4 2.3-4-2.3v-4.6L16 12z" fill="#8247E5" stroke="none"></path>
                </svg>
                <span>Polygon</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <circle cx="16" cy="16" r="13" fill="none" stroke="#28A0F0" strokeWidth="2.2"></circle>
                  <path d="M16 9l6 12h-4.5L16 15l-1.5 6H10L16 9z" fill="#28A0F0"></path>
                </svg>
                <span>Arbitrum</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <circle cx="16" cy="16" r="13" fill="#FF0420"></circle>
                  <rect x="8.5" y="13" width="6" height="6" rx="3" fill="#0e130f"></rect>
                  <rect x="17.5" y="13" width="6" height="6" rx="3" fill="#0e130f"></rect>
                </svg>
                <span>Optimism</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M16 5l11 20H5L16 5z" fill="#E84142"></path>
                  <path d="M13 25l3-6 3 6h-6z" fill="#0e130f"></path>
                </svg>
                <span>Avalanche</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M16 5L28 25H4L16 5z" fill="none" stroke="#00D2AB" strokeWidth="2.4" strokeLinejoin="round">
                  </path>
                </svg>
                <span>Aptos</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M16 3l3 10 10 3-10 3-3 10-3-10-10-3 10-3 3-10z" fill="#7D00FF"></path>
                </svg>
                <span>Stellar</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M9 6v20M23 6v20M9 14h14M9 18h14" stroke="#8259EF" strokeWidth="2.6" strokeLinecap="round" fill="none">
                  </path>
                </svg>
                <span>Hedera</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M6 6l20 20M26 6L6 26" stroke="#00AAE4" strokeWidth="3.2" strokeLinecap="round"></path>
                </svg>
                <span>XRPL</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <circle cx="16" cy="16" r="13" fill="#1652F0"></circle>
                  <path d="M10 21l6-12 6 12h-4l-2-4-2 4h-4z" fill="#fff"></path>
                </svg>
                <span>Arc</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M8 24l5-14 3 8-3 6H8z" fill="#000"></path>
                  <path d="M17 10h3l5 14h-3.5l-1-3h-4l1-3h2l-2.5-8z" fill="#000"></path>
                </svg>
                <span>Algorand</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <circle cx="16" cy="8" r="2" fill="#0033AD"></circle>
                  <circle cx="9" cy="12" r="2" fill="#0033AD"></circle>
                  <circle cx="23" cy="12" r="2" fill="#0033AD"></circle>
                  <circle cx="9" cy="20" r="2" fill="#0033AD"></circle>
                  <circle cx="23" cy="20" r="2" fill="#0033AD"></circle>
                  <circle cx="16" cy="24" r="2" fill="#0033AD"></circle>
                  <circle cx="16" cy="16" r="2.4" fill="#0033AD"></circle>
                </svg>
                <span>Cardano</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#0052FF"></circle></svg>
                <span>Base</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M16 3L6 17l10 6 10-6L16 3z" fill="#C0C7C2"></path>
                  <path d="M16 25l-10-8 10 15 10-15-10 8z" fill="#8B948C"></path>
                </svg>
                <span>Ethereum</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <defs>
                    <linearGradient id="solg2" x1="0" y1="0" x2="32" y2="32">
                      <stop offset="0" stopColor="#00FFA3"></stop>
                      <stop offset="1" stopColor="#DC1FFF"></stop>
                    </linearGradient>
                  </defs>
                  <path d="M6 22l3-3h17l-3 3H6z" fill="url(#solg2)"></path>
                  <path d="M6 14l3-3h17l-3 3H6z" fill="url(#solg2)"></path>
                  <path d="M26 18l-3-3H6l3 3h17z" fill="url(#solg2)"></path>
                </svg>
                <span>Solana</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32" fill="none" stroke="#8247E5" strokeWidth="2.4" strokeLinejoin="round">
                  <path d="M16 4l10 5.8v11.4L16 27 6 21.2V9.8L16 4z"></path>
                  <path d="M16 12l4 2.3v4.6l-4 2.3-4-2.3v-4.6L16 12z" fill="#8247E5" stroke="none"></path>
                </svg>
                <span>Polygon</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <circle cx="16" cy="16" r="13" fill="none" stroke="#28A0F0" strokeWidth="2.2"></circle>
                  <path d="M16 9l6 12h-4.5L16 15l-1.5 6H10L16 9z" fill="#28A0F0"></path>
                </svg>
                <span>Arbitrum</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <circle cx="16" cy="16" r="13" fill="#FF0420"></circle>
                  <rect x="8.5" y="13" width="6" height="6" rx="3" fill="#0e130f"></rect>
                  <rect x="17.5" y="13" width="6" height="6" rx="3" fill="#0e130f"></rect>
                </svg>
                <span>Optimism</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M16 5l11 20H5L16 5z" fill="#E84142"></path>
                  <path d="M13 25l3-6 3 6h-6z" fill="#0e130f"></path>
                </svg>
                <span>Avalanche</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M16 5L28 25H4L16 5z" fill="none" stroke="#00D2AB" strokeWidth="2.4" strokeLinejoin="round">
                  </path>
                </svg>
                <span>Aptos</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M16 3l3 10 10 3-10 3-3 10-3-10-10-3 10-3 3-10z" fill="#7D00FF"></path>
                </svg>
                <span>Stellar</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M9 6v20M23 6v20M9 14h14M9 18h14" stroke="#8259EF" strokeWidth="2.6" strokeLinecap="round" fill="none">
                  </path>
                </svg>
                <span>Hedera</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M6 6l20 20M26 6L6 26" stroke="#00AAE4" strokeWidth="3.2" strokeLinecap="round"></path>
                </svg>
                <span>XRPL</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <circle cx="16" cy="16" r="13" fill="#1652F0"></circle>
                  <path d="M10 21l6-12 6 12h-4l-2-4-2 4h-4z" fill="#fff"></path>
                </svg>
                <span>Arc</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <path d="M8 24l5-14 3 8-3 6H8z" fill="#000"></path>
                  <path d="M17 10h3l5 14h-3.5l-1-3h-4l1-3h2l-2.5-8z" fill="#000"></path>
                </svg>
                <span>Algorand</span>
              </span>
              {" "}
              <span className="logo-item">
                <svg viewBox="0 0 32 32">
                  <circle cx="16" cy="8" r="2" fill="#0033AD"></circle>
                  <circle cx="9" cy="12" r="2" fill="#0033AD"></circle>
                  <circle cx="23" cy="12" r="2" fill="#0033AD"></circle>
                  <circle cx="9" cy="20" r="2" fill="#0033AD"></circle>
                  <circle cx="23" cy="20" r="2" fill="#0033AD"></circle>
                  <circle cx="16" cy="24" r="2" fill="#0033AD"></circle>
                  <circle cx="16" cy="16" r="2.4" fill="#0033AD"></circle>
                </svg>
                <span>Cardano</span>
              </span>
            </div>
          </div>
          <div className="chainband reveal">
            <span className="chain-chip live"><i>●</i> Base Sepolia <b>LIVE</b></span>
            {" "}
            <span className="chain-chip live"><i>●</i> Solana Devnet <b>LIVE</b></span>
            {" "}
            <span className="chain-chip live"><i>●</i> Aptos Testnet <b>LIVE</b></span>
            {" "}
            <span className="chain-chip live"><i>●</i> Stellar Testnet <b>LIVE</b></span>
            {" "}
            <span className="chain-chip live"><i>●</i> Hedera Testnet <b>LIVE</b></span>
            {" "}
            <span className="chain-chip live"><i>●</i> XRPL Testnet <b>LIVE</b></span>
            {" "}
            <span className="chain-chip">XRPL <b>READY (mainnet, opt-in)</b></span>
            {" "}
            <span className="chain-chip">Arc Testnet <b>READY</b></span>
            {" "}
            <span className="chain-chip">Algorand Testnet <b>READY (governed, not signable)</b></span>
            {" "}
            <span className="chain-chip">Cardano Preprod <b>READY (governed, not settleable)</b></span>
            {" "}
            <span className="chain-chip">Base <b>READY</b></span>
            {" "}
            <span className="chain-chip">Ethereum <b>READY</b></span>
            {" "}
            <span className="chain-chip">Polygon <b>READY</b></span>
            {" "}
            <span className="chain-chip">Arbitrum <b>READY</b></span>
            {" "}
            <span className="chain-chip">Optimism <b>READY</b></span>
            {" "}
            <span className="chain-chip">Avalanche <b>READY</b></span>
            {" "}
            <span className="chain-chip">Monad <b>READY</b></span>
            {" "}
            <span className="chain-chip">Celo <b>READY</b></span>
            {" "}
            <span className="chain-chip">Sei <b>READY</b></span>
            {" "}
            <span className="chain-chip">Stable <b>READY (USDT0)</b></span>
          </div>
          <p className="reveal" style={{ color: "var(--dim)", maxWidth: "58ch", lineHeight: "1.7", fontSize: "0.95rem" }}>
            The chain rides{" "}
            <em>inside</em>
            {" "}every signed authorization — a payment signed for Polygon cannot settle anywhere else — and every wallet keeps a separate balance per chain. Policies and delegated grants pin which chains an agent may settle on. On-chain settlement is live today on six testnets across six signature schemes: Base Sepolia (secp256k1), Solana devnet (ed25519), Aptos testnet (Move), Stellar testnet, Hedera testnet (account-id addressing) and XRPL testnet.{" "}
            <b>XRPL mainnet</b>
            {" "}is fully wired but{" "}
            <b>disabled by default</b>
            {" "}— real money, in RLUSD rather than USDC — an operator has to explicitly opt in to enable it, entirely at their own risk; we don't run or control anyone's deployment.{" "}
            <b>Arc testnet</b>
            {" "}is registry-wired (Circle's native-USDC L1) and settlement-ready, awaiting a facilitator that names it.{" "}
            <b>Algorand testnet</b>
            {" "}is governed here — policy, allowlists, per-chain balances all apply — but not signable, since no client signature package for it is published yet; the registry says so per chain.{" "}
            <b>Cardano preprod</b>
            {" "}is governed the same way, one step earlier — the x402 spec added Cardano support 2026-09-09, but as of registration neither the public facilitator nor npm has anything for it yet, so it's not signable or settleable anywhere. The remaining EVM chains are{" "}
            <em>settlement-ready</em>
            : the gate asks its configured facilitator what it can settle at boot and brings every supported chain live automatically — multi-chain 402s, per-chain scheme registration, canonical stablecoin addresses all wired (tested against a mock facilitator advertising all twenty). Pointing at a CDP facilitator with an API key and a funded wallet flips its EVM mainnets on with zero code changes, at that operator's own discretion.
          </p>
        </div>
      </section>
      <section id="beyond" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="shell" style={{ paddingTop: "4.5rem", paddingBottom: "4.5rem" }}>
          <p className="counter reveal"><b>BEYOND CRYPTO</b> Tokens, cards, bank rails — one budget per agent</p>
          <h2 className="reveal">Every way an agent spends, decided before it's spent.</h2>
          <div className="reveal" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem", marginTop: "1.6rem" }}>
            <div style={{ border: "1px solid var(--line)", borderRadius: "14px", padding: "1.3rem 1.4rem", background: "rgba(12,17,14,0.6)" }}>
              <b style={{ color: "#eef3ed" }}>Model tokens</b>
              <p style={{ color: "var(--dim)", lineHeight: "1.65", fontSize: "0.92rem", marginTop: "0.5rem" }}>
                One environment variable puts Claude Code, Codex or any OpenAI/Anthropic SDK behind a budget, a loop detector and a kill switch.{" "}
                <a href="/ai-spend" style={{ color: "var(--green)" }}>How →</a>
              </p>
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: "14px", padding: "1.3rem 1.4rem", background: "rgba(12,17,14,0.6)" }}>
              <b style={{ color: "#eef3ed" }}>Fiat payouts</b>
              <p style={{ color: "var(--dim)", lineHeight: "1.65", fontSize: "0.92rem", marginTop: "0.5rem" }}>
                Agents paying vendors and people through Stripe, RazorpayX (UPI, IMPS, NEFT, RTGS), PayPal and ACH / RTP / wire — caps, budgets, and a human approves every new payee.
              </p>
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: "14px", padding: "1.3rem 1.4rem", background: "rgba(12,17,14,0.6)" }}>
              <b style={{ color: "#eef3ed" }}>Agent cards</b>
              <p style={{ color: "var(--dim)", lineHeight: "1.65", fontSize: "0.92rem", marginTop: "0.5rem" }}>
                Stripe Issuing and Lithic ask SpendVeto in real time: merchant categories, caps, budgets and the kill switch decide every swipe.
              </p>
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: "14px", padding: "1.3rem 1.4rem", background: "rgba(12,17,14,0.6)" }}>
              <b style={{ color: "#eef3ed" }}>AI FinOps &amp; rebilling</b>
              <p style={{ color: "var(--dim)", lineHeight: "1.65", fontSize: "0.92rem", marginTop: "0.5rem" }}>
                Tag spend by team or customer, cap it per tag, export it as FOCUS v1.4 for your FinOps tools — and bill customers for their AI usage through Stripe Billing at your markup.
              </p>
            </div>
          </div>
        </div>
      </section>
      <section id="network" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="shell" style={{ paddingTop: "4.5rem", paddingBottom: "4.5rem" }}>
          <p className="counter reveal"><b>THE NETWORK</b> Proof that travels with the payment</p>
          <h2 className="reveal">A platform can copy a feature. It can't copy a network it doesn't own.</h2>
          <p className="lede reveal">
            Every payment platform can cap spend on its own rail. An agent's spending crosses all of them, and the businesses it pays can't see whether anyone is in control. SpendVeto's open network layer gets more useful with every other company that runs it.
          </p>
          <div className="reveal" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem", marginTop: "1.6rem" }}>
            <div style={{ border: "1px solid var(--line)", borderRadius: "14px", padding: "1.3rem 1.4rem", background: "rgba(12,17,14,0.6)" }}>
              <b style={{ color: "#eef3ed" }}>Spend attestations</b>
              <p style={{ color: "var(--dim)", lineHeight: "1.65", fontSize: "0.92rem", marginTop: "0.5rem" }}>
                When your policy says yes, the payment carries a signed, five-minute proof of it. Sellers verify it offline with one middleware and can refuse agents nobody governs: 3-D Secure, for agents.
              </p>
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: "14px", padding: "1.3rem 1.4rem", background: "rgba(12,17,14,0.6)" }}>
              <b style={{ color: "#eef3ed" }}>Shared reputation</b>
              <p style={{ color: "var(--dim)", lineHeight: "1.65", fontSize: "0.92rem", marginTop: "0.5rem" }}>
                Flag a scam payee once and every company that trusts you refuses it, on every rail: crypto addresses, UPI VPAs, IBANs, card merchants. Feeds carry hashes, never data.
              </p>
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: "14px", padding: "1.3rem 1.4rem", background: "rgba(12,17,14,0.6)" }}>
              <b style={{ color: "#eef3ed" }}>An open policy standard</b>
              <p style={{ color: "var(--dim)", lineHeight: "1.65", fontSize: "0.92rem", marginTop: "0.5rem" }}>
                Agent budgets as a published JSON Schema. Lint them in CI with one command, so a typo can't silently remove a limit.
              </p>
            </div>
          </div>
          <div className="cta-row reveal" style={{ marginTop: "1.6rem" }}>
            <a className="btn btn-ghost" href="/network">How the network works →</a>
          </div>
        </div>
      </section>
      <section id="market" style={{ background: "linear-gradient(rgba(9, 13, 10, 0.82), rgba(7, 10, 8, 0.94)), url('./assets/terrain.jpg') center 65% / cover no-repeat", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="shell" data-num="06">
          <p className="counter reveal"><b>06 / 06</b> Why now</p>
          <h2 className="reveal">Every newly paid tool makes the ungoverned wallet more expensive.</h2>
          <div className="numbers">
            <div className="reveal">
              <div className="n-val"><em>$3–5T</em></div>
              <p className="n-cap">
                agentic-commerce spend projected globally by 2030 — McKinsey. Every dollar needs a spend decision before it moves.
              </p>
            </div>
            <div className="reveal">
              <div className="n-val"><em>169M</em>+</div>
              <p className="n-cap">
                payments cleared by x402 in its first year, across 590,000 buyers and 100,000 sellers — and the seller side is commoditizing monthly.
              </p>
            </div>
            <div className="reveal">
              <div className="n-val"><em>$4.5T</em></div>
              <p className="n-cap">
                stablecoin transfer volume in Q1 2026 alone — the settlement layer agents actually use is already at Visa scale.
              </p>
            </div>
            <div className="reveal">
              <div className="n-val"><em>$56B</em></div>
              <p className="n-cap">
                business spend-management software market by 2032 — built for human spenders. Agents are the next, faster cohort.
              </p>
            </div>
          </div>
        </div>
      </section>
      <section id="quickstart" className="qs">
        <div className="shell qs-grid">
          <div>
            <p className="counter reveal"><b>RUN IT</b> Quickstart</p>
            <h2 className="reveal">Zero keys. Zero faucets. Sixty seconds.</h2>
            <p className="lede reveal">
              Simulate mode uses real keypairs and real signature verification — it just settles locally, so you can feel the whole governance loop before funding anything. Flip one env var for real x402 on Base Sepolia.
            </p>
            <p className="reveal" style={{ marginTop: "1.1rem" }}>
              Prefer code to CLI? A Node SDK and a LangChain adapter ship in the same repo — no separate install.
            </p>
            <a className="btn btn-ghost reveal" href="/docs#sdk" style={{ marginTop: "0.6rem" }}>
              SDK &amp; LangChain docs →
            </a>
          </div>
          <div className="codebox mono reveal hud">
            <div>
              <span className="p">$</span>
              {" "}npx spendveto &nbsp;
              <span className="c"># console + spend guard on :8402</span>
            </div>
            <div><span className="p">$</span> ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude</div>
            <div>
              <span className="p">$</span>
              {" "}npx spendveto budget 10 &nbsp;
              <span className="c"># $10/day per agent</span>
            </div>
            <div>
              <span className="p">$</span>
              {" "}npx spendveto guard razorpay &nbsp;
              <span className="c"># guard a payment MCP server</span>
            </div>
            <div><span className="p">$</span> claude mcp add spendveto -- npx spendveto mcp</div>
            <div>
              <span className="p">$</span>
              {" "}npx spendveto validate policy.json &nbsp;
              <span className="c"># lint budgets before they ship</span>
            </div>
          </div>
        </div>
      </section>
      <section id="faq" style={{ background: "var(--bg-2)", borderTop: "1px solid var(--line)" }}>
        <div className="shell" style={{ paddingTop: "5rem", paddingBottom: "5rem" }}>
          <p className="counter reveal"><b>FAQ</b> Straight answers</p>
          <h2 className="reveal">Asked before you had to ask.</h2>
          <div className="faq" style={{ marginTop: "1.5rem" }}>
            <details className="reveal">
              <summary>Is this a real product or a demo?</summary>
              <p>
                Real. It runs on your machine today: real ECDSA signatures, real x402 settlement on six testnets, and a{" "}
                <b>510-assertion end-to-end suite</b>
                {" "}(
                <span className="mono">npm run verify</span>
                ) that exercises every claim on this page. Hosted SpendVeto isn't self-serve yet: we set it up directly with each team, and managed custody, orgs and SSO are still being built.
              </p>
            </details>
            <details className="reveal">
              <summary>Does SpendVeto hold my keys?</summary>
              <p>
                Your choice of two trust models, both self-hosted.{" "}
                <b>Library mode:</b>
                {" "}agents hold their own wallets and the governance pipeline runs inside their own call path.{" "}
                <b>Enforcement proxy:</b>
                {" "}agents are keyless — they POST spending intents, and the proxy’s custody wallet signs only after freeze, policy, caps, scopes, and approvals all pass. Keys never leave your machine either way.
              </p>
            </details>
            <details className="reveal">
              <summary>Which chains work today?</summary>
              <p>
                Twenty registered chains across eight signature families run the full governed pipeline end to end — chain-scoped signatures, per-chain balances, chain allowlists.{" "}
                <b>On-chain settlement is live on six testnets</b>
                {" "}(Base Sepolia, Solana devnet, Aptos, Stellar, Hedera and XRPL testnet) through x402’s public facilitator; the rest settle locally until a facilitator supports them. XRPL mainnet is wired but off unless an operator opts in.
              </p>
            </details>
            <details className="reveal">
              <summary>What happens when an agent goes rogue?</summary>
              <p>
                The burst detector freezes it{" "}
                <b>mid-loop</b>
                {" "}— by default, ten payment attempts inside ten seconds trips the freeze automatically. Every wallet also has a one-click manual kill switch. A frozen wallet is refused even when it presents a correctly signed payment (403, not a fresh challenge), and its trust score collapses to an F.
              </p>
            </details>
            <details className="reveal">
              <summary>What does “simulate mode” actually simulate?</summary>
              <p>
                Only the settlement. Keypairs, ECDSA signing and verification, nonce replay protection, signed receipts — all real cryptography; balances just settle in a local file instead of on-chain. Forged signatures are rejected, and that rejection is one of the 510 tested assertions. Flip one env var for real x402 on Base Sepolia.
              </p>
            </details>
            <details className="reveal">
              <summary>What will the hosted platform add?</summary>
              <p>
                The parts a company needs to run this for a fleet: a managed custody proxy on the money path, orgs and SSO, a Postgres audit trail, alert routing, and mainnet settlement.{" "}
                <a href="/contact" style={{ color: "var(--green)" }}>Book a call</a>
                {" "}— the chains design partners need literally decide which adapters we build first.
              </p>
            </details>
            <details className="reveal">
              <summary>How do I set a spending limit for Claude Code or Codex?</summary>
              <p>
                Run{" "}
                <span className="mono">npx spendveto</span>
                , then start Claude Code with{" "}
                <span className="mono">ANTHROPIC_BASE_URL=http://127.0.0.1:8402</span>
                {" "}(Codex:{" "}
                <span className="mono">OPENAI_BASE_URL=http://127.0.0.1:8402/v1</span>
                ). Every request is checked against a per-agent daily, hourly, per-request and per-session budget{" "}
                <b>before</b>
                {" "}it reaches the provider, and the actual cost is booked from the provider's own usage report.{" "}
                <span className="mono">spendveto budget 10</span>
                {" "}sets $10 a day per agent. Your API key passes through and is never stored.{" "}
                <a href="/ai-spend">Full guide</a>
                .
              </p>
            </details>
            <details className="reveal">
              <summary>How do I stop a runaway AI agent loop from running up a bill?</summary>
              <p>
                The loop detector freezes an agent that keeps making the same successful tool call and getting the same result, so the loop stops before the next model call is paid for. Retries of a failed request don't count. A requests-per-minute limit answers bursts with a real 429, budgets cap the damage, and any agent can be frozen from the Console or with{" "}
                <span className="mono">spendveto freeze</span>
                .
              </p>
            </details>
            <details className="reveal">
              <summary>Is SpendVeto tied to one payment provider?</summary>
              <p>
                No. One policy and one ledger decide spend on model tokens, x402 stablecoin payments on 20 chains, Stripe Issuing and Lithic cards, and Stripe, RazorpayX, PayPal and Modern Treasury payouts. A provider's own controls see only its own rail, while an agent's budget has to cover all of them. The attestation, reputation-feed and policy formats are open: anyone can verify or implement them.{" "}
                <a href="/network">How the network works</a>
                .
              </p>
            </details>
            <details className="reveal">
              <summary>Can a seller check that an AI agent's spending is governed?</summary>
              <p>
                Yes. When the buyer's policy allows a payment, SpendVeto signs a short-lived{" "}
                <b>governed-spend attestation</b>
                {" "}naming the payer, payee, resource and ceiling, and sends it with the payment. The seller verifies it offline against the issuer address it trusts, with one Express middleware and no call to SpendVeto. The seller learns which policy version governed the spend, not the buyer's limits.
              </p>
            </details>
            <details className="reveal">
              <summary>Do reputation feeds share my data with other companies?</summary>
              <p>
                Only what you choose to publish, and only as hashes: a feed lists hashed counterparty identifiers with a kind and severity — no raw addresses, reasons, amounts or customers. Another company imports it only if it explicitly trusts your issuer address, and edited or rolled-back feeds are refused.
              </p>
            </details>
            <details className="reveal">
              <summary>Is there an SDK, or just the CLI?</summary>
              <p>
                Both. A dependency-free Node SDK (
                <code className="mono">sdk/</code>
                {" "}—{" "}
                <code className="mono">.pay()</code>
                ,{" "}
                <code className="mono">.dryRun()</code>
                ,{" "}
                <code className="mono">.chat()</code>
                , throws a typed denial with the fix attached) and a LangChain adapter (
                <code className="mono">integrations/</code>
                ) ship in the repo alongside the CLI and MCP server — same governed pipeline underneath all four. Code samples in the{" "}
                <a href="/docs#sdk">docs</a>
                .
              </p>
            </details>
          </div>
        </div>
      </section>
      <section className="final">
        <div className="shell">
          <p className="counter reveal" style={{ justifyContent: "center", display: "flex" }}>
            <b>Self-hosted</b>
            {" "}your machine, your keys
          </p>
          <h2 className="reveal">
            Give your agents a budget,{" "}
            <span style={{ color: "var(--green)" }}>not a blank check.</span>
          </h2>
          <div className="cta-row reveal">
            <a className="btn btn-primary" href="/signup">Get started</a>
            {" "}
            <a className="btn btn-ghost" href="#quickstart">Run it locally</a>
          </div>
        </div>
        <div className="planet" aria-hidden="true"><div className="ghost-word">SPENDVETO</div></div>
      </section>
    </Page>
  );
}
