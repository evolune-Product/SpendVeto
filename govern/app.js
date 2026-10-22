// HTTP surface of the Governance API (/v1). Server-to-server: no CORS, JSON
// only, small bodies. Every route is tenant-scoped through its API key; a
// resource belonging to another tenant answers 404, never 403, so ids cannot
// be probed across tenants.
import express from "express";
import { z } from "zod";
import { requireOperator, resolveKey, hasScope, SCOPES } from "./auth.js";
import { createEngine } from "./engine.js";
import { createAdmin, createTenant, mintKeyForTenant } from "./admin.js";
import { verifyChain } from "./audit.js";
import { isUnavailable } from "./db.js";
import { GovernError } from "./util.js";

const MAX_CALL_MICROS = 1_000_000_000_000; // $1,000,000 for one call: anything larger is a bug upstream
const MAX_CAP_MICROS = 1_000_000_000_000_000; // $1,000,000,000

const externalId = z.string().regex(/^[A-Za-z0-9._:@-]{1,200}$/, "use 1-200 characters from A-Z a-z 0-9 . _ : @ -");
const micros = (max) => z.number().int().min(0).max(max);
// Metadata is flat and float-free so it hashes identically after a JSONB
// round trip (it is part of the idempotency fingerprint).
const metadata = z
  .record(z.string().max(64), z.union([z.string().max(1000), z.number().int().refine(Number.isSafeInteger), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 32, "at most 32 metadata keys")
  .refine((m) => JSON.stringify(m).length <= 4096, "metadata must serialize to at most 4096 characters");
const noNul = (s) => !s.includes("\u0000");
const shortText = (n) => z.string().max(n).refine(noNul, "must not contain NUL");

const authorizeSchema = z.strictObject({
  budget: externalId,
  estimate_micros: micros(MAX_CALL_MICROS),
  idempotency_key: z.string().min(1).max(200).optional(),
  operation: shortText(120).optional(),
  provider: shortText(120).optional(),
  model: shortText(200).optional(),
  metadata: metadata.optional(),
  ttl_seconds: z.number().int().min(10).max(86400).default(900),
  approval_ttl_seconds: z.number().int().min(30).max(604800).default(3600),
});

const settleSchema = z.strictObject({
  actual_micros: micros(MAX_CALL_MICROS),
  input_tokens: z.number().int().min(0).max(1e9).optional(),
  output_tokens: z.number().int().min(0).max(1e9).optional(),
  metadata: metadata.optional(),
});

const decideSchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  actor: shortText(200).min(1).optional(),
  reason: shortText(1000).optional(),
});

const budgetFields = {
  parent: externalId.nullable().optional(),
  kind: shortText(40).nullable().optional(),
  label: shortText(200).nullable().optional(),
  cap_micros: micros(MAX_CAP_MICROS).nullable().optional(),
  period: z.enum(["total", "hour", "day", "week", "month"]).nullable().optional(),
  per_call_max_micros: micros(MAX_CAP_MICROS).nullable().optional(),
  approval_above_micros: micros(MAX_CAP_MICROS).nullable().optional(),
  approvals_required: z.number().int().min(1).max(10).nullable().optional(),
  max_calls_per_period: z.number().int().min(1).max(1e9).nullable().optional(),
  burst_per_minute: z.number().int().min(1).max(1e6).nullable().optional(),
  metadata: metadata.nullable().optional(),
};
const budgetSchema = z.strictObject(budgetFields);
const syncSchema = z.strictObject({
  budgets: z.array(z.strictObject({ budget: externalId, ...budgetFields })).min(1).max(500),
});

