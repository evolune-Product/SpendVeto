# Sanctions / denylist screening

**First-class, deterministic, address-based OFAC sanctions screening** — wired directly into the
real `checkPolicy()` enforcement pipeline (`client/policy.js`), not a side experiment sitting in
its own folder. Every governed payment to an external payee is checked against OFAC's real,
published Specially Designated Nationals (SDN) list digital-currency-address entries before it's
allowed to proceed, same as the freeze check: absolute, not configurable, not overridable by policy.

## What's real here

- **The data source is genuine.** `scripts/fetch-sanctions-list.mjs` fetches
  `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML` — the U.S.
  Treasury's own Sanctions List Service, confirmed live during development (list published
  2026-10-02, 19,488 total SDN entries, 1,066 of them carrying at least one digital currency
  address across 19 token/chain tags). Not a sample file, not a handful of hardcoded addresses
  pretending to be a list.
- **The tests cite real SDN entries**, independently verifiable by anyone at
  `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=<uid>` — e.g. uid 24003 (Behzad MESRI,
  CYBER2/HRIT-IR) and uid 56360 (Rolan SOKOLOVSKI, ILLICIT-DRUGS-EO14059). Not fabricated test
  fixtures.
- **Enforcement is live in `checkPolicy()`**, not a standalone module nobody calls. A payment to a
  real SDN-listed address is refused by the actual governance pipeline every SDK/proxy/MCP call
  goes through, end to end, tested with the real server running.

## How it works

```
npm run sanctions:update     # fetch the real, current list (run this first)
npm run server                 # the running server now screens every external payee
```

`checkPolicy(address, price, toolId, chain, category, payee)` screens `payee` — the same external
recipient the existing payee allowlist already governs — before the chain allowlist, before the
payee allowlist, right after the freeze check. A hit denies with code `sanctioned_payee`, citing
the real SDN uid and program, and cannot be waived by any policy setting, allowlist entry, or
delegation scope.

```js
screenAddress(address, chain)
// -> { sanctioned: false, screened: true,  listStatus }                 clean
// -> { sanctioned: true,  screened: true,  match: {...}, listStatus }   hit — real SDN entry cited
// -> { sanctioned: false, screened: false, reason: "...", listStatus }  couldn't screen — never treated as clean
```

## The one correctness bug worth knowing about (found and fixed during development)

OFAC's own "USDT" tag mixes genuinely different address formats under one label — some are EVM
(`0x...`), some are Tron (`T...`, base58). Trusting OFAC's chain *tag* to decide which SpendVeto
chains an address applies to would misclassify real entries, so this screens by the **address's
own format** instead (confirmed necessary, not a design preference — see
`scripts/fetch-sanctions-list.mjs`'s header).

That in turn surfaced a real bug: base58 (Solana, XRP) is case-sensitive — it deliberately excludes
`0`, `O`, `I`, `l` to avoid visual ambiguity — so blindly lowercasing an address before checking its
format can turn a valid uppercase letter into an excluded lowercase one, corrupting the address
before it's even classified. A real SDN-listed Solana address containing `L` silently failed to
screen until both `server/sanctions.js` and `scripts/fetch-sanctions-list.mjs` were fixed to
canonicalize case only for EVM addresses (where it's actually safe and conventional) and preserve
original casing everywhere else. Caught by testing against a real address, not by inspection —
exactly the kind of bug a synthetic test fixture would never have found.

## Chain coverage

EVM-format addresses (`0x...`) are screened against **every** SpendVeto EVM chain — Base, Base
Sepolia, Ethereum, Polygon, Arbitrum, Optimism, Avalanche, Arc — regardless of which EVM chain OFAC
happened to tag the address with, because the same address space is valid on all of them and
chain-specific screening would be a real evasion vector. Solana addresses screen against
`solana-devnet`; XRP-format addresses against `xrpl`. Chains with no current OFAC digital-currency
coverage (Aptos, Stellar, Hedera, Algorand, Cardano) are honestly reported as **not screened**, not
silently treated as clean.

## What this is NOT

- **Not a complete compliance program.** Exact address match against one list (OFAC SDN digital
  currency addresses) only — no name screening, no the Consolidated (non-SDN) list, no EU/UN/UK
  sanctions lists, no fuzzy/alias matching, no tracing through intermediate wallets.
- **Not auto-refreshing.** `npm run sanctions:update` must be run periodically by the operator;
  nothing here schedules that. `sanctionsListStatus()` reports the cache's age honestly so an
  operator (or a dashboard) can see exactly how stale it is, rather than silently trusting it
  forever.
- **Not a substitute for a licensed sanctions-screening vendor** for an entity with real regulatory
  exposure. This is the concrete, address-level, zero-ambiguity piece that's directly actionable
  against a blockchain payee — exactly the gap called out as absent — not a claim of full
  regulatory compliance coverage.

## Testing

```bash
npm run sanctions:update          # fetch the real current list
node scripts/test-sanctions.mjs   # 15 assertions: direct screenAddress() unit tests +
                                   # end-to-end checkPolicy() integration with the real server
```

Run three times during development: 15/15 passed every time. The full existing `npm run verify`
suite (300+ assertions covering the rest of the product) was also run twice against the final code
with this wired into the live `checkPolicy()` — zero new failures; the only failures present are
pre-existing, already-diagnosed environment issues (no Python interpreter on this machine; a
timing-sensitive allowance-window test) unrelated to this change, confirmed by reproducing the same
failures on the untouched baseline earlier in this session.
