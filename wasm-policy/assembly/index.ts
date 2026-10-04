// SpendVeto's policy-decision core, compiled to WebAssembly.
//
// This is a faithful port of client/policy.js's `checkPolicy` — same rule order, same denial
// codes, same messages wherever the message doesn't depend on something only a live server can
// know. The one architectural difference, and it's the whole point of this module: every piece
// of state checkPolicy fetches over HTTP (freeze status, last-hour ledger spend, the delegation
// tree, resolved ENS payees, open `upto` holds) is instead supplied by the HOST as part of the
// input. This module does zero I/O, reads no clock, and makes no network call — which is exactly
// what makes it portable. The host is responsible for syncing that state (from the real server,
// a cached snapshot, or a replicated edge store) on whatever cadence fits its deployment; this
// module just makes the same decision client/policy.js would, deterministically, offline, in any
// WASM host (browser, edge function, sandboxed agent runtime) — "a control that travels with the
// agent," not a service it has to call.
//
// What's deliberately NOT here, and why: ENS name resolution (needs network — the host resolves
// `.eth` names via client/ens.js before calling this, exactly as checkPolicy already does
// internally via resolvePayeeList) and date parsing for `expiresAt` (the host pre-computes an
// `expired: bool` per delegation hop using its own Date.parse, rather than this module attempting
// ISO-8601 parsing itself — a narrower, more auditable surface than reimplementing a date parser
// in a 1,000-line WASM module). Every other check is the genuine rule, not a simplification of it.

import { JSON, JSONEncoder } from "assemblyscript-json/assembly";

// ---------------------------------------------------------------------------------------------
// Small helpers. AssemblyScript's assemblyscript-json distinguishes a JSON number's *decoded*
// type (Float vs Integer) by whether the source text contained a decimal point — "13" decodes as
// Integer, "13.0" as Float. A caller serializing with plain JS `JSON.stringify` can produce either
// depending on the value, so every numeric read here tries both rather than assuming one.
//
// Independent audit finding (fixed here): checkPolicy's JS does `Number(proposedPriceUSD)` and
// similar on every numeric field, which coerces a numeric STRING ("0.5") the same as the number
// 0.5. The original version of these helpers didn't — a field sent as a JSON string silently fell
// through to the hardcoded fallback instead of the caller's real value, which for a cap or price
// field means the real-world effect is fail-open (a cap silently reverts to its loosest default).
// numOr/intOr now also try getString + parseFloat before giving up, matching Number()'s coercion
// for the case that actually matters here: a numeric-looking string.
// ---------------------------------------------------------------------------------------------

function numOr(obj: JSON.Obj, key: string, fallback: f64): f64 {
  const f = obj.getFloat(key);
  if (f != null) return f.valueOf();
  const n = obj.getInteger(key);
  if (n != null) return f64(n.valueOf());
  const s = obj.getString(key);
  if (s != null) {
    const parsed = parseFloat(s.valueOf());
    if (!isNaN(parsed)) return parsed;
  }
  const b = obj.getBool(key);
  if (b != null) return b.valueOf() ? 1.0 : 0.0;
  return fallback;
}

function intOr(obj: JSON.Obj, key: string, fallback: i32): i32 {
  const n = obj.getInteger(key);
  if (n != null) return i32(n.valueOf());
  const f = obj.getFloat(key);
  if (f != null) return i32(f.valueOf());
  const s = obj.getString(key);
  if (s != null) {
    const parsed = parseFloat(s.valueOf());
    if (!isNaN(parsed)) return i32(parsed);
  }
  const b = obj.getBool(key);
  if (b != null) return b.valueOf() ? 1 : 0;
  return fallback;
}

