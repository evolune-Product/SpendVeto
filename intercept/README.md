# spendveto-intercept

**Universal interception gateway.** Governs x402 payment attempts from agent code that never
adopted SpendVeto at all — no SDK import, no MCP server, no enforcement proxy — by transparently
intercepting its HTTP(S) traffic and running the real `client/policy.js` `checkPolicy()` pipeline
before a payment reaches its destination. Point an agent's standard `HTTP_PROXY`/`HTTPS_PROXY`
environment variable at it; the agent's code doesn't change at all.

This is the "govern what you didn't build" move: every other integration surface in this repo
requires cooperation from the agent's own code. This one requires cooperation from neither the
agent's code nor the seller's — it works purely at the network layer, the same way mitmproxy,
Charles, Fiddler, or HTTP Toolkit's own `mockttp` (what this is built on) work.

## Why this needs an unusual amount of trust, and why that's the point

To intercept HTTPS, this gateway generates a local root CA and dynamically signs a leaf
certificate for every domain it sees, the same technique every TLS-debugging proxy uses. Anything
that trusts this CA will trust certificates this process generates on the fly. That is real
cryptographic trust infrastructure, not a toy, and the honest framing is: **a closed SaaS cannot
credibly ask for this level of trust, and an open-source, self-hosted, fully-readable tool can** —
but only if it actually earns that by being narrow, scoped, and auditable rather than a black box
that happens to be open-source. This file and `gateway.mjs` are short on purpose, so reading all of
it is a reasonable bar to clear before trusting it with real traffic.

## Scope, by default

- **Host allowlist, not "the whole internet."** `INTERCEPT_HOSTS` (comma-separated) controls
  exactly which hosts get intercepted; everything else passes through mockttp without this
  gateway's governance logic touching it at all. Default: just the local SpendVeto server. A
  gateway that silently MITMs every HTTPS connection on the machine the moment it's pointed at —
  banking sites, email, anything — the moment it's configured is a surveillance tool wearing a
  governance tool's clothes, not a governance tool. Widen deliberately via `INTERCEPT_HOSTS`, never
  by default.
- **Upstream certificate verification stays on by default.** The gateway verifies the real TLS
  certificate of whatever it forwards to, same as any correct HTTPS client. `INTERCEPT_IGNORE_UPSTREAM_CERT_ERRORS`
  (comma-separated hostnames) is an explicit, narrow opt-in for the one legitimate case this
  matters for — an operator governing their own self-signed internal x402 seller — never a global
  "trust everything" switch.
- **Fails closed.** A payment attempt for a resource whose price this gateway doesn't already know
  (no local catalog entry, no previously observed 402 challenge) is refused, not silently allowed.
  See `priceFor()` in `gateway.mjs`.

## What's intercepted, what passes straight through

Only requests carrying a recognized payment header are ever touched. Everything else — including
the ordinary, unpaid first request that triggers an x402 402 challenge — passes through mockttp's
`thenPassThrough` completely untouched. Two header forms are recognized:

- `X-SIM-PAYMENT` — this repo's own simulate-mode format (`0xAddress:nonce[:chain]:0xSignature`),
  fully parsed, chain-aware.
- `X-PAYMENT` — a generic fallback for a third party's own x402 seller, parsed as
  `address:signature`. **Not** the real x402 v2 `PAYMENT-SIGNATURE` header's base64-encoded
  EIP-3009 payload — decoding that properly is real, undone scope, disclosed here rather than
  pretended at. What this does handle is enough to prove the actual claim (see Tests, below): a
  seller SpendVeto has no relationship with, paid by an agent that never imported SpendVeto either,
  still gets governed.

