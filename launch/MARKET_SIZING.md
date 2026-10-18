# SpendVeto — market sizing (TAM / SAM / SOM)

*Prepared 2026-10-18. Every figure is either cited (source at the bottom) or labelled as an assumption. Scenarios are mechanisms, not forecasts.*

## What we sell, and to whom

SpendVeto governs money an AI agent spends **before it is spent**, across four rails — and, since v0.28.0, turns the same ledger into cost allocation (FinOps) and customer billing:

| Rail | Spend that exists today | Who feels the pain | SpendVeto surface |
|---|---|---|---|
| **Model tokens** | Model-API spend was **$8.4B** in mid-2025 (Menlo survey of 150 technical leaders) and is growing fast | every team running agents — runaway loops turn into four- and five-figure bills (≈$6,000 overnight in one public Claude Code report; ≈$50,000 in under an hour in a cited red-team case) | the LLM guard: one env var, budgets + loop freeze + kill switch |
| **Agent payments (x402 / stablecoins)** | tens of millions of dollars cumulative so far; protocol now governed by the Linux Foundation's x402 Foundation | teams whose agents buy APIs and data | the x402 gate, delegated budgets, upto / auth-capture governance |
| **Agent cards** | early: every network and Stripe launched agent-card programs in 2025–26; merchant adoption still thin | fintechs and platforms issuing cards to agents (Stripe Issuing, Lithic) | real-time authorization webhooks |
| **Fiat payouts** | AP and payouts run on bank rails at enormous scale (US ACH alone: $63.1T in 2025) | finance teams putting agents on bill pay, refunds, contractor and seller payouts | governed payouts: Stripe, RazorpayX (UPI/IMPS/NEFT/RTGS), PayPal, ACH/RTP/wire |

The wedge is the first row: it has a buyer **today** and needs no belief in crypto or agent commerce. Rows two and three are where the volume compounds.

## TAM — the spend that will need governing (2030)

- **Agentic commerce: $3–5 trillion** of global spend by 2030 (McKinsey). Juniper Research projects **$1.5T by 2030**, from **$8B in 2026**.
- Present-day scale of agent-driven spending: Gartner puts **agentic AI spending at ≈$201.9B in 2026** (a broad measure, incl. agentic features embedded across enterprise software).
- Governance monetizes as a take-rate on governed volume plus a SaaS layer. At **10 bps** of McKinsey's $3–5T — a conservative rate next to card economics (≈2–3%) or LLM-credit resellers (OpenRouter's 5.5% platform fee) — the governance pool is **$3–5B per year by 2030**.

## Expansion TAM — adjacent markets the same ledger serves (v0.28.0)

SpendVeto records every governed dollar as a priced, attributed ledger entry. Three adjacent software markets run on exactly that data, and v0.28.0 ships into each:

| Market | Size | Source | SpendVeto surface |
|---|---|---|---|
| Cloud FinOps / cost management | $14.88B (2025) → $26.91B (2030), 12.6% CAGR | MarketsandMarkets, Jan 2026 | tag allocation, tag budgets, unified cost report, FOCUS v1.4 export of AI spend |
| — AI is now the FinOps priority | 98% of FinOps teams manage or expect to manage AI spend (31% two years earlier); 1,192 practitioners, $83B cloud spend | FinOps Foundation, State of FinOps 2026 (secondary coverage) | same |
| Usage-based billing software | $7.37B (2026) → $11.50B (2032) | 360iResearch | rebilling: AI usage → Stripe Billing meter events at a markup |
| AP automation | $3.8B–$8.0B (2026), by definition | Future Market Insights / Research and Markets | governed fiat payouts with new-payee approval |
| Mass payouts | $5.65B–$30.8B (2026), by definition | Intel Market Research / MarketIntelo | Stripe, RazorpayX, PayPal, Modern Treasury payouts |
| Payment volume on the rails it now governs | US ACH: $63.1T across 8.08B payments (2025, Nacha); B2B card payments $5.9T (2026, Juniper) | as cited | basis points on governed payout volume (upside, not in SOM) |

**Software pools at the 2030 horizon:** FinOps $26.9B + usage-based billing $11.5B + AP automation ≈$8B ≈ **$46B**, before the governance take-rate on agent spend ($3–5B/yr, below). Definitions and years differ across these reports; read the total as reach, not as a share SpendVeto will win.

## SAM — who the product serves now (bottom-up, subscriptions only)

