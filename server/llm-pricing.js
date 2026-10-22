// What an LLM request actually cost — from the provider's own usage report.
//
// The guard (server/llmguard.js) decides BEFORE a request reaches the model
// on an estimate, then books the real cost AFTER, from the `usage` object the
// provider returns. This file is the second half: provider usage in, dollars
// out, with the price source stamped on every result so a ledger entry can
// always answer "where did this number come from?".
//
// Sources (re-check when prices move; operators can override any row with
// policy.llm.prices without touching code):
//   Anthropic — first-party API rates (Claude API skill reference, cached
//     2026-10-06). Cache writes bill 1.25x base input (5-minute TTL) or 2x
//     (1-hour TTL); cache reads ~0.1x, except where a row says otherwise.
//   OpenAI — developers.openai.com/api/docs/pricing, standard tier, short
//     context, fetched 2026-10-18 (newest rows confirmed against the raw page;
//     older rows corroborated by OpenAI's model pages).
//
// Matching is EXACT after stripping a date suffix (-20251001, -2024-08-06) or
// "-latest" — never by prefix. "gpt-5.6-terra" is not "gpt-5" priced cheap; a
// model this table doesn't know is priced at the provider's most expensive
// flagship rate instead (fail-safe: an unknown model can over-reserve budget,
// never under-reserve it), and the result says so.
export const PRICES_AS_OF = "2026-10-18";

// USD per million tokens. cacheRead defaults to 0.1x input; cacheWrite5m to
// 1.25x and cacheWrite1h to 2x input. `long` = rates once the prompt exceeds
// `longThreshold` input tokens (whole request billed at the long rate).
const A = (input, output, cacheRead, extra = {}) => ({ input, output, cacheRead, ...extra });
export const ANTHROPIC_PRICES = {
  "claude-fable-5-1": A(10, 50, 0.25),
  "claude-mythos-5-1": A(10, 50, 0.25),
  "claude-fable-5": A(10, 50, 1.0),
  "claude-mythos-5": A(10, 50, 1.0),
  "claude-opus-5-5": A(4, 20, 0.2),
  "claude-opus-5": A(5, 25, 0.5),
  "claude-opus-4-8": A(5, 25, 0.5),
  "claude-opus-4-7": A(5, 25, 0.5),
  "claude-opus-4-6": A(5, 25, 0.5),
  "claude-opus-4-5": A(5, 25, 0.5),
  "claude-opus-4-1": A(15, 75, 1.5),
  "claude-sonnet-5-5": A(2, 10, 0.2),
  "claude-sonnet-5": A(2, 10, 0.2),
  "claude-sonnet-4-6": A(3, 15, 0.3),
  "claude-sonnet-4-5": A(3, 15, 0.3),
  "claude-haiku-5-5": A(0.1, 0.5, 0.01, { longThreshold: 100_000, long: A(0.5, 2.5, 0.05) }),
  "claude-haiku-4-5": A(1, 5, 0.1),
};

// OpenAI bills cached input at its own listed rate; models with no cached rate
// on the price sheet bill cached tokens at the full input rate.
const O = (input, cachedInput, output, extra = {}) => ({ input, cacheRead: cachedInput ?? input, output, ...extra });
export const OPENAI_PRICES = {
  "gpt-6-astra": O(10, 1.0, 50, { longThreshold: 272_000, long: O(20, 2.0, 75) }),
  "gpt-6.1-sol": O(2, 0.1, 10, { longThreshold: 272_000, long: O(4, 0.2, 15) }),
  "gpt-6-luna": O(0.1, 0.01, 0.5, { longThreshold: 272_000, long: O(0.2, 0.02, 0.75) }),
  "gpt-5.6-sol": O(4, 0.4, 20, { longThreshold: 272_000, long: O(8, 0.8, 30) }),
  "gpt-5.6-cyber": O(12.5, 1.25, 75),
  "gpt-5.5": O(5, 0.5, 30),
  "gpt-5.5-pro": O(30, null, 180),
  "gpt-5.4": O(2.5, 0.25, 15),
  "gpt-5.4-mini": O(0.75, 0.075, 4.5),
  "gpt-5.4-nano": O(0.2, 0.02, 1.25),
  "gpt-5.4-pro": O(30, null, 180),
  "gpt-5.3-codex": O(1.75, 0.175, 14),
  "gpt-5.2": O(1.75, 0.175, 14),
  "gpt-5.2-pro": O(21, null, 168),
  "gpt-5.1": O(1.25, 0.125, 10),
  "gpt-5": O(1.25, 0.125, 10),
  "gpt-5-mini": O(0.25, 0.025, 2),
  "gpt-5-nano": O(0.05, 0.005, 0.4),
  "gpt-5-pro": O(15, null, 120),
  "gpt-4.1": O(2, 0.5, 8),
  "gpt-4.1-mini": O(0.4, 0.1, 1.6),
  "gpt-4.1-nano": O(0.1, 0.025, 0.4),
  "gpt-4o": O(2.5, 1.25, 10),
  "gpt-4o-2024-05-13": O(5, null, 15),
  "gpt-4o-mini": O(0.15, 0.075, 0.6),
  "o1": O(15, 7.5, 60),
  "o1-pro": O(150, null, 600),
  "o3": O(2, 0.5, 8),
  "o3-pro": O(20, null, 80),
  "o3-mini": O(1.1, 0.55, 4.4),
  "o4-mini": O(1.1, 0.275, 4.4),
};

