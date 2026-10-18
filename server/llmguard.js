// The LLM spend guard — a budget gateway any agent can use by changing ONE
// environment variable. No wallet, no crypto, no SDK.
//
//   ANTHROPIC_BASE_URL=http://localhost:8402 claude          # Claude Code
//   OPENAI_BASE_URL=http://localhost:8402/v1 codex           # Codex CLI / OpenAI SDKs
//
// Why this exists: the money AI agents spend most of today is not x402 or
// cards — it is model tokens, and the failure people actually hit is a loop
// that burns hundreds or thousands of dollars before anyone looks (a Claude
// Code session reportedly burned ~$6,000 overnight; a LangChain agent made
// 14,000 redundant tool calls). Provider spend caps are monthly and lag.
// This sits on the request path and decides BEFORE the model is called.
//
// What it does, per request:
//   1. Estimates the worst case from the request itself (server/llm-pricing.js)
//      and checks it against the identity's per-request, hourly, daily and
//      per-session budgets — plus a velocity limit, a model allow/block list,
//      the kill switch, and (for agents bound to a delegated wallet) the same
//      cascading delegation caps that govern its x402 spend.
//   2. Detects agent loops: the same tool call returning the same result,
//      again and again, freezes the identity until a human looks. Only
//      SUCCESSFUL repeats count — an SDK retrying a failed request is not a loop.
//   3. Reserves the estimate as a hold while the request runs (two parallel
//      requests can't both squeeze into the last dollar), streams the response
//      through untouched, reads the provider's own usage report out of the
//      stream, and books the ACTUAL cost into the same hash-chained ledger
//      every other spend uses. The hold is released.
//
// What it is careful NOT to do (Claude Code's gateway compatibility guide is
// explicit about these): it forwards Anthropic request bodies byte-for-byte
// (no re-serialization), passes every anthropic-* header through unchanged,
// relays streams event by event including keep-alive pings, and forwards
// upstream error bodies unmodified. Only its OWN refusals use its own envelope.
//
// Credentials: by default the client's own provider key passes straight
// through and is never stored or logged. Team mode: an agent authenticates to
// the guard with a SpendVeto agent token (tg_…) and the guard swaps in a
// provider key only it holds — developers never see the key, and revoking the
// token revokes the access. A server-side key is NEVER used for a request that
// didn't present a valid agent token.
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { estimateRequest, costOf, PRICES_AS_OF, lookupPrice } from "./llm-pricing.js";

export const LLM_DEFAULTS = {
  // "enforce" blocks; "observe" decides and records what it WOULD have
  // blocked but never blocks — the zero-risk way to try a policy on real
  // traffic (the LLM counterpart of shadow mode).
  mode: "enforce",
  dailyBudgetUSD: 25, // rolling 24 hours, per identity
  hourlyBudgetUSD: 10, // rolling 60 minutes, per identity
  sessionBudgetUSD: null, // per Claude Code session (x-claude-code-session-id); null = off
  maxRequestUSD: 5, // worst-case estimate of a single request
  maxRequestsPerMinute: 60,
  outputEstimateCapTokens: 16000,
  approvalAboveUSD: null, // pause requests estimated above this for a human; null = off
  approvalTimeoutMs: 60000,
  loop: { enabled: true, threshold: 6, windowSeconds: 300 },
  allowedModels: null,
  blockedModels: [],
  requireAgentToken: false,
  identityFrom: "local", // "local" | "credential"
  passthroughUnknown: false,
  prices: {},
  unknownModelRates: null,
};

export function llmSettings(policy) {
  const p = policy?.llm || {};
  return { ...LLM_DEFAULTS, ...p, loop: { ...LLM_DEFAULTS.loop, ...(p.loop || {}) }, prices: { ...(p.prices || {}) } };
}

