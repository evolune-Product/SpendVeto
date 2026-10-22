// The Governance API's decision engine: reserve-then-settle spend control.
//
//   authorize  reserve the worst-case cost against every budget from the leaf
//              to the root, or refuse with a code + suggestion
//   settle     replace the reservation with the actual cost
//   void       release a reservation that was never used
//
// Correctness under concurrency comes from row locks, not from a process-
// local mutex: every decision locks the budget rows it reads, in a fixed
// order, inside one transaction. Two server processes (or twenty) sharing one
// database therefore cannot both pass a cap that only has room for one.
//
// LOCK ORDER — every code path acquires locks in this order and never the
// reverse, which is what keeps it deadlock-free:
//   reservation row → approval row → budget rows (sorted by id) → audit lock
// The audit lock (appendEvent) is always last, so nothing that holds it ever
// waits on a row lock.
import { randomUUID } from "node:crypto";
import { withTx } from "./db.js";
import { appendEvent } from "./audit.js";
import { enqueueWebhook } from "./webhooks.js";
import { hasScope } from "./auth.js";
import { GovernError, canonical, sha256, windowStart, minuteStart, addSeconds, iso, usd } from "./util.js";

const MAX_DEPTH = 16;
const THRESHOLDS = [50, 80, 100];

function deny(code, reason, suggestion, budget) {
  return { code, reason, suggestion, budget };
}

// ---------------------------------------------------------------------------
// Budget chain locking

