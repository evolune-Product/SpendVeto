# Audit Report — Universal Interception Gateway

**Component**: `intercept/` — a local HTTP(S)-intercepting MITM proxy that governs x402 payment
attempts from AI agents that never adopted SpendVeto's SDK, MCP server, or enforcement proxy, by
running the real `client/policy.js` `checkPolicy()` pipeline against traffic it intercepts.

**Date**: 2026-10-04 · **Status**: prototype, locally built and tested, not committed/pushed, not
wired into `scripts/verify.mjs` or any public claim.

**Scope of this report**: everything under `intercept/` (`gateway.mjs`, `tests/mock-seller.mjs`,
`tests/run-all.mjs`, `package.json`, `README.md`). Does not cover the rest of the SpendVeto
codebase, which this component calls into (`client/policy.js`, `client/pay.js`) but does not
modify.

---

## 1. What was built

A transparent proxy, built on [mockttp](https://github.com/httptoolkit/mockttp) (the TLS-MITM
engine behind HTTP Toolkit — not hand-rolled TLS termination), that:

- Generates and caches a local root CA (`intercept/data/ca.json`, gitignored) used to dynamically
  sign leaf certificates for any domain it intercepts — the standard mitmproxy/Charles/Fiddler
  technique for HTTPS interception.
- Scopes interception to an explicit host allowlist (`INTERCEPT_HOSTS`), never "the whole
  internet" by default.
- Recognizes two payment-header formats on intercepted requests: this repo's own `X-SIM-PAYMENT`
  format, and a generic `X-PAYMENT: address:price:signature` convention standing in for any third
  party's own x402 seller.
- Verifies the signature on **every** payment header before calling `checkPolicy` with the address
  or price it claims — closing a gap described in §3 below.
- Determines price from this repo's own `TOOLS` catalog when known, or by passively observing a
  real 402 challenge response moments earlier (never guessed; an unpriced resource is refused, not
  waved through).
- On denial: returns a synthetic 402 **before the payment ever reaches its destination** — the
  seller receives nothing.
