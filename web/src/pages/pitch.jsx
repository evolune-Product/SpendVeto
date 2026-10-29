import "../styles/pages.css";
import "./pitch.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "SpendVeto Investor Deck — AI Agent Spend Governance Pitch",
  "description": "SpendVeto investor deck: the spend-governance layer for AI agents paying over x402. Every number cited and covered by npm run verify.",
  "path": "/pitch",
  "keywords": "SpendVeto pitch deck, AI agent governance startup, x402 investor deck"
};

// Behaviour lives in pitch.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

export default function PitchPage() {
  return (
    <Page note={<>Every product claim in this deck is covered by <span className="mono">npm run verify</span> — 511 end-to-end assertions.</>}>
      <div className="deck">
        <section className="slide" id="s1">
          <div className="shell">
            <p className="counter reveal"><b>DECK · 2026-07</b> Pre-seed / accelerator</p>
            <h1 className="reveal">Your agents can spend.<br /><span className="g">SpendVeto decides.</span></h1>
            <p className="sub reveal">
              <strong>The spend-governance layer for AI agents.</strong>
              {" "}Payment rails move an agent's money; SpendVeto decides whether it should be allowed to move it. Self-hosted, x402 + MCP native, working today — every claim in this deck is executed by a 511-assertion verification suite before it's published.
            </p>
          </div>
          <span className="slide-num mono">01 / 13</span>
        </section>
        <section className="slide" id="s2">
          <div className="shell">
            <p className="counter reveal"><b>02</b> Problem</p>
            <h2 className="reveal">
              An agent with a wallet is a corporate card with no limit — issued to software that runs at machine speed.
            </h2>
            <div className="rows">
              <p className="row reveal">
                <span>
                  AI agents now pay for tools, APIs, and data autonomously — no human, no card form. x402 alone:{" "}
                  <b>169M payments across 590,000 buyers</b>
                  {" "}in its first year (~$50M cumulative).
                </span>
              </p>
              <p className="row reveal">
                <span>
                  Coinbase, Stripe, Visa, Mastercard, Google, and Cloudflare are all shipping agent-payment rails in 2026. Every one answers{" "}
                  <b>"how does the agent pay?"</b>
                </span>
              </p>
              <p className="row reveal">
                <span>
                  Almost nobody answers the question every team asks first:{" "}
                  <b>"how do I stop it from overspending?"</b>
                </span>
              </p>
            </div>
          </div>
          <span className="slide-num mono">02 / 13</span>
        </section>
        <section className="slide" id="s3">
          <div className="shell">
            <p className="counter reveal"><b>03</b> Why now — the asymmetry</p>
            <h2 className="reveal">The seller side is commoditizing monthly. The buyer side is funded — but closed.</h2>
            <div className="rows">
              <p className="row reveal">
                <span>
                  Cloudflare opened its x402 Monetization Gateway waitlist{" "}
                  <b>July 1, 2026</b>
                  {" "}— anyone can now charge agents for anything. Stripe MPP, Nevermined, xpay, Zuplo all monetize the{" "}
                  <b>seller</b>
                  {" "}side.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  Buyer-side governance is now being funded —{" "}
                  <b>Catena Labs raised $30M (a16z crypto, May 2026)</b>
                  {" "}and is filing for a bank charter — but every funded player is{" "}
                  <b>closed and custodial</b>
                  . Payman is a closed fiat platform.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  The open position is empty:{" "}
                  <b>self-hostable, rail-neutral, MCP-native</b>
                  {" "}buyer-side governance. The GitLab-vs-a-bank position — SpendVeto works{" "}
                  <b>with</b>
                  {" "}any rail and any custodian, competing with none.
                </span>
              </p>
            </div>
          </div>
          <span className="slide-num mono">03 / 13</span>
        </section>
        <section className="slide" id="s4">
          <div className="shell">
            <p className="counter reveal"><b>04</b> Product — working today, not a plan</p>
            <h2 className="reveal">Twelve controls between an agent and its money.</h2>
            <div className="tiles">
              <div className="tile reveal">
                <b>Policy engine</b>
                <span>caps, hourly budgets, rate limits — enforced before payment</span>
              </div>
              <div className="tile reveal">
                <b>Human approvals</b>
                <span>Approve/Deny on a live dashboard; fails closed in 30s</span>
              </div>
              <div className="tile reveal">
                <b>n-level budgets</b>
                <span>ancestor caps bind whole subtrees — IAM for money</span>
              </div>
              <div className="tile reveal">
                <b>Tool + chain scoping</b>
                <span>grants whitelist which tools an agent may buy and which chains it may settle on</span>
              </div>
              <div className="tile reveal">
                <b>Kill switch</b>
                <span>manual freeze + automatic runaway-burst freeze</span>
              </div>
              <div className="tile reveal"><b>MCP middleware</b><span>governance Claude cannot opt out of</span></div>
              <div className="tile reveal">
                <b>Signed receipts</b>
                <span>ECDSA-signed settlements + CSV audit export</span>
              </div>
              <div className="tile reveal">
                <b>Alerts + analytics</b>
                <span>webhooks on freeze/block; blocked-spend as a first-class metric</span>
              </div>
              <div className="tile reveal">
                <b>Enforcement proxy</b>
                <span>agents POST intents; keys never leave custody — SpendVeto on the money path</span>
              </div>
              <div className="tile reveal">
                <b>Trust scores + packs</b>
                <span>the ledger as an agent credit file; governance as importable presets</span>
              </div>
              <div className="tile reveal">
                <b>Multichain governance</b>
                <span>
                  chain-scoped signatures, per-chain balances, chain allowlists across 20 registered chains, eight signature families
                </span>
              </div>
              <div className="tile reveal">
                <b>Self-correcting denials + dry runs</b>
                <span>
                  every block returns a machine code + fix the agent can act on; dry-run any intent with zero side effects; time-boxed budgets that self-expire
                </span>
              </div>
            </div>
            <p className="foot-note reveal">
              Real x402 on Base Sepolia + zero-setup simulate mode with real ECDSA and replay protection. 511 end-to-end assertions:{" "}
              <span className="mono">npm run verify</span>
              .
            </p>
          </div>
          <span className="slide-num mono">04 / 13</span>
        </section>
        <section className="slide" id="s5">
          <div className="shell">
            <p className="counter reveal"><b>05</b> Positioning</p>
            <h2 className="reveal">Open Policy Agent, for agent spending.</h2>
            <p className="quote reveal">
              "Stripe moves money. SpendVeto decides whether the agent should be allowed to move it."
            </p>
            <p className="sub reveal">
              Rail-agnostic by design: x402 today; Google AP2, Stripe MPP, and Mastercard adapters on the roadmap — the policy layer shouldn't care which rail settles.
            </p>
          </div>
          <span className="slide-num mono">05 / 13</span>
        </section>
        <section className="slide" id="s6">
          <div className="shell">
            <p className="counter reveal"><b>06</b> Competition</p>
            <h2 className="reveal">Everyone builds the roads. SpendVeto is the traffic lights.</h2>
            <div className="table-wrap reveal">
              <table className="data">
                <thead><tr><th>Player</th><th>What they are</th><th>What they don't do</th></tr></thead>
                <tbody>
                  <tr>
                    <td>Stripe — Issuing controls, Link approvals, agent guardrails (preview)</td>
                    <td>Agent spend controls on Stripe instruments</td>
                    <td>Stripe's own rails only</td>
                  </tr>
                  <tr>
                    <td>Sapiom · Fragment · Natural (funded 2026)</td>
                    <td>Agent spend controls and agent payments</td>
                    <td>Category validation at our stage — $15.75M + $35M, $12M, $9.8M + $30M</td>
                  </tr>
                  <tr>
                    <td>Ramp ($60B) — AI token limits, agent cards</td>
                    <td>Limits by user or API key; its own cards</td>
                    <td>Its own cards and four AI providers; no seller-verifiable proof or shared reputation found</td>
                  </tr>
                  <tr>
                    <td>LLM gateways — LiteLLM, Portkey, Cloudflare</td>
                    <td>Budgets on model traffic</td>
                    <td>Model spend only — budget stops at the model bill</td>
                  </tr>
                  <tr>
                    <td>Coinbase x402 · Spend Permissions</td>
                    <td>The rail, and wallet allowances</td>
                    <td>Coinbase wallets only</td>
                  </tr>
                  <tr>
                    <td>AP2 · Mastercard Verifiable Intent</td>
                    <td>Signed records of what a user authorized</td>
                    <td>
                      No budgets; prove user intent, not the org's policy decision — composes with our attestations
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="foot-note reveal">
              The gap: neutral, buyer-side governance across every rail an agent spends on, with open network formats on top. 2026 rounds price the category at our stage: Sapiom $15.75M seed then a $35M Series A six months later, Natural $9.8M then $30M, Baselayer $35M, Fragment $12M.
            </p>
          </div>
          <span className="slide-num mono">06 / 13</span>
        </section>
        <section className="slide" id="s6b">
          <div className="shell">
            <p className="counter reveal"><b>07</b> Defensibility</p>
            <h2 className="reveal">Stripe can copy a feature. It can't copy a network it doesn't own.</h2>
            <div className="rows">
              <p className="row reveal">
                <span>
                  <b>Every incumbent control is single-rail.</b>
                  {" "}Stripe's limits, approvals and agent guardrails sit on Stripe instruments. OpenAI and Anthropic cap their own models monthly, and by their own docs spend can exceed it. Coinbase governs its wallets. An agent's budget spans all of them.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  <b>Neutral beats owned.</b>
                  {" "}x402 moved to the Linux Foundation, with Stripe, Visa, Mastercard, Google and AWS as members. Visa tried to buy Plaid; Google paid $32B for multi-cloud Wiz; Stripe bought Bridge, Privy and Metronome rather than build them.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  <b>What compounds — shipped in v0.29.0.</b>
                  {" "}Spend attestations a seller verifies offline (two-sided network), fraud reports shared across companies as signed hashes (data network), an open JSON-Schema policy standard linted by a GitHub Action (ecosystem).
                </span>
              </p>
            </div>
            <p className="foot-note reveal">
              Risks we take seriously: Stripe bundling "good enough" limits for Stripe-only spenders; signed user-intent proofs already exist (AP2, Mastercard Verifiable Intent) — our attestations prove the organization's policy decision and compose with them; the network has no outside participants yet.
            </p>
          </div>
          <span className="slide-num mono">07 / 13</span>
        </section>
        <section className="slide" id="s7">
          <div className="shell">
            <p className="counter reveal"><b>08</b> Market</p>
            <h2 className="reveal">Every agent dollar needs a spend decision before it moves.</h2>
            <div className="stat-grid">
              <div className="reveal">
                <div className="big"><em>$3–5T</em></div>
                <p className="cap">
                  TAM — global agentic-commerce spend by 2030 (McKinsey; Bain: $300–500B US). Stablecoins already move $4.5T/quarter.
                </p>
              </div>
              <div className="reveal">
                <div className="big"><em>69K</em> agents</div>
                <p className="cap">
                  SAM — teams already paying via x402/MCP today, plus every agent-fleet team that needs governance before trusting agents with money.
                </p>
              </div>
              <div className="reveal">
                <div className="big"><em>$1–3M</em> ARR</div>
                <p className="cap">
                  SOM, 18–24 months — OSS-led: a few hundred teams on the hosted tier (orgs, SSO, alerts, audit, enforcement proxy) + bps on governed volume.
                </p>
              </div>
            </div>
            <p className="foot-note reveal">
              Monetizes like usage-billing infra (Lago, Metronome, Orb): self-hosted core, hosted platform for money. Spend-management software (human spenders) is $26B → $56B by 2032 — agents are the next cohort.
            </p>
          </div>
          <span className="slide-num mono">08 / 13</span>
        </section>
        <section className="slide" id="s7b">
          <div className="shell">
            <p className="counter reveal"><b>09</b> Where adoption starts</p>
            <h2 className="reveal">Two wedges that don't need anyone to believe in crypto first.</h2>
            <div className="rows">
              <p className="row reveal">
                <span>
                  <b>AI spend control — a buyer exists today.</b>
                  {" "}Every team running agents has an LLM bill an agent loop can blow up.{" "}
                  <span className="mono">npm run quickstart:ai</span>
                  {" "}gives an agent a hard dollar budget and shows the next call refused{" "}
                  <i>before</i>
                  {" "}the model is called. JavaScript and Python clients.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  <b>India · UPI — regulation shaped like our product.</b>
                  {" "}RBI's 2026 e-mandate framework fixes the thresholds (human authentication on the first debit and above ₹15,000; ₹1,00,000 for insurance, mutual funds, card bills; 24-hour pre-debit notice). NPCI's own line:{" "}
                  <i>
                    "AI may recommend, but authentication and final settlement must follow deterministic auditable rules."
                  </i>
                  {" "}That is a policy engine.{" "}
                  <span className="mono">/api/upi/evaluate</span>
                  {" "}encodes it; the agent can never approve itself.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  <b>Honest limits:</b>
                  {" "}the UPI adapter is an evaluator — it does not initiate or settle UPI, is not a PSP, and claims no NPCI/RBI approval; NPCI's agent protocol is not live and needs RBI sign-off. We are the rule layer that sits in front of whatever rail is cleared.
                </span>
              </p>
            </div>
          </div>
          <span className="slide-num mono">09 / 13</span>
        </section>
        <section className="slide" id="s8">
          <div className="shell">
            <p className="counter reveal"><b>10</b> Fit — why these funds, right now</p>
            <h2 className="reveal">Two RFS items in one repo.</h2>
            <div className="rows">
              <p className="row reveal">
                <span>
                  <b>Y Combinator</b>
                  {" "}— the 2026 RFS explicitly asks for agent infrastructure naming MCPs, and stablecoin infrastructure. YC now funds S26 in{" "}
                  <b>$500K USDC</b>
                  .
                </span>
              </p>
              <p className="row reveal">
                <span><b>a16z CSX</b> — $500K for 7%, crypto-native; already backed Skyfire one layer below us.</span>
              </p>
              <p className="row reveal">
                <span>
                  <b>Alliance DAO</b>
                  {" "}— crypto×AI accelerator, $500K, rolling applications, decisions in 2 weeks. Next cohort starts{" "}
                  <b>Sept 7, 2026</b>
                  .
                </span>
              </p>
            </div>
          </div>
          <span className="slide-num mono">10 / 13</span>
        </section>
        <section className="slide" id="s9">
          <div className="shell">
            <p className="counter reveal"><b>11</b> Traction plan — before applications go in</p>
            <h2 className="reveal">Ship in public. Walk in with usage, not promises.</h2>
            <div className="rows">
              <p className="row reveal">
                <span>
                  <b>Launch:</b>
                  {" "}npm install + hosted beta → Show HN, MCP registries, x402 Discord. Site, deck, demo script, and listing blurbs are already built.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  <b>5 design partners</b>
                  {" "}running agent fleets in simulate mode — governance value lands before real money moves.{" "}
                  <b>Today: none yet</b>
                  {" "}— this slide is the plan, not a claim.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  <b>The metric nobody else can show:</b>
                  {" "}blocked-spend dollars — already a first-class stat — plus one testimonial from a team whose runaway agent got auto-frozen mid-loop.
                </span>
              </p>
            </div>
          </div>
          <span className="slide-num mono">11 / 13</span>
        </section>
        <section className="slide" id="s10">
          <div className="shell">
            <p className="counter reveal"><b>12</b> Honest gaps — and what funding fixes</p>
            <h2 className="reveal">Prototype-grade where it should be. Real where it must be.</h2>
            <div className="rows">
              <p className="row reveal">
                <span>JSON-file storage → <b>hosted Postgres backend</b> is the first funded milestone.</span>
              </p>
              <p className="row reveal">
                <span>
                  The enforcement proxy — keyless agents, custody-side signing —{" "}
                  <b>ships verified as self-host today</b>
                  {" "}→ funding builds the hosted multi-tenant version: orgs, SSO, per-team custody, SLAs.
                </span>
              </p>
              <p className="row reveal">
                <span>
                  No external security audit yet → a third-party review and the SOC 2 path are funded milestones; mainnet settlement stays opt-in until design partners want it.
                </span>
              </p>
              <p className="row reveal">
                <span>No production users yet → that's what the 30–60 day plan is for.</span>
              </p>
            </div>
          </div>
          <span className="slide-num mono">12 / 13</span>
        </section>
        <section className="slide" id="s11">
          <div className="shell">
            <p className="counter reveal"><b>13</b> The ask</p>
            <h2 className="reveal" style={{ fontSize: "clamp(2.2rem,5.5vw,4.2rem)" }}>
              $500K to go from
              <br />
              <span className="g">verified prototype</span>
              {" "}to hosted product.
            </h2>
            <p className="sub reveal">
              Multi-rail adapters (AP2, Stripe MPP), richer anomaly models and real-time alerting, SOC 2 path, and the hosted governance dashboard that is the business.
            </p>
            <div className="rows" style={{ marginTop: "2rem" }}>
              <p className="row reveal">
                <span>Revanth Rajeev · <span className="mono">revanthrajeev2004@gmail.com</span></span>
              </p>
              <p className="row reveal">
                <span>
                  All sources for every number are in the full investor memo — ask at{" "}
                  <a href="mailto:foundersoffice@evolune.in?subject=SpendVeto%20investor%20memo">
                    foundersoffice@evolune.in
                  </a>
                  {" "}— McKinsey, Bain, Morgan Stanley, Forbes/BCG, Fortune BI, Coinbase disclosures.
                </span>
              </p>
            </div>
          </div>
          <span className="slide-num mono">13 / 13</span>
        </section>
      </div>
      <div className="dots" id="dots"></div>
    </Page>
  );
}
