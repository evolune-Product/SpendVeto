# spendveto-wasm-policy

**SpendVeto's policy-decision core, compiled to WebAssembly.** The same rules
`client/policy.js`'s `checkPolicy()` enforces — same denial codes, same
messages, same rule order — but with every piece of state checkPolicy
normally fetches over HTTP (freeze status, last-hour ledger spend, the
delegation tree, resolved ENS payees, open `upto` holds) pushed out to the
caller as explicit input instead. The result is a module that does **zero
I/O, reads no clock, makes no network call** — and can therefore run
anywhere a WASM host exists: a browser tab with no server reachable, a
Cloudflare Worker at the edge, a sandboxed agent runtime, an offline CLI.

This is the OPA playbook, not an analogy to it: [Open Policy
Agent](https://www.openpolicyagent.org/docs/wasm) compiles Rego policies to a
WASM module with a memory-buffer + JSON-in/JSON-out ABI, so any embedder can
drive it without understanding Rego or Go. This module does the same thing
for SpendVeto's own rules, written directly in
[AssemblyScript](https://www.assemblyscript.org/) rather than compiled from
a separate policy language.

## Why this exists

Every other integration surface in this repo (`client/pay.js`, the MCP
server, the enforcement proxy) is **a client that calls a server**. That's
fine for "govern my own agent against my own server" — it's not fine for "an
agent framework wants to ship governance *inside itself*," because a closed,
custodial competitor's business model requires that call to land on their
servers. An OSS, self-hosted product doesn't have that constraint, and this
is what it looks like to actually use that freedom: compile the decision
logic once, ship the `.wasm` file, and let it travel with the agent. State
still has to get synced from somewhere — this module doesn't pretend
otherwise — but the *decision* no longer waits on a round trip.

## What's a faithful port, and what deliberately isn't

**Ported exactly, rule for rule, code for code:** frozen-wallet kill switch,
chain allowlist, payee allowlist (pre-resolved addresses), trading-hours
window (wrap-around included), per-call cap, the full delegation cascade
(revoked / expired / tool scope / chain scope / payee scope / cap, at every
ancestor depth, including rolling-allowance window notes), category caps,
hourly call-rate cap, hourly USD cap (settled spend *and* open `upto`
holds), and the `requireApprovalAboveUSD` threshold. Every denial code in
`client/policy.js` has a matching code here, with the same message text
wherever the message doesn't depend on something only a live server knows.

**Deliberately NOT in WASM, and why:**
- **ENS name resolution** — needs network. The host resolves `.eth` names
  via `client/ens.js` *before* calling this module, exactly as `checkPolicy`
  already does internally via `resolvePayeeList`. This module only ever sees
  resolved, lowercase addresses.
- **Date parsing for `expiresAt`** — AssemblyScript has no battle-tested
  ISO-8601 parser in its standard library, and hand-rolling one is exactly
  the kind of narrow, easy-to-get-subtly-wrong code this module's whole
  purpose (portable correctness) argues against adding. The host
  pre-computes `expired: boolean` per delegation hop using JS's own
  `Date.parse`, and passes that — not the raw timestamp — as the thing this
  module checks. The *rule* ("an expired grant denies with
  `delegation_expired`") is identical; only *where* "is it expired"
  gets computed moves, the same way freeze/ledger state already does.
- **Live state gathering itself** — walking the full delegation graph,
  summing the relevant ledger window, checking freeze status: all of that
  needs a central index (or a synced replica of one). This module just
  validates the already-gathered data and applies the same caps/scopes
  `checkPolicy` does. "Syncing decisions later" means: the host syncs state
  on whatever cadence fits its deployment, and every decision made against
  the last-synced snapshot is instant and offline.

This module will never claim to replace `checkPolicy` as the live
enforcement point — the x402 gate (`server/simulate.js`) stays
server-authoritative for anything actually settling. This is for the cases
where a decision is needed *before* a round trip is possible at all: a
browser extension warning a user before it even submits a payment, an edge
function doing a cheap pre-filter, an agent sandbox that's genuinely
offline.

## Build

```bash
cd wasm-policy
npm install
npm run asbuild          # debug + release .wasm into build/
npm test                 # directed + 50,000-case randomized parity suite
```

Compiled with `--runtime stub` (a minimal bump allocator that never frees —
the right tradeoff for a stateless, call-and-return workload: no GC pause
can land mid-decision) and `--exportRuntime` (exports `__new`, used
internally by `alloc()`).

## The ABI

Three exported functions, raw UTF-8 bytes in and out — **not**
AssemblyScript's managed-string marshalling, which would require a host
that understands AS's internal object layout (what `@assemblyscript/loader`
exists for). This ABI needs nothing but the standard `WebAssembly` API on
either side:

```
alloc(size: i32) -> ptr          // allocate `size` bytes, host writes UTF-8 JSON here
evaluate(ptr: i32, len: i32)     // decode input, run the decision, encode the result
getResultPtr() -> ptr            // where the output UTF-8 JSON landed
getResultLen() -> i32            // its byte length
abiVersion() -> i32              // bumped alongside the rule set it implements (currently 1)
memory                            // the linear memory, read/write directly
```

`loader.js` wraps this into a single `evaluate(input): output` call — see
its source, it's ~70 lines, dependency-free, and works unmodified in Node
or a browser.

```js
import { loadPolicyWasmFile } from "./loader.js";

const policy = await loadPolicyWasmFile("./build/release.wasm");
const decision = policy.evaluate({
  proposedPriceUSD: 0.02,
  toolId: "summarize",
  chain: "base-sepolia",
  category: null,
  payee: null,
  policy: { maxPerCallUSD: 0.05, maxPerHourUSD: 0.2, maxCallsPerHour: 10, requireApprovalAboveUSD: 0.015 },
  frozen: null,
  nowUTCHour: 14,
  recent: { totalUSD: 0, count: 0 },
  heldUSD: 0,
  categorySpent: 0,
  delegationChain: [],
});
// => { allowed: true, requiresApproval: true }
```

In a browser, the same `loader.js` works via `instantiateStreaming`:

```js
import { loadPolicyWasm } from "./loader.js";
const policy = await loadPolicyWasm(fetch("./release.wasm"));
```

## Input schema

| Field | Type | Meaning |
|---|---|---|
| `proposedPriceUSD` | number | The price being evaluated |
| `toolId` | string \| null | Tool being called |
| `chain` | string \| null | Settlement chain requested |
| `category` | string \| null | Spend category tag |
| `payee` | string \| null | Payee address, **already resolved** if it was a `.eth` name |
| `policy` | object | `maxPerCallUSD`, `maxPerHourUSD`, `maxCallsPerHour`, `requireApprovalAboveUSD`, optional `allowedChains[]`, `allowedPayees[]` (resolved), `allowedHoursUTC: {start,end}`, `categoryCapsUSD: {category: cap}` |
| `frozen` | object \| null | `{ isFrozen, source, reason }`, or `null`/absent if not frozen |
| `nowUTCHour` | integer | Current UTC hour (0–23) — the host's clock, not this module's |
| `recent` | object | `{ totalUSD, count }` — this wallet's settled spend in the last rolling hour |
| `heldUSD` | number | Open `upto` authorization holds against this wallet |
| `categorySpent` | number | This wallet's settled spend in `category`, last rolling hour |
| `delegationChain` | array | One entry per hop from this wallet to the root, **closest first**: `{ label, revoked, expired, expiresAt, allowedTools, allowedChains, allowedPayees, capUSD, subtreeSpend, periodSeconds }` |

## Output

```json
{ "allowed": true, "requiresApproval": false }
```
or
```json
{ "allowed": false, "code": "per_call_cap", "reason": "price $0.5 exceeds maxPerCallUSD $0.05", "suggestion": "pick a tool priced at or under $0.05, or have a human raise maxPerCallUSD in data/policy.json" }
```

## Status

Prototype. Verified by a 50,000-iteration randomized parity test against a
hand-written JS reference (`tests/parity.mjs`) plus 39 directed edge cases —
zero disagreements.

It also went through an independent adversarial audit — a second pass
specifically looking for what randomized fuzzing structurally can't
generate — which found and this repo then fixed four real issues before any
of them shipped:

1. **Numeric fields sent as JSON strings** (`"0.5"` instead of `0.5`)
   silently fell back to hardcoded defaults instead of the real value — a
   fail-open on every cap in the schema. Fixed: `numOr`/`intOr` now coerce
   numeric strings the same way `Number()` does.
2. **Non-string `chain`/`payee`/`toolId`/`category` values** (e.g. `chain`
   sent as a bare number) were silently treated as "field absent," bypassing
   the allowlist/scope check entirely. Fixed: comparisons now replicate JS
   truthiness per JSON type, so a present-but-wrong-type value still
   participates in the check instead of skipping it.
3. **Unbounded WASM memory growth** under the loader's own intended
   reuse pattern (`--runtime stub`'s bump allocator never frees) — measured
   256 MB after 20,000 calls on one instance, no bound. Fixed: switched to
   `--runtime incremental` (real GC) with GC-rooted result/input buffers;
   re-measured flat at 128 KB after 50,000 calls.
4. **`allowedHoursUTC` with fractional bounds** (`{start: 9.5, end: 17.5}`)
   got silently truncated and enforced, where real `checkPolicy` requires
   `Number.isInteger` and treats a malformed config as "unset." Fixed to
   match exactly (including that a whole-number *float* like `9.0` still
   correctly counts as an integer, same as `Number.isInteger(9.0) === true`).

One finding was shared by **both** the WASM port and the independently
written JS reference it was checked against — both treated an empty string
(`""`) for `chain`/`payee`/`toolId`/`category` as "present," where real
`checkPolicy` gates on `if (x && ...)` and treats `""` as falsy (check
skipped). Two independent implementations making the same misreading is
exactly the blind spot a parity test *against only itself* can't catch —
caught here because the audit compared both against the actual
`client/policy.js` source, not just against each other. Fixed in both files.

All four fixes (plus the shared one) now have dedicated regression cases in
`tests/parity.mjs`, not just the fuzz pass, so none of them can silently
come back.

Not wired into the live server, the SDK, or the MCP
server yet; that's a deliberate next step, not an oversight. See the root
`CLAUDE.md`'s "one rule" — this module hasn't earned a public claim on
spendveto.com yet, because it isn't in `scripts/verify.mjs` and isn't
reachable from anything a user runs today. Treat it as what it is: a working
proof that the policy core can be this portable, not a shipped feature.