// Pseudo-addresses: a stable 0x-shaped identifier per identity, so the
// freeze list, the ledger, trust scores and the Console all work on LLM
// identities unchanged. They are identifiers, not wallets — nothing can sign
// for one, and nothing is ever sent to one.
export function pseudoAddress(seed) {
  return "0x" + createHash("sha256").update(`spendveto-llm:${seed}`).digest("hex").slice(0, 40);
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const clean = (v, max = 64) => String(v || "").replace(/[^\w .:@\-/]/g, "").slice(0, max).trim();

// Hop-by-hop and length/encoding headers never cross the proxy as-is.
const HOP = new Set(["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding"]);
const RESPONSE_DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

// The agent-loop signature: the last tool call the model made and the result
// it got back. Ids (tool_use_id, call ids) change every turn, cache_control
// markers move every turn, thinking blocks and their signatures differ every
// turn — all stripped. Returns null when the request carries no tool result:
// identical plain prompts are a rate/budget question, not a loop.
function stripVolatile(v) {
  if (Array.isArray(v)) return v.filter((x) => !(x && (x.type === "thinking" || x.type === "redacted_thinking" || x.type === "reasoning"))).map(stripVolatile);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (["id", "tool_use_id", "tool_call_id", "call_id", "cache_control", "signature"].includes(k)) continue;
      out[k] = stripVolatile(val);
    }
    return out;
  }
  return v;
}

export function loopFingerprint(provider, body) {
  if (!body || typeof body !== "object") return null;
  let tail = null;
  let hasToolResult = false;
  if (provider === "anthropic" && Array.isArray(body.messages)) {
    tail = body.messages.slice(-2);
    const last = body.messages[body.messages.length - 1];
    hasToolResult = Array.isArray(last?.content) && last.content.some((b) => b?.type === "tool_result");
  } else if (Array.isArray(body.messages)) {
    // Chat Completions: the assistant turn with tool_calls + its tool results.
    let i = body.messages.length - 1;
    while (i >= 0 && body.messages[i]?.role === "tool") i--;
    hasToolResult = i < body.messages.length - 1;
    tail = body.messages.slice(Math.max(0, i));
  } else if (Array.isArray(body.input)) {
    tail = body.input.slice(-2);
    hasToolResult = tail.some((x) => x?.type === "function_call_output");
  }
  if (!hasToolResult || !tail) return null;
  return sha(`${provider}|${body.model}|${JSON.stringify(stripVolatile(tail))}`);
}

// Incremental SSE usage reader. Bytes pass through untouched; this only
// watches them. Usage counters in a stream are cumulative, so the largest
// value seen per field is the final one.
function usageWatcher(provider, kind) {
  let buf = "";
  let usage = null;
  const decoder = new TextDecoder();
  const merge = (u) => {
    if (!u || typeof u !== "object") return;
    usage = usage || {};
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === "number") usage[k] = Math.max(usage[k] ?? 0, v);
      else if (v && typeof v === "object") usage[k] = { ...(usage[k] || {}), ...v };
      else if (v != null) usage[k] = v;
    }
  };
  const onData = (json) => {
    let obj;
    try {
      obj = JSON.parse(json);
    } catch {
      return;
    }
    if (provider === "anthropic") {
      if (obj.type === "message_start") merge(obj.message?.usage);
      else if (obj.type === "message_delta") merge(obj.usage);
    } else if (kind === "responses") {
      if (obj.response?.usage && /^response\.(completed|incomplete|failed)$/.test(obj.type || "")) merge(obj.response.usage);
    } else if (obj.usage) {
      merge(obj.usage);
    }
  };
  return {
    push(chunk) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") onData(data);
        }
      }
    },
    get usage() {
      return usage;
    },
  };
}