// True only if the field, however it was encoded, holds a whole-number value — mirrors JS's
// Number.isInteger(9.0) === true (an integer-VALUED float still counts), which checkPolicy relies
// on for allowedHoursUTC. Independent audit finding (fixed here): the original version accepted
// ANY numeric encoding (so {start: 9.5, end: 17.5} silently got truncated to 9/17 and the window
// was enforced), where real checkPolicy requires Number.isInteger and skips the whole check — a
// fractional bound is a malformed config, and the rule is "treat malformed as unset," not "guess."
function isIntegerField(obj: JSON.Obj, key: string): bool {
  const f = obj.getFloat(key);
  if (f != null) return Math.trunc(f.valueOf()) == f.valueOf();
  const n = obj.getInteger(key);
  if (n != null) return true;
  return false;
}

function strOr(obj: JSON.Obj, key: string, fallback: string): string {
  const s = obj.getString(key);
  return s != null ? s.valueOf() : fallback;
}

// Mirrors JS truthiness for chain/payee/toolId/category — checkPolicy gates every one of these on
// `if (x && ...)`, not `if (x != null && ...)`. Two independent audit findings, fixed together
// because they're the same underlying gap (this function previously used getString alone):
//   - empty string ("") is falsy in JS, so `if (chain && ...)` SKIPS the check — the earlier
//     version treated "" as a present, comparable value and wrongly ENFORCED the check instead.
//   - a non-string truthy value (chain sent as the JSON number 123 by a confused or malicious
//     caller) is still truthy in JS, so the check still APPLIES and `.includes(123)` on a string
//     array is false -> deny. The earlier version used getString alone, which returns null for a
//     non-string JSON type, and null was treated as "field absent" -> check silently SKIPPED. That
//     is a real fail-open: an allowlist/scope control defeated just by sending the field as the
//     wrong JSON type. This function instead reads the raw Value, applies JS-style truthiness per
//     type, and for a truthy non-string value returns a string that cannot coincidentally collide
//     with a real chain id / address / tool id, so the comparison still correctly denies.
function truthyStr(obj: JSON.Obj, key: string): string | null {
  const v = obj.get(key);
  if (v == null) return null;
  if (v.isString) {
    const s = (<JSON.Str>v).valueOf();
    return s.length > 0 ? s : null;
  }
  if (v.isBool) {
    return (<JSON.Bool>v).valueOf() ? "true" : null;
  }
  if (v.isFloat) {
    const n = (<JSON.Float>v).valueOf();
    return n != 0.0 ? n.toString() : null;
  }
  if (v.isInteger) {
    const n = (<JSON.Integer>v).valueOf();
    return n != 0 ? n.toString() : null;
  }
  if (v.isNull) return null;
  // Object or array: always truthy in JS, and this sentinel can never equal a real allowlist
  // string, so the comparison correctly falls through to "not allowed" rather than "no check."
  return "\u0000[non-string-value]";
}

function boolOr(obj: JSON.Obj, key: string, fallback: bool): bool {
  const b = obj.getBool(key);
  return b != null ? b.valueOf() : fallback;
}

// Reads a JSON array of strings; returns null if the key is absent (meaning "no restriction" —
// matches checkPolicy's `policy.allowedChains &&` truthiness check), but a *present, empty* array
// still returns an empty Array<string> (meaning "nothing is allowed" — also matches: `[].includes(x)`
// is always false in the original, so an explicit empty allowlist denies everything, on purpose).
function strArrOrNull(obj: JSON.Obj, key: string): Array<string> | null {
  const arr = obj.getArr(key);
  if (arr == null) return null;
  const vals = arr.valueOf();
  const out = new Array<string>(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    out[i] = v.isString ? (<JSON.Str>v).valueOf() : "";
  }
  return out;
}

function contains(arr: Array<string>, value: string): bool {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == value) return true;
  }
  return false;
}

function joinStrs(arr: Array<string>, sep: string): string {
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) out += sep;
    out += arr[i];
  }
  return out;
}

function toFixed4(v: f64): string {
  // AssemblyScript's f64.toString() has no fixed-precision formatter in the stub runtime, so this
  // rounds to 4 decimal places (matching checkPolicy's `.toFixed(4)` calls) by hand, the same way
  // every dollar amount elsewhere in this codebase rounds to cents: scale, round, rescale, format.
  const scaled = Math.round(v * 10000.0) / 10000.0;
  let s = scaled.toString();
  const dot = s.indexOf(".");
  if (dot < 0) {
    s += ".0000";
  } else {
    const decimals = s.length - dot - 1;
    for (let i = decimals; i < 4; i++) s += "0";
  }
  return s;
}