// The fail-safe rate for a model no table knows: each provider's most
// expensive widely used flagship (pro/research tiers excluded — pricing every
// unknown model like o1-pro would make the guard refuse everything, which is
// safe but useless). Overridable with policy.llm.unknownModelRates.
export const UNKNOWN_MODEL_RATES = {
  anthropic: ANTHROPIC_PRICES["claude-fable-5-1"],
  openai: OPENAI_PRICES["gpt-6-astra"],
};

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// "claude-haiku-4-5-20251001" → "claude-haiku-4-5"; "gpt-4o-2024-08-06" →
// "gpt-4o"; "chatgpt-4o-latest" stays unknown (its own model, its own price).
export function canonicalModel(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "")
    .replace(/-latest$/, "");
}

const tableFor = (provider) => (provider === "anthropic" ? ANTHROPIC_PRICES : OPENAI_PRICES);

export function lookupPrice(provider, model, overrides = {}, unknownRates = null) {
  const raw = String(model || "").trim().toLowerCase();
  const canon = canonicalModel(raw);
  const custom = overrides?.[raw] || overrides?.[canon];
  if (custom) return { price: normalizeCustom(custom), source: "policy.llm.prices", model: canon };
  const table = tableFor(provider);
  // Exact id first (some dated snapshots carry their own price, e.g.
  // gpt-4o-2024-05-13), then the date-stripped family id.
  const row = table[raw] || table[canon];
  if (row) return { price: row, source: `${provider} price sheet (${PRICES_AS_OF})`, model: table[raw] ? raw : canon };
  // policy.llm.unknownModelRates: { anthropic: { inputPerM, outputPerM }, openai: {…} } replaces the flagship fallback.
  const declared = unknownRates?.[provider];
  if (declared && Number(declared.inputPerM) >= 0 && Number(declared.outputPerM) >= 0) return { price: normalizeCustom(declared), source: "policy.llm.unknownModelRates", model: canon, unknown: true };
  return { price: UNKNOWN_MODEL_RATES[provider] || UNKNOWN_MODEL_RATES.anthropic, source: "unknown-model-fallback", model: canon, unknown: true };
}

// policy.llm.prices rows use explicit names so an operator can't confuse
// per-token and per-million units: { inputPerM, outputPerM, cacheReadPerM }.
function normalizeCustom(c) {
  return { input: Number(c.inputPerM) || 0, output: Number(c.outputPerM) || 0, cacheRead: c.cacheReadPerM != null ? Number(c.cacheReadPerM) : undefined };
}

// One usage shape for every provider:
//   input       — uncached input tokens billed at the full input rate
//   cacheRead   — input tokens served from cache
//   cacheWrite5m / cacheWrite1h — input tokens written to cache (Anthropic)
//   output      — output tokens (including reasoning/thinking tokens, which
//                 both providers bill as output)
//   reportedCostUSD — an upstream that reports its own charge (OpenRouter's
//                 usage.cost) wins over any table: it is the bill
export function normalizeUsage(provider, usage) {
  if (!usage || typeof usage !== "object") return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const reported = Number.isFinite(Number(usage.cost)) && usage.cost !== null && usage.cost !== undefined ? Number(usage.cost) : null;
  if (provider === "anthropic") {
    const creation = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
    const write1h = creation ? n(creation.ephemeral_1h_input_tokens) : 0;
    const write5m = creation ? n(creation.ephemeral_5m_input_tokens) : n(usage.cache_creation_input_tokens);
    return { input: n(usage.input_tokens), cacheRead: n(usage.cache_read_input_tokens), cacheWrite5m: write5m, cacheWrite1h: write1h, output: n(usage.output_tokens), reportedCostUSD: reported };
  }
  // OpenAI Chat Completions: prompt_tokens INCLUDES cached tokens.
  if (usage.prompt_tokens != null || usage.completion_tokens != null) {
    const cached = n(usage.prompt_tokens_details?.cached_tokens);
    return { input: Math.max(0, n(usage.prompt_tokens) - cached), cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0, output: n(usage.completion_tokens), reportedCostUSD: reported };
  }
  // OpenAI Responses API: input_tokens INCLUDES cached tokens.
  const cached = n(usage.input_tokens_details?.cached_tokens);
  return { input: Math.max(0, n(usage.input_tokens) - cached), cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0, output: n(usage.output_tokens), reportedCostUSD: reported };
}