export function createLlmGuard(deps) {
  const {
    loadPolicy,
    checkPolicy,
    policyHash,
    appendLedgerEntry,
    getLedger,
    findActiveFreeze,
    createFreeze,
    listDelegations,
    sendAlert,
    createApproval,
    getApproval,
    readAgents,
    childAddress,
  } = deps;
  const upstreamFor = (provider) =>
    (provider === "anthropic" ? process.env.SPENDVETO_ANTHROPIC_UPSTREAM || "https://api.anthropic.com" : process.env.SPENDVETO_OPENAI_UPSTREAM || "https://api.openai.com").replace(/\/+$/, "");
  const providerKey = (provider) =>
    provider === "anthropic" ? process.env.SPENDVETO_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY : process.env.SPENDVETO_OPENAI_KEY || process.env.OPENAI_API_KEY;

  // In-memory state. Spend is rebuilt from the ledger on first use, so a
  // restart never forgets what an identity already spent today.
  const holds = new Map(); // id -> { address, session, usd, at }
  const requestsAt = new Map(); // address -> [ms]
  const loopSeen = new Map(); // address -> Map(fingerprint -> [ms])
  const labels = new Map(); // address -> { label, kind }
  let spend = null; // address -> [{ t, usd, session }]
  const locks = new Map();

  const DAY = 24 * 3600e3;
  function spendLog() {
    if (spend) return spend;
    spend = new Map();
    const cutoff = Date.now() - DAY;
    for (const e of getLedger()) {
      if (e.category !== "llm" || e.status !== "paid") continue;
      const t = Date.parse(e.ts);
      if (!(t >= cutoff)) continue;
      const key = String(e.address).toLowerCase();
      if (!spend.has(key)) spend.set(key, []);
      spend.get(key).push({ t, usd: Number(e.amount) || 0, session: e.session || null });
      if (e.agent && !labels.has(key)) labels.set(key, { label: e.agent, kind: e.identityKind || "label" });
    }
    return spend;
  }
  function windowUSD(address, ms, session) {
    const now = Date.now();
    const rows = (spendLog().get(address.toLowerCase()) || []).filter((r) => r.t >= now - DAY);
    spendLog().set(address.toLowerCase(), rows);
    return round6(rows.filter((r) => r.t >= now - ms && (!session || r.session === session)).reduce((s, r) => s + r.usd, 0));
  }
  function heldUSD(address, session) {
    const key = address.toLowerCase();
    let total = 0;
    for (const h of holds.values()) {
      if (Date.now() - h.at > 15 * 60e3) continue; // a hold can't outlive any real request
      if (h.address === key && (!session || h.session === session)) total += h.usd;
    }
    return round6(total);
  }
  function withLock(address, fn) {
    const key = address.toLowerCase();
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(key, run.catch(() => {}));
    return run;
  }

  function resolveIdentity(req, settings) {
    const auth = req.get("authorization") || "";
    const bearer = (auth.match(/^Bearer\s+(.+)$/i) || [])[1] || null;
    const xkey = req.get("x-api-key") || null;
    const agents = readAgents();
    const agent = agents.find((a) => a.token && (a.token === bearer || a.token === xkey)) || null;
    const session = clean(req.get("x-claude-code-session-id") || req.get("x-spendveto-session"), 128) || null;
    const subagent = clean(req.get("x-claude-code-agent-id"), 128) || null;
    if (agent) {
      const address = (agent.child && childAddress(agent.child)) || pseudoAddress(`agent:${agent.id}`);
      return { address: address.toLowerCase(), label: agent.label, kind: agent.child ? "agent (delegated wallet)" : "agent", agent, session, subagent };
    }
    const label = clean(req.get("x-spendveto-agent"));
    if (label) return { address: pseudoAddress(`label:${label}`), label, kind: "label", agent: null, session, subagent };
    if (settings.identityFrom === "credential" && (bearer || xkey)) {
      const fp = sha(bearer || xkey).slice(0, 12);
      return { address: pseudoAddress(`cred:${fp}`), label: `key ${fp}`, kind: "credential", agent: null, session, subagent };
    }
    return { address: pseudoAddress("local"), label: "local", kind: "local", agent: null, session, subagent };
  }

  function refusalBody(provider, d) {
    const message = `SpendVeto blocked this request — ${d.reason}. ${d.suggestion || ""}`.trim();
    const details = { code: d.code, reason: d.reason, suggestion: d.suggestion, ...(d.extra || {}) };
    return provider === "anthropic"
      ? { type: "error", error: { type: "spendveto_blocked", message }, spendveto: details }
      : { error: { message, type: "spendveto_blocked", code: d.code, param: null }, spendveto: details };
  }

  function record(entry) {
    try {
      appendLedgerEntry({ chain: "api", category: "llm", mode: "llm-guard", policyHash: policyHash(), ...entry });
    } catch {}
  }

  // The decision. Everything synchronous up to the hold reservation runs
  // inside the identity's lock, so concurrent requests can't both pass a
  // budget that only has room for one.
  async function decide(ctx) {
    const { settings, identity, estimate, model, fingerprint } = ctx;
    const deny = (code, reason, suggestion, status = 402, extra = {}) => ({ allow: false, code, reason, suggestion, status, extra });

    const canon = estimate.model;
    if (Array.isArray(settings.blockedModels) && settings.blockedModels.map((m) => String(m).toLowerCase()).includes(canon)) {
      return deny("llm_model_blocked", `model "${model}" is on policy.llm.blockedModels`, "use a model this policy allows, or have a human remove it from blockedModels");
    }
    if (Array.isArray(settings.allowedModels) && settings.allowedModels.length && !settings.allowedModels.map((m) => String(m).toLowerCase()).includes(canon)) {
      return deny("llm_model_not_allowed", `model "${model}" is not in policy.llm.allowedModels (${settings.allowedModels.join(", ")})`, `retry with one of: ${settings.allowedModels.join(", ")}`);
    }
    const frozen = findActiveFreeze(identity.address);
    if (frozen) {
      return deny("frozen", `"${identity.label}" is frozen (${frozen.source}): ${frozen.reason}`, "do not retry; a human must review and unfreeze it in the SpendVeto Console");
    }
    if (settings.loop.enabled && fingerprint) {
      const seen = (loopSeen.get(identity.address) || new Map()).get(fingerprint) || [];
      const recent = seen.filter((t) => t >= Date.now() - settings.loop.windowSeconds * 1000);
      if (recent.length >= settings.loop.threshold) {
        const reason = `agent loop detected: the same tool call returned the same result ${recent.length} times in ${settings.loop.windowSeconds}s`;
        if (settings.mode === "enforce") {
          createFreeze({ address: identity.address, reason, source: "llm-loop" });
          sendAlert("llm.loop_detected", { address: identity.address, agent: identity.label, session: identity.session, model, repeats: recent.length });
        }
        return deny("llm_loop_detected", reason, "the identity is now frozen — fix the loop, then unfreeze it from the Console");
      }
    }
    const minute = (requestsAt.get(identity.address) || []).filter((t) => t >= Date.now() - 60e3);
    if (minute.length >= settings.maxRequestsPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((minute[0] + 60e3 - Date.now()) / 1000));
      return deny("llm_rate_limited", `more than ${settings.maxRequestsPerMinute} requests in the last minute`, `slow down — retry after ${retryAfter}s`, 429, { retryAfter });
    }
    if (estimate.usd > settings.maxRequestUSD) {
      return deny("llm_request_cap", `this request could cost up to $${estimate.usd.toFixed(4)} (≈${estimate.inputTokens} input + ${estimate.outputTokens} output tokens on ${model}), over maxRequestUSD $${settings.maxRequestUSD}`, "send less context, lower max_tokens, use a cheaper model, or have a human raise policy.llm.maxRequestUSD");
    }
    const held = heldUSD(identity.address);
    const hour = windowUSD(identity.address, 3600e3);
    if (hour + held + estimate.usd > settings.hourlyBudgetUSD) {
      return deny("llm_hourly_budget", `would exceed the hourly budget $${settings.hourlyBudgetUSD} ($${hour.toFixed(4)} spent, $${held.toFixed(4)} in flight)`, `wait for the hour to roll over, or have a human raise policy.llm.hourlyBudgetUSD`, 402, { spentHourUSD: hour });
    }
    const day = windowUSD(identity.address, DAY);
    if (day + held + estimate.usd > settings.dailyBudgetUSD) {
      return deny("llm_daily_budget", `would exceed the daily budget $${settings.dailyBudgetUSD} ($${day.toFixed(4)} spent in the last 24h, $${held.toFixed(4)} in flight)`, "the budget resets on a rolling 24 hours — or a human can raise policy.llm.dailyBudgetUSD", 402, { spentDayUSD: day });
    }
    if (identity.session && Number(settings.sessionBudgetUSD) > 0) {
      const s = windowUSD(identity.address, DAY, identity.session) + heldUSD(identity.address, identity.session);
      if (s + estimate.usd > Number(settings.sessionBudgetUSD)) {
        return deny("llm_session_budget", `would exceed the per-session budget $${settings.sessionBudgetUSD} ($${s.toFixed(4)} used by this session)`, "start a new session deliberately, or have a human raise policy.llm.sessionBudgetUSD");
      }
    }
    // The shared policy engine — only when it can change the answer: a
    // delegated wallet (cascading caps across tokens AND payments), an
    // operator category cap on "llm", or a trading-hours window.
    const policy = ctx.policy;
    const delegated = listDelegations().some((d) => String(d.childAddress).toLowerCase() === identity.address && !d.revoked);
    if (delegated || policy.categoryCapsUSD?.llm != null || policy.allowedHoursUTC) {
      const override = { ...policy, maxPerCallUSD: Infinity, maxPerHourUSD: Infinity, maxCallsPerHour: Infinity, requireApprovalAboveUSD: Infinity };
      const verdict = await checkPolicy(identity.address, estimate.usd, `llm:${canon}`, undefined, "llm", undefined, override);
      if (!verdict.allowed) return deny(verdict.code || "policy", verdict.reason, verdict.suggestion);
    }
    return { allow: true };
  }

  async function waitForHuman(identity, model, estimate, settings) {
    const approval = createApproval({ address: identity.address, resource: `llm:${estimate.model}`, price: estimate.usd });
    const deadline = Date.now() + Number(settings.approvalTimeoutMs || 60000);
    while (Date.now() < deadline) {
      const a = getApproval(approval.id);
      if (a?.status === "approved") return { ok: true, approvalId: approval.id };
      if (a?.status === "denied") return { ok: false, reason: "denied by a human approver" };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, reason: "approval timed out — failed closed, the model was never called" };
  }

  // Path → provider and kind. Explicit /anthropic and /openai prefixes always
  // win; bare /v1 paths route by endpoint, and /v1/models (which both
  // providers serve) by the anthropic-version header Anthropic clients send.
  function route(req) {
    const m = req.path.match(/^\/(anthropic\/|openai\/)?v1\/(.*)$/);
    if (!m) return null;
    const prefix = m[1] ? m[1].slice(0, -1) : null;
    const rest = m[2];
    let provider = prefix;
    if (!provider) {
      if (/^messages(\/|$)/.test(rest)) provider = "anthropic";
      else if (/^(chat\/completions|responses|embeddings)$/.test(rest)) provider = "openai";
      else if (rest === "models" || rest.startsWith("models/")) provider = req.get("anthropic-version") ? "anthropic" : "openai";
      else provider = req.get("anthropic-version") ? "anthropic" : "openai";
    }
    let kind = "passthrough";
    if (provider === "anthropic" && rest === "messages") kind = "messages";
    else if (provider === "anthropic" && rest === "messages/count_tokens") kind = "free";
    else if (provider === "openai" && rest === "chat/completions") kind = "chat";
    else if (provider === "openai" && rest === "responses") kind = "responses";
    else if (provider === "openai" && rest === "embeddings") kind = "embeddings";
    else if (rest === "models" || rest.startsWith("models/")) kind = "free";
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    return { provider, kind, url: `${upstreamFor(provider)}/v1/${rest}${qs}` };
  }

  async function forward(req, res, { provider, kind, url, body, headers, onDone, extraHeaders = {} }) {
    const controller = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) controller.abort();
    });
    const started = Date.now();
    let upstream;
    try {
      upstream = await fetch(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, signal: controller.signal, redirect: "manual" });
    } catch (err) {
      finished = true;
      if (!res.headersSent) {
        const msg = `SpendVeto could not reach the upstream (${new URL(url).host}): ${err.message}`;
        res.status(502).json(provider === "anthropic" ? { type: "error", error: { type: "api_error", message: msg } } : { error: { message: msg, type: "upstream_unreachable" } });
      }
      onDone?.({ status: 502, usage: null, aborted: false, error: err.message, durationMs: Date.now() - started, streamed: false });
      return;
    }
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!RESPONSE_DROP.has(k.toLowerCase())) outHeaders[k] = v;
    });
    Object.assign(outHeaders, extraHeaders);
    const contentType = upstream.headers.get("content-type") || "";
    const streamed = contentType.includes("text/event-stream");
    if (streamed && upstream.body) {
      const watcher = usageWatcher(provider, kind);
      res.writeHead(upstream.status, outHeaders);
      res.flushHeaders?.();
      let aborted = false;
      try {
        for await (const chunk of upstream.body) {
          watcher.push(chunk);
          // Respect backpressure, but never wait on a client that has gone:
          // a disconnect resolves the wait and the abort ends the read.
          if (!res.write(chunk)) await new Promise((r) => { res.once("drain", r); res.once("close", r); });
        }
      } catch {
        aborted = true;
      }
      finished = true;
      res.end();
      onDone?.({ status: upstream.status, usage: watcher.usage, aborted, durationMs: Date.now() - started, streamed: true });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer().catch(() => new ArrayBuffer(0)));
    let usage = null;
    if (contentType.includes("json")) {
      try {
        usage = JSON.parse(buf.toString("utf8")).usage || null;
      } catch {}
    }
    const booked = onDone?.({ status: upstream.status, usage, aborted: false, durationMs: Date.now() - started, streamed: false, beforeSend: true });
    if (booked?.costUSD != null) outHeaders["x-spendveto-cost-usd"] = String(booked.costUSD);
    finished = true;
    res.writeHead(upstream.status, outHeaders);
    res.end(buf);
  }

  const router = express.Router();
  // Raw bytes, generous limit: Claude Code requests routinely run to
  // megabytes, and Anthropic bodies must be forwarded exactly as received.
  const raw = express.raw({ type: () => true, limit: "64mb" });

  router.all(/^\/(?:anthropic\/|openai\/)?v1\/.*/, raw, async (req, res) => {
    const r = route(req);
    if (!r) return res.status(404).end();
    const policy = loadPolicy();
    const settings = llmSettings(policy);
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // Headers to forward: everything but hop-by-hop, our own x-spendveto-*,
    // and (in team mode) the client's credential.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP.has(lk) || lk.startsWith("x-spendveto-")) continue;
      headers[lk] = v;
    }
    headers["accept-encoding"] = "identity";

    const identity = resolveIdentity(req, settings);
    labels.set(identity.address, { label: identity.label, kind: identity.kind });
    if (settings.requireAgentToken && !identity.agent) {
      return res.status(401).json(refusalBody(r.provider, { code: "agent_token_required", reason: "this guard requires a SpendVeto agent token", suggestion: "authenticate with the tg_… token issued for this agent (as the API key or bearer token)" }));
    }
    if (identity.agent) {
      const key = providerKey(r.provider);
      if (!key) {
        return res.status(503).json(refusalBody(r.provider, { code: "no_provider_key", reason: `team mode needs a ${r.provider} key configured on the guard`, suggestion: `set ${r.provider === "anthropic" ? "SPENDVETO_ANTHROPIC_KEY" : "SPENDVETO_OPENAI_KEY"} on the SpendVeto server` }));
      }
      delete headers.authorization;
      delete headers["x-api-key"];
      if (r.provider === "anthropic") headers["x-api-key"] = key;
      else headers.authorization = `Bearer ${key}`;
    }

    // Free and unmetered endpoints.
    if (r.kind === "free") return forward(req, res, { ...r, body: rawBody, headers });
    if (r.kind === "passthrough") {
      if (!settings.passthroughUnknown) {
        return res.status(501).json(refusalBody(r.provider, { code: "llm_endpoint_not_governed", reason: `SpendVeto can't meter ${req.method} ${req.path} yet, so it won't pass it through ungoverned`, suggestion: "call the provider directly for this endpoint, or set policy.llm.passthroughUnknown to true to accept the risk" }));
      }
      return forward(req, res, { ...r, body: rawBody, headers });
    }

    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8") || "{}");
    } catch {
      return forward(req, res, { ...r, body: rawBody, headers }); // let the upstream reject it in its own words
    }
    const model = body.model || "unknown";
    let sendBody = rawBody;
    // OpenAI streams only report usage when asked to; ask, so the cost is the
    // provider's number, not a guess. Anthropic bodies are never touched.
    if (r.kind === "chat" && body.stream === true && body.stream_options?.include_usage !== true) {
      body.stream_options = { ...(body.stream_options || {}), include_usage: true };
      sendBody = Buffer.from(JSON.stringify(body));
    }
    const estimate = estimateRequest(r.provider, body, { outputCapTokens: settings.outputEstimateCapTokens, overrides: settings.prices });
    const fingerprint = settings.loop.enabled ? loopFingerprint(r.provider, body) : null;

    const holdId = randomUUID();
    const decision = await withLock(identity.address, async () => {
      const d = await decide({ settings, policy, identity, estimate, model, fingerprint });
      if (d.allow || settings.mode === "observe") {
        holds.set(holdId, { address: identity.address, session: identity.session, usd: estimate.usd, at: Date.now() });
        const list = (requestsAt.get(identity.address) || []).filter((t) => t >= Date.now() - 60e3);
        list.push(Date.now());
        requestsAt.set(identity.address, list);
      }
      return d;
    });

    const base = { address: identity.address, agent: identity.label, identityKind: identity.kind, resource: `llm:${estimate.model}`, provider: r.provider, model, session: identity.session || undefined, subagent: identity.subagent || undefined, estimateUSD: estimate.usd };
    if (!decision.allow && settings.mode === "enforce") {
      record({ ...base, amount: estimate.usd, status: "blocked", reason: decision.reason, code: decision.code });
      const out = { "x-should-retry": decision.status === 429 ? "true" : "false" };
      if (decision.extra?.retryAfter) out["retry-after"] = String(decision.extra.retryAfter);
      res.set(out);
      return res.status(decision.status).json(refusalBody(r.provider, decision));
    }
    const wouldBlock = decision.allow ? null : { code: decision.code, reason: decision.reason };

    if (decision.allow && settings.approvalAboveUSD != null && estimate.usd > Number(settings.approvalAboveUSD) && settings.mode === "enforce") {
      const human = await waitForHuman(identity, model, estimate, settings);
      if (!human.ok) {
        holds.delete(holdId);
        record({ ...base, amount: estimate.usd, status: "blocked", reason: human.reason, code: "approval_required" });
        res.set({ "x-should-retry": "false" });
        return res.status(402).json(refusalBody(r.provider, { code: "approval_required", reason: `this request (up to $${estimate.usd.toFixed(4)}) needs a human's approval: ${human.reason}`, suggestion: "approve it in the SpendVeto Console, or lower the request's cost" }));
      }
    }

    const remainingDay = round6(Math.max(0, settings.dailyBudgetUSD - windowUSD(identity.address, DAY) - heldUSD(identity.address)));
    const extraHeaders = { "x-spendveto-identity": identity.label, "x-spendveto-estimate-usd": String(estimate.usd), "x-spendveto-remaining-day-usd": String(remainingDay) };

    let booked = false;
    const onDone = ({ status, usage, aborted, durationMs, streamed, error }) => {
      if (booked) return null;
      booked = true;
      holds.delete(holdId);
      const ok = status >= 200 && status < 300;
      let cost = usage ? costOf(r.provider, model, usage, settings.prices) : null;
      let priceSource = cost?.priceSource;
      if (!cost && ok) {
        // A 2xx that never reported usage (a stream cut before message_start,
        // a proxy that strips it): book the estimated INPUT cost rather than
        // zero — conservative, and labelled as an estimate.
        const inputOnly = round6((estimate.inputTokens * lookupPrice(r.provider, model, settings.prices).price.input) / 1e6);
        cost = { usd: inputOnly, usage: null };
        priceSource = "estimated (provider reported no usage)";
      }
      const usd = cost?.usd ?? 0;
      if (ok || usd > 0) {
        const key = identity.address;
        if (!spendLog().has(key)) spendLog().set(key, []);
        spendLog().get(key).push({ t: Date.now(), usd, session: identity.session || null });
      }
      if (ok && fingerprint && !aborted) {
        if (!loopSeen.has(identity.address)) loopSeen.set(identity.address, new Map());
        const m = loopSeen.get(identity.address);
        m.set(fingerprint, [...(m.get(fingerprint) || []).filter((t) => t >= Date.now() - settings.loop.windowSeconds * 1000), Date.now()]);
      }
      record({
        ...base,
        amount: usd,
        status: ok || usd > 0 ? "paid" : "failed",
        ...(ok ? {} : { reason: error || `upstream returned ${status}` }),
        upstreamStatus: status,
        usage: cost?.usage || undefined,
        priceSource,
        ...(cost?.unknownModel ? { unknownModel: true } : {}),
        streamed,
        ...(aborted ? { aborted: true } : {}),
        durationMs,
        ...(wouldBlock ? { wouldBlock } : {}),
      });
      return { costUSD: usd };
    };
    return forward(req, res, { ...r, body: sendBody, headers, onDone, extraHeaders });
  });

  // ---- Read side: what the Console and CLI show ----
  function summary() {
    const policy = loadPolicy();
    const settings = llmSettings(policy);
    const cutoff = Date.now() - DAY;
    const entries = getLedger().filter((e) => e.category === "llm" && Date.parse(e.ts) >= cutoff);
    const byId = new Map();
    const row = (address) => {
      const key = String(address).toLowerCase();
      if (!byId.has(key)) {
        const l = labels.get(key);
        byId.set(key, { address: key, label: l?.label || null, kind: l?.kind || null, spentDayUSD: 0, spentHourUSD: 0, requestsDay: 0, blockedDay: 0, models: {}, sessions: {}, lastAt: null });
      }
      return byId.get(key);
    };
    let unknownModelRequests = 0;
    const recentDecisions = [];
    for (const e of entries) {
      const r = row(e.address);
      if (!r.label && e.agent) r.label = e.agent;
      if (!r.kind && e.identityKind) r.kind = e.identityKind;
      r.lastAt = e.ts;
      if (e.status === "paid") {
        r.spentDayUSD += Number(e.amount) || 0;
        if (Date.parse(e.ts) >= Date.now() - 3600e3) r.spentHourUSD += Number(e.amount) || 0;
        r.requestsDay++;
        r.models[e.model] = round6((r.models[e.model] || 0) + (Number(e.amount) || 0));
        if (e.session) r.sessions[e.session] = round6((r.sessions[e.session] || 0) + (Number(e.amount) || 0));
        if (e.unknownModel) unknownModelRequests++;
      }
      if (e.status === "blocked") r.blockedDay++;
      if (e.status === "blocked" || e.wouldBlock) recentDecisions.push({ ts: e.ts, agent: e.agent, model: e.model, code: e.code || e.wouldBlock?.code, reason: e.reason || e.wouldBlock?.reason, observeOnly: Boolean(e.wouldBlock) });
    }
    const identities = [...byId.values()].map((r) => {
      const frozen = findActiveFreeze(r.address);
      const held = heldUSD(r.address);
      return {
        ...r,
        spentDayUSD: round6(r.spentDayUSD),
        spentHourUSD: round6(r.spentHourUSD),
        heldUSD: held,
        remainingDayUSD: round6(Math.max(0, settings.dailyBudgetUSD - r.spentDayUSD - held)),
        frozen: frozen ? { id: frozen.id, reason: frozen.reason, source: frozen.source } : null,
        sessions: Object.entries(r.sessions).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, usd]) => ({ id, usd })),
      };
    });
    identities.sort((a, b) => b.spentDayUSD - a.spentDayUSD);
    return {
      mode: settings.mode,
      pricesAsOf: PRICES_AS_OF,
      settings: { dailyBudgetUSD: settings.dailyBudgetUSD, hourlyBudgetUSD: settings.hourlyBudgetUSD, sessionBudgetUSD: settings.sessionBudgetUSD, maxRequestUSD: settings.maxRequestUSD, maxRequestsPerMinute: settings.maxRequestsPerMinute, approvalAboveUSD: settings.approvalAboveUSD, loop: settings.loop, allowedModels: settings.allowedModels, blockedModels: settings.blockedModels, requireAgentToken: settings.requireAgentToken },
      totals: {
        spentDayUSD: round6(identities.reduce((s, r) => s + r.spentDayUSD, 0)),
        requestsDay: identities.reduce((s, r) => s + r.requestsDay, 0),
        blockedDay: identities.reduce((s, r) => s + r.blockedDay, 0),
        loopFreezesDay: entries.filter((e) => e.code === "llm_loop_detected").length,
        unknownModelRequests,
        inFlight: holds.size,
      },
      identities,
      recentDecisions: recentDecisions.slice(-20).reverse(),
    };
  }

  return { router, summary, heldUSD: (address) => heldUSD(String(address || "")), settings: () => llmSettings(loadPolicy()) };
}