function numToStr(v: f64): string {
  // Mirrors how checkPolicy interpolates a raw number into a message (template literal, not
  // .toFixed) — e.g. `$${price}`, `$${policy.maxPerCallUSD}` — so an integer-valued amount like
  // 0.05 or 20 prints as "0.05" / "20", not "0.0500" / "20.0000".
  if (v == Math.trunc(v) && Math.abs(v) < 1e15) {
    return i64(v).toString();
  }
  return v.toString();
}

// ---------------------------------------------------------------------------------------------
// Decision result + JSON output
// ---------------------------------------------------------------------------------------------

class Decision {
  allowed: bool;
  requiresApproval: bool;
  code: string | null;
  reason: string | null;
  suggestion: string | null;

  constructor(allowed: bool, requiresApproval: bool, code: string | null, reason: string | null, suggestion: string | null) {
    this.allowed = allowed;
    this.requiresApproval = requiresApproval;
    this.code = code;
    this.reason = reason;
    this.suggestion = suggestion;
  }

  static deny(code: string, reason: string, suggestion: string): Decision {
    return new Decision(false, false, code, reason, suggestion);
  }

  static allow(requiresApproval: bool): Decision {
    return new Decision(true, requiresApproval, null, null, null);
  }

  toJSON(): string {
    const enc = new JSONEncoder();
    enc.pushObject(null);
    enc.setBoolean("allowed", this.allowed);
    if (this.allowed) {
      enc.setBoolean("requiresApproval", this.requiresApproval);
    } else {
      enc.setString("code", this.code!);
      enc.setString("reason", this.reason!);
      enc.setString("suggestion", this.suggestion!);
    }
    enc.popObject();
    return enc.toString();
  }
}

// ---------------------------------------------------------------------------------------------
// The port. Mirrors checkPolicy's exact rule order: frozen -> chain allowlist -> payee allowlist
// -> trading hours -> per-call cap -> delegation walk -> category cap -> hourly rate -> hourly USD.
// ---------------------------------------------------------------------------------------------

