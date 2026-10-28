// Per-client rate limit for the API (/api/*): a token bucket per client IP,
// dependency-free like the rest of the server. The LLM guard keeps its own
// per-agent limit (policy.llm.maxRequestsPerMinute); this one is about the
// endpoints anyone can reach — a scripted client hammering the ledger, the
// evaluators or the approval queue gets a 429 instead of the server's time.
//
// Not limited: loopback callers — the agents, tools and test suite on this
// host already run with the operator's trust — and the card-network webhooks,
// which are signature-verified and must never be declined for volume. The
// client IP is req.ip, so it's only as honest as the "trust proxy" setting
// (server/index.js): believed from a proxy on this machine, not from anyone.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const EXEMPT = /^\/api\/cards\/(stripe\/authorization|lithic\/asa)$/;

export function createRateLimiter({ perMinute = 600, burst = Math.max(20, Math.floor(perMinute / 6)) } = {}) {
  const buckets = new Map(); // ip -> { tokens, at }
  const perMs = perMinute / 60e3;
  return (req, res, next) => {
    if (!(perMinute > 0) || !req.path.startsWith("/api/") || EXEMPT.test(req.path) || LOOPBACK.has(req.ip)) return next();
    const now = Date.now();
    if (buckets.size > 10000) for (const [ip, b] of buckets) if (now - b.at > 10 * 60e3) buckets.delete(ip);
    const b = buckets.get(req.ip) || { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) * perMs);
    b.at = now;
    buckets.set(req.ip, b);
    if (b.tokens < 1) {
      const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ code: "rate_limited", error: `more than ${perMinute} requests a minute from this client — retry after ${retryAfter}s` });
    }
    b.tokens -= 1;
    next();
  };
}