async function lockBudgetsById(client, ids) {
  if (!ids.length) return new Map();
  const { rows } = await client.query(
    "SELECT * FROM sv_budgets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [[...new Set(ids)].sort()]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// Returns the locked chain [leaf, parent, ..., root]. The ancestor ids are read
// first without locks, then locked in id order; if a concurrent reparent moved
// the chain in between, the walk notices a missing parent and retries.
async function lockChain(client, tenantId, leafId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await client.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, 1 AS depth FROM sv_budgets WHERE id = $1 AND tenant_id = $2
         UNION ALL
         SELECT b.id, b.parent_id, up.depth + 1 FROM sv_budgets b JOIN up ON b.id = up.parent_id
         WHERE up.depth < $3
       ) SELECT id FROM up`,
      [leafId, tenantId, MAX_DEPTH + 1]
    );
    const locked = await lockBudgetsById(client, rows.map((r) => r.id));
    const chain = [];
    let cur = locked.get(leafId);
    let consistent = Boolean(cur);
    while (cur) {
      chain.push(cur);
      if (!cur.parent_id) break;
      const next = locked.get(cur.parent_id);
      if (!next || chain.length > MAX_DEPTH) {
        consistent = false;
        break;
      }
      cur = next;
    }
    if (consistent) return chain;
  }
  throw new GovernError(409, "budget_tree_changed", "the budget tree changed repeatedly during this request; retry");
}

async function windowRow(client, budget, at) {
  const ws = windowStart(budget.period, at);
  await client.query(
    "INSERT INTO sv_budget_windows (budget_id, window_start) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [budget.id, ws]
  );
  const { rows } = await client.query(
    "SELECT * FROM sv_budget_windows WHERE budget_id = $1 AND window_start = $2",
    [budget.id, ws]
  );
  return rows[0];
}

function remainingOf(budget, w) {
  if (budget.cap_micros == null) return null;
  return Math.max(0, budget.cap_micros - w.spent_micros - w.reserved_micros);
}

// Fires 50/80/100% alerts once per window, measured on committed spend
// (settled + reserved) so the warning arrives before the cap refuses a call.
async function checkThresholds(client, tenantId, budget, w, at) {
  if (budget.cap_micros == null || budget.cap_micros === 0) return;
  const committed = w.spent_micros + w.reserved_micros;
  const pct = Math.floor((committed * 100) / budget.cap_micros);
  const crossed = THRESHOLDS.filter((t) => t > w.alerted_pct && pct >= t);
  if (!crossed.length) return;
  const top = crossed[crossed.length - 1];
  await client.query("UPDATE sv_budget_windows SET alerted_pct = $3 WHERE budget_id = $1 AND window_start = $2", [budget.id, w.window_start, top]);
  const payload = {
    budget: budget.external_id,
    threshold_pct: top,
    window_start: iso(w.window_start),
    period: budget.period,
    cap_micros: budget.cap_micros,
    spent_micros: w.spent_micros,
    reserved_micros: w.reserved_micros,
  };
  await enqueueWebhook(client, tenantId, "budget.threshold", payload);
  return { budget, payload };
}

// Reverses the holds a reservation placed. Caller must hold the reservation
// row lock; this takes the budget locks (in order).
async function releaseHolds(client, reservation) {
  const holds = reservation.holds || [];
  if (!holds.length) return;
  await lockBudgetsById(client, holds.map((h) => h.budget_id));
  for (const h of holds) {
    await client.query(
      "UPDATE sv_budget_windows SET reserved_micros = reserved_micros - $3 WHERE budget_id = $1 AND window_start = $2",
      [h.budget_id, h.window_start, h.amount]
    );
  }
}

function reservationView(r, extra = {}) {
  return {
    reservation_id: r.id,
    status: r.status,
    decision: r.decision,
    estimate_micros: r.estimate_micros,
    actual_micros: r.actual_micros,
    operation: r.operation,
    provider: r.provider,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    approval_id: r.approval_id,
    expires_at: iso(r.expires_at),
    late_settle: r.late_settle,
    created_at: iso(r.created_at),
    resolved_at: iso(r.resolved_at),
    metadata: r.metadata,
    // Refused by policy at authorize time, or later by a human approver.
    ...(r.deny_code ? { denial: { code: r.deny_code, reason: r.deny_reason, suggestion: r.deny_suggestion, budget: r.deny_budget } } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------

export function createEngine({ pool, now = () => new Date() }) {
  // ------------------------------------------------------------------ authorize
  async function authorize(auth, input) {
    const fingerprint = sha256(
      canonical({
        budget: input.budget,
        estimate_micros: input.estimate_micros,
        operation: input.operation ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        metadata: input.metadata ?? {},
        ttl_seconds: input.ttl_seconds,
        approval_ttl_seconds: input.approval_ttl_seconds,
      })
    );
    try {
      return await withTx(pool, (client) => authorizeTx(client, auth, input, fingerprint));
    } catch (err) {
      // Two requests with the same idempotency key on DIFFERENT budgets don't
      // serialize on a budget lock, so the second one loses on the unique
      // index instead. Answer it exactly as if it had arrived second.
      if (err.code === "23505" && err.constraint === "sv_reservations_idem_unique") {
        const { rows } = await pool.query("SELECT * FROM sv_reservations WHERE tenant_id = $1 AND idempotency_key = $2", [auth.tenantId, input.idempotency_key]);
        if (rows[0]) return replay(rows[0], fingerprint);
      }
      throw err;
    }
  }

  function replay(existing, fingerprint) {
    if (existing.request_hash !== fingerprint) {
      throw new GovernError(409, "idempotency_conflict", "this idempotency key was already used for a different request", { reservation_id: existing.id });
    }
    // A replay must describe the reservation as it stands NOW, not as it was
    // first decided: an "allow" whose hold has since been voided or expired
    // reserves nothing, and answering 201 would let a retry spend uncapped.
    if (existing.status === "denied") {
      return {
        status: 403,
        body: { ok: false, ...reservationView(existing), decision: "deny", code: existing.deny_code, reason: existing.deny_reason,
          suggestion: existing.deny_suggestion, budget: existing.deny_budget, replayed: true },
      };
    }
    if (existing.status === "voided" || existing.status === "expired") {
      throw new GovernError(409, `reservation_${existing.status}`,
        `this idempotency key belongs to a reservation that is ${existing.status}; nothing is held for it — use a new key`,
        { reservation_id: existing.id });
    }
    const status = existing.status === "pending_approval" ? 202 : 201;
    return { status, body: { ok: true, ...reservationView(existing), replayed: true } };
  }

  async function authorizeTx(client, auth, input, fingerprint) {
    const at = now();
    const tenantId = auth.tenantId;

    const { rows: leafRows } = await client.query(
      "SELECT id FROM sv_budgets WHERE tenant_id = $1 AND external_id = $2",
      [tenantId, input.budget]
    );
    if (!leafRows[0]) {
      throw new GovernError(404, "unknown_budget", `no budget "${input.budget}" in this tenant`, {
        suggestion: "create it with PUT /v1/budgets/{external_id} before spending against it",
      });
    }
    const chain = await lockChain(client, tenantId, leafRows[0].id);

    // Checked after the chain lock: a concurrent request with the same key on
    // the same budget has committed by now, so this read sees it.
    if (input.idempotency_key) {
      const { rows } = await client.query(
        "SELECT * FROM sv_reservations WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantId, input.idempotency_key]
      );
      if (rows[0]) return replay(rows[0], fingerprint);
    }

    const est = input.estimate_micros;
    let refusal = null;
    const events = [];

    for (const b of chain) {
      if (b.archived_at) {
        refusal = deny("budget_archived", `budget "${b.external_id}" is archived`, "spend against an active budget", b.external_id);
        break;
      }
    }
    if (!refusal) {
      for (const b of chain) {
        if (b.frozen_at) {
          const scope = b.id === chain[0].id ? "this budget" : `ancestor budget "${b.external_id}"`;
          refusal = deny("budget_frozen", `${scope} is frozen (${b.frozen_source}): ${b.frozen_reason}`,
            "do not retry; a human must review why it was frozen and unfreeze it", b.external_id);
          break;
        }
      }
    }
    if (!refusal) {
      for (const b of chain) {
        if (b.per_call_max_micros != null && est > b.per_call_max_micros) {
          refusal = deny("per_call_cap", `estimate ${usd(est)} exceeds the per-call limit ${usd(b.per_call_max_micros)} on "${b.external_id}"`,
            `reduce max output tokens or use a cheaper model so the worst case is at most ${usd(b.per_call_max_micros)}`, b.external_id);
          break;
        }
      }
    }
    // Burst detection counts ATTEMPTS, refused or not: a runaway loop that is
    // being refused is still a runaway loop.
    if (!refusal) {
      const minute = minuteStart(at);
      for (const b of chain) {
        if (b.burst_per_minute == null) continue;
        const { rows } = await client.query(
          `INSERT INTO sv_burst_counters (budget_id, minute_start, attempts) VALUES ($1, $2, 1)
           ON CONFLICT (budget_id, minute_start) DO UPDATE SET attempts = sv_burst_counters.attempts + 1
           RETURNING attempts`,
          [b.id, minute]
        );
        if (rows[0].attempts > b.burst_per_minute) {
          const reason = `auto-frozen: ${rows[0].attempts} spend attempts in one minute (limit ${b.burst_per_minute})`;
          await client.query(
            "UPDATE sv_budgets SET frozen_at = $2, frozen_reason = $3, frozen_source = 'burst', updated_at = $2 WHERE id = $1",
            [b.id, at, reason]
          );
          await enqueueWebhook(client, tenantId, "budget.frozen", { budget: b.external_id, source: "burst", reason, at: iso(at) });
          events.push({ type: "budget.frozen", budgetId: b.id, data: { budget: b.external_id, source: "burst", reason } });
          refusal = deny("burst_frozen", `"${b.external_id}" was frozen for runaway spend (${rows[0].attempts} attempts in a minute)`,
            "stop retrying; this looks like a loop. A human must unfreeze the budget after reviewing it", b.external_id);
          break;
        }
      }
    }

    const windows = new Map();
    if (!refusal) {
      for (const b of chain) windows.set(b.id, await windowRow(client, b, at));
      for (const b of chain) {
        const w = windows.get(b.id);
        if (b.max_calls_per_period != null && w.calls + 1 > b.max_calls_per_period) {
          refusal = deny("call_limit", `"${b.external_id}" allows ${b.max_calls_per_period} calls per ${b.period}; ${w.calls} used`,
            `wait for the ${b.period} window to roll over, or ask an owner to raise max_calls_per_period`, b.external_id);
          break;
        }
        if (b.cap_micros != null && w.spent_micros + w.reserved_micros + est > b.cap_micros) {
          const left = remainingOf(b, w);
          const scope = b.id === chain[0].id ? "" : `, a parent of "${chain[0].external_id}"`;
          refusal = deny("budget_cap", `estimate ${usd(est)} exceeds what is left on "${b.external_id}"${scope}: ${usd(left)} of ${usd(b.cap_micros)} per ${b.period}`,
            left > 0 ? `the worst case must be at most ${usd(left)}: reduce max tokens, use a cheaper model, or request a larger budget`
              : `this ${b.period}'s budget is used up; wait for the window to roll over or request a larger budget`, b.external_id);
          break;
        }
      }
    }

    const common = {
      tenantId,
      budgetId: chain[0].id,
      idem: input.idempotency_key || null,
      fingerprint,
      est,
      operation: input.operation ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      metadata: input.metadata ?? {},
      ttl: input.ttl_seconds,
      at,
    };

    if (refusal) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO sv_reservations (id, tenant_id, budget_id, idempotency_key, request_hash, status, decision,
           deny_code, deny_reason, deny_suggestion, deny_budget, estimate_micros, operation, provider, model, metadata,
           ttl_seconds, created_at, resolved_at, created_by_key)
         VALUES ($1,$2,$3,$4,$5,'denied','deny',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17)`,
        [id, tenantId, common.budgetId, common.idem, fingerprint, refusal.code, refusal.reason, refusal.suggestion, refusal.budget,
          est, common.operation, common.provider, common.model, common.metadata, common.ttl, at, auth.keyId]
      );
      for (const e of events) await appendEvent(client, tenantId, { ...e, actor: `key:${auth.keyId}`, at });
      await appendEvent(client, tenantId, {
        type: "reservation.denied", reservationId: id, budgetId: common.budgetId, amountMicros: est, actor: `key:${auth.keyId}`,
        data: { budget: input.budget, code: refusal.code, at_budget: refusal.budget }, at,
      });
      return {
        status: 403,
        body: { ok: false, decision: "deny", reservation_id: id, code: refusal.code, reason: refusal.reason, suggestion: refusal.suggestion, budget: refusal.budget, estimate_micros: est },
      };
    }

    // Allowed (possibly pending a human). Reserve the estimate on every level.
    const approvers = chain.filter((b) => b.approval_above_micros != null && est > b.approval_above_micros);
    const needsApproval = approvers.length > 0;
    const required = needsApproval ? Math.max(...approvers.map((b) => b.approvals_required)) : 0;
    const holds = [];
    for (const b of chain) {
      const w = windows.get(b.id);
      const { rows } = await client.query(
        `UPDATE sv_budget_windows SET reserved_micros = reserved_micros + $3, calls = calls + 1
         WHERE budget_id = $1 AND window_start = $2 RETURNING *`,
        [b.id, w.window_start, est]
      );
      windows.set(b.id, rows[0]);
      holds.push({ budget_id: b.id, window_start: iso(w.window_start), amount: est });
    }

    const id = randomUUID();
    const approvalId = needsApproval ? randomUUID() : null;
    const expiresAt = needsApproval ? addSeconds(at, input.approval_ttl_seconds) : addSeconds(at, input.ttl_seconds);
    await client.query(
      `INSERT INTO sv_reservations (id, tenant_id, budget_id, idempotency_key, request_hash, status, decision,
         estimate_micros, holds, operation, provider, model, metadata, approval_id, ttl_seconds, expires_at, created_at, created_by_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, tenantId, common.budgetId, common.idem, fingerprint, needsApproval ? "pending_approval" : "held",
        needsApproval ? "needs_approval" : "allow", est, JSON.stringify(holds), common.operation, common.provider, common.model,
        common.metadata, approvalId, input.ttl_seconds, expiresAt, at, auth.keyId]
    );
    if (needsApproval) {
      await client.query(
        `INSERT INTO sv_approvals (id, tenant_id, reservation_id, status, required_approvals, expires_at, created_at)
         VALUES ($1,$2,$3,'pending',$4,$5,$6)`,
        [approvalId, tenantId, id, required, expiresAt, at]
      );
      await enqueueWebhook(client, tenantId, "approval.requested", {
        approval_id: approvalId, reservation_id: id, budget: input.budget, estimate_micros: est, required_approvals: required,
        triggered_by: approvers.map((b) => b.external_id), operation: common.operation, model: common.model,
        metadata: common.metadata, expires_at: iso(expiresAt),
      });
    }

    const alerts = [];
    for (const b of chain) {
      const fired = await checkThresholds(client, tenantId, b, windows.get(b.id), at);
      if (fired) alerts.push(fired);
    }

    await appendEvent(client, tenantId, {
      type: "reservation.authorized", reservationId: id, budgetId: common.budgetId, amountMicros: est, actor: `key:${auth.keyId}`,
      data: { budget: input.budget, decision: needsApproval ? "needs_approval" : "allow", levels: chain.length }, at,
    });
    if (needsApproval) {
      await appendEvent(client, tenantId, {
        type: "approval.requested", reservationId: id, budgetId: common.budgetId, amountMicros: est,
        data: { approval_id: approvalId, required_approvals: required }, at,
      });
    }
    for (const a of alerts) {
      await appendEvent(client, tenantId, { type: "budget.threshold", budgetId: a.budget.id, data: { budget: a.budget.external_id, threshold_pct: a.payload.threshold_pct }, at });
    }

    const budgets = chain.map((b) => ({ budget: b.external_id, remaining_micros: remainingOf(b, windows.get(b.id)), period: b.period }));
    if (needsApproval) {
      return {
        status: 202,
        body: { ok: true, decision: "needs_approval", reservation_id: id, approval_id: approvalId, required_approvals: required,
          approval_expires_at: iso(expiresAt), estimate_micros: est, budgets },
      };
    }
    return { status: 201, body: { ok: true, decision: "allow", reservation_id: id, expires_at: iso(expiresAt), estimate_micros: est, budgets } };
  }

  // ------------------------------------------------------------------ settle
  async function settle(auth, reservationId, input) {
    return withTx(pool, async (client) => {
      const at = now();
      const { rows } = await client.query(
        "SELECT * FROM sv_reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [reservationId, auth.tenantId]
      );
      const r = rows[0];
      if (!r) throw new GovernError(404, "unknown_reservation", "no such reservation in this tenant");
      const actual = input.actual_micros;

      if (r.status === "settled") {
        if (r.actual_micros === actual) return { status: 200, body: { ok: true, ...reservationView(r), replayed: true } };
        throw new GovernError(409, "already_settled", `reservation was already settled at ${usd(r.actual_micros)}`);
      }
      if (r.status === "pending_approval") throw new GovernError(409, "approval_pending", "this reservation is still waiting for a human approval; it must not have been spent");
      if (r.status === "denied") throw new GovernError(409, "reservation_denied", "this reservation was refused; nothing may be settled against it");
      if (r.status === "voided") throw new GovernError(409, "reservation_voided", "this reservation was voided");
      // An expired reservation that needed a human and never got one was never
      // authorized at all. Refuse it, and record the attempt: a caller that
      // reaches this point spent money it was not allowed to.
      if (r.status === "expired" && r.approval_id) {
        const { rows: ap } = await client.query("SELECT status FROM sv_approvals WHERE id = $1", [r.approval_id]);
        if (ap[0]?.status !== "approved") {
          await appendEvent(client, auth.tenantId, {
            type: "settle.refused_unapproved", reservationId: r.id, budgetId: r.budget_id, amountMicros: actual,
            actor: `key:${auth.keyId}`, data: { approval_status: ap[0]?.status || null }, at,
          });
          return {
            status: 409,
            body: { ok: false, code: "approval_not_granted", error: "this spend needed a human approval that was never granted; it cannot be settled, and the attempt was recorded in the audit log" },
          };
        }
      }

      // held → normal settle. expired → the hold was already released, but the
      // money was really spent at the provider: book it, and say it was late.
      const late = r.status === "expired" || (r.expires_at && at > r.expires_at);
      const holds = r.holds || [];
      const locked = await lockBudgetsById(client, holds.map((h) => h.budget_id));
      for (const h of holds) {
        await client.query(
          `UPDATE sv_budget_windows SET reserved_micros = reserved_micros - $3, spent_micros = spent_micros + $4
           WHERE budget_id = $1 AND window_start = $2`,
          [h.budget_id, h.window_start, r.status === "held" ? h.amount : 0, actual]
        );
      }
      const metadata = input.metadata ? { ...r.metadata, settle: input.metadata } : r.metadata;
      const { rows: updated } = await client.query(
        `UPDATE sv_reservations SET status = 'settled', actual_micros = $2, input_tokens = $3, output_tokens = $4,
           late_settle = $5, resolved_at = $6, metadata = $7 WHERE id = $1 RETURNING *`,
        [r.id, actual, input.input_tokens ?? null, input.output_tokens ?? null, late, at, metadata]
      );

      const alerts = [];
      for (const h of holds) {
        const b = locked.get(h.budget_id);
        const { rows: w } = await client.query("SELECT * FROM sv_budget_windows WHERE budget_id = $1 AND window_start = $2", [h.budget_id, h.window_start]);
        const fired = await checkThresholds(client, auth.tenantId, b, w[0], at);
        if (fired) alerts.push(fired);
      }
      const overEstimate = actual > r.estimate_micros;
      await appendEvent(client, auth.tenantId, {
        type: late ? "reservation.settled_late" : "reservation.settled", reservationId: r.id, budgetId: r.budget_id, amountMicros: actual,
        actor: `key:${auth.keyId}`, data: { estimate_micros: r.estimate_micros, over_estimate: overEstimate }, at,
      });
      for (const a of alerts) {
        await appendEvent(client, auth.tenantId, { type: "budget.threshold", budgetId: a.budget.id, data: { budget: a.budget.external_id, threshold_pct: a.payload.threshold_pct }, at });
      }
      return { status: 200, body: { ok: true, ...reservationView(updated[0]), over_estimate: overEstimate } };
    });
  }

  // ------------------------------------------------------------------ void
  async function voidReservation(auth, reservationId) {
    return withTx(pool, async (client) => {
      const at = now();
      const { rows } = await client.query("SELECT * FROM sv_reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [reservationId, auth.tenantId]);
      const r = rows[0];
      if (!r) throw new GovernError(404, "unknown_reservation", "no such reservation in this tenant");
      if (r.status === "voided") return { status: 200, body: { ok: true, ...reservationView(r), replayed: true } };
      if (r.status !== "held" && r.status !== "pending_approval") {
        throw new GovernError(409, `reservation_${r.status}`, `a ${r.status} reservation cannot be voided`);
      }
      if (r.approval_id) {
        await client.query("SELECT id FROM sv_approvals WHERE id = $1 FOR UPDATE", [r.approval_id]);
        await client.query("UPDATE sv_approvals SET status = 'cancelled', decided_at = $2 WHERE id = $1 AND status = 'pending'", [r.approval_id, at]);
      }
      await releaseHolds(client, r);
      const { rows: updated } = await client.query("UPDATE sv_reservations SET status = 'voided', resolved_at = $2 WHERE id = $1 RETURNING *", [r.id, at]);
      await appendEvent(client, auth.tenantId, { type: "reservation.voided", reservationId: r.id, budgetId: r.budget_id, amountMicros: r.estimate_micros, actor: `key:${auth.keyId}`, at });
      return { status: 200, body: { ok: true, ...reservationView(updated[0]) } };
    });
  }

  // ------------------------------------------------------------------ approvals
  async function expireApprovalTx(client, tenantId, r, a, at) {
    await releaseHolds(client, r);
    await client.query("UPDATE sv_approvals SET status = 'expired', decided_at = $2 WHERE id = $1", [a.id, at]);
    await client.query("UPDATE sv_reservations SET status = 'expired', resolved_at = $2 WHERE id = $1", [r.id, at]);
    await enqueueWebhook(client, tenantId, "approval.decided", { approval_id: a.id, reservation_id: r.id, status: "expired", at: iso(at) });
    await appendEvent(client, tenantId, { type: "approval.expired", reservationId: r.id, budgetId: r.budget_id, amountMicros: r.estimate_micros, data: { approval_id: a.id }, at });
  }

  async function decideApproval(auth, approvalId, input) {
    return withTx(pool, async (client) => {
      const at = now();
      const { rows: found } = await client.query("SELECT reservation_id FROM sv_approvals WHERE id = $1 AND tenant_id = $2", [approvalId, auth.tenantId]);
      if (!found[0]) throw new GovernError(404, "unknown_approval", "no such approval in this tenant");
      const { rows: rr } = await client.query("SELECT * FROM sv_reservations WHERE id = $1 FOR UPDATE", [found[0].reservation_id]);
      const { rows: aa } = await client.query("SELECT * FROM sv_approvals WHERE id = $1 FOR UPDATE", [approvalId]);
      const r = rr[0];
      const a = aa[0];
      if (a.status !== "pending") throw new GovernError(409, "approval_not_pending", `this approval is already ${a.status}`, { approval_status: a.status });
      if (at > a.expires_at) {
        await expireApprovalTx(client, auth.tenantId, r, a, at);
        return { status: 409, body: { ok: false, code: "approval_expired", error: "the approval window closed before a decision; the spend was refused (fails closed)" } };
      }
      // Separation of duties, enforced here rather than trusted to the caller:
      // the key that requested a spend can never approve it (this also covers
      // an admin key, which otherwise holds every scope).
      if (input.decision === "approve" && r.created_by_key && r.created_by_key === auth.keyId) {
        throw new GovernError(403, "self_approval", "the key that requested this spend cannot approve it");
      }
      // A named actor is only honoured from a key trusted to vouch for its
      // humans (approve_as). Otherwise the vote IS the key, so filling an
      // N-approver rule takes N different keys.
      if (input.actor && !hasScope(auth, "approve_as")) {
        throw new GovernError(403, "actor_not_allowed", "this key may only vote as itself; naming an actor needs the approve_as scope");
      }
      const actor = input.actor ? input.actor : `key:${auth.keyId}`;
      const approvers = a.approvers || [];
      if (input.decision === "approve" && approvers.some((x) => x.actor === actor && x.decision === "approve")) {
        throw new GovernError(409, "duplicate_approver", `"${actor}" has already approved; ${a.required_approvals} distinct approvers are required`);
      }
      approvers.push({ actor, decision: input.decision, reason: input.reason || null, key_id: auth.keyId, at: iso(at) });

      let approvalStatus = "pending";
      const approvesNow = input.decision === "approve" && approvers.filter((x) => x.decision === "approve").length >= a.required_approvals;
      if (approvesNow) {
        // The kill switch outranks a human's earlier "yes": a budget frozen or
        // archived while this request waited is re-checked before release.
        const chain = await lockChain(client, auth.tenantId, r.budget_id);
        const blocked = chain.find((b) => b.frozen_at || b.archived_at);
        if (blocked) {
          const code = blocked.frozen_at ? "budget_frozen" : "budget_archived";
          await releaseHolds(client, r);
          await client.query(
            `UPDATE sv_reservations SET status = 'denied', deny_code = $2, deny_reason = $3,
               deny_suggestion = 'a human must unfreeze or restore the budget, then request the spend again', deny_budget = $4, resolved_at = $5 WHERE id = $1`,
            [r.id, code, `"${blocked.external_id}" is ${blocked.frozen_at ? "frozen" : "archived"}; the approval could not release the spend`, blocked.external_id, at]
          );
          await client.query(
            "UPDATE sv_approvals SET status = 'denied', approvers = $2, decided_reason = $3, decided_at = $4 WHERE id = $1",
            [a.id, JSON.stringify(approvers), `${code} at approval time`, at]
          );
          await enqueueWebhook(client, auth.tenantId, "approval.decided", { approval_id: a.id, reservation_id: r.id, status: "denied", reason: code, at: iso(at) });
          await appendEvent(client, auth.tenantId, {
            type: "approval.denied", reservationId: r.id, budgetId: r.budget_id, amountMicros: r.estimate_micros, actor,
            data: { approval_id: a.id, reason: code, budget: blocked.external_id }, at,
          });
          return { status: 409, body: { ok: false, code, budget: blocked.external_id, error: `"${blocked.external_id}" was ${blocked.frozen_at ? "frozen" : "archived"} while this request waited; the spend stays refused` } };
        }
      }
      if (input.decision === "deny") {
        approvalStatus = "denied";
        await releaseHolds(client, r);
        await client.query(
          `UPDATE sv_reservations SET status = 'denied', deny_code = 'approval_denied', deny_reason = $2,
             deny_suggestion = 'do not retry the same spend; a human declined it', resolved_at = $3 WHERE id = $1`,
          [r.id, `denied by ${actor}${input.reason ? `: ${input.reason}` : ""}`, at]
        );
      } else if (approvesNow) {
        approvalStatus = "approved";
        // The spend clock starts now: the caller gets the full ttl to use it.
        await client.query("UPDATE sv_reservations SET status = 'held', expires_at = $2 WHERE id = $1", [r.id, addSeconds(at, r.ttl_seconds)]);
      }
      const { rows: updated } = await client.query(
        `UPDATE sv_approvals SET status = $2, approvers = $3, decided_reason = $4, decided_at = CASE WHEN $2 = 'pending' THEN NULL ELSE $5::timestamptz END
         WHERE id = $1 RETURNING *`,
        [a.id, approvalStatus, JSON.stringify(approvers), input.reason || null, at]
      );
      if (approvalStatus !== "pending") {
        await enqueueWebhook(client, auth.tenantId, "approval.decided", { approval_id: a.id, reservation_id: r.id, status: approvalStatus, actor, at: iso(at) });
      }
      await appendEvent(client, auth.tenantId, {
        type: approvalStatus === "pending" ? "approval.vote" : `approval.${approvalStatus}`, reservationId: r.id, budgetId: r.budget_id,
        amountMicros: r.estimate_micros, actor, data: { approval_id: a.id, decision: input.decision, votes: approvers.length }, at,
      });
      return { status: 200, body: { ok: true, approval: approvalView(updated[0]) } };
    });
  }

  // ------------------------------------------------------------------ expiry
  // One reservation per transaction, so the sweeper never holds the audit lock
  // while waiting for a budget row (see LOCK ORDER above).
  async function expireDue({ limit = 200 } = {}) {
    const at = now();
    const { rows } = await pool.query(
      `SELECT id FROM sv_reservations WHERE status IN ('held','pending_approval') AND expires_at < $1 ORDER BY expires_at LIMIT $2`,
      [at, limit]
    );
    let expired = 0;
    for (const { id } of rows) {
      const did = await withTx(pool, async (client) => {
        const { rows: rr } = await client.query("SELECT * FROM sv_reservations WHERE id = $1 FOR UPDATE SKIP LOCKED", [id]);
        const r = rr[0];
        if (!r || !["held", "pending_approval"].includes(r.status) || !(r.expires_at < at)) return false;
        if (r.status === "pending_approval" && r.approval_id) {
          const { rows: aa } = await client.query("SELECT * FROM sv_approvals WHERE id = $1 FOR UPDATE", [r.approval_id]);
          await expireApprovalTx(client, r.tenant_id, r, aa[0], at);
          return true;
        }
        await releaseHolds(client, r);
        await client.query("UPDATE sv_reservations SET status = 'expired', resolved_at = $2 WHERE id = $1", [r.id, at]);
        await appendEvent(client, r.tenant_id, { type: "reservation.expired", reservationId: r.id, budgetId: r.budget_id, amountMicros: r.estimate_micros, at });
        return true;
      });
      if (did) expired++;
    }
    // Housekeeping: burst counters older than an hour are never read again.
    await pool.query("DELETE FROM sv_burst_counters WHERE minute_start < $1", [new Date(at.getTime() - 3600_000)]);
    return expired;
  }

  // ------------------------------------------------------------------ freeze
  async function setFrozen(auth, externalId, { frozen, reason }) {
    return withTx(pool, async (client) => {
      const at = now();
      const { rows } = await client.query("SELECT * FROM sv_budgets WHERE tenant_id = $1 AND external_id = $2 FOR UPDATE", [auth.tenantId, externalId]);
      const b = rows[0];
      if (!b) throw new GovernError(404, "unknown_budget", `no budget "${externalId}" in this tenant`);
      if (frozen && b.frozen_at) return { status: 200, body: { ok: true, budget: budgetView(b), replayed: true } };
      if (!frozen && !b.frozen_at) throw new GovernError(409, "not_frozen", "this budget is not frozen");
      const { rows: updated } = await client.query(
        `UPDATE sv_budgets SET frozen_at = $2, frozen_reason = $3, frozen_source = $4, updated_at = $5 WHERE id = $1 RETURNING *`,
        [b.id, frozen ? at : null, frozen ? reason || "frozen manually" : null, frozen ? "manual" : null, at]
      );
      const type = frozen ? "budget.frozen" : "budget.unfrozen";
      await enqueueWebhook(client, auth.tenantId, type, { budget: externalId, source: frozen ? "manual" : null, reason: frozen ? reason || "frozen manually" : null, at: iso(at) });
      await appendEvent(client, auth.tenantId, { type, budgetId: b.id, actor: `key:${auth.keyId}`, data: { budget: externalId, reason: reason || null }, at });
      return { status: 200, body: { ok: true, budget: budgetView(updated[0]) } };
    });
  }

  return { authorize, settle, voidReservation, decideApproval, expireDue, setFrozen, now };
}

export function approvalView(a) {
  return {
    approval_id: a.id,
    reservation_id: a.reservation_id,
    status: a.status,
    required_approvals: a.required_approvals,
    approvers: a.approvers,
    reason: a.decided_reason,
    expires_at: iso(a.expires_at),
    created_at: iso(a.created_at),
    decided_at: iso(a.decided_at),
  };
}

export function budgetView(b, extra = {}) {
  return {
    budget: b.external_id,
    parent_id: b.parent_id,
    kind: b.kind,
    label: b.label,
    cap_micros: b.cap_micros,
    period: b.period,
    per_call_max_micros: b.per_call_max_micros,
    approval_above_micros: b.approval_above_micros,
    approvals_required: b.approvals_required,
    max_calls_per_period: b.max_calls_per_period,
    burst_per_minute: b.burst_per_minute,
    frozen: Boolean(b.frozen_at),
    frozen_at: iso(b.frozen_at),
    frozen_reason: b.frozen_reason,
    frozen_source: b.frozen_source,
    archived: Boolean(b.archived_at),
    metadata: b.metadata,
    created_at: iso(b.created_at),
    updated_at: iso(b.updated_at),
    ...extra,
  };
}

export { reservationView };