function evaluateInternal(root: JSON.Obj): Decision {
  const price = numOr(root, "proposedPriceUSD", 0.0);
  const toolId = truthyStr(root, "toolId");
  const chain = truthyStr(root, "chain");
  const category = truthyStr(root, "category");
  const payeeRaw = truthyStr(root, "payee");
  const payee = payeeRaw != null ? payeeRaw!.toLowerCase() : null;

  const policy = root.getObj("policy");
  if (policy == null) {
    return Decision.deny("policy_missing", "no policy object supplied", "send the effective policy alongside the call context");
  }

  // 1. Kill switch first, regardless of what the other rules would say.
  const frozen = root.getObj("frozen");
  if (frozen != null) {
    const isFrozen = boolOr(frozen, "isFrozen", false);
    if (isFrozen) {
      const source = strOr(frozen, "source", "unknown");
      const reason = strOr(frozen, "reason", "no reason on record");
      return Decision.deny(
        "frozen",
        "wallet frozen (" + source + "): " + reason + " — unfreeze from the dashboard",
        "do not retry; a human must unfreeze this wallet from the dashboard after reviewing why it was frozen"
      );
    }
  }

  // 2. Chain allowlist.
  const allowedChains = strArrOrNull(policy, "allowedChains");
  if (chain != null && allowedChains != null && !contains(allowedChains, chain!)) {
    const list = joinStrs(allowedChains, ", ");
    return Decision.deny(
      "chain_not_allowed",
      'chain "' + chain! + '" is not in this policy\'s allowed chains (allowed: ' + list + ")",
      "retry the same call with --chain set to one of: " + list
    );
  }

  // 3. Payee allowlist. The host has already resolved any .eth names to lowercase addresses
  // (client/ens.js) before calling this, exactly as checkPolicy does via resolvePayeeList.
  const allowedPayees = strArrOrNull(policy, "allowedPayees");
  if (payee != null && allowedPayees != null && allowedPayees!.length > 0 && !contains(allowedPayees!, payee!)) {
    return Decision.deny(
      "payee_not_allowed",
      "payee " + payeeRaw! + " is not in this policy's allowed payees",
      "do not retry against this address; a human must add it to allowedPayees after verifying the recipient"
    );
  }

  // 4. Trading-hours window (UTC). Wrap-around windows (e.g. 22-6) supported. The host supplies
  // the current UTC hour rather than this module reading a clock, so a decision is reproducible
  // given the same input regardless of when or where it runs.
  const hoursWin = policy.getObj("allowedHoursUTC");
  if (hoursWin != null) {
    if (isIntegerField(hoursWin, "start") && isIntegerField(hoursWin, "end")) {
      const start = intOr(hoursWin, "start", 0);
      const end = intOr(hoursWin, "end", 0);
      const h = intOr(root, "nowUTCHour", 0);
      const inside = start <= end ? h >= start && h < end : h >= start || h < end;
      if (!inside) {
        return Decision.deny(
          "outside_trading_hours",
          "outside allowed trading hours (UTC " + start.toString() + ":00–" + end.toString() + ":00, now " + h.toString() + ":00)",
          "retry inside the allowed window, or have a human widen allowedHoursUTC in data/policy.json"
        );
      }
    }
  }

  // 5. Per-call cap.
  const maxPerCallUSD = numOr(policy, "maxPerCallUSD", 0.05);
  if (price > maxPerCallUSD) {
    return Decision.deny(
      "per_call_cap",
      "price $" + numToStr(price) + " exceeds maxPerCallUSD $" + numToStr(maxPerCallUSD),
      "pick a tool priced at or under $" + numToStr(maxPerCallUSD) + ", or have a human raise maxPerCallUSD in data/policy.json"
    );
  }

  // 6. Delegation caps, cascading. The host has already walked the grant chain from this wallet to
  // the root and supplies one entry per hop, each carrying its own pre-computed subtree spend for
  // the relevant window (lifetime, or the rolling allowance window if periodSeconds is set) —
  // walking the full ledger + delegation graph needs a central index, so that stays host-side; this
  // module just validates each hop's data and applies the same cap/scope rules checkPolicy does.
  const chainArr = root.getArr("delegationChain");
  if (chainArr != null) {
    const hops = chainArr.valueOf();
    for (let depth = 0; depth < hops.length; depth++) {
      const hop = <JSON.Obj>hops[depth];
      const who = strOr(hop, "label", "ancestor");

      if (boolOr(hop, "revoked", false)) {
        return Decision.deny(
          "delegation_revoked",
          depth == 0 ? "delegation revoked by parent" : 'ancestor delegation revoked ("' + who + '")',
          "do not retry; this budget line was revoked — request a fresh grant from the parent wallet"
        );
      }
      if (boolOr(hop, "expired", false)) {
        const expiresAt = strOr(hop, "expiresAt", "");
        return Decision.deny(
          "delegation_expired",
          depth == 0 ? "delegation expired at " + expiresAt : 'ancestor delegation expired ("' + who + '" at ' + expiresAt + ")",
          "do not retry; this was a time-boxed budget — request a fresh grant from the parent wallet"
        );
      }
      const hopTools = strArrOrNull(hop, "allowedTools");
      if (toolId != null && hopTools != null && !contains(hopTools!, toolId!)) {
        const level = depth == 0 ? "this wallet's delegated scope" : 'the scope granted to ancestor "' + who + '"';
        const list = joinStrs(hopTools!, ", ");
        return Decision.deny(
          "tool_scope",
          'tool "' + toolId! + '" is outside ' + level + " (allowed: " + list + ")",
          "retry with one of the allowed tools (" + list + "), or ask the grantor to widen the scope"
        );
      }
      const hopChains = strArrOrNull(hop, "allowedChains");
      if (chain != null && hopChains != null && !contains(hopChains!, chain!)) {
        const level = depth == 0 ? "this wallet's delegated chain scope" : 'the chain scope granted to ancestor "' + who + '"';
        const list = joinStrs(hopChains!, ", ");
        return Decision.deny(
          "chain_scope",
          'chain "' + chain! + '" is outside ' + level + " (allowed: " + list + ")",
          "retry the same call on an allowed chain (" + list + "), or ask the grantor to widen the chain scope"
        );
      }
      const hopPayees = strArrOrNull(hop, "allowedPayees");
      if (payee != null && hopPayees != null && !contains(hopPayees!, payee!)) {
        const level = depth == 0 ? "this wallet's delegated payee scope" : 'the payee scope granted to ancestor "' + who + '"';
        const list = joinStrs(hopPayees!, ", ");
        return Decision.deny(
          "payee_scope",
          "payee " + payeeRaw! + " is outside " + level + " (allowed: " + list + ")",
          "pay an allowed recipient, or ask the grantor to add this address to the payee scope"
        );
      }
      const capUSD = numOr(hop, "capUSD", 0.0);
      const subtreeSpend = numOr(hop, "subtreeSpend", 0.0);
      const periodSeconds = intOr(hop, "periodSeconds", 0);
      if (subtreeSpend + price > capUSD) {
        const level = depth == 0 ? "" : ' granted to ancestor "' + who + '"';
        const windowNote = periodSeconds > 0 ? " in the current " + periodSeconds.toString() + "s allowance window" : "";
        const remaining = capUSD - subtreeSpend;
        return Decision.deny(
          "delegation_cap",
          "would exceed delegated budget cap $" + numToStr(capUSD) + level + " ($" + toFixed4(subtreeSpend) + " of it already spent" + windowNote + ")",
          "remaining budget on this line is $" + toFixed4(remaining < 0.0 ? 0.0 : remaining) + ' — pick a cheaper tool that fits, or request a top-up grant from "' + who + '"'
        );
      }
    }
  }

  // 7. Ramp-style category caps: hourly budget per spend category, from the host's own tally.
  const categoryCaps = policy.getObj("categoryCapsUSD");
  if (category != null && categoryCaps != null && categoryCaps!.has(category!)) {
    const cap = numOr(categoryCaps!, category!, 0.0);
    const catSpent = numOr(root, "categorySpent", 0.0);
    if (catSpent + price > cap) {
      return Decision.deny(
        "category_cap",
        'would exceed the hourly cap for category "' + category! + '" ($' + numToStr(cap) + "; $" + toFixed4(catSpent) + " already spent)",
        "wait for the hourly window, use a tool in another category, or raise categoryCapsUSD." + category!
      );
    }
  }

  // 8 & 9. Hourly rate + hourly USD cap (recent settled spend plus open `upto` holds).
  const recent = root.getObj("recent");
  const recentCount = recent != null ? intOr(recent!, "count", 0) : 0;
  const recentTotalUSD = recent != null ? numOr(recent!, "totalUSD", 0.0) : 0.0;
  const heldUSD = numOr(root, "heldUSD", 0.0);
  const maxCallsPerHour = intOr(policy, "maxCallsPerHour", 10);
  const maxPerHourUSD = numOr(policy, "maxPerHourUSD", 0.2);

  if (recentCount + 1 > maxCallsPerHour) {
    return Decision.deny(
      "hourly_rate_cap",
      "would exceed maxCallsPerHour (" + maxCallsPerHour.toString() + ")",
      "wait for the hourly window to roll over before retrying, or have a human raise maxCallsPerHour"
    );
  }
  const committedUSD = recentTotalUSD + heldUSD;
  if (committedUSD + price > maxPerHourUSD) {
    const heldNote = heldUSD > 0.0 ? ", $" + toFixed4(heldUSD) + " held by open upto authorizations" : "";
    const remaining = maxPerHourUSD - committedUSD;
    const releaseNote = heldUSD > 0.0 ? ", settle or void an open authorization to release its hold" : "";
    return Decision.deny(
      "hourly_usd_cap",
      "would exceed maxPerHourUSD $" + numToStr(maxPerHourUSD) + " (spent $" + toFixed4(recentTotalUSD) + " so far" + heldNote + ")",
      "only $" + toFixed4(remaining < 0.0 ? 0.0 : remaining) + " remains in this hour's budget — wait for the window to roll over" + releaseNote + ", or pick a cheaper tool"
    );
  }

  const requireApprovalAboveUSD = numOr(policy, "requireApprovalAboveUSD", 0.015);
  return Decision.allow(price > requireApprovalAboveUSD);
}