export function costOf(provider, model, usage, overrides = {}, unknownRates = null) {
  const u = normalizeUsage(provider, usage);
  if (!u) return null;
  const { price: base, source, unknown } = lookupPrice(provider, model, overrides, unknownRates);
  if (u.reportedCostUSD != null) {
    return { usd: round6(u.reportedCostUSD), priceSource: "upstream-reported", usage: u, unknownModel: Boolean(unknown) };
  }
  const promptTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const price = base.long && base.longThreshold && promptTokens > base.longThreshold ? base.long : base;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  // Per-component lines (what a FOCUS export and an invoice need): tokens,
  // the $/MTok rate applied, and the cost of that component alone.
  const line = (tokens, ratePerM) => ({ tokens, ratePerM: round6(ratePerM), usd: round6((tokens * ratePerM) / 1e6) });
  const breakdown = {
    input: line(u.input, price.input),
    cacheRead: line(u.cacheRead, cacheRead),
    cacheWrite5m: line(u.cacheWrite5m, price.input * 1.25),
    cacheWrite1h: line(u.cacheWrite1h, price.input * 2),
    output: line(u.output, price.output),
  };
  const usd =
    (u.input * price.input + u.cacheRead * cacheRead + u.cacheWrite5m * price.input * 1.25 + u.cacheWrite1h * price.input * 2 + u.output * price.output) / 1e6;
  return { usd: round6(usd), priceSource: source, usage: u, breakdown, unknownModel: Boolean(unknown), longContext: price !== base };
}

// The pre-request estimate the guard decides and reserves on. Input is sized
// from the request's text (≈3 bytes/token — deliberately on the high side for
// English and code), images and documents get flat allowances instead of
// their base64 size (a 1 MB screenshot is ~1,600 tokens, not 450,000), and
// output is the request's own max_tokens, capped at outputCapTokens so a
// client that always asks for 64K doesn't reserve a fortune per call. Only
// the hold uses this number; what gets booked is the provider's usage.
const IMAGE_TOKENS = 1600;
const DOCUMENT_TOKENS = 3000;

function textBytes(node, acc) {
  if (node == null) return;
  if (typeof node === "string") {
    acc.bytes += Buffer.byteLength(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) textBytes(x, acc);
    return;
  }
  if (typeof node === "object") {
    const t = node.type;
    if (t === "image" || t === "image_url" || t === "input_image") {
      acc.media += IMAGE_TOKENS;
      return;
    }
    if (t === "document" || t === "file" || t === "input_file") {
      acc.media += DOCUMENT_TOKENS;
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "data" && typeof v === "string" && v.length > 2048) continue; // stray base64
      textBytes(v, acc);
    }
  }
}

export function estimateRequest(provider, body, { outputCapTokens = 16000, overrides = {}, unknownRates = null } = {}) {
  const model = body?.model || "";
  const acc = { bytes: 0, media: 0 };
  if (provider === "anthropic") {
    textBytes(body?.system, acc);
    textBytes(body?.messages, acc);
    textBytes(body?.tools, acc);
  } else {
    textBytes(body?.messages, acc);
    textBytes(body?.input, acc);
    textBytes(body?.instructions, acc);
    textBytes(body?.tools, acc);
  }
  const inputTokens = Math.ceil(acc.bytes / 3) + acc.media;
  const requested = Number(body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens);
  const outputTokens = Math.min(Number.isFinite(requested) && requested > 0 ? requested : outputCapTokens, outputCapTokens);
  const { price: base, source, unknown, model: canon } = lookupPrice(provider, model, overrides, unknownRates);
  const price = base.long && base.longThreshold && inputTokens > base.longThreshold ? base.long : base;
  const usd = (inputTokens * price.input + outputTokens * price.output) / 1e6;
  return { usd: round6(usd), inputTokens, outputTokens, model: canon, priceSource: source, unknownModel: Boolean(unknown) };
}
