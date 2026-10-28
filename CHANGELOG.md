# Changelog

Every feature listed here is exercised by the end-to-end suite (`npm run verify`) — the suite grew from 33 assertions at the first public cut to **114** at v0.7.0. If a claim isn't an assertion, it doesn't ship.

## Wallet sign-in and wallet-first signup — 2026-10-28

Sign-In with Ethereum (EIP-4361) on both sides. The server writes every message itself — its own domain, a single-use nonce, a short expiry, a statement saying what the signature is for — and accepts back only that exact message, signed by the address it was issued to. A signature, never a transaction or gas. Browser wallets are found the EIP-6963 way (`client/browser-wallet.js`), so several installed wallets can be told apart; no WalletConnect SDK.

- **Console:** a signed-in user links a wallet on the Users page; from then on the wallet signs them in instead of the password (`POST /api/auth/wallet/challenge|login|link`, `DELETE /api/auth/wallet/:address`). A link signature can't sign in, a replayed or altered one is refused, and a wallet links to one account. On a public deployment set `SPENDVETO_PUBLIC_URL` so the message's domain is fixed, not taken from the request's Host header.
- **Governance API signup:** an optional first step on spendveto.com/signup — the wallet signs a challenge from `POST /v1/signup/wallet` (only for the site's own origins), the proof rides along with the email, and the tenant the link creates records it as `owner_wallet` (`GET /v1/tenant`). The email link still creates the account: a wallet costs nothing to make, so it can't be the abuse limit. One tenant per wallet (enforced by a unique index; the first link opened wins). Migration `003_wallet_signup`.
- Personal-account (EOA) wallets only — MetaMask, Rabby, Coinbase Wallet's extension and the like. Smart-contract wallets sign via EIP-1271, which needs a chain read; not supported yet.
- **Verify: 510** (+2). Governance API suite: 89 (+4).

## Postgres storage for the core server — 2026-10-28

Set `SPENDVETO_CORE_DATABASE_URL` and the core server keeps its state in Postgres instead of `data/*.json` (`server/store.js`). Unset, nothing changes — `npx spendveto` still needs no database. It's its own variable so that pointing the Governance API at a database never moves the core.

- Every document under the data directory becomes a row in `sv_core_docs`; the ledger is `sv_core_ledger`, one row per entry, append-only in the database itself (a trigger refuses UPDATE and DELETE). Both are held in memory and written through in order, with ledger appends group-committed.
- **Durable before acknowledged:** a response leaves only once the writes it caused are committed; if storage fails, it answers `503 storage_unavailable` instead of a success.
- One server per database (an advisory lock — a second refuses to start). The proxy and the CLI share documents with it through `LISTEN/NOTIFY`. On first start against an empty database, the existing data files are imported, hash chain intact.
- Faster in both modes: the ledger is cached in memory instead of re-parsed on every read, and the policy engine reads state in-process inside the server (no HTTP round trips, no full-ledger download per decision; agents' processes fetch only paid/unmanaged rows via `/api/ledger?view=spend`). At 10,000 ledger entries, file mode: `/api/stats` p50 259 → 22 ms; Postgres: LLM-guard decisions ~700/s at p50 14 ms (file mode: ~40/s at 248 ms), and appends no longer slow down as history grows.
- `npm run test:pg-storage`: import, durability, cross-process writes, single writer, append-only, restart, scale — against a real database (like the Governance API suite, not in the published verify count). `GET /api/health` reports which storage is in use.

## Self-serve signup for the Governance API — 2026-10-27

spendveto.com/signup now creates accounts. Enter an email and a company name; a one-time link (24 hours) arrives by email; opening it creates an isolated Governance API tenant and shows its first admin key, once — the key is stored only as its fingerprint. `govern/signup.js`, migration `002_signups`, `govern/mailer.js` (Resend or Postmark over plain HTTPS; unconfigured, signup refuses with `503 signup_unavailable` rather than creating unverified accounts).

- The request answers identically whether or not the address already has an account; an existing address gets a "you already have an account" email, never a second tenant. Verifying consumes the link in the same transaction that creates the tenant — six concurrent verifications of one link create exactly one.
- Abuse limits: 3 links per address per hour, 10 requests per client per hour, and a Cloudflare Turnstile check when `GOVERN_TURNSTILE_SECRET` is set. CORS is open on the two signup routes only, for the site's origins.
- The verify page removes the token from the address bar as soon as it reads it.
- Governance API suite: 85 tests (+10) against real Postgres — not in the published verify count.

## Console sign-in — 2026-10-27

The Console has accounts. Email + password, a role each (viewer reads, approver also decides approvals, admin changes everything — the API-key ranks), and a session in an HttpOnly, SameSite=Strict, Secure-over-HTTPS cookie that lasts 12 hours. Users are invited, never self-registered: the first admin with `npm run user -- invite you@company.com admin` on the host (a one-time, 48-hour link; the invitee sets their own password, so none passes through a shell), the rest from the Console's new Users page. Any user record turns sign-in on; until one exists the Console stays open, as before.

- A Console session can only make changes from the Console: writes on the cookie must carry the Console's header and, when the browser names one, this server's origin.
- Five wrong passwords lock an account for 15 minutes; an unknown email gets exactly the answer a wrong password does, in the same time. Login and invite acceptance are also rate-limited per client.
- Nothing secret is stored as itself: passwords are scrypt hashes (N=2^15), session ids and invite tokens SHA-256 digests. Changing a password, disabling an account or changing its role signs it out everywhere; no change can leave the instance without an active admin.
- **Verify: 508** (+4).

## Security — 2026-10-27

Found by a security test pass against a live server — two high-severity holes and the medium findings, all closed.

- **Approvals could be granted without a key.** The one-click decide link was the approval id and nothing else, and `GET /api/approvals` listed every pending id — with auth required, anyone who could reach the server (or any website, through the open CORS header) could approve a pending spend. Each link now carries a token bound to its approval and its decision (HMAC, per-process secret, compared in constant time); a link without it, with a forged one, or with the other decision's token is refused with 403. Listing approvals needs a viewer key once auth is on.
- **Anyone could write ledger rows about any wallet.** `POST /api/ledger/event` was unauthenticated: 12 spoofed rows froze a stranger's wallet, and spoofed "paid" rows would burn its budget. Events are now signed by the wallet they name (`client/ledger-event.js` — EIP-191 over every recorded field, a timestamp and a nonce); unsigned, wrongly signed, edited, stale or replayed events are refused with 401. `client/pay.js` and the proxy sign every event they report.
- Production dependencies audited clean (`npm audit fix`, non-breaking: proxy-addr, body-parser, qs, fast-uri, ip-address, @modelcontextprotocol/sdk, hono).
- **Reads are locked too once auth is on.** Every read except the public ones (catalog and open standards, the aggregate counters, an agent paying for a tool or polling its own approval) needs a viewer key; the server's own in-process policy checks use a per-boot internal credential, and local tools send `SPENDVETO_API_KEY`. API keys are compared in constant time.
- **Cross-origin reads only for what is public.** The blanket `Access-Control-Allow-Origin: *` let any website read a running server's ledger, policy and approvals; now the open standards and catalog answer any origin, the live counters only the marketing site's (`SPENDVETO_CORS_ORIGINS` adds more), and nothing else answers one.
- **Response hardening.** No `X-Powered-By`; `nosniff`, `X-Frame-Options: DENY` and a CSP with `frame-ancestors 'none'` on every response, so the Console can't be clickjacked.
- **CSV exports can't carry formulas.** The ledger and FOCUS exports prefix an agent-written `=`, `+`, `-` or `@` cell with an apostrophe (`server/csv.js`).
- **LLM budgets hold under concurrency.** The guard decides on its estimate, and a provider can bill above it; one request at a time that gap is one request's, but 100 parallel calls overshot a $0.10 budget by 14%. While an agent's requests are in flight, another now joins only with room for every in-flight request to bill 50% over its estimate — otherwise a retryable 429 (`llm_budget_in_flight`). The same burst now books $0.078 of $0.10; a lone request is decided exactly as before.
- **`trust proxy` is `loopback`, not `true`.** X-Forwarded-For was believed from anyone, so a client could claim any IP; it's now believed only from a proxy on the same machine (`SPENDVETO_TRUST_PROXY` names another hop).
- **Per-client rate limit on `/api/*`** (`server/ratelimit.js`, `SPENDVETO_RATE_LIMIT_PER_MIN`, default 600; 0 turns it off). Loopback callers and the signature-verified card webhooks are exempt.
- **API keys are stored as SHA-256 digests**, never the key; a plaintext keys file is rewritten on first read.
- **Verify: 504** (+12).

## Licensing — 2026-10-25

SpendVeto is now proprietary software of Evolune EdgeTech LLP (`LICENSE`, `NOTICE`), and the source repository is private. Versions released before this change (npm `spendveto` ≤ 0.31.0, `spendveto-sdk` 0.1.0) were licensed under Apache-2.0 and stay under it for whoever received them; every later version is covered by the SpendVeto Proprietary License. `package.json` is marked `"private": true`. The site, README, OpenAPI document and llms.txt no longer link to the repository, and the network specification moved to https://spendveto.com/spec/NETWORK.md.

## 0.32.0 — 2026-10-23

`spendveto guard`: SpendVeto in front of a payment provider's MCP server. Razorpay, Stripe, PayPal, Cashfree and Square publish MCP servers, so an agent with a merchant key can refund, transfer and charge with a tool call. Now the agent's MCP client launches the guard instead, and the provider only sees what SpendVeto allowed.

- **`mcp/guard.js`** is an MCP proxy over stdio. It connects to the provider's server (hosted, over Streamable HTTP, or any command, including `mcp-remote` for OAuth servers), lists its tools unchanged but marked where SpendVeto decides, and asks the SpendVeto server before every call that isn't a read. When SpendVeto can't be reached, only reads pass.
- **`server/mcpguard.js` + `POST /api/mcpguard/evaluate`** classify each call as read, collect, spend, change, risky or unknown, from provider profiles built on the docs' tool names (checked Oct 23, 2026).
  - Stripe's single `stripe_api_write` tool is classified by the API path it calls; Square's `make_api_request` by service and method.
  - A spend is priced in USD at the operator's declared rate (`policy.payouts.fxRates`; no rate, no spend), then checked against the per-call cap, rolling daily budget, hourly velocity, kill switch, reputation and delegation caps.
  - A human approves above the approval line, for a recipient not on the allowlist, for a batch, and for risky changes (accepting a dispute, cancelling a subscription, revoking a saved card, sweeping the balance).
  - Unknown tools are refused.
  - A full refund names no amount, so the guard reads the payment and SpendVeto prices that.
  - An amount the guard can't read goes to a human.
- **Outcomes are booked from the provider's answer.** `POST /api/mcpguard/calls/:id/report` books a spend only when the provider confirms it; a failure releases its hold, and an unreported spend is booked once its hold expires. `GET /api/mcpguard` shows recent calls.
- **`spendveto guard <profile>`** in the CLI; a new `mcpGuard` section in the policy standard.
- **`pg` became a devDependency** (the Governance API in `govern/` runs from a checkout and isn't published).
- **Verify: 492** (+10). The real MCP SDK client drives the real guard against a local Razorpay-shaped server that logs what reached it; Stripe, PayPal, Cashfree and Square shapes are checked through the classifier. 495 with `../prediction-copilot` alongside.

## 0.31.0 — 2026-10-19

Out-of-band spend detection: caps that hold when the agent pays around the gate (GitHub issue #1). SpendVeto governed every payment that passed through it. An agent holding its own key could also send USDC straight from its wallet, pay through another facilitator, or use a second MCP server's rail — every in-gate call would pass while the budget was exceeded in aggregate.

- **`server/outofband.js`** reconciles the governed wallets — the agent wallet, every delegated child, and any the policy names — against their on-chain stablecoin transfers. A transfer SpendVeto recorded (same settlement hash, or the same payer, payee, amount and chain moments apart) is managed. One it never saw is **unmanaged spend**: booked against the same hourly budget and delegation caps, alerted (`unmanaged_spend`), and under `policy.outOfBand.onDetect: "freeze"` the wallet is frozen.
- **Two ways in.** `POST /api/outofband/scan`, plus a background poller when `enabled`, reads ERC-20 Transfer logs on each watched chain's USDC, filtered by sender, resuming after a per-chain cursor (RPC from `SPENDVETO_RPC_<CHAIN>`, else the registry's). `POST /api/outofband/transfers` takes deliveries from an indexer or an address-activity webhook.
- **No false alarms from SpendVeto's own payments.** Testnet x402 payments now record the facilitator's settlement hash (x402's PAYMENT-RESPONSE header) for an exact match. A fresh unmatched transfer waits `graceSeconds` (default 120) for its ledger record before it is judged. Reconciliation is idempotent; transfers to `ignoreTo` addresses (the operator's own treasury) are left alone; a token SpendVeto can't price is recorded as unpriced, never as dollars.
- **Visible everywhere.** Unmanaged spend is in `/api/stats`, `/metrics` (`spendveto_unmanaged_usd_total`), `GET /api/outofband`, and the console overview ("Paid around the gate"). The overview's stat row folds total attempts into "Stopped attempts".
- **Policy standard:** an `outOfBand` section; a chain it can't watch is an error.
- **What it is not:** prevention. A wallet whose key the agent holds can always sign. Prevention is custody — the keyless enforcement proxy — or sellers that require governed-spend attestations.
- **Verify: 482** (+6). The chain path reads a local JSON-RPC node speaking the real wire format. 485 with `../prediction-copilot` alongside.

## 0.30.0 — 2026-10-19

Stripe and Tempo's Machine Payments Protocol, governed. MPP (launched March 18, 2026) is x402's sibling: a server answers 402 with one `WWW-Authenticate: Payment` challenge per offer — a one-off charge, a session that streams vouchers against an escrowed deposit, or a subscription — and the official client, mppx, pays by itself. SpendVeto now decides before mppx creates a credential.

- **`server/mpp.js` + `POST /api/mpp/evaluate`.** Parses every Payment challenge in a 402, including several in one header the way fetch joins them. Prices each one: Tempo OUSD, pathUSD or USDC.e on mainnet and Moderato; the registry's USDC on EVM; USD for Stripe and card. Anything else is refused, never guessed. Then applies MPP's own rules and the same policy engine as every rail (hourly budget with holds, approval line, payees, sanctions, reputation, freezes, chain allowlist), and picks the cheapest offer the policy accepts.
- **MPP-specific protections.**
  - A charge's splits are payees too.
  - A session is decided on its deposit, capped by `policy.mpp.maxSessionDepositUSD`, and refused if its escrow isn't Tempo's TIP-1034 channel reserve.
  - A subscription needs a human approval, which the first allow consumes.
  - Expired challenges, credential headers other than Authorization/Payment-Authorization, and Tempo offers with no chainId are refused. mppx's parser lets all three through.
- **Nothing allowed vanishes from the budget.**
  - Allowed charges are held until reported (`POST /api/mpp/charges/:id/report`, which keeps the server's Payment-Receipt as evidence), and are booked as paid if their challenge expires unreported.
  - A session's whole deposit is held until `POST /api/mpp/sessions/:id/close` books the amount consumed.
  - Vouchers (`…/voucher`) must be cumulative and within the approved deposit.
  - MPP holds fold into `GET /api/upto/holds/:address`.
- **`integrations/mppx.js`.** `governMppx()` plugs SpendVeto into mppx's `onChallenge` hook. A denial throws before anything is signed, `requires_approval` waits for a human, and `governed.fetch()` reports each payment's outcome.
- **Policy standard.** A new `mpp` section (`maxSessionDepositUSD`, `maxUnitPriceUSD`, `allowCustomEscrow`, `allowedMethods`), and `tempo` and `tempo-moderato` are chains a policy may allow.
- **Elsewhere.** Tempo addresses are screened against OFAC's EVM list. Attestations may name the `mpp` rail. The `stripe-mpp` rail slot now says what's governed; settlement stays with mppx and the server.
- **Dev dependencies.** `mppx` 0.13.5 (pinned) for the suite, with an npm override for its optional `express >=5` peer: SpendVeto stays on Express 4 and never loads mppx/express. viem moves to 2.57.7, mppx's minimum.
- **Verify: 476** (+10). Every challenge is produced by the official SDK, and the last check pays a local seller with the real mppx client. 479 with `../prediction-copilot` alongside.

## 0.29.1 — 2026-10-19

The fast install. `npx spendveto` used to download every chain SDK the live x402 rail can settle on before anyone could put a budget in front of Claude Code: 630 packages and about 700 MB from a clean npm cache, 77 seconds on the benchmark machine, with Hedera's SDK alone pulling in React Native and Metro. It now installs 150 packages (120 MB) in 25 seconds.

- **Chain SDKs are optional peer dependencies** (`server/optional.js`). The fourteen x402 and chain packages (`@x402/*`, `@solana/kit`, `@aptos-labs/ts-sdk`, `@stellar/stellar-sdk`, `@hiero-ledger/sdk`, `xrpl`) moved out of `dependencies`. The LLM spend guard, the policy engine, approvals, the simulate rail, cards, payouts, attestations and the MCP server need none of them. `client/wallet.js`, `rails/x402-testnet.js` and the testnet gate in `server/index.js` load a family's packages when they settle on it.
- **Missing packages are named, never a crash.** A live payment without them is refused with `rail_package_missing` and the install command. Testnet mode without the x402 core refuses to boot and prints that command. A chain whose family isn't installed is skipped in testnet mode instead of being advertised in a 402 the gate can't verify. A package that is installed but broken inside keeps its real error.
- `spendveto rails` lists which chain families are installed and prints the one command that adds the rest. `GET /api/rails` reports the same per family on the `x402-live` rail.
- A clone is unchanged: the same packages are devDependencies, so `npm install` in the repo brings every rail and `npm run verify` exercises all of them.
- `three` (the source of the site's vendored `site/vendor/three.module.min.js`) moved to devDependencies; nothing at runtime imports it.
- Verify: 466 (+8, run against the `npm pack` output with every chain SDK absent: the dependency declaration, a governed Claude call, a simulate-rail payment, `/api/rails`, the live rail's refusal, testnet's refusal to boot, `spendveto rails`, and a broken package keeping its real error; 469 with `../prediction-copilot` alongside).

## 0.29.0 — 2026-10-18

The network release. A VC asked why Stripe — or anyone with engineers — couldn't just build this. A platform can build spend controls for its own rail; it can't make them more valuable with every *other* company that runs them. These three pieces do exactly that, and none of them belongs to any one rail.

- **Governed-spend attestations** (`server/attestations.js`, `POST /api/attestations`) — after the server-side policy check passes (and, above the approval line, only with an approved, unconsumed approval), the instance signs a short-lived token (`sva1.<base64url claims>.<EIP-191 signature>`, 300 s default, 900 s maximum) naming payer, payee, resource, USD ceiling, policy hash and decision. The policy's limits are deliberately not disclosed. `governedCall` — and so the MCP server and the proxy — attaches it to every x402 payment as `X-SpendVeto-Attestation` (both rails; the live x402 fetch wrapper carries it through its paid retry). Sellers verify offline against a pinned issuer address: `GET /.well-known/spendveto-issuer.json` publishes it, `integrations/seller-express.js` is the one-line Express gate (`requireGovernedAgent`) — fails closed with no trusted issuers, single-use per `jti`, bound to the paying wallet, root-cause error codes. `policy.attestations.requireOnCatalog` enforces it on this server's own catalog. `POST /api/attestations/verify` and `GET /api/attestations` for inspection.
- **Federated counterparty reputation** (`server/reputation.js`) — report a counterparty (crypto address, UPI VPA, IBAN, email, domain, `card-merchant:<network id>`) as `block` or `review`; the policy engine (so x402, AP2 and ACP evaluation), payouts (on the provider payee id and an optional portable `counterparty`) and card authorizations (on the network merchant id) refuse it or send it to a human. `GET /api/reputation/feed` publishes a signed feed of domain-separated SHA-256 subject hashes — no identifiers, reasons or amounts; `POST /api/reputation/import` accepts a feed only from a publisher on `policy.reputation.trustedPublishers` (fail closed), rejects edited feeds (digest), forged ones (signature) and rollbacks (an older feed over a newer one). `importedAction: "review"` downgrades imported blocks to human review. Canonicalization makes one counterparty one hash across casing, URL forms and spaced IBANs (mod-97 checked), while case-sensitive base58 addresses keep their case. `PUT /api/reputation/settings`, `GET /api/reputation/check`.
- **The policy file as an open standard** — `spec/policy-v1.schema.json` (JSON Schema 2020-12), hosted at `https://spendveto.com/schemas/policy-v1.json` with CORS. `server/policyspec.js` validates with strict keys (a misspelled limit fails open, so unknown keys are errors with a did-you-mean), wrong types, enums, unregistered chain ids, and warnings for contradictory limits; it implements exactly the keywords the schema uses and refuses a schema that uses others. Surfaces: `spendveto validate [file] [--strict]`, `POST|GET /api/policy/validate`, `GET /api/policy/schema`, a boot-time warning, and a **GitHub Action** (`action.yml`, `uses: revanthrajeev/spendveto@main`) that runs the validator from its own checkout with no install.
- **Fixed: `policy.llm.unknownModelRates` was documented but never read.** The default in `LLM_DEFAULTS` and the comment in `server/llm-pricing.js` both promised it; nothing passed it to the pricing lookup. It now replaces the flagship fallback per provider, and the ledger labels such entries `policy.llm.unknownModelRates`.
- `docs/NETWORK.md` specifies all three formats for independent implementations.
- Verify: 458 (+16: 6 attestations, 5 reputation, 4 policy standard incl. the GitHub Action, 1 unknownModelRates; 461 with `../prediction-copilot` alongside).

## 0.28.0 — 2026-10-18

Beyond crypto, beyond governance: real fiat payouts, and the ledger as a cost and billing system.

- **Governed fiat payouts** (`server/payouts.js`, `POST /api/payouts`) on four real providers, each in its documented request format (checked 2026-10-18): **Stripe** Connect transfers (`/v1/transfers`, cents, `Idempotency-Key`), **RazorpayX** payouts over UPI / IMPS / NEFT / RTGS (`/v1/payouts`, paise, `X-Payout-Idempotency`, basic auth), **PayPal** Payouts (client-credentials OAuth, `/v1/payments/payouts`, decimal-string amounts, `PayPal-Request-Id`), **Modern Treasury** payment orders over ACH / RTP / wire / book (`/api/payment_orders`, cents, basic auth org-ID:API-key). Before any money moves: a registered agent token by default (`policy.payouts.requireAgentToken`), kill switch, per-payout cap, rolling daily budget, hourly velocity, purpose allowlist, delegation caps — and a new payee or a large amount waits for a human (202; executes when approved in the Console, never when denied; unauthenticated one-click links can't approve payouts). Idempotency keys replay instead of paying twice. Non-USD money counts against USD budgets only at an operator-declared rate; no rate, no payout. Unconfigured providers refuse honestly. Not yet: asynchronous provider status webhooks.
- **AI FinOps** (`server/finops.js`) — request tags (`x-spendveto-tags: team=…,customer=…`) attribute model spend; **tag budgets** cap a team or customer across every agent; `GET /api/costs` groups spend across all rails (model tokens, x402 tools, cards, payouts) by rail, tag, agent, model or provider; `GET /api/costs/focus.csv` exports model spend in **FOCUS v1.4** (FinOps Foundation, June 2026) with all 21 mandatory columns, one row per priced token component, hourly charge periods. Ledger entries now carry a per-component cost breakdown.
- **Rebilling to Stripe Billing** — customer-tagged model spend becomes a Stripe Billing meter event (`/v1/billing/meter_events`: `event_name`, `payload[stripe_customer_id]`, `payload[value]` in micro-dollars at the operator's markup, an `identifier` for de-duplication); `GET /api/rebilling` reports cost, billed and margin per customer; `PUT /api/rebilling` configures it.
- **Console**: new **Costs** (spend by rail / team / customer / agent / model, FOCUS download, rebilling margins) and **Payouts** (providers, recent payouts, statuses) pages. Cards registered with tags carry them onto their decisions.
- Verify: 442 (+13: 8 payouts, 3 FinOps, 2 rebilling; 445 with `../prediction-copilot` alongside).

## 0.27.0 — 2026-10-18

The adoption release. Investors keep asking "who is using it?", and the honest answer was: nobody could, without running x402 — a market that is real but small today. The money AI agents actually spend right now is model tokens, and the failure people actually hit is a runaway agent (one developer reported ~$6,000 of Claude usage gone overnight; a LangChain agent made 14,000 redundant tool calls; a red-team case study cites ~$50,000 in under an hour). So SpendVeto now governs that spend, for anyone, with one environment variable.

- **LLM spend guard** (`server/llmguard.js`, `server/llm-pricing.js`) — an Anthropic- and OpenAI-compatible budget gateway on the main server's own port. `ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude`, `OPENAI_BASE_URL=…/v1 codex`, or any OpenAI/Anthropic SDK. Before a request reaches the provider: per-agent daily (rolling 24h), hourly, per-request (worst-case estimate) and per-Claude-Code-session budgets, a requests-per-minute limit (a real 429 with integer `retry-after`), a model allow/block list, the kill switch, an optional human approval above a threshold, and the shared policy engine for agents bound to a delegated wallet (one cascading cap across tokens, x402 and cards). **Loop detection**: the same tool call returning the same result N times freezes the agent (`source: llm-loop`) — only *successful* repeats count, so an SDK retrying a failed request is never a loop. While a request runs, its estimate is held (the shared holds number every payment check reads); afterwards the **actual** cost is booked from the provider's own usage — read out of the SSE stream as it passes — with cache reads and 5-minute / 1-hour cache writes priced separately and the price source stamped on the ledger entry. Prices for every current Claude model and OpenAI's current sheet (as of 2026-10-18), exact-match only (never by prefix), an unknown model priced at the provider's flagship rate and flagged, operator overrides in `policy.llm.prices`, upstream-reported cost (OpenRouter) preferred over any table. **Observe mode** records what it would have blocked and blocks nothing. **Team mode**: an agent presents a `tg_…` token and the guard swaps in a provider key only it holds; a server-side key is never used for a request without a valid token. Follows Claude Code's gateway compatibility guide: request bodies forwarded byte-for-byte, every `anthropic-*` header passed through, `?beta=true` preserved, streams relayed event by event including keep-alive pings, upstream errors unmodified; endpoints it can't meter (Message Batches) refused rather than passed through ungoverned. **Checked by hand with the real client**: Claude Code v2.1.300 ran through the guard unconfigured on 2026-10-18; its main request was booked at $0.012638 (63,180 tokens written to the one-hour cache at 2× input) — a manual check against a live account, kept out of the automated suite, which tests the same wire format against a local mock provider.
- **Card authorization governance** (`server/cards.js`) — Stripe Issuing's synchronous `issuing_authorization.request` webhook and Lithic Auth Stream Access, each signature-verified with replay protection (Stripe `t=,v1=` HMAC; Standard Webhooks for Lithic) and answered in the provider's own format. Kill switch, per-authorization cap, rolling daily budget, hourly velocity, merchant-category allow/block list (7995/6051/4829/6540 blocked by default), delegation caps for a card registered to a delegated wallet. USD only — a foreign-currency authorization is declined rather than compared with a guessed exchange rate.
- **`spendveto` CLI** (`bin/spendveto.mjs`) — `npx github:revanthrajeev/spendveto` (or `npm start` in a clone) starts the server bound to loopback and prints the one-line setup for each client; `budget`, `status`, `observe`/`enforce`, `freeze`/`unfreeze`, `connect`, `mcp`. Installs never write into their own package: runtime state moved behind **`SPENDVETO_DATA_DIR`** (`~/.spendveto` for an installed copy; `./data` in a checkout, unchanged), shipped assets (policy packs) stay in the package. The npm package is publish-ready (`files` whitelist, 70 files / 205 kB, verified by installing the packed tarball into an empty directory and running it) and carries an MCP registry entry (`server.json`, `mcpName`) — publishing is the maintainer's step.
- **Console → AI spend page**: per-agent spend (24h, last hour, remaining), top model, freeze/unfreeze, budgets form, recent decisions including observe-mode would-blocks, and copy-paste connection lines. `GET /api/llm/summary`, `GET /api/llm/connect`, `GET|PUT /api/llm/settings`; `GET|POST /api/cards`, `GET /api/cards/decisions`.
- Site: the homepage leads with "Cap your agent's spend in one line"; `/ai-spend.html` rewritten around the guard.
- Freezes accept `llm-loop` as a source (was coerced to `manual`). The server honours `HOST`.
- Verify: 429 (+27: 19 LLM guard, 6 card governance, 2 CLI/data-dir; 432 with `../prediction-copilot` alongside).

## 0.26.1 — 2026-10-16

- **x402 packages 2.18 → 2.28** (`@x402/core`, `express`, `evm`, `fetch`, `svm`, `aptos`, `stellar`, `hedera`, `xrpl`). Picks up upstream's released payment-bypass fixes since 2.18 — wildcard routes matched across encoded newlines (2.21), a backslash in a route parameter (2.22), and matching against both the escaped path and the framework's decoded view (2.27) — none of which this gate's probes had found open, plus Cache-Control `no-store` on 402s and facilitator request timeouts. The `HEAD` fix (#3796) is still unreleased; v0.26.0's own HEAD gating covers it. Every existing assertion passed unchanged on the new packages except one that read the old default-asset shape (`address` → `asset`).
- **Stronger registry cross-check.** x402's 2.28 default-asset table now covers 11 of the registry's 12 EVM chains (all but Optimism) and agrees with it on every one — stablecoin address **and** EIP-712 domain, including Monad's "USDC", which the 2.18 table had as "USD Coin". The assertion now checks both, offline.
- **auth-capture escrows pinned to the package.** `server/authcapture.js`'s canonical escrow and collector addresses (taken from the spec) are now asserted equal to the constants `@x402/evm` ships, so an upstream redeploy can't leave the gate approving an escrow nobody uses.
- **Docker image on Node 22.** Node 20 reached end-of-life in April 2026, and `@x402/stellar` 2.28 declares `node >=22`. The suite still passes on Node 20.
- Verify: 402 (+1; 405 with `../prediction-copilot` alongside).

## 0.26.0 — 2026-10-15

Upstream re-scan of `x402-foundation/x402` (27 commits since 2026-09-29) and the live facilitator's `/supported`, plus a first live-chain check of the registry. One real payment bypass, two payment-correctness bugs, one new scheme, five new chains.

- **Fixed: `HEAD` ran paid handlers unpaid on the live x402 gate.** Upstream fixed this class on 2026-10-13 (#3796, not yet in a published `@x402/express`). Probing this gate found it exposed: Express answers `HEAD` with the `GET` handler, the x402 rules named only `GET`, so `HEAD /api/agent/translate` returned 200 — the paid handler (and whatever it costs to run) executed without payment; the body was stripped, the work was not. Every paid route is now gated for `HEAD` too. Simulate mode was never affected (its gate is per-handler). Also probed and pinned: absolute-form request targets (`GET http://other.host/paid`, the class upstream fixed for Fastify in #3577) — not exposed here.
- **Fixed: EVM mainnet authorizations would have failed at settlement.** Every 402 carried `extra: { name: "USDC", version: "2" }`, but Circle's mainnet USDC on Base, Ethereum, Polygon, Arbitrum, Optimism and Avalanche signs EIP-712 as **"USD Coin"** — an EIP-3009 authorization signed against the wrong domain is rejected by the token. Each EVM registry entry now carries its token's own domain (`eip712`), each verified by recomputing the contract's `DOMAIN_SEPARATOR()`. Found by the new `npm run check-chains`, not by any local test — the truth lives on-chain.
- **Fixed: XRPL mainnet was registered under the testnet's network id.** `@x402/xrpl` defines `xrpl:0` as mainnet and `xrpl:1` as testnet; the registry described mainnet (mainnet RPC and RLUSD issuer, "real money") as `xrpl:1`, and a verify assertion pinned that. Split into **XRPL testnet** (`xrpl:1`, testnet RLUSD issuer — now live by default, since the public facilitator lists it) and **XRPL mainnet** (`xrpl:0`), whose opt-in moves to its own `SERVER_PAYOUT_ADDRESS_XRPL_MAINNET` so enabling the testnet can never enable real money. An empty payout variable now counts as unset.
- **x402 `auth-capture` governance** (`server/authcapture.js`) — the buyer's side of the escrow scheme (spec v1.1; TS SDK merged 2026-10-06). Vets a route before signing: canonical commerce-payments escrow (v1.1 / v1.0) and the matching collector, deadline order, `policy.authCapture.maxHoldSeconds` (default 7 days) and `minRefundWindowSeconds` (buyer protection as a policy knob), fee bounds and a bound fee recipient, and refuses the stranding case the spec names (a collect-only route publishing sync capture). Governs the maximum; holds the uncaptured remainder against the hourly budget alongside `upto` (`/api/upto/holds` now reports both); re-checks capture / charge / void / refund against the signed terms; and lists holds past their capture deadline as **reclaimable** — money only the buyer's own `reclaim` call recovers. `POST /api/authcapture/evaluate|authorize`, `/:id/capture|charge|void|refund|reclaimed`, `GET /api/authcapture`, `GET /api/authcapture/reclaimable`.
- **Five new chains (20 total, eight families):** XRPL testnet (live), and Monad, Celo, Sei and Stable mainnets (ready). Each EVM address is taken from x402's own default-asset table and then checked live — chain id, token symbol/decimals, EIP-3009 support, EIP-712 domain. (The installed `@x402/evm` table lists Monad's USDC domain as "USD Coin"; the contract signs as "USDC", and upstream has since corrected it — the registry follows the chain.) Stable settles in USDT0, labelled as such. Arc mainnet (`eip155:5042`) is in upstream's table but its public RPC was unreachable, so it is not registered until it can be checked.
- **`npm run check-chains`** (`scripts/check-chains.mjs`) — live-RPC drift check of every EVM registry entry. Network-dependent, so deliberately not in `npm run verify`.
- Fixed: Polygon's registry RPC (`polygon-rpc.com`) no longer answers; moved to `polygon-bor-rpc.publicnode.com`.
- Verify: 401 (+19: 13 auth-capture, HEAD gating, absolute-form targets, per-chain EIP-712 domains in a live 402, XRPL mainnet opt-in, registry-vs-x402 default assets, the new mainnets; 5 updated for the new counts and the XRPL ids; 404 with `../prediction-copilot` alongside).

## 0.25.0 — 2026-10-04

Regional payment governance and sanctions screening (entry reconstructed from the v0.25.0 commit, which shipped without one).

- **Four regulatory evaluators on the UPI pattern**, each read from its own regulation: `server/eu-sepa.js` (PSD2 SCA exemptions — Art. 10 one-off, Art. 14(1) fixed-amount recurring, operator-declared Art. 18 TRA threshold — plus SEPA Direct Debit pre-notification), `server/uk-fps.js` (Faster Payments push payments, Confirmation of Payee, the PSR's £85,000 APP-fraud reimbursement cap), `server/br-pix.js` (BCB nighttime transfer limit, Pix Automático scheduling-window and 7-day retry rules), `server/us-ach.js` (Nacha WEB-debit account validation, Regulation E consumer authorization). Each has an interactive page (`site/eu.html`, `uk.html`, `br.html`, `us.html`) whose client-side evaluator is asserted byte-identical to the server copy. Rail registry 7 → 11 (9 declared slots).
- **OFAC sanctions screening** (`server/sanctions.js`), wired into `checkPolicy` right after the freeze check: a payee on OFAC's SDN digital-currency-address list is refused unconditionally — no allowlist or delegation scope overrides it. Classifies by the address's own format, not OFAC's chain tag; fixed a lowercasing bug that corrupted base58 addresses. Its 15 assertions live in `scripts/test-sanctions.mjs` (they need a government-data fetch), not the main count. See `server/SANCTIONS_SCREENING.md`.
- **Two audited R&D prototypes, not shipped and not counted:** `wasm-policy/` (the deterministic half of `checkPolicy` in AssemblyScript → WebAssembly, 41-assertion parity suite incl. 50,000 fuzz cases) and `intercept/` (an HTTPS gateway that governs x402 payments from agents that never integrated SpendVeto; findings in `intercept/AUDIT_REPORT.md`).
- Verify: 382 (+61; 385 with `../prediction-copilot` alongside).

## 0.24.0 — 2026-10-02

Adoption release: the pieces a new team needs to try SpendVeto in minutes, plus an India wedge.

- **`npm run quickstart:ai`** (`scripts/quickstart-ai.mjs`) — boots the server and proxy, gives a fresh agent a hard LLM budget, spends until it's gone, and shows the next call refused *before* the model is called, with the hash-chain verified at the end. Works with no API key (simulated completions; governance and metering are real).
- **Python SDK** (`sdk-python/`) — stdlib-only twin of `spendveto-sdk`: `pay`, `dry_run`, `chat`, `register_agent`, and `SpendVetoDenialError` with `code` / `suggestion` / `stage`. Not on PyPI yet (`pip install ./sdk-python`). The denial path is tested against a local mock proxy, because a live blocked call would shift the suite's exact ledger counts.
- **UPI mandate governance** (`server/upi.js`, `POST /api/upi/evaluate`) — RBI Digital Payments E-mandate Framework 2026 rules, deterministic and INR end to end: human authentication on the first debit, above ₹15,000 per recurring debit (₹1,00,000 for insurance / mutual funds / card bills), ≥24 h pre-debit notice (FASTag/NCMC exempt), mandate withdrawal and expiry, plus operator caps and allowlists via `policy.upi`. The verdict is ECDSA-signed over rupees; the payee VPA is masked. **Evaluator only** — no UPI initiation or settlement, no PSP status, no NPCI/RBI approval claimed; "requires approval" is always a human completing the customer's authentication. A declared `npci-upi-agent` rail slot refuses honestly (NPCI's agent protocol is not live). Rail registry is now 7 (2 live, 5 slots).
- **Site**: `/upi.html` (interactive playground running the real evaluator in the browser — `site/assets/upi.js` is asserted byte-identical to `server/upi.js`) and `/ai-spend.html` (the quickstart); a new "Where adoption starts" slide in the deck.
- Verify: 321 (+18: 3 Python SDK, 15 UPI incl. the site/server evaluator parity check; rail assertions updated 6 → 7; 324 with `../prediction-copilot` alongside).

## 0.23.2 — 2026-09-29

- **Upstream re-scan** of `x402-foundation/x402` (56 commits since 2026-09-11) and the live facilitator's `/supported`. Two findings touched this repo:
- **Path-bypass regression guard.** x402 fixed its TypeScript route matcher (#3542) — a paid route could be reached unpaid when the web framework dispatched an encoded path the matcher never saw (`/api%2Fpremium` → `/api/premium`). Probed SpendVeto's live testnet gate with encoded, re-cased, trailing-slash, double-slash and dot-segment spellings: every one returned 402 or 404, none 200 — not exposed. A new assertion pins that, sending raw paths (not `fetch`, which normalizes dot segments away) so a future dependency bump can't silently open it.
- **Cardano note corrected.** `@x402/cardano` is now on npm (2.27.0), so the registry's "no package published" note had become false. The public facilitator still doesn't list a cardano network, so Cardano stays governed-but-not-settleable; the note and its assertion now say exactly that.
- Also checked, no change needed: upstream made `0x3600…0000` the default Arc USDC — the address this registry already carries. Noted for later: Arc mainnet (`eip155:5042`), Monad testnet, Casper and Bitcoin Lightning specs, SVM batch-settlement.
- Verify: 300 (+1; 303 with `../prediction-copilot` alongside).

## 0.23.1 — 2026-09-11

- **Cardano** (`cardano:preprod`) — registered the same day the x402 Foundation's own spec merged Cardano support (2026-09-09, checked directly against `x402-foundation/x402`), and registered **one step more honestly than Algorand**: Algorand at least has a facilitator that settles it — as of this entry, neither the public facilitator's `/supported` nor npm carries anything for Cardano at all (no published `@x402/cardano` package). So this instance can govern a Cardano payment — chain allowlists, delegated chain scope, per-chain ledger — and cannot sign *or settle* one anywhere yet. `schemeFor` throws for it rather than falling through to the EVM scheme, same defense as Algorand. Stablecoin is USDM (a native Cardano token, `policyId.assetNameHex`), not USDC — Cardano has no canonical USDC deployment, the same shape as XRPL/RLUSD.
- Registry now 15 chains across eight signature families.
- Verify: 299 (+1; 302 with `../prediction-copilot` alongside).

## 0.23.0 — 2026-09-08

- **ENS names in payee allowlists** (`client/ens.js`) — `allowedPayees` (global policy and per-delegation payee scope) now accepts `.eth` names alongside raw addresses, resolved against real Ethereum mainnet before the payee comparison in `checkPolicy` runs. The point: an allowlist a human can actually audit at a glance is `vitalik.eth`, not `0xd8dA6BF2...`. Resolutions cache (10 min on success, 1 min on failure — a name added moments after registration shouldn't sit "unresolvable" for the full 10) so the hot path (`checkPolicy` runs on every single governed call) never pays an RPC round trip on a cache hit. A name that fails to resolve is **dropped** from the effective allowlist, never treated as a wildcard — same fail-closed posture as everything else in this codebase.
- Fixed a real, unrelated bug found while wiring this up: the registry's `ethereum` chain RPC (`eth.llamarpc.com`) was returning `525 SSL handshake failed`. Swapped for `ethereum-rpc.publicnode.com`.
- Test design note: every other assertion in `npm run verify` is local and hermetic — even the x402 facilitator is a mock HTTP server, never a live third party — so a clean clone's result never depends on outside infrastructure staying up. A live Ethereum mainnet RPC call in the automated suite would have been the first exception, and a real one (rate limits, an RPC outage failing an assertion this repo did nothing to deserve). So `client/ens.js` exposes `__setEnsResolverForTesting` — production code never calls it, only `scripts/verify.mjs` does — swapping the network boundary for a deterministic fake while exercising the real resolution/caching/fail-closed logic around it.
- Verify: 298 (+3; 301 with `../prediction-copilot` alongside).

## 0.22.2 — 2026-09-08

- **Added `GET /openapi.json`** (`server/openapi.js`): a standard OpenAPI 3.0 document of the x402-priced catalog, generated from the same tool list (`allTools()` — the static `TOOLS` array plus anything registered dynamically via `POST /api/catalog/tools`) that `server/discovery.js`'s Bazaar-shaped resource list reads from. Two schemas, one source of truth, so they can't independently drift from what a call actually costs or where it lives.
- **Fixed a real `req.protocol` bug**: without `app.set("trust proxy", true)`, Express reports `http` even when the actual client connection was `https` — behind any reverse proxy (a CDN, a load balancer, a tunnel), every self-referential URL this server generates (the Bazaar resource list, the new OpenAPI document) would advertise a scheme a real client might not be able to reach. Set globally, not just for the new endpoint.
- Context: built while attempting to register a Bazantic gateway for ETHOnline 2026 (their platform wants an OpenAPI spec + a publicly-reachable endpoint). Registration itself hit a wall unrelated to this repo — `@bazantic/cli`'s login flow fails on their side, reproduced across multiple fresh sessions and an incognito window — so that integration was dropped, but the OpenAPI endpoint and the proxy fix are correct and useful independent of it.
- Verify: 292 (+1; 295 with `../prediction-copilot` alongside).

## 0.22.1 — 2026-09-08

- **Migrated World ID gating to World ID 4.0.** The old integration called the retired v2 `app_id`-keyed Verify API; World's Developer Portal has moved to an RP-based v4 protocol (`/api/v4/verify/:rpId`) that requires the backend to hand the client widget a signed `rp_context` (nonce + timestamps + signature) before it will even open a proof request — proving the request came from this server, not something impersonating it. `server/worldid.js` rewritten against `@worldcoin/idkit-server`'s `signRequest()`; new `GET /api/worldid/rp-context` endpoint for the widget to call.
- **Fixed a dormant env-loading bug in the same file.** `WORLD_APP_ID` (now `WORLD_RP_ID` / `WORLD_RP_SIGNING_KEY`) was read into a top-level `const` at module-load time — but with ES modules, an imported module's top-level code runs during the import phase, before the importing file's own later statements, including its `dotenv.config()` call. The env var was always `undefined` at the moment it was read, even with a correct `.env.local`. Never caught before because nobody had actually configured World ID for a real run. Fixed by reading `process.env` lazily inside each function instead.
- **Fixed a matching test-isolation gap** in `scripts/verify.mjs`: the suite's server subprocess inherits `process.env`, so once a maintainer's `.env.local` has real World ID credentials, the "refused when unconfigured" assertion silently stopped testing what it claimed to — it was asserting against whatever happened to be on the machine, not a guaranteed-unconfigured environment. World ID vars are now explicitly blanked (not just omitted — dotenv skips keys already present, even empty ones) in that spawn's env.
- Verified end-to-end against World's real infrastructure, not simulated: a real device-level proof scanned from the actual World App, POSTed to a live approval, refused without it (`world_id_proof_malformed`, 403) and approved with it (real Cloud Verify API round trip, 200) — gating a governed payment that then settled for real on Hedera testnet.
- Added `launch/worldid-demo.html`, a standalone page (loads `@worldcoin/idkit-core` from a version-pinned CDN URL — the unpinned one serves a JS/WASM version mismatch that fails silently) that requests a real proof and shows the exact object to POST to `/api/approvals/:id/decide`.
- Verify: 294 (unchanged — this is a protocol fix to an existing control, not a new one; the World ID assertions test the *unconfigured* refusal path, which stayed 3/3 passing throughout).

## 0.22.0 — 2026-09-04

The protocol-drift release. Two things changed underneath this codebase between v0.21 and now, both found by asking the public x402 facilitator what it actually supports rather than by reading an announcement: it settles a **new network** (Algorand, fee sponsored by the facilitator itself), and it settles **two new schemes** on base-sepolia — `upto` and `batch-settlement` — beside `exact`.

- **`upto`-scheme governance** (`server/upto.js`) — the scheme exists for usage-based billing inside one request: the buyer signs an authorization for a **maximum** and the seller decides afterwards what to actually charge. Every control here until now governed a known price, and treating an `upto` authorization like an `exact` payment fails three ways. Policy now decides on the **ceiling**, not the quote (a "$2" call permitting $50 is a $50 decision). An open authorization **holds** its ceiling against the hourly budget until it resolves — card pre-auth semantics — because otherwise an agent can sign ten $50 authorizations under a $60/hour cap and break nothing, since nothing has settled. Settlement releases the unused headroom, and only the settled amount enters the spend record. The three rules the scheme places on the *seller* — settle at most once, never above the authorized maximum, never after the deadline — are re-checked on the buyer's side, because the buyer is the party who pays for the facilitator being wrong: `upto_over_settlement`, `upto_already_settled`, `upto_expired`. `POST /api/upto/authorize` → `/settle` → `/void`, with `GET /api/upto` and `GET /api/upto/holds/:address`.
- **Arc** (`eip155:5042002`) — Circle's USDC-native L1, registered as an EVM chain because it is one, but it inverts an assumption the rest of the registry shares: USDC is the **gas token**, not an ERC-20 on top of one. The registered address is the ERC-20 interface over that native balance — 6 decimals over an 18-decimal native unit — which is the view an x402 `AssetAmount` is denominated in. Chain id verified live against its RPC, not copied from a doc.
- **Algorand** (`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`) — registered as **governed-but-not-signable**, the honesty rule applied to a chain. The public facilitator settles it and sponsors the fee, but no `@x402/algorand` client scheme package is published on npm, so this instance can govern an Algorand payment (chain allowlists, delegated chain scope, per-chain ledger) and cannot sign one. It has no entry in the payout map, so it can never enter `liveSettlementChains` by accident, and `schemeFor` throws for it rather than quietly signing an Algorand payment with the EVM scheme.
- Fixed: `CONTROLS.md` had its "Known gaps" section buried in the middle of the control table (rows 27+ appeared after it); the gaps now close the document. The site's static chain-picker fallback listed XRPL as `live` while the registry called it `ready` — the registry is right, since XRPL mainnet settlement is disabled unless an operator explicitly opts in.
- Verify: 291 (+11).

## 0.21.0 — 2026-08-21

The competitor-scan release. A fresh market sweep (Fireblocks joining the x402 Foundation with a *request integrity and spend governance* extension; AWS Bedrock AgentCore Payments previewing spend limits; Cloudflare announcing Account Wallets with spending controls; ACP's Delegated Payments Spec shipping Shared Payment Tokens; a Cloud Security Alliance survey putting 65% of agent-running enterprises at one or more agent incidents in twelve months) surfaced four gaps a per-call cap structurally cannot close. All four are local, deterministic, and dependency-free.

- **Request integrity** (`server/integrity.js`) — the first control here that answers *is this the spend I allowed?* rather than *is this spend allowed?*. Policy runs on a described request and something else executes; in between, a compromised or buggy agent can change the payload while payer, price and approval all still match, and every amount-based control passes. Canonical recursive sorted-key SHA-256 of the request (key order can't change the answer), signed by the same key that signs receipts and verdicts; `POST /api/integrity/bind` → `POST /api/integrity/verify`. Single-use (`binding_consumed`), TTL-bounded (`binding_expired`), agent-scoped (`binding_agent_mismatch`), and a swapped payload fails `request_integrity_mismatch`. The buyer-side counterpart to the extension Fireblocks is contributing to x402.
- **ACP shared-payment-token scope** (`server/acp.js`, `POST /api/acp/checkout`) — an SPT is minted for an amount, a merchant and a window; the merchant validates the token, and nobody validates the shopping. Same failure shape as the AP2 intent→cart drift, so the same treatment: `spt_merchant_drift`, `session_exceeds_spt`, `spt_expired`, `spt_category_drift`, `session_total_mismatch` (arithmetic checked *before* the ceiling), `spt_session_mismatch`, and `spt_currency_mismatch` — a ceiling in one currency is never silently compared against a charge in another. An allowed session leaves bound to its own bytes; a denied one gets no binding.
- **Dispute evidence packs** (`server/disputes.js`, `GET /api/disputes/:entryHash/evidence`) — agent purchases produce no device fingerprint, IP or browsing session, so they lose chargebacks by default; Visa TAP, Mastercard Agent Pay, AP2 and Amex's agent protections all describe authorization but not the after-the-fact defence file. Nothing new is captured — the pack assembles the ledger entry pinned between its neighbouring hashes, the policy hash in force with drift **disclosed**, the human approval and the signed consents, then signs the bundle over its own digest (`pack_tampered` on any edit). Every pack carries a `doesNotEstablish` list inside the artifact: it never implies delivery, satisfaction, or that the policy was a good one.
- **OpenTelemetry decision spans** (`server/otel.js`, `GET /api/otel/spans`) — OTLP/HTTP JSON, no OpenTelemetry SDK (a supply-chain surface the component whose job is refusing to trust things doesn't need). Adopts an inbound W3C `traceparent` so a refusal appears under the agent run that caused it; span ids derive from the entry hash so re-export doesn't duplicate; a malformed header degrades to a standalone trace rather than breaking the decision surface. **Blocked is status OK, not ERROR** — the gate did its job, and colouring refusals red trains a team to ignore the colour that matters.
- Verify: 267 (+30).

## 0.20.0 — 2026-07-17

- **Facilitator-adaptive multichain live settlement.** The testnet gate no longer hardcodes Base Sepolia: at boot it calls the configured facilitator's `GET /supported` and registers **every registry chain the facilitator names** — per-chain `ExactEvmScheme` registration and one accepts entry per live chain in every 402, priced as explicit atomic-USDC `AssetAmount`s from the registry's canonical contracts (the `"$0.01"` shorthand needs the package's default-asset table, which doesn't cover ethereum/optimism/avalanche). Falls back to base-sepolia if `/supported` is unreachable. `/api/chains` now reports per-chain `settlement: "live" | "ready" | "simulated"` plus the instance's `liveSettlementChains`. The client rail generalized to `x402-live` (was `x402-base-sepolia`): it signs for any registry chain and lets the protocol — not an artificial throw — decide. Chain registry statuses: the six non-sepolia chains are now `ready` (full v2 wiring; the facilitator's supported list + a funded wallet flips them live, zero code changes), rendered as READY (not SIM) on the site chain band, signup pills, and console chain cards. 3 assertions via a mock facilitator: all-seven advertised → all seven live with seven CAIP-2 payment options in one real 402; one advertised → exactly one live + six ready.
- Verify: 188.

## 0.19.0 — 2026-07-17

The evidence release — driven by a fresh deep-research round (`launch/PERPLEXITY_RESEARCH_2026.md` + the resulting report): what enterprise buyers ask for that rails don't provide is *pre-decision evidence*, and what the ecosystem's rails standardize is mandates. Four features, all locally verified; the research's "don't build" list (hosted SaaS, ML anomaly models, own custody, deep billing engine, early SOC 2 certification) matches what this repo already deferred.

- **Structured decision events + SIEM export.** `server/events.js` reshapes the hash-chained ledger into one stable schema (`spendveto.decision.v1`): agent, decision, amount, payee, reason, receipt id, policy version, and the chain-of-custody hashes. `GET /api/events` (filterable JSON) and `GET /api/events/export` (JSON Lines — one event per line, straight into Splunk/Datadog/Elastic/`jq`). Read-only over the ledger.
- **Policy versioning in the audit trail.** `policyHash()` (`client/policy.js`) — recursive sorted-key SHA-256 of the effective policy — is stamped onto every gate decision (paid and blocked). An auditor can answer "which policy was in force when this spend was allowed?" from the ledger alone. The enterprise record-keeping detail governance checklists (EU AI Act record-keeping, NIST AI RMF) actually name.
- **AP2-style mandate evaluation with signed verdicts.** `POST /api/ap2/evaluate` runs the full policy pipeline against an AP2-shaped mandate (agent, amount, payee, category, expiry) and returns the verdict ECDSA-signed by the server's receipt key — portable evidence anyone can verify. Expired mandates are refused (`mandate_expired`). AP2 *settlement* remains an honest roadmap rail slot; this is the governance half, real today.
- **Governed-billing sink.** `server/billing.js` — after a settlement, one normalized `spendveto.usage.v1` event (transaction id = receipt id, wallet, tool, amount, chain) is pushed to `policy.billingWebhookUrl` with optional HMAC signing; same fire-and-forget contract as alerts. SpendVeto decides pre-payment; Lago/Orb/Metronome-style platforms invoice post-usage — the division of labor the research recommended instead of building a billing engine.
- **OpenAI Agents SDK adapter.** `integrations/openai-agents.js` — dependency-free `{name, description, parameters, execute}` tools (the Agents SDK `tool()` shape) over the same governed proxy path as the LangChain adapter, catalog-live, structured denials included.
- **CONTROLS.md** — the control inventory mapped to EU AI Act / NIST AI RMF expectations, each row citing the verify assertion that exercises it. A self-assessment, explicitly not a certification.
- Verify: 185 (+9: events schema, JSONL export, policyHash changes with policy, AP2 signed allow / per_call_cap deny / mandate_expired, billing usage event by receipt id, adapter shape, adapter governed call).

## 0.18.0 — 2026-07-17

Two roadmap items from the pitch's funded-milestone list, built to the point they're testable today (the rest of that list — hosted Postgres, multi-tenant SSO, mainnet, full marketplace — genuinely needs infra/funds this environment doesn't have, and stays honestly deferred rather than faked):

- **Cross-org trust graph + counterparty credit bureau (roadmap: "scale the per-wallet score into a cross-organizational agent credit bureau and trust graph").** The flat per-wallet governance score already existed; `server/trust.js` scales it out. `/api/trust/graph` returns the whole forest — every wallet a scored node, every delegation a directed edge, every delegation root an "org" whose blended, paid-volume-weighted reputation aggregates its entire sub-tree (answers "how well-governed is this whole fleet?"). `/api/trust/payee/:address` is the counterparty bureau: the reputation of a *recipient*, aggregated across every wallet that has ever paid it (distinct payers, paid/blocked counts, total volume, and the average governance grade of its payers) — the cross-org signal a single-wallet score can't see, since payees are shared across organizations even when wallets aren't. Paid **and** blocked ledger entries now record `payTo`, so the bureau sees both settled and attempted-but-refused payments. The existing `/api/trust/:address` now shares one score definition with the graph (DRY). 3 assertions.
- **Advanced anomaly models (roadmap: "richer anomaly detection on top of the baseline burst-rate detector").** The burst detector was a single reflex — rate. `analyzeAnomalies()` in `server/anomaly.js` adds a read-side panel of deterministic behavioural signals over a wallet's own ledger: block-rate spike (a probing/misconfigured loop the timer misses), novel payee (money to a never-before-paid recipient), category drift (spend in a category the wallet has never touched), and amount outlier (a paid amount far above the wallet's own median). Each returns a bounded severity and a plain-English reason; the composite advisory `level` (none/low/elevated/high) is surfaced at `/api/anomaly/:address`. Nothing here is a black box or a network call — every signal is a pure function of the ledger, so it's fully reproducible. Advisory only; the burst freeze remains the sole auto-action. 2 assertions.
- **SOC 2 readiness mapping (`SOC2_READINESS.md`).** An honest controls-to-evidence map for the roadmap's SOC 2 item — maps the Trust Services Criteria a security audit would examine to the specific enforced controls and their verify assertions, and states plainly what is *not* yet true (no audit performed, no certification). A readiness artifact for a design partner's security team, not a certification claim.
- Verify: 176.

## 0.17.0 — 2026-07-17

- **API-key auth + roles on the admin surface (board-review issue #10).** Closes the review's disqualifying "platform security" finding: the management API was previously reachable by anyone who could hit the port. `server/auth.js` adds bearer keys with roles (viewer < approver < admin) and a `requireAuth(minRole)` middleware now guarding 12 admin-surface endpoints (policy PUT/apply, shadow PUT/DELETE, freezes, delegations, catalog registration, top-ups, approval decisions). Same "open until configured" pattern the proxy uses for agent identities — zero keys = open mode (zero-setup demos and this suite unaffected); the first key flips the server to auth-required. First key is minted on the trusted host with `npm run apikey [role] [label]`, never over the API (no privilege bootstrap from an unauthenticated request). Public read endpoints (`/api/stats` etc.) stay open so the marketing site keeps working. 5 assertions: unauth write → 401, admin write → 200, viewer write → 403, reads stay open, keys removed → open mode.
- **Deferred honestly: Postgres store (issue #9).** The board review's other P1 was a `Store` interface + Postgres adapter. It's not in this release because this environment has no Postgres to test against, and shipping an untested on-disk-vs-database abstraction would violate the repo's one rule (no claim without a passing assertion). It's the right next build once a real Postgres is available to verify both backends.
- Verify: 171.

## 0.16.0 — 2026-07-17

Two features driven by fresh market research (both surfaced repeatedly as gaps in 2026 agentic-payments guidance and the board review):

- **Payee allowlisting.** Pin which recipient addresses an agent may pay, enforced server-side at the gate — the most-cited guardrail in current agentic-payments guidance ("even if the agent is compromised or prompt-injected, it can only reach addresses on the list"). A global `allowedPayees` policy plus a per-delegation `allowedPayees` scope that cascades through the budget tree exactly like tool/chain scope (`client/policy.js`, `server/delegations.js`, marketplace tools now carry an optional `payTo`). New codes: `payee_not_allowed`, `payee_scope`. Three assertions: off-list payee blocked at the gate, same payment settles once allowlisted, payee-scoped sub-agent blocked from an out-of-scope recipient.
- **Shadow mode.** Set a candidate policy that runs alongside the live one *without enforcing* (`server/shadow.js`; `GET/PUT/DELETE /api/shadow`). Every real decision at the gate is also evaluated against the candidate — same delegations/freezes/spend history — and the report says how much spend it would have additionally blocked or newly allowed. Measure a policy change against live traffic before promoting it. `checkPolicy` gained an optional policy-override param to make this a single source of truth rather than a parallel evaluator. Three assertions: live call still settles, report shows the strict candidate would have blocked it, clearing ends the experiment.
- Verify: 166.

## 0.15.0 — 2026-07-17

Board-review round (`launch/BOARD_REVIEW.md`): a full teardown against the funded competitive landscape (Catena Labs' $30M a16z Series A + bank-charter filing) drove a licensing switch, an honesty pass, and the two deepest correctness items.

- **Server-authoritative enforcement (issue #8).** The single biggest architectural gap the review found: in self-custody mode, policy ran only in the *caller's* library, so a key-holding agent with a modified client could push a validly-signed over-budget payment straight to the settlement gate, which previously checked only freeze + nonce + signature + balance. The gate now runs the **same governance pipeline server-side** (`server/simulate.js` → `checkPolicy`), and above-threshold spends must be backed by a real, **single-use** approval record (`findApprovableFor`/`consumeApproval` in `server/approvals.js`). Governance is now enforced by the party holding the money. Proven by an assertion that reproduces the bypass and confirms the gate refuses it, plus one for the approval requirement.
- **Hash-chained audit ledger (issue #11).** Every ledger entry now carries `prevHash` + `entryHash` (SHA-256 over the prior hash + canonical entry); `GET /api/ledger/verify-chain` walks the chain and returns `brokenAt` for the first tampered row. Tested by editing a settled amount on disk and confirming detection at that exact index.
- **Relicensed MIT → Apache-2.0** (explicit patent grant for payments infra; done now while there are zero external contributors). LICENSE + NOTICE + every reference across README/PITCH/site/SDK.
- **Honesty pass:** competition section updated with Catena's raise (removed "buyer side is nearly empty"); marketplace "two-sided flywheel" downgraded to the supply-side primitive it is; trust score labeled per-instance wallet health with the cross-org trust graph called roadmap; "private beta" language removed sitewide (it's a waitlist, not a live product); a stale "138 verified behaviors" fixed.
- **Distribution prep:** Dockerfile + docker-compose + .dockerignore; SDK readied for npm (types, `files` allowlist, repo metadata, README) — `npm pack` clean.
- Verify: 160.

## 0.14.0 — 2026-07-12

Security-test round, closing the last two items from GPT's "top-5 security tests" backlog (`launch/RESEARCH_TRIAGE.md`) that weren't already covered — TOCTOU races, cross-chain replay, and delegation cycles were already tested; these two weren't:

- **Tampered-webhook detection**: a new assertion proves the HMAC signature on webhook deliveries actually catches tampering — computes the signature a receiver would derive from a mutated payload and confirms it no longer matches what was delivered, rather than just asserting a valid signature exists on the untampered case.
- **Freeze-before-signature ordering**: a new assertion proves a frozen wallet is rejected for being frozen even when the request also carries a forged signature — confirming the freeze check runs first in the pipeline rather than only mattering once a signature would otherwise have passed.
- **`docs/safe-allowance.md` + `rails/safe-allowance.js`**: real (non-stub) implementation of the Safe{Wallet} AllowanceModule off-chain signing math (`transferHash`/`domainSeparator` against the canonical typehashes), gated behind config and honestly refusing until a funded testnet Safe exists to verify the on-chain call path against. `scripts/deploy-safe-allowance.mjs` is ready to run the moment the existing testnet wallet has Base Sepolia ETH (currently blocked on a faucet's human-verification step, confirmed via a live RPC balance check, not assumed).
- Verify: 155.

## 0.13.0 — 2026-07-12

Research-driven correctness + distribution round, triaged from a GPT deep-research pass (`launch/RESEARCH_TRIAGE.md`):

- **Fixed a real concurrency race**: `checkPolicy` reads spend over HTTP, and the debit+ledger-append happened several `await`s later with no lock — two concurrent calls for the same wallet could both read the same "spent so far" snapshot and both pass a cap that only had room for one (the "20 agents each pass a budget check simultaneously" failure mode). `withWalletLock` (`client/pay.js`) now serializes the whole decide-and-commit unit per wallet, covering both `governedCall` (CLI/MCP/`/proxy/call`) and `/proxy/llm`. Proven with 6 concurrent calls against a cap sized for exactly one — verified exactly one wins, every time.
- **`sdk/`**: a dependency-free npm client (`SpendVeto` class — `pay()`, `dryRun()`, `chat()`, `registerAgent()`, throws `SpendVetoDenialError` with `code`/`suggestion`) — the "npm import instead of curl" surface.
- **`integrations/langchain.js`**: catalog tools exposed as duck-typed LangChain-shaped `{ name, description, func }` objects, zero hard dependency on `@langchain/core`. Denials throw with the structured code embedded so an agent's next reasoning step can self-correct.
- **`GET /metrics`**: Prometheus text-exposition scrape target (paid/blocked/failed counters, frozen-wallet gauge, per-category breakdown) alongside the existing JSON `/api/stats`.
- Verify: 151.

## 0.12.0 — 2026-07-12

Console completeness: **Agents & Market** page (mint agent identity tokens, list marketplace tools — from forms, not curl) and **Report** page (`GET /api/report` — headline, spend by category/chain, top block reasons for a rolling window). Console now 10 pages. Fixed an order-dependent assertion in the verify suite (comparing a stale snapshot to live state) before it could flake in CI. verify: 141.

## 0.11.0 — 2026-07-11

Competitor-parity round (research-mapped): **agent identities** (bearer tokens bound to wallets; proxy auth switches on with the first registered identity), **hourly category caps**, **N-approver approvals** (deny instant, approve needs quorum), **trading-hours windows** (UTC, wrap-around). Verify: 138.

## 0.10.0 — 2026-07-11

- **Tool marketplace**: `POST /api/catalog/tools` — anyone lists a paid endpoint behind the same 402 gate (optional `upstreamUrl` forwarding); CLI resolves marketplace tools from the live catalog.
- **Recurring allowances**: `--every 7d` on grants — caps apply to a rolling window and re-fill on their own (tested with a 2s window).
- **Simulated top-ups**: `POST /api/balances/topup` (simulate mode only).

## 0.9.0 — 2026-07-11

- **The API-spend rail** (`POST /proxy/llm`): auth/capture governance for LLM/API dollars — estimate up front, full pipeline against the estimate (fails closed, upstream never called), actual metered cost into the shared ledger's `api` bucket. Real Anthropic upstream with a key; honestly-simulated without.
- PITCH: dual-engine model (SaaS ARR on API spend today + bps on governed volume at scale) and the $1B+ take-rate scenario table.

## 0.8.0 — 2026-07-11

- **x402 v2 migration**: `@x402/*` scoped packages, CAIP-2 network ids on all 7 chains, `x402ResourceServer` + `HTTPFacilitatorClient`, `SPENDVETO_FACILITATOR_URL` override for the CDP facilitator; deprecated v1 packages removed.
- **Idempotency hardening**: store scoped to key+tool+child+chain (poisoning-proof); consumed-authorization replay and delegation-cycle-termination assertions.

## 0.7.0 — 2026-07-11

The "one API, any rail" release: multichain governance, the console, the rails layer, and the research-driven agent-UX features.

**Multichain governance (not a logo strip)**
- The settlement chain rides *inside* every signed payment authorization — a payment signed for Polygon is cryptographically rejected on Arbitrum (tested).
- Per-`(wallet, chain)` balances; 7 chains registered with canonical USDC contracts + RPCs (`/api/chains`).
- Policy-level chain allowlists (`allowedChains`), chain-scoped delegation (`--chains`, ancestors bind subtrees), `--chain=` on the CLI, `chain` on proxy intents, per-chain analytics, chain column in the CSV export.

**Agent-experience features (from the July 2026 deep-research round — see `launch/RESEARCH_TRIAGE.md`)**
- **Self-correcting denials**: every block carries a machine-readable `code` + concrete `suggestion` through CLI (`Fix:` line), MCP tool errors, and proxy 403 bodies — blocked agents adjust instead of retry-looping.
- **Time-boxed budgets**: `--ttl 90|10m|2h` on any grant; expired links (and expired *ancestors*) kill the branch.
- **Dry runs**: `--dry-run` / `{"dryRun":true}` evaluates the whole pipeline with zero side effects (ledger asserted unchanged).
- **One-click approvals**: webhook alerts carry `approveUrl`/`denyUrl`; `GET /api/approvals/:id/decide` works from chat.

**The Console** — the dashboard rebuilt as an 8-page control surface (overview, approvals, budgets, ledger, chains, analytics, trust, policy) with real write controls: create wallet+grant in one call (`POST /api/delegations/wallet`), live policy editing (`PUT /api/policy`), policy-pack apply (`POST /api/policy/apply`), freeze/unfreeze/revoke/approve/deny everywhere, ledger filters + CSV.

**Rails adapter layer (`rails/`)** — one `pay({ tool, account, chain, baseUrl })` contract; `x402-simulate` and `x402-base-sepolia` live behind it, Google AP2 / OpenAI ACP / Stripe MPP as declared slots that refuse honestly. `GET /api/rails`; the proxy advertises its rails in `/proxy/health`.

**Gateway-grade hardening**
- **Idempotency keys** on the proxy: a retried intent replays the stored response — an agent can never pay twice for one intent (tested: one ledger entry).
- **HMAC-signed webhooks**: set `alertSigningSecret` and every alert carries `X-SpendVeto-Signature` for receiver-side verification.
- **Receipts API**: `receiptId` lands in the ledger; `GET /api/receipts/:id` + `POST /api/receipts/verify` (tampered receipts fail — tested).

**Site** — Reown-style self-contained wallet modal (EIP-6963, INSTALLED badges, All-Wallets search grid — no SDK, no cloud project id), "Launch App" sign-in card, chain band + FAQ on the landing page, market numbers re-verified against primary sources (x402: 169M payments / 590K buyers in year one, InfoQ Jul 2026).

## 0.6.0 — 2026-07-10

- **Enforcement proxy** (`npm run proxy`, :8404): keyless agents POST spending intents; custody signs only after the full pipeline passes — SpendVeto on the money path.
- **Trust scores** (`GET /api/trust/:address`): governance history → 0–100 score + grade; a runaway wallet grades F at 0.
- **Policy packs**: `cautious` / `standard` / `production` presets, `npm run policy -- apply <pack>`.
- Sign-up/waitlist + wallet sign-in pages; durable waitlist API (position returned, emails never exposed); 7-chain registry.

## 0.4.0 – 0.5.0 — 2026-07-09/10

- **Kill switch + runaway detection**: manual per-wallet freeze + automatic burst freeze (default 10 attempts/10s); frozen wallets refused even with correctly signed payments (403).
- **n-level budget delegation**: caps cascade — every ancestor's cap binds its whole subtree; revoking a link kills the branch. Tool scoping (`--tools`).
- **ECDSA-signed receipts**, CSV audit export, per-tool/per-wallet analytics, webhook alerts, blocked-spend as the headline metric.
- Deploy-ready marketing site (Three.js hero, fully static, self-contained) + investor deck page + docs page.

## 0.1.0 – 0.3.0 — 2026-07-08/09

- The "smallest real test": x402 payments (real `x402-express`/`x402-fetch` on Base Sepolia via the public facilitator) gating a catalog of three Claude-backed tools at three prices.
- Zero-setup **simulate mode** with real secp256k1/ECDSA signing, nonce replay protection, and local settlement — forged signatures rejected (tested).
- Policy engine (per-call / hourly / rate caps), human approvals that **fail closed** on timeout, governance dashboard, MCP server exposing the governed catalog to any MCP client.
