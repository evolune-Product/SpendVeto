# SpendVeto — go-to-market plan: from "who is using it?" to an answer

*Prepared 2026-10-18 for the founders. Everything below is a plan or a draft; nothing has been posted or sent.*

## The honest starting point

- Users today: **zero** in production. Investors have noticed.
- What changed in v0.27.0: any developer can now use SpendVeto in **one line**, with no crypto — `npx github:revanthrajeev/spendveto`, then `ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude`. Their key passes through and is never stored. Verified with the real Claude Code client.
- So the bottleneck has moved from product to **distribution**. The next 90 days are about putting this in front of the people who already feel the pain, and measuring what happens.

## Positioning

**One line:** *A budget, a loop detector and a kill switch in front of every dollar your AI agents spend — model tokens first, then payments and cards. Free, open source, one environment variable.*

**Why us, not an LLM gateway (LiteLLM, Portkey) or an observability tool (Helicone, Langfuse):** gateways budget model spend per key or team; observability tools watch. SpendVeto is the agent's **one** budget across tokens, x402 payments and card swipes, with a loop detector that freezes the agent, delegated budgets that cascade across all three, human approval, and an audit-grade hash-chained ledger. Say this plainly; don't claim gateways have no budgets — they do — and don't claim what they lack unless you've checked.

## Ideal customers, in the order to pursue them

1. **Individual developers on Claude Code / Codex / Cursor** — feel runaway-cost pain personally, adopt in 30 seconds, tell others. *Free.* Source of stars, installs and stories.
2. **AI-native startups running agent fleets** (5–50 engineers, agents in production) — need per-agent budgets and a kill switch before trusting agents with money. *Team tier.* Source of design partners and the first revenue.
3. **Platform / AI-enablement teams at larger companies** — giving every employee and agent a token allowance (Uber reportedly tightened allowances after agent loops used up a year's AI budget in four months). *Enterprise.*
4. **Fintechs issuing cards to agents** (Stripe Issuing, Lithic customers) — need a real-time authorization brain. *Platform contracts.*
5. **x402 ecosystem builders** — agents that buy APIs and data with stablecoins. *Where the long-run volume is.*

## Week-by-week

### Week 0–1: make it installable and visible
1. **Publish the npm package** so the line becomes `npx spendveto` (the package is ready: `npm publish` from the repo root, with your npm account that already owns `spendveto-sdk`).
2. **Publish to the official MCP registry** (`server.json` is ready; `mcp-publisher login github` then `mcp-publisher publish`), then list on Smithery, mcp.so and Glama.
3. **Record a 30-second GIF**: Claude Code in a loop → SpendVeto freezes it → Console shows the block. Put it at the top of the README.
4. **Show HN** (draft below). Post Tuesday–Thursday, ~8–9am US Eastern. Both founders answer every comment for the first 6 hours.
5. **Reddit**: r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA, r/OpenAI — one honest post each, a day apart, framed as "I built this after reading about $6,000 overnight bills", not as an ad.
6. **X thread** (draft below), tagging nobody who hasn't engaged; reply under the public runaway-bill threads with the fix, not a pitch.

### Week 2–3: integrations that bring people to you
- PRs: `awesome-claude-code`, `awesome-mcp-servers`, `awesome-x402`; a "use SpendVeto as a budget proxy" recipe for LangChain, LiteLLM and Aider docs/communities; a Cursor forum guide.
- A blog post: *"Every way an AI agent can burn your money, and the one line that stops it"* (dev.to + Hashnode + your site).
- Product Hunt launch once the GIF and the npm one-liner exist.

### Week 2–6: design partners (the traction investors actually weigh)
- **20 targeted messages a week** (template below) to: YC W26/S26 agent startups, x402 ecosystem projects, teams posting about agent costs on X/Reddit, Stripe Issuing / Lithic customers building agent cards.
- Offer: *30 minutes to set up observe mode on their real traffic; in two weeks we send them a report of what it would have blocked.* Zero risk for them, a concrete number for you.
- Convert: observe → enforce → hosted pilot. Ask every partner for one sentence you can quote.

### Week 6–12: the paid product
- Build the hosted version only after 10 design partners are running observe mode: orgs, SSO, per-team keys, the Console online. Price: Team $199/mo + 0.5% of governed model spend (from `PITCH.md`).

## What to report to investors, every week (counts, not adjectives)

| Metric | Where it comes from |
|---|---|
| GitHub stars, forks | `github.com/revanthrajeev/spendveto` |
| Weekly installs | npm downloads for `spendveto` (after publishing) |
| Design partners in observe mode | your CRM / a shared sheet |
| Governed and blocked spend at partners | partners' own `spendveto status` / Console, shared with permission |
| Quotes from teams whose runaway agent got frozen | partners |

Never present the simulate-mode demo data in the Console as usage.

## Drafts (edit, then post yourselves)

### Show HN

**Title:** Show HN: SpendVeto – a one-line budget cap for Claude Code and other AI agents

**Body:**
> AI agents can spend money on their own now, and the common failure isn't fraud, it's loops: an agent retrying the same failing tool call for hours. I kept reading about $1,800 and $6,000 overnight bills, and provider caps are monthly and lag.
>
> SpendVeto sits between your agent and the model provider. Start it with `npx github:revanthrajeev/spendveto`, then run `ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude` (or set `OPENAI_BASE_URL` for Codex and the OpenAI SDKs). Every request is checked against a per-agent budget before it reaches the provider; if the same tool call keeps returning the same result, the agent is frozen until you look. The cost is booked from the provider's own usage numbers. Your key passes through and is never stored.
>
> It's open source (Apache-2.0), self-hosted, and the same engine also governs x402 payments and card authorizations (Stripe Issuing, Lithic), so one agent can have one budget across all three. 442 end-to-end tests run from a clean clone.
>
> Honest limits: the pre-check uses an estimate, so the last request under a budget can overshoot by one request; there's no hosted version yet. I'd love to hear where it breaks for your setup.

### X thread (5 posts)
1. Someone burned ~$6,000 of Claude usage overnight with one command. Agent loops are the new runaway cloud bill. I built a one-line fix. 🧵
2. `npx github:revanthrajeev/spendveto` → `ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude`. Every model call is checked against a budget *before* it reaches the provider.
3. If your agent repeats the same tool call and gets the same result again and again, SpendVeto freezes it until you look. Retries of failed calls don't count.
4. Works with Claude Code, Codex, Cursor and any OpenAI/Anthropic SDK. Your key is never stored. Free, open source.
5. Same engine governs agent payments (x402) and agent cards (Stripe Issuing, Lithic): one budget per agent, everywhere it spends. github.com/revanthrajeev/spendveto

### Design-partner message
> Hi {name} — saw {their agent product / their post about agent costs}. I'm building SpendVeto, an open-source budget and kill switch for AI agents (works by changing one base-URL env var). Would you let me set it up in *observe* mode on your agents for two weeks? It blocks nothing; at the end you get a report of every request it would have stopped and why. 30 minutes of your time. — Revanth & Harshil

## What not to do
- Don't build more rails, chains or regions before ten teams use it.
- Don't split founder time across the other ventures during these 90 days; SpendVeto ranks first for funding (see the October funding assessment).
- Don't claim users, partners or numbers you don't have — the repo's rule (every claim is a test) is a selling point; keep it true in marketing too.