function evaluateJson(inputJson: string): string {
  const parsed = JSON.parse(inputJson);
  if (!parsed.isObj) {
    return Decision.deny("input_invalid", "input was not a JSON object", "send a JSON object matching the documented schema (see wasm-policy/README.md)").toJSON();
  }
  return evaluateInternal(<JSON.Obj>parsed).toJSON();
}

// ---------------------------------------------------------------------------------------------
// Exported ABI: raw UTF-8 bytes in, raw UTF-8 bytes out — deliberately NOT AssemblyScript's
// managed-string marshalling (which needs a host that understands AS's internal object layout,
// e.g. via @assemblyscript/loader). A host here only ever needs three primitives: call alloc(len)
// to get a pointer, write len bytes of UTF-8 JSON into the exported `memory` at that pointer, call
// evaluate(ptr, len), then read getResultLen() bytes of UTF-8 JSON back from getResultPtr(). That's
// the same shape OPA's own production WASM ABI uses (memory + JSON in/out via exported pointers),
// and it means ANY WASM host — not just one with an AssemblyScript-aware loader — can drive this
// module: a browser with nothing but the standard WebAssembly API, an edge runtime, a sandboxed
// agent process in any language with a WASM embedder.
//
// Memory management: compiled with --runtime incremental (real, bounded GC), not --runtime stub.
// Independent audit finding (fixed here): stub's bump allocator never frees, and the loader's own
// documented usage pattern is "load once, call evaluate() repeatedly on the same instance" — under
// stub that grew WASM memory linearly and unboundedly (measured 256 MB after 20,000 calls with no
// bound), which is a real leak for the long-lived-host deployment this module is for. Incremental
// GC reclaims each call's parse tree and buffers once nothing references them — the normal case.
//
// That GC switch has one consequence this code has to get right: a raw `usize` pointer is NOT a GC
// root. Storing only a pointer (as the stub-runtime version of this file did) means the garbage
// collector can legally reclaim the referenced object between evaluate() returning and the host
// reading it back. inputBuf/resultBuf below are real AssemblyScript-typed globals specifically so
// the GC recognizes them as live references — each call's buffer stays rooted until the *next*
// call overwrites the global, by which point the host has already read the previous result out.
// ---------------------------------------------------------------------------------------------

let inputBuf: ArrayBuffer = new ArrayBuffer(0);
let resultBuf: ArrayBuffer = new ArrayBuffer(0);

// Allocates a byte buffer the host can write the UTF-8-encoded input JSON into.
export function alloc(size: i32): usize {
  inputBuf = changetype<ArrayBuffer>(__new(<usize>size, idof<ArrayBuffer>()));
  return changetype<usize>(inputBuf);
}

export function evaluate(ptr: usize, len: i32): void {
  const inputStr = String.UTF8.decodeUnsafe(ptr, <usize>len);
  const outStr = evaluateJson(inputStr);
  resultBuf = String.UTF8.encode(outStr);
}

export function getResultPtr(): usize {
  return changetype<usize>(resultBuf);
}

export function getResultLen(): i32 {
  return resultBuf.byteLength;
}

// Lets a host (or the parity test harness) confirm which build it loaded without inspecting the
// binary — bumped manually alongside the rule set it implements.
export function abiVersion(): i32 {
  return 1;
}