Price discovery for a governed payment: a known catalog tool (`shared-config.js`'s `TOOLS`) is
priced from there; anything else is priced from the real 402 challenge the gateway observed
passing through moments earlier (`beforeResponse`, cached per exact request target). Never guessed.

## Run it

```bash
cd intercept
npm install
npm start                 # listens on :8405 by default
```

Then point an agent at it — literally any HTTP client, no SpendVeto import required:

```bash
HTTP_PROXY=http://localhost:8405 HTTPS_PROXY=http://localhost:8405 <agent command>
```

For HTTPS targets, the client needs to trust the gateway's generated CA
(`intercept/data/ca.json`'s `cert` field) — e.g. via `NODE_EXTRA_CA_CERTS` for a Node client, or
the system trust store for anything else. The gateway never asks for OS-level trust store changes
itself; that's the operator's explicit decision to make.

## Tests

```bash
cd intercept
npm test
```

Three scenarios, against a mock third-party x402 seller (`tests/mock-seller.mjs`) that imports
**nothing** from SpendVeto, paid by a test client (`tests/run-all.mjs`) that imports **nothing**
from SpendVeto's governance code either — just `viem` (generic crypto) and `undici` (a generic HTTP
client). This is the actual claim under test: neither side has to cooperate.

1. **HTTP, deny** — an over-cap payment is refused before it ever reaches the seller. Proven by
   checking the seller's own request log never received it at all, not just that the client got a
   denial.
2. **HTTP, allow** — an in-policy payment passes through and the seller actually fulfills it (a
   real 200 from the real seller, not a synthetic gateway response) — proving the gateway doesn't
   just block things, it forwards legitimate traffic correctly too.
3. **HTTPS, deny** — the same block, over a real TLS connection the gateway had to terminate and
   re-originate using its own dynamically generated certificate, proving the MITM mechanism itself,
   not just the governance logic sitting behind it.

Run three times consecutively during development (fresh random wallets each run, not cached
state): 10/10 passed, every time.

## Known gaps, stated plainly

- **Generic `X-PAYMENT` parsing doesn't verify a signature itself** — it extracts an address and
  defers cryptographic verification to whatever the real destination does with the rest of the
  header. The gateway's governance decision (allow/deny/requires-approval) is made against the
  *claimed* address before that verification happens downstream. See the independent audit section
  below for what this does and doesn't expose.
- **Real x402 v2's `PAYMENT-SIGNATURE` header (base64 EIP-3009 payload) is not decoded** — only
  this repo's own simulate format and the simpler generic `address:signature` convention are.
- **No persistent audit trail of gateway decisions yet** — `console.log` only; this repo's ledger
  and decision-event infrastructure (`server/events.js`) isn't wired in. A blocked payment at the
  gateway currently leaves no trace in `/api/events`, only in this process's stdout.
- **Not wired into `scripts/verify.mjs`** — this module's own test suite is separate, matching
  `wasm-policy/`'s precedent; it hasn't earned a public claim on spendveto.com yet.

## Known dependency vulnerability (disclosed, not hidden)

`npm audit` reports 4 high-severity findings, all the same root cause: `basic-ftp`'s FTP
directory-listing parser (ReDoS), pulled in transitively via `mockttp` → `pac-proxy-agent` →
`get-uri` → `basic-ftp`, for PAC-based upstream-proxy-chaining support this gateway never
configures or invokes. Unresolved upstream at the latest `mockttp` (4.6.3) as of this writing. See
the independent audit section below for whether that "unreachable code path" claim was actually
verified or just asserted.

## Independent audit

This went through an independent security audit specifically because it's a MITM/TLS-interception
tool — a meaningfully higher bar than ordinary code review. It found and this repo then fixed two
critical, genuinely exploitable issues before either shipped:

1. **Host-scoping was plain string comparison, not real scope enforcement.** `localhost:8402` in
   `INTERCEPT_HOSTS` did not govern `127.0.0.1:8402`, `[::1]:8402`, or `localhost.:8402` (trailing
   dot) — identical requests to any of those sailed through with **zero governance**, no
   `checkPolicy` call, nothing logged. Not an exotic DNS-rebinding attack; `127.0.0.1` instead of
   `localhost` is one of the most ordinary ways to write a base URL. Fixed by canonicalizing every
   loopback spelling to one identity before either side of the comparison runs. (DNS rebinding for
   a *non-loopback* allowlisted hostname — one that resolves to a different IP between the 402
   observation and the paid retry — is **not** closed by this fix; stated here rather than left for
   someone else to find.)
2. **The generic `X-PAYMENT` path called `checkPolicy` with an address it never verified**, and
   governed a price that came only from a plaintext, un-signed 402 body the gateway had observed up
   to ten minutes earlier. Two real consequences: anyone could claim to be any wallet just by
   naming it in a header, letting them read that wallet's private governance state (`checkPolicy`'s
   denial messages routinely embed exact spend-to-date, freeze reasons, delegation caps) and spam
   its approval queue, with no key; separately, nothing tied the price actually governed to what a
   payment artifact cryptographically authorized. Fixed together, since they're the same root
   cause: the generic header format now carries the price it was signed for
   (`address:price:signature`), the signature is verified — over `pay:<path>:<price>` — **before**
   `checkPolicy` is ever called, and a bad signature gets a deliberately generic refusal with zero
   policy detail. The same verification was added to this repo's own `X-SIM-PAYMENT` format too,
   for the same reason: even though the real downstream gate (`server/simulate.js`) independently
   verifies and would reject a forged claim, this gateway had already made and returned its own
   governance decision — with full denial detail — against an unverified identity by the time that
   downstream check would run.

Fixing the signature-verification gap surfaced a real bug of its own, caught by re-running the test
suite rather than by inspection: mockttp's `req.path` includes the query string (not pathname-only,
despite the name), so the message being verified for a request like `/paid-resource?price=0.08`
never matched what was actually signed over `/paid-resource` — every signature check failed, allow
and deny alike, until the governed path/catalog lookup/signature message were all switched to use a
proper pathname-only helper consistently.

Checked and confirmed **not** a problem: the CA private key is `.gitignore`d; upstream TLS
verification is genuinely off by default and scoped per-hostname when enabled; a dead main-server
mid-flight fails **closed** (`checkPolicy`'s own `server_unreachable` deny, and mockttp itself turns
any unexpected `beforeRequest` exception into a client-facing 500, never a silent pass-through); the
disclosed `basic-ftp` dependency vulnerability (above) was confirmed genuinely unreachable by
reading `mockttp`'s own request-handling code, not just asserted; nothing logs raw signatures or
payment header content, only address/path/price.

All fixes are covered by re-running `npm test` (10/10, three consecutive runs) plus two standalone
scripts that reproduce the exact pre-fix exploits and confirm both are now refused.
