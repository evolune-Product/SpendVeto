# Why can't Stripe, or anyone with engineers, just build this?

*Prepared 2026-10-18 for investor conversations. Every external fact links to its source. Where a point is our own judgment, it says so.*

## The answer, in one paragraph

Stripe can build spend controls for Stripe, and it has: Issuing spending controls, Link spending approvals, and an "Agent guardrails" preview, all on Stripe's own instruments. But a company's agents spend across OpenAI and Anthropic tokens, stablecoins, other issuers' cards and bank payouts. No owner of one rail can be the neutral referee of its competitors' traffic, which is why the industry moved x402 to the Linux Foundation. SpendVeto is that neutral layer: one policy across every rail. Since v0.29.0 it also runs an open network on top of that policy: signed attestations a seller verifies offline, fraud reports shared across companies as hashes, and an open policy standard. Each gets more valuable with every company that runs it, and that is the part a platform can't copy with engineers. If Stripe wants this layer, history says it buys it. It bought Bridge, Privy and Metronome.

## 1. What the incumbents have actually shipped

| Company | Agent spend controls (verified) | What they cover |
|---|---|---|
| Stripe | Issuing controls block merchant categories, countries or merchants, with limits per authorization or per month ([docs](https://docs.stripe.com/issuing/controls/spending-controls)). Sessions 2026 announced Link "spending approvals" and an "Agent guardrails" preview to "assign agent identities, enforce scope rules, and configure approval flows" ([Stripe](https://stripe.com/blog/everything-we-announced-at-sessions-2026)). Shared Payment Tokens are scoped to a merchant and basket total ([Stripe](https://stripe.com/newsroom/news/stripe-openai-instant-checkout)). | Stripe instruments: Issuing cards, Link, Privy wallets. The announcement ties none of these controls to non-Stripe rails. |
| Visa | Intelligent Commerce: consumers "set spending limits and conditions" ([Visa](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.21361.html)). Intelligent Commerce Connect (pilot, Apr 2026) lists spend controls ([Visa](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.22276.html)). | Cards, across card networks. No mention of x402 or AP2. |
| Mastercard | Agent Pay; Verifiable Intent (Mar 2026), an open-source, tamper-resistant record of who the user is, what they instructed and what happened ([PYMNTS](https://www.pymnts.com/mastercard/2026/mastercard-unveils-open-standard-to-verify-ai-agent-transactions/)). | A record of user intent. No spend limits are described. |
| Coinbase | Spend Permissions, an allowance per period ([docs](https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions)). Agentic Wallets with caps per session and per transaction ([docs](https://docs.cdp.coinbase.com/agentic-wallet/cli/welcome)). | Coinbase wallets only. |
| OpenAI | Monthly spend limits per organization or project. Alerts are soft, the hard limit returns 429, and recorded spend "can slightly exceed" it ([docs](https://developers.openai.com/api/docs/guides/spend-limits)). | OpenAI models only. No per-agent or daily limits documented. |
| Anthropic | Monthly caps by usage tier, plus workspace limits ([docs](https://platform.claude.com/docs/en/api/rate-limits)). A self-hosted gateway with per-user caps, described as "a circuit breaker rather than an invoice", that admits requests by default if its database is down ([docs](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits)). Claude Code's `--max-budget-usd` works in non-interactive mode only, and "spend can pass the cap" ([docs](https://code.claude.com/docs/en/cli-reference)). | Claude models only. |
| AWS | AgentCore Payments preview (May 2026, built with Coinbase and Stripe): "spending limits are enforced per session" ([AWS](https://aws.amazon.com/blogs/machine-learning/agents-that-transact-introducing-amazon-bedrock-agentcore-payments-built-with-coinbase-and-stripe/)). | x402 inside AgentCore. |
| Cloudflare, Ramp | AI Gateway spend limits (Jun 2026, 429 at the limit) ([Cloudflare](https://developers.cloudflare.com/changelog/post/2026-06-05-spend-limits/)). Ramp AI token spend management, "soft or hard limits by user or API key" (Jul 2026) ([Ramp](https://ramp.com/blog/ai-token-spend-launch)). | LLM spend (Ramp also has its own cards). |

**Finding:** every control we found is scoped to the vendor's own rail, wallet or models. The partial exceptions are Visa's Connect, which spans card networks but only cards, and Ramp, which covers four AI providers plus its own cards. We found no product enforcing one policy across model APIs, stablecoins, cards and bank payouts.

## 2. Why the incumbents' position works against them

- **Rail scope.** An agent's budget spans rails that compete with each other. Stripe can't govern a Lithic card, a RazorpayX UPI payout, a Coinbase wallet or an OpenAI bill. OpenAI can't govern Anthropic tokens. A CFO wants one limit per agent, not one per vendor.
- **Neutrality is a requirement, not a slogan.** x402 moved to the Linux Foundation under "vendor-neutral governance", with Stripe, Visa, Mastercard, Google and AWS among its members ([Coinbase](https://docs.cdp.coinbase.com/x402/support/x402-foundation)). Competitors adopt neutral layers; they don't route their customers' governance through a rival.
- **Incentive** (our judgment). Processors earn per transaction. SpendVeto's core output is a payment declined or reduced, on behalf of the spender, not the merchant.
- **Vendor caps are billing safety nets, not agent governance.** They are monthly, per organization or project, and by the vendors' own documentation they leak at the edges (quoted above). Per-agent, per-session, loop-aware, approval-gated control is a different product.

## 3. What compounds: the moat we are building (v0.29.0)

- **Two-sided network: governed-spend attestations.** When the buyer's policy allows a payment, SpendVeto signs a five-minute attestation naming payer, payee, resource, ceiling and policy version, and attaches it to the payment. A seller verifies it offline with one middleware and can refuse agents nobody governs. Every buyer that can prove governance makes requiring it cheaper for the next seller, and every seller that requires it pulls in buyers. This is the 3-D Secure pattern, and it works on any rail.
- **Data network: federated reputation.** A scam payee reported once is refused by every company that trusts the reporter, on every rail: crypto addresses, UPI VPAs, IBANs, card merchants. Feeds carry signed hashes, never data. Stripe Radar learns from Stripe's network; this one learns from whatever its members, on any rail, choose to share.
- **A standard: the open policy schema.** a16z (May 2025): "There is currently no agreed-upon standard for how a human assigns a role and scope to an agent" ([a16z](https://a16z.com/newsletter/agent-payments-stack/)). We published one, as a JSON Schema with a validator in the CLI, the API and a GitHub Action. QED (Feb 2026): open protocols "have been designed to… create advantages for their creators" ([QED](https://qedinvestors.substack.com/p/a-biblical-history-of-agentic-payments)). The reference implementation of a standard is the default implementation.
- **Distribution and switching costs.** A one-command install, an MCP registry entry, a policy validator in other teams' CI. Over time, policy files, approval history, the hash-chained audit ledger, FOCUS exports and rebilling wired into a customer's Stripe Billing all accumulate where the customer runs SpendVeto.
- **Business model, open core** (our plan). The formats and the engine stay open. The paid products are the hosted control plane (SSO, orgs, managed custody), a directory of verified issuers, and curated reputation feeds: network services whose value is the network, so a fork of the code doesn't copy them.

**Stated plainly:** none of this has users yet. A network with no participants is a design, not a moat. The next 90 days are about the first ten design partners and the first two-sided pair: one buyer presenting attestations to one seller who requires them.

## 4. Precedents: neutral layers beat platforms, or get bought by them

- **Plaid vs Visa.** Visa's CEO called the blocked $5.3B acquisition an "insurance policy" against a "threat to our important US debit business" ([DOJ](https://www.justice.gov/opa/pr/justice-department-sues-block-visas-proposed-acquisition-plaid)). Plaid stayed independent and raised at $6.1B in 2025 ([TechCrunch](https://techcrunch.com/2025/04/03/fintech-plaid-raises-575m-at-6-1b-valuation-says-it-will-not-go-public-in-2025)).
- **Wiz.** Google paid $32B and committed that Wiz "will continue to work… across all major clouds" ([Google](https://blog.google/inside-google/company-announcements/google-agreement-acquire-wiz/)).
- **Datadog** competes with AWS, Azure and GCP's native monitoring and reported $3.43B of revenue for 2025 ([10-K](https://www.sec.gov/Archives/edgar/data/1561550/000162828026008819/ddog-20251231.htm)).
- **Ramp** runs on Visa's rails and reached a $60B valuation on 2026-10-15 ([TechCrunch](https://techcrunch.com/2026/10/15/ramp-reaches-60b-valuation-as-it-pushes-deeper-into-ai)). Capital One is buying Brex for $5.15B rather than building its own ([SEC](https://www.sec.gov/Archives/edgar/data/927628/000119312526019543/d97758dex991.htm)).
- **Stripe buys the layers it wants:** Bridge ($1.1B, closed Feb 2025), Privy (Jun 2025) and Metronome (closed Jan 2026) ([Bridge](https://stripe.com/us/newsroom/news/stripe-completes-bridge-acquisition), [Privy](https://siliconangle.com/2025/06/11/stripe-acquires-crypto-wallet-infrastructure-provider-privy/), [Metronome](https://stripe.com/newsroom/news/stripe-completes-metronome-acquisition)).

## 5. The category is funded

| Company | Round | Lead | Relevance |
|---|---|---|---|
| Sapiom | $15.75M seed (Feb 2026); $35M Series A (Aug 2026) | Accel; Dragonfly | "Per-tool and per-session spending limits" for agents ([SiliconANGLE](https://siliconangle.com/2026/02/06/sapiom-reels-15-75m-equip-ai-agents-payment-features/), [Runtime Wire](https://www.runtimewire.com/article/sapiom-raises-35m-series-a-agent-infrastructure)) |
| Fragment | $12M Series A (Oct 2026); seed led by Stripe | FirstMark, BoxGroup | "Keep AI agents from going rogue with company money" ([Fortune](https://fortune.com/2026/10/14/fragment-raises-12-million-to-help-keep-ai-agents-from-going-rogue-with-company-money/)) |
| Natural | $9.8M seed (Oct 2025); $30M Series A (Jul 2026) | Abstract, Human Capital; Forerunner | Payments for AI agents ([Axios](https://www.axios.com/pro/fintech-deals/2025/10/23/natural-9-million-agentic-payments), [FinTech Global](https://fintech.global/2026/07/21/natural-raises-30m-to-power-payments-for-ai-agents/)) |
| Baselayer | $35M Series A (Sep 2026) | M13 | Agent identity and trust layer ([SiliconANGLE](https://siliconangle.com/2026/09/22/with-35m-in-series-a-funding-baselayer-is-building-the-trust-layer-for-the-agentic-economy/)) |
| Portkey | $15M Series A (Feb 2026) | Elevation | LLM gateway; budget limits per virtual key ([VCA](https://www.vcaonline.com/news/2026021904/portkey-raises-15m-series-a-to-scale-the-unified-control-plane-for-production-ai/)) |
| Kite | $18M Series A (Sep 2025) | PayPal Ventures, General Catalyst | Trust for the agentic web ([PayPal](https://newsroom.paypal-corp.com/2025-09-02-Kite-Raises-18M-in-Series-A-Funding-To-Enforce-Trust-in-the-Agentic-Web)) |
| Catena Labs | $18M seed (May 2025) | a16z crypto | Agentic payments ([Decrypt](https://decrypt.co/322051/tom-brady-crypto-investment-ai-startup)) |
| Revenium | $13.5M seed (Nov 2025) | Two Bear | AI usage and cost ([VCA](https://www.vcaonline.com/news/2025112005/revenium-closes-13-5-million-seed-round-funding-led-by-two-bear-capital-with-participation-from-westwave-capital/)) |
| OpenRouter | $113M Series B (May 2026), about $1.3B as reported | CapitalG | Neutral model router across providers ([OpenRouter](https://openrouter.ai/blog/announcements/series-b/)) |

Accel's thesis for Sapiom names the layer: teams "need a new layer in the stack: a control plane for automated transactions" that is "governed by policy" ([Accel](https://www.accel.com/news/powering-the-agentic-economy-our-seed-investment-in-sapiom.md)). SpendVeto's position in that category: self-hosted, the widest rail coverage we know of (model tokens, x402 on 20 chains, two card issuers, four payout providers, five regional evaluators), and open network formats instead of a closed graph. We make no claims here about competitors' internals beyond what the cited sources say.

**If you're pitching Elevation:** Elevation led Portkey's Series A, so expect "how is this different from Portkey?" Portkey's documented budgets are limits per virtual key on LLM traffic. SpendVeto treats model tokens as one of four rails, and adds loop freeze, approvals, payments, cards, payouts, attestations and reputation. The two are complementary: a team can keep its LLM gateway and put SpendVeto on the money.

## 6. Risks we take seriously

| Risk | Our answer |
|---|---|
| Stripe bundles "good enough" agent limits into Issuing, Link and ACP | True for Stripe-only spenders. Our buyer is the multi-rail agent fleet, and Stripe is one of our rails (Issuing webhooks, Connect transfers, Billing meter events are already integrated). |
| Signed authorization proofs already exist: Mastercard Verifiable Intent, AP2 mandates | They prove what a *user* authorized. Our attestation proves what the *paying organization's policy* decided, on any rail. The two compose. Next: carry an AP2 mandate or Verifiable Intent reference inside an attestation. |
| LLM budgets are commoditizing (Cloudflare, Ramp, LiteLLM, Portkey) | The LLM guard is the distribution wedge, not the moat. The moat is one policy across rails plus the network formats. |
| Agent payment volume is still small: about 165M x402 transactions but about $50M cumulative volume by Apr 2026 ([Forkast](https://forkast.news/?p=127414)) | Take-rate revenue is years out. Near-term revenue is SaaS on model-spend governance, where the spend exists today. |
| No users yet | The 90-day plan is distribution and design partners ([GTM_PLAN.md](./GTM_PLAN.md)). Every number we report will be a count, not an adjective. |

## 7. What to say on the call (about 30 seconds)

> "Stripe can and does build controls for Stripe's rails — Issuing limits, Link approvals, agent guardrails. But your agents spend across OpenAI and Anthropic tokens, stablecoins, other issuers' cards and bank payouts, and no rail owner can be the neutral referee of its competitors' traffic. That's why x402 went to the Linux Foundation. We're that neutral layer: one policy across every rail, plus an open network on top — attestations a seller can verify, fraud reports shared across companies, and an open policy standard. Those get more valuable with every company that joins, which is the part a platform can't copy with engineers. And if Stripe wants this layer, history says they buy it: Bridge, Privy, Metronome."