| Input | Value | Basis |
|---|---|---|
| Organizations paying a frontier-model API | **≥300,000** | Anthropic's own count of business customers (Oct 2025); Ramp's AI Index (May 2026) has 34.4% of businesses in its dataset paying Anthropic and 32.3% paying OpenAI — so this floor ignores OpenAI-only and Google-only orgs |
| Share running autonomous agents with material spend | **25%** | *assumption* (conservative vs. IDC's forecast of 1B+ enterprise agents by 2029) |
| Serviceable teams | **≥75,000** | 300,000 × 25% |
| Annual contract value | **≈$2,600** | Team tier $199/mo ($2,388) + 0.5% of governed model spend on an *assumed* $40K/yr per team (≈$200) |
| **SAM** | **≈$195M / year** | before any x402 or card volume, and before enterprise contracts |

## SOM — what we plan to capture by end of 2029

| Line | Assumption | ARR |
|---|---|---|
| Hosted Team accounts | 1.5% of SAM teams ≈ **1,100** × $2,600 | ≈ $2.9M |
| Enterprise / platform contracts | **20** × $50,000 (SSO, per-team custody, card governance for issuers) | ≈ $1.0M |
| Volume take on agent payments and cards | not counted — upside | — |
| **SOM** | | **≈ $4M ARR** |

The metric that compounds underneath is **governed spend** (dollars that flowed through a SpendVeto decision) and **blocked spend** (dollars it stopped). Both are first-class numbers in the product.

## Funnel that produces the SOM (what we measure weekly)

`npx` starts → agents connected → weekly-active guards → observe-mode design partners → paid hosted teams → enterprise contracts.

| Stage | 30-day target | 90-day target |
|---|---|---|
| GitHub stars | 1,000 | 3,000 |
| Weekly installs (`npx` / npm) | 300 | 1,500 |
| Design partners running observe mode on real traffic | 10 | 25 |
| Paid pilots (hosted, once built) | — | 3 |
| Governed model spend / month (opt-in reporting) | $10K | $250K |

*Targets are commitments to measure, not results. Today every one of these is zero or unmeasured.*

## What would move these numbers fastest (and what wouldn't)

- **Would:** being the default answer to "how do I stop my coding agent burning money" — one command, works with Claude Code / Codex / Cursor, free. Distribution compounds through every agent framework, MCP registry and gateway guide.
- **Would:** a hosted version (no install) with SSO for teams — the paid product.
- **Wouldn't:** more rails or chains before there are users. The product is ahead of the traction; the next three months are distribution.

## Sources

- MarketsandMarkets, Cloud FinOps Market ($14.88B 2025 → $26.91B 2030): https://tools.prnewswire.com/en-us/live/20813/release/20260106EN57079
- State of FinOps 2026 (secondary coverage): https://virtasant.com/blog/state-of-finops-2026 · https://www.nops.io/blog/state-of-finops-2026/
- 360iResearch, usage-based billing software ($7.37B 2026 → $11.50B 2032): https://www.360iresearch.com/library/intelligence/usage-based-billing-software
- AP automation market (2026): https://www.futuremarketinsights.com/reports/accounts-payable-automation-market · https://www.researchandmarkets.com/reports/6242294/ap-automation-market-outlook-market-share
- Mass payouts market (2026): https://www.intelmarketresearch.com/mass-payoutpayroll-disbursement-platform-market-44369 · https://marketintelo.com/report/mass-payments-market
- Nacha 2025 ACH volume (via Axis Intelligence): https://axis-intelligence.com/b2b-payments-statistics/ · Juniper B2B card payments: https://www.ictbusiness.biz/analysis/b2b-card-payments-to-reach-11-trillion-in-2030

- Menlo Ventures, mid-2025 LLM market update — model API spend $8.4B (reported by BigDATAwire): https://www.bigdatawire.com/this-just-in/menlo-ventures-report-enterprise-llm-spend-reaches-8-4b-as-anthropic-overtakes-openai
- Anthropic — 300,000+ business customers (Oct 2025), via Sacra / press: https://sacra.com/c/anthropic
- Ramp AI Index, May 2026 (TechCrunch): https://techcrunch.com/2026/05/13/anthropic-now-has-more-business-customers-than-openai-according-to-ramp-data/
- Gartner agentic AI spending forecast (secondary summary): https://softwarestrategiesblog.com/2026/02/16/gartner-forecasts-agentic-ai-overtakes-chatbot-spending-2027/
- IDC — 1B+ enterprise agents by 2029 (secondary): https://publication.cybermagazine.com/cyber-magazine-august2026/0782584001784888908/p61
- Juniper Research agentic spend $8B (2026) → $1.5T (2030) (secondary): https://privacy.com/blog/payment-solutions-ai-agents-2026-compared
- McKinsey $3–5T agentic commerce by 2030 — see PITCH.md sources
- Runaway-agent bills: https://devtoolpicks.com/blog/ai-agents-runaway-claude-code-bills-overnight-2026 · https://linas.substack.com/p/ai-agent-loop-governance
- OpenRouter platform fee and LLM gateway pricing (secondary): https://www.web3aiblog.com/blog/llm-gateways-compared-openrouter-litellm-portkey-cloudflare-2026