const freezeSchema = z.strictObject({ reason: shortText(500).optional() });
const webhookSchema = z.strictObject({ url: z.string().max(2000).nullable(), rotate_secret: z.boolean().optional() });
const keySchema = z.strictObject({ scopes: z.array(z.enum(SCOPES)).min(1), label: shortText(120).optional() });
const tenantSchema = z.strictObject({ name: shortText(200).min(1) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse(schema, value) {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new GovernError(400, "invalid_request", "request body failed validation", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

function uuidParam(req, name, code) {
  const v = req.params[name];
  if (!UUID.test(v)) throw new GovernError(404, code, `no such ${code.replace("unknown_", "")} in this tenant`);
  return v.toLowerCase();
}

// Per-key request budget (per process). Protects the database from a client
// stuck in a retry loop; it is not the spend control — budgets are.
function rateLimiter(perSecond) {
  const buckets = new Map();
  setInterval(() => buckets.clear(), 60_000).unref();
  return (req, res, next) => {
    const sec = Math.floor(Date.now() / 1000);
    const key = req.auth.keyId;
    const b = buckets.get(key);
    if (!b || b.sec !== sec) {
      buckets.set(key, { sec, n: 1 });
      return next();
    }
    if (++b.n > perSecond) {
      res.set("Retry-After", "1");
      return res.status(429).json({ ok: false, code: "rate_limited", error: `more than ${perSecond} requests per second on this key` });
    }
    next();
  };
}

export function createGovernApp({ pool, now, rateLimitPerSecond } = {}) {
  const engine = createEngine({ pool, now });
  const admin = createAdmin({ pool, now });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  const limiter = rateLimiter(rateLimitPerSecond || Number(process.env.GOVERN_RATE_LIMIT_PER_SEC) || 200);

  // Any of the listed scopes is enough (admin always is).
  const scope = (...scopes) => async (req, res, next) => {
    try {
      const h = req.get("Authorization") || "";
      const m = /^Bearer\s+(\S+)$/i.exec(h);
      const auth = await resolveKey(pool, m ? m[1] : null);
      if (!auth) return res.status(401).json({ ok: false, code: "unauthorized", error: "send Authorization: Bearer <svk_ key>" });
      if (!scopes.some((s) => hasScope(auth, s))) {
        return res.status(403).json({ ok: false, code: "insufficient_scope", error: `this endpoint needs one of: ${scopes.join(", ")}; this key has: ${auth.scopes.join(", ")}` });
      }
      req.auth = auth;
      limiter(req, res, next);
    } catch (err) {
      next(err);
    }
  };

  const send = (fn) => async (req, res, next) => {
    try {
      const { status, body } = await fn(req);
      res.status(status).json(body);
    } catch (err) {
      next(err);
    }
  };

  const r = express.Router();

  r.get("/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, service: "spendveto-govern", db: "up" });
    } catch {
      res.status(503).json({ ok: false, service: "spendveto-govern", db: "down" });
    }
  });

  // Spend path
  r.post("/authorize", scope("spend"), send((req) => {
    const body = { ...(req.body || {}) };
    const headerKey = req.get("Idempotency-Key");
    if (headerKey && !body.idempotency_key) body.idempotency_key = headerKey;
    return engine.authorize(req.auth, parse(authorizeSchema, body));
  }));
  r.post("/reservations/:id/settle", scope("spend"), send((req) =>
    engine.settle(req.auth, uuidParam(req, "id", "unknown_reservation"), parse(settleSchema, req.body))));
  r.post("/reservations/:id/void", scope("spend"), send((req) =>
    engine.voidReservation(req.auth, uuidParam(req, "id", "unknown_reservation"))));
  r.get("/reservations/:id", scope("read", "spend"), send((req) =>
    admin.getReservation(req.auth, uuidParam(req, "id", "unknown_reservation"))));
  r.get("/reservations", scope("read"), send((req) => admin.listReservations(req.auth, req.query)));

  // Approvals
  r.get("/approvals", scope("read", "approve", "approve_as"), send((req) => admin.listApprovals(req.auth, req.query)));
  r.get("/approvals/:id", scope("read", "approve", "approve_as", "spend"), send((req) =>
    admin.getApproval(req.auth, uuidParam(req, "id", "unknown_approval"))));
  r.post("/approvals/:id/decide", scope("approve", "approve_as"), send((req) =>
    engine.decideApproval(req.auth, uuidParam(req, "id", "unknown_approval"), parse(decideSchema, req.body))));

  // Budgets
  r.post("/budgets/sync", scope("manage"), send((req) => admin.syncBudgets(req.auth, parse(syncSchema, req.body).budgets)));
  r.get("/budgets", scope("read"), send((req) => admin.listBudgets(req.auth, { include_archived: req.query.include_archived === "true" })));
  r.get("/budgets/:budget", scope("read", "spend"), send((req) => admin.getBudget(req.auth, parse(externalId, req.params.budget))));
  r.put("/budgets/:budget", scope("manage"), send((req) => admin.upsertBudget(req.auth, parse(externalId, req.params.budget), parse(budgetSchema, req.body))));
  r.delete("/budgets/:budget", scope("manage"), send((req) => admin.archiveBudget(req.auth, parse(externalId, req.params.budget))));
  r.post("/budgets/:budget/freeze", scope("manage"), send((req) =>
    engine.setFrozen(req.auth, parse(externalId, req.params.budget), { frozen: true, reason: parse(freezeSchema, req.body).reason })));
  r.post("/budgets/:budget/unfreeze", scope("manage"), send((req) =>
    engine.setFrozen(req.auth, parse(externalId, req.params.budget), { frozen: false })));

  // Reports + audit
  r.get("/usage", scope("read"), send((req) => {
    const at = engine.now();
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const to = req.query.to ? new Date(req.query.to) : new Date(at.getTime() + 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new GovernError(400, "invalid_range", "from and to must be ISO timestamps with from < to");
    }
    return admin.usage(req.auth, {
      from, to,
      budget: req.query.budget ? parse(externalId, req.query.budget) : null,
      include_descendants: req.query.include_descendants === "true",
      group_by: req.query.group_by || "budget",
    });
  }));
  r.get("/events", scope("read"), send((req) => admin.listEvents(req.auth, req.query)));
  r.get("/events/verify", scope("read"), send(async (req) => ({ status: 200, body: { ok: true, ...(await verifyChain(pool, req.auth.tenantId)) } })));

  // Tenant + keys
  r.get("/tenant", scope("read"), send((req) => admin.getTenant(req.auth)));
  r.put("/tenant/webhook", scope("admin"), send((req) => admin.setWebhook(req.auth, parse(webhookSchema, req.body))));
  r.post("/keys", scope("admin"), send((req) => admin.createKey(req.auth, parse(keySchema, req.body))));
  r.get("/keys", scope("admin"), send((req) => admin.listKeys(req.auth)));
  r.delete("/keys/:id", scope("admin"), send((req) => admin.revokeKey(req.auth, uuidParam(req, "id", "unknown_key"))));

  // Operator (deploy-time secret; disabled unless SPENDVETO_OPERATOR_KEY is set)
  r.post("/operator/tenants", requireOperator(), send(async (req) => ({ status: 201, body: { ok: true, ...(await createTenant(pool, parse(tenantSchema, req.body))) } })));
  r.post("/operator/tenants/:id/keys", requireOperator(), send(async (req) => {
    const key = await mintKeyForTenant(pool, uuidParam(req, "id", "unknown_tenant"), parse(keySchema, req.body));
    return { status: 201, body: { ok: true, ...key } };
  }));

  app.use("/v1", r);

  app.use((req, res) => res.status(404).json({ ok: false, code: "not_found", error: `no route ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof GovernError) return res.status(err.status).json({ ok: false, code: err.code, error: err.message, ...err.extra });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ ok: false, code: "invalid_json", error: "body is not valid JSON" });
    if (err?.type === "entity.too.large") return res.status(413).json({ ok: false, code: "body_too_large", error: "request body exceeds 64kb" });
    if (isUnavailable(err)) {
      // Fail closed: the caller must treat this exactly like a refusal.
      return res.status(503).json({ ok: false, code: "governance_unavailable", error: "spend governance is temporarily unavailable; do not proceed with the spend" });
    }
    console.error("[govern] unhandled error:", err);
    res.status(500).json({ ok: false, code: "internal_error", error: "internal error; the spend was not authorized" });
  });

  return { app, engine, admin };
}