- On approval-required: synchronously polls the real dashboard approval queue
  (`client/pay.js`'s `waitForApproval`), same as every other governed path in this repo.
- On allow: forwards the original request, unmodified, to the real destination.

Reuses the production `checkPolicy` function directly (not a reimplementation); does not duplicate
governance logic anywhere in the gateway itself.

---

## 2. Test methodology — "test it 3 times"

A mock third-party seller (`tests/mock-seller.mjs`) that imports **nothing** from SpendVeto, paid
by a test client (`tests/run-all.mjs`) that imports **nothing** from SpendVeto's governance code
either (just `viem`, a generic crypto library, and `undici`, a generic HTTP client) — proving the
actual claim under test: neither the agent's code nor the seller's needs to cooperate.

| # | Scenario | Proves |
|---|---|---|
| 1 | HTTP, over-cap payment | Refused **before** reaching the seller — confirmed by checking the seller's own request log never received it, not just that the client got a 402. |
| 2 | HTTP, in-policy payment | Passes through correctly and the seller's **real** 200 fulfillment comes back — proving the gateway doesn't just block, it forwards legitimate traffic without breaking it. |
| 3 | HTTPS, over-cap payment | Same block, over a real TLS connection the gateway had to terminate and re-originate with its own generated certificate — proving the MITM mechanism itself, not just the governance logic behind it. |

**Run three times, with the final fixed code** (fresh random wallets each run, not cached state):

| Run | Result |
|---|---|
| 1 | 10/10 PASS |
| 2 | 10/10 PASS |
| 3 | 10/10 PASS |

(Three earlier runs against the pre-fix code are not counted here — see §3; one caught a real bug
in the test's own HTTPS fixture (an un-awaited async cert generator), unrelated to the gateway;
after fixing the fixture, those three also ran 10/10 clean, but the security fixes below changed
the code shape enough that the three runs above, against the code as it actually ships, are the
ones that count.)

---

## 3. Independent security audit

Given this is a MITM/TLS tool, not an ordinary feature, a separate agent was dispatched
specifically to adversarially probe the trust surface — private key handling, host-scoping
correctness, payment-header spoofing, upstream TLS trust, fail-open/fail-closed behavior on error —
rather than relying on self-review alone. It read every file, ran the existing test suite, and
wrote its own adversarial scripts to empirically verify (not just assert) each concern.

### Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **Critical** | Host-scoping was plain string comparison. `INTERCEPT_HOSTS=localhost:8402` did not match `127.0.0.1:8402`, `[::1]:8402`, or `localhost.:8402` — identical requests to any of those passed through with **zero governance**: no `checkPolicy` call, nothing logged. Empirically confirmed with a live reproduction. | Every hostname (both allowlist entries and the live destination) is canonicalized — lowercased, trailing dot stripped, every loopback spelling (`127.0.0.0/8`, `::1`, `localhost`) mapped to one identity — before comparison. Re-tested against the exact reproduction: now correctly intercepted. |
| 2 | **Critical** | The generic `X-PAYMENT` path called `checkPolicy(claimedAddress, ...)` with **no signature verification at all**. Confirmed exploitable two ways: (a) anyone naming a wallet address in the header got that wallet's private governance state back — exact spend-to-date, freeze reasons, delegation caps, all embedded in `checkPolicy`'s denial messages — with no key; (b) the price governed came only from a plaintext, unsigned 402 body observed up to 10 minutes earlier, with nothing binding it to what a payment actually authorized. | The generic header format now carries the price it was signed for (`address:price:signature`), and the signature is verified — over `pay:<path>:<price>` — **before** `checkPolicy` is ever called. A bad signature gets a deliberately generic `signature_invalid` refusal with zero policy detail, never reaching the governance function. The same verification was retrofitted onto this repo's own `X-SIM-PAYMENT` format too, for the same reason, even though its downstream gate (`server/simulate.js`) independently verifies and would reject a forged claim — by the time that runs, this gateway would already have made and returned its own decision against an unverified identity. Re-tested against the exact reproduction (a forged victim address with a garbage signature): now refused at `signature_invalid`, `checkPolicy` never called. |

### A bug the fix itself surfaced

Implementing finding #2's fix broke the *legitimate* (allow) test case too — every signature
check failed, allowed or denied alike. Root cause: `mockttp`'s `req.path` includes the query
string (not pathname-only, despite the name), so the message being verified for
`/paid-resource?price=0.08` never matched what the client had actually signed over
(`/paid-resource`). Fixed by introducing a single pathname-only helper and using it consistently
everywhere a clean resource identity was needed (the catalog lookup, both signature-message
constructions) — caught by re-running the test suite immediately after the fix landed, not by
further inspection.

### Checked and confirmed not a problem

- **CA private key**: `intercept/data/ca.json` is `.gitignore`d (verified); file permissions match
  this repo's existing (already-known, not a regression) convention for other local private keys
  (`data/children.json`); nothing logs the key material.
- **Upstream TLS verification**: genuinely off by default; `INTERCEPT_IGNORE_UPSTREAM_CERT_ERRORS`
  is scoped per-hostname when explicitly set, never global.
- **Fail-open vs. fail-closed on the main server dying mid-flight**: confirmed fail-**closed** by
  empirically killing the server mid-test — `checkPolicy`'s own `server_unreachable` deny fires,
  returned as a 402. Separately, `mockttp` itself converts any unhandled exception from a
  `beforeRequest` callback into a client-facing 500, never a silent pass-through, so even an
  unanticipated throw fails closed.
- **The disclosed `basic-ftp` dependency vulnerability** (ReDoS, transitive via `mockttp` →
  `pac-proxy-agent`, for PAC-proxy-chaining support this gateway never configures): confirmed
  genuinely unreachable by reading `mockttp`'s own request-handling code — the vulnerable package
  is `require()`'d into memory but its code path only executes when a `pac+http(s):` proxy config
  is passed, which `gateway.mjs` never does. The "unreachable, disclosed, not hidden" framing in
  `README.md` holds up under inspection, not just assertion.
- **Logging**: only wallet address, resource path, and price are logged — never raw signatures or
  payment header content.

---

## 4. Known gaps — stated plainly, not discovered later

These are not failures of this audit; they're scope boundaries the component itself declares (see
`README.md`'s "Known gaps" section) and that this report is not claiming to have closed:

- **DNS rebinding for a non-loopback allowlisted hostname** (one that resolves to a different IP
  between the 402 observation and the paid retry) is not mitigated by the host-canonicalization fix
  above, which only closes the loopback-spelling bypass that was actually demonstrated. A full fix
  needs resolving the hostname to an IP and pinning it per in-flight request.
- **Real x402 v2's `PAYMENT-SIGNATURE` header** (base64-encoded EIP-3009 payload) is not decoded —
  only this repo's own simulate format and the generic `address:price:signature` convention this
  component defines.
- **No persistent audit trail** of gateway decisions yet (`console.log` only) — this repo's
  ledger/decision-event infrastructure isn't wired in.
- **Not wired into `scripts/verify.mjs`** or any public claim — this module's test suite is
  separate, matching the `wasm-policy/` precedent from the same session.

---

## 5. Verdict

Two genuinely critical, independently-verified-exploitable issues were found before either shipped
publicly, both fixed, and both fixes re-tested against the exact reproductions that demonstrated
them — not just re-run against the existing happy-path suite. The fix for the second finding
surfaced a real functional bug of its own (the `req.path` query-string issue), caught by the same
test discipline rather than slipping through. The component's declared scope boundaries (DNS
rebinding, real x402 v2 signature decoding, audit-trail persistence) are accurately stated, not
silently absent.

This is a working prototype with a real, demonstrated security posture for the threat model it
targets (governing payment attempts from agents/sellers that don't cooperate) — not a finished,
production-hardened product. It has not been reviewed by anyone outside this session, has no
external security audit, and should be treated accordingly before any real traffic (not test
traffic against a disposable mock seller) is routed through it.
