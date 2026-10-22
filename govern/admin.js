// Budget tree management, reports, tenant settings and key administration.
import { randomBytes } from "node:crypto";
import { withTx } from "./db.js";
import { appendEvent } from "./audit.js";
import { insertKey } from "./auth.js";
import { assertWebhookUrlAllowed } from "./netguard.js";
import { budgetView, reservationView, approvalView } from "./engine.js";
import { GovernError, windowStart, iso } from "./util.js";

const MAX_DEPTH = 16;
const BUDGET_FIELDS = [
  "kind", "label", "cap_micros", "period", "per_call_max_micros", "approval_above_micros",
  "approvals_required", "max_calls_per_period", "burst_per_minute", "metadata",
];

export function createAdmin({ pool, now = () => new Date() }) {
  // ------------------------------------------------------------ budget upsert
  // Fields absent from the input keep their stored value; an explicit null
  // clears it. A caller that only wants to change a cap must not wipe the
  // approval threshold it didn't mention.
  async function upsertBudgetTx(client, auth, externalId, input, at) {
    // Tree-shape changes are serialized per tenant, so two concurrent
    // reparents (A under B, B under A) cannot both pass the cycle check.
    if ("parent" in input) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 11))", [auth.tenantId]);

    const { rows: existingRows } = await client.query(
      "SELECT * FROM sv_budgets WHERE tenant_id = $1 AND external_id = $2 FOR UPDATE",
      [auth.tenantId, externalId]
    );
    const existing = existingRows[0];

    let parentId = existing ? existing.parent_id : null;
    if ("parent" in input) {
      if (input.parent == null) {
        parentId = null;
      } else {
        if (input.parent === externalId) throw new GovernError(409, "budget_cycle", "a budget cannot be its own parent");
        const { rows } = await client.query("SELECT id FROM sv_budgets WHERE tenant_id = $1 AND external_id = $2", [auth.tenantId, input.parent]);
        if (!rows[0]) throw new GovernError(404, "unknown_parent", `no parent budget "${input.parent}" in this tenant`);
        parentId = rows[0].id;
        // Walk up from the new parent: reaching this budget would close a loop.
        const { rows: up } = await client.query(
          `WITH RECURSIVE up AS (
             SELECT id, parent_id, 1 AS depth FROM sv_budgets WHERE id = $1
             UNION ALL SELECT b.id, b.parent_id, up.depth + 1 FROM sv_budgets b JOIN up ON b.id = up.parent_id WHERE up.depth <= $2
           ) SELECT id, depth FROM up`,
          [parentId, MAX_DEPTH + 1]
        );
        if (existing && up.some((r) => r.id === existing.id)) {
          throw new GovernError(409, "budget_cycle", `making "${input.parent}" the parent of "${externalId}" would create a cycle`);
        }
        let subtreeHeight = 1;
        if (existing) {
          const { rows: down } = await client.query(
            `WITH RECURSIVE down AS (
               SELECT id, 1 AS depth FROM sv_budgets WHERE id = $1
               UNION ALL SELECT b.id, down.depth + 1 FROM sv_budgets b JOIN down ON b.parent_id = down.id WHERE down.depth <= $2
             ) SELECT max(depth) AS h FROM down`,
            [existing.id, MAX_DEPTH + 1]
          );
          subtreeHeight = Number(down[0].h) || 1;
        }
        if (up.length + subtreeHeight > MAX_DEPTH) {
          throw new GovernError(422, "budget_too_deep", `budget trees may be at most ${MAX_DEPTH} levels deep`);
        }
      }
    }

    let row;
    let changed;
    if (!existing) {
      const values = {
        kind: input.kind ?? "scope",
        label: input.label ?? "",
        cap_micros: input.cap_micros ?? null,
        period: input.period ?? "month",
        per_call_max_micros: input.per_call_max_micros ?? null,
        approval_above_micros: input.approval_above_micros ?? null,
        approvals_required: input.approvals_required ?? 1,
        max_calls_per_period: input.max_calls_per_period ?? null,
        burst_per_minute: input.burst_per_minute ?? null,
        metadata: input.metadata ?? {},
      };
      const { rows } = await client.query(
        `INSERT INTO sv_budgets (tenant_id, external_id, parent_id, kind, label, cap_micros, period, per_call_max_micros,
           approval_above_micros, approvals_required, max_calls_per_period, burst_per_minute, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
        [auth.tenantId, externalId, parentId, values.kind, values.label, values.cap_micros, values.period, values.per_call_max_micros,
          values.approval_above_micros, values.approvals_required, values.max_calls_per_period, values.burst_per_minute, values.metadata, at]
      );
      row = rows[0];
      changed = ["created"];
    } else {
      const sets = [];
      const params = [existing.id];
      changed = [];
      for (const f of BUDGET_FIELDS) {
        if (!(f in input)) continue;
        let v = input[f];
        if (v === null && ["kind", "label", "period", "approvals_required", "metadata"].includes(f)) {
          v = { kind: "scope", label: "", period: "month", approvals_required: 1, metadata: {} }[f];
        }
        params.push(v);
        sets.push(`${f} = $${params.length}`);
        changed.push(f);
      }
      if ("parent" in input && parentId !== existing.parent_id) {
        params.push(parentId);
        sets.push(`parent_id = $${params.length}`);
        changed.push("parent");
      }
      if (existing.archived_at) {
        sets.push("archived_at = NULL");
        changed.push("restored");
      }
      // Changing the period moves the budget to a different window row. Holds
      // in flight point at the old window and would no longer be counted, so a
      // change is refused while any are open; settled spend is carried into the
      // new window (taking the larger figure, so toggling can never inflate it
      // or reset it to zero) — a month→week switch mid-month must not hand out
      // a fresh allowance.
      const newPeriod = "period" in input ? input.period ?? "month" : existing.period;
      if (newPeriod !== existing.period) {
        const { rows: open } = await client.query(
          `SELECT count(*)::int AS n FROM sv_reservations
           WHERE tenant_id = $1 AND status IN ('held','pending_approval') AND holds @> $2::jsonb`,
          [auth.tenantId, JSON.stringify([{ budget_id: existing.id }])]
        );
        if (open[0].n > 0) {
          throw new GovernError(409, "period_change_with_open_holds",
            `"${externalId}" has ${open[0].n} open reservation(s); settle, void or let them expire before changing the period`);
        }
        const { rows: cur } = await client.query(
          "SELECT spent_micros, calls FROM sv_budget_windows WHERE budget_id = $1 AND window_start = $2",
          [existing.id, windowStart(existing.period, at)]
        );
        if (cur[0]) {
          await client.query(
            `INSERT INTO sv_budget_windows (budget_id, window_start, spent_micros, calls) VALUES ($1, $2, $3, $4)
             ON CONFLICT (budget_id, window_start) DO UPDATE SET
               spent_micros = GREATEST(sv_budget_windows.spent_micros, EXCLUDED.spent_micros),
               calls = GREATEST(sv_budget_windows.calls, EXCLUDED.calls)`,
            [existing.id, windowStart(newPeriod, at), cur[0].spent_micros, cur[0].calls]
          );
        }
      }
      params.push(at);
      sets.push(`updated_at = $${params.length}`);
      const { rows } = await client.query(`UPDATE sv_budgets SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
      row = rows[0];
    }
    // The audit event is returned, not appended: the caller appends it only
    // after every row lock it needs is held (audit lock last — see engine.js).
    const event = {
      type: existing ? "budget.updated" : "budget.created", budgetId: row.id, actor: `key:${auth.keyId}`,
      data: { budget: externalId, fields: changed, cap_micros: row.cap_micros, period: row.period }, at,
    };
    return { row, created: !existing, event };
  }

  async function upsertBudget(auth, externalId, input) {
    return withTx(pool, async (client) => {
      const { row, created, event } = await upsertBudgetTx(client, auth, externalId, input, now());
      await appendEvent(client, auth.tenantId, event);
      return { status: created ? 201 : 200, body: { ok: true, created, budget: budgetView(row) } };
    });
  }

  // Upserts many budgets in one transaction. Parents named in the same payload
  // are created before their children, whatever order they were sent in.
  async function syncBudgets(auth, items) {
    const byId = new Map();
    for (const it of items) {
      if (byId.has(it.budget)) throw new GovernError(400, "duplicate_budget", `"${it.budget}" appears twice in the payload`);
      byId.set(it.budget, it);
    }
    const ordered = [];
    const state = new Map();
    const visit = (id, path) => {
      if (state.get(id) === "done") return;
      if (state.get(id) === "visiting") throw new GovernError(409, "budget_cycle", `the payload's parents form a cycle: ${[...path, id].join(" → ")}`);
      state.set(id, "visiting");
      const it = byId.get(id);
      if (it.parent != null && byId.has(it.parent)) visit(it.parent, [...path, id]);
      state.set(id, "done");
      ordered.push(it);
    };
    for (const id of byId.keys()) visit(id, []);

    return withTx(pool, async (client) => {
      const at = now();
      // Take the tree lock up front, before any budget row lock, so two
      // concurrent syncs always queue in the same order.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 11))", [auth.tenantId]);
      // Lock every existing budget this sync touches in id order — the same
      // order authorize uses — before the topological loop locks them one by
      // one in tree order, which would otherwise invert the order and deadlock.
      await client.query(
        "SELECT id FROM sv_budgets WHERE tenant_id = $1 AND external_id = ANY($2::text[]) ORDER BY id FOR UPDATE",
        [auth.tenantId, ordered.map((it) => it.budget)]
      );
      const results = [];
      const events = [];
      for (const it of ordered) {
        const { budget, ...fields } = it;
        const { row, created, event } = await upsertBudgetTx(client, auth, budget, fields, at);
        results.push({ budget, created });
        events.push(event);
      }
      for (const e of events) await appendEvent(client, auth.tenantId, e);
      return { status: 200, body: { ok: true, count: results.length, budgets: results } };
    });
  }

  async function archiveBudget(auth, externalId) {
    return withTx(pool, async (client) => {
      const at = now();
      const { rows } = await client.query(
        "UPDATE sv_budgets SET archived_at = $3, updated_at = $3 WHERE tenant_id = $1 AND external_id = $2 AND archived_at IS NULL RETURNING *",
        [auth.tenantId, externalId, at]
      );
      if (!rows[0]) {
        const { rows: any } = await client.query("SELECT 1 FROM sv_budgets WHERE tenant_id = $1 AND external_id = $2", [auth.tenantId, externalId]);
        if (!any[0]) throw new GovernError(404, "unknown_budget", `no budget "${externalId}" in this tenant`);
        throw new GovernError(409, "already_archived", "this budget is already archived");
      }
      await appendEvent(client, auth.tenantId, { type: "budget.archived", budgetId: rows[0].id, actor: `key:${auth.keyId}`, data: { budget: externalId }, at });
      return { status: 200, body: { ok: true, budget: budgetView(rows[0]) } };
    });
  }

  // ------------------------------------------------------------ budget reads
  async function currentWindows(budgets, at) {
    if (!budgets.length) return new Map();
    const ids = budgets.map((b) => b.id);
    const starts = budgets.map((b) => windowStart(b.period, at));
    const { rows } = await pool.query(
      `SELECT w.* FROM sv_budget_windows w
       JOIN unnest($1::uuid[], $2::timestamptz[]) AS k(budget_id, window_start)
         ON w.budget_id = k.budget_id AND w.window_start = k.window_start`,
      [ids, starts]
    );
    const map = new Map(rows.map((r) => [r.budget_id, r]));
    return new Map(budgets.map((b, i) => [b.id, map.get(b.id) || { window_start: starts[i], spent_micros: 0, reserved_micros: 0, calls: 0 }]));
  }

  function usageOf(b, w) {
    return {
      window_start: iso(w.window_start),
      spent_micros: w.spent_micros,
      reserved_micros: w.reserved_micros,
      calls: w.calls,
      remaining_micros: b.cap_micros == null ? null : Math.max(0, b.cap_micros - w.spent_micros - w.reserved_micros),
    };
  }

  async function getBudget(auth, externalId) {
    const { rows } = await pool.query("SELECT * FROM sv_budgets WHERE tenant_id = $1 AND external_id = $2", [auth.tenantId, externalId]);
    const b = rows[0];
    if (!b) throw new GovernError(404, "unknown_budget", `no budget "${externalId}" in this tenant`);
    const { rows: chainRows } = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT b.*, 0 AS depth FROM sv_budgets b WHERE id = $1
         UNION ALL SELECT p.*, up.depth + 1 FROM sv_budgets p JOIN up ON p.id = up.parent_id WHERE up.depth < $2
       ) SELECT * FROM up ORDER BY depth`,
      [b.id, MAX_DEPTH]
    );
    const windows = await currentWindows(chainRows, now());
    const { rows: kids } = await pool.query("SELECT external_id FROM sv_budgets WHERE parent_id = $1 AND archived_at IS NULL ORDER BY external_id", [b.id]);
    return {
      status: 200,
      body: {
        ok: true,
        budget: budgetView(b, {
          parent: chainRows[1]?.external_id ?? null,
          usage: usageOf(b, windows.get(b.id)),
          children: kids.map((k) => k.external_id),
          // What actually limits the next call: every level from here to the root.
          chain: chainRows.map((c) => ({ budget: c.external_id, frozen: Boolean(c.frozen_at), cap_micros: c.cap_micros, period: c.period, ...usageOf(c, windows.get(c.id)) })),
        }),
      },
    };
  }

  async function listBudgets(auth, { include_archived = false } = {}) {
    const { rows } = await pool.query(
      `SELECT b.*, p.external_id AS parent_external_id FROM sv_budgets b LEFT JOIN sv_budgets p ON p.id = b.parent_id
       WHERE b.tenant_id = $1 ${include_archived ? "" : "AND b.archived_at IS NULL"} ORDER BY b.external_id LIMIT 5000`,
      [auth.tenantId]
    );
    const windows = await currentWindows(rows, now());
    return { status: 200, body: { ok: true, budgets: rows.map((b) => budgetView(b, { parent: b.parent_external_id, usage: usageOf(b, windows.get(b.id)) })) } };
  }

  // ------------------------------------------------------------ reservations / approvals
  async function getReservation(auth, id) {
    const { rows } = await pool.query(
      `SELECT r.*, b.external_id AS budget_external_id FROM sv_reservations r JOIN sv_budgets b ON b.id = r.budget_id
       WHERE r.id = $1 AND r.tenant_id = $2`,
      [id, auth.tenantId]
    );
    if (!rows[0]) throw new GovernError(404, "unknown_reservation", "no such reservation in this tenant");
    return { status: 200, body: { ok: true, ...reservationView(rows[0], { budget: rows[0].budget_external_id }) } };
  }

  async function listReservations(auth, { status, budget, limit = 100, before }) {
    const params = [auth.tenantId];
    const where = ["r.tenant_id = $1"];
    if (status) {
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }
    if (budget) {
      params.push(budget);
      where.push(`b.external_id = $${params.length}`);
    }
    if (before) {
      if (Number.isNaN(Date.parse(before))) throw new GovernError(400, "invalid_request", "before must be an ISO timestamp");
      params.push(new Date(before));
      where.push(`r.created_at < $${params.length}`);
    }
    params.push(Math.min(Number(limit) || 100, 500));
    const { rows } = await pool.query(
      `SELECT r.*, b.external_id AS budget_external_id FROM sv_reservations r JOIN sv_budgets b ON b.id = r.budget_id
       WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC LIMIT $${params.length}`,
      params
    );
    return { status: 200, body: { ok: true, reservations: rows.map((r) => reservationView(r, { budget: r.budget_external_id })) } };
  }

  async function getApproval(auth, id) {
    const { rows } = await pool.query(
      `SELECT a.*, r.estimate_micros, r.operation, r.model, r.metadata, b.external_id AS budget_external_id
       FROM sv_approvals a JOIN sv_reservations r ON r.id = a.reservation_id JOIN sv_budgets b ON b.id = r.budget_id
       WHERE a.id = $1 AND a.tenant_id = $2`,
      [id, auth.tenantId]
    );
    if (!rows[0]) throw new GovernError(404, "unknown_approval", "no such approval in this tenant");
    const a = rows[0];
    return { status: 200, body: { ok: true, approval: { ...approvalView(a), budget: a.budget_external_id, estimate_micros: a.estimate_micros, operation: a.operation, model: a.model, metadata: a.metadata } } };
  }

  async function listApprovals(auth, { status = "pending", limit = 100 }) {
    const { rows } = await pool.query(
      `SELECT a.*, r.estimate_micros, b.external_id AS budget_external_id
       FROM sv_approvals a JOIN sv_reservations r ON r.id = a.reservation_id JOIN sv_budgets b ON b.id = r.budget_id
       WHERE a.tenant_id = $1 AND a.status = $2 ORDER BY a.created_at DESC LIMIT $3`,
      [auth.tenantId, status, Math.min(Number(limit) || 100, 500)]
    );
    return { status: 200, body: { ok: true, approvals: rows.map((a) => ({ ...approvalView(a), budget: a.budget_external_id, estimate_micros: a.estimate_micros })) } };
  }

  // ------------------------------------------------------------ usage report
  // Settled spend in [from, to), grouped. With `budget` + include_descendants
  // the report covers that budget's whole subtree — the chargeback view for a
  // department whose teams and agents each have their own budget.
  async function usage(auth, { from, to, budget, include_descendants = false, group_by = "budget" }) {
    const groupExpr = {
      budget: "b.external_id",
      model: "coalesce(r.model, '(none)')",
      provider: "coalesce(r.provider, '(none)')",
      operation: "coalesce(r.operation, '(none)')",
      day: "to_char(date_trunc('day', r.resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",
    }[group_by];
    if (!groupExpr) throw new GovernError(400, "invalid_group_by", "group_by must be one of: budget, model, provider, operation, day");
    const params = [auth.tenantId, from, to];
    let budgetFilter = "";
    if (budget) {
      const { rows } = await pool.query("SELECT id FROM sv_budgets WHERE tenant_id = $1 AND external_id = $2", [auth.tenantId, budget]);
      if (!rows[0]) throw new GovernError(404, "unknown_budget", `no budget "${budget}" in this tenant`);
      params.push(rows[0].id);
      budgetFilter = include_descendants
        ? `AND r.budget_id IN (WITH RECURSIVE down AS (SELECT id, 1 AS d FROM sv_budgets WHERE id = $4
             UNION ALL SELECT c.id, down.d + 1 FROM sv_budgets c JOIN down ON c.parent_id = down.id WHERE down.d <= ${MAX_DEPTH})
           SELECT id FROM down)`
        : "AND r.budget_id = $4";
    }
    const { rows } = await pool.query(
      `SELECT ${groupExpr} AS key, sum(r.actual_micros)::bigint AS spent_micros, count(*)::int AS calls,
              coalesce(sum(r.input_tokens), 0)::bigint AS input_tokens, coalesce(sum(r.output_tokens), 0)::bigint AS output_tokens,
              count(*) FILTER (WHERE r.actual_micros > r.estimate_micros)::int AS over_estimate_calls
       FROM sv_reservations r JOIN sv_budgets b ON b.id = r.budget_id
       WHERE r.tenant_id = $1 AND r.status = 'settled' AND r.resolved_at >= $2 AND r.resolved_at < $3 ${budgetFilter}
       GROUP BY 1 ORDER BY spent_micros DESC, key`,
      params
    );
    const total = rows.reduce((s, r) => s + r.spent_micros, 0);
    const { rows: denied } = await pool.query(
      `SELECT count(*)::int AS n FROM sv_reservations r WHERE r.tenant_id = $1 AND r.status = 'denied'
       AND r.created_at >= $2 AND r.created_at < $3 ${budgetFilter}`,
      params
    );
    return {
      status: 200,
      body: { ok: true, from: iso(from), to: iso(to), group_by, total_spent_micros: total, denied_calls: denied[0].n, rows },
    };
  }

  // ------------------------------------------------------------ audit read
  async function listEvents(auth, { after_seq = 0, limit = 200 }) {
    const { rows } = await pool.query(
      `SELECT seq, type, reservation_id, budget_id, amount_micros, actor, data, created_at, prev_hash, entry_hash
       FROM sv_events WHERE tenant_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [auth.tenantId, Number(after_seq) || 0, Math.min(Number(limit) || 200, 1000)]
    );
    return { status: 200, body: { ok: true, events: rows.map((e) => ({ ...e, created_at: iso(e.created_at) })) } };
  }

  // ------------------------------------------------------------ tenant + keys
  async function getTenant(auth) {
    const { rows } = await pool.query("SELECT id, name, webhook_url, created_at FROM sv_tenants WHERE id = $1", [auth.tenantId]);
    const t = rows[0];
    // The URL can embed a token (Slack-style incoming webhooks do), so only
    // its host is ever read back.
    let host = null;
    try {
      host = t.webhook_url ? new URL(t.webhook_url).host : null;
    } catch {}
    return { status: 200, body: { ok: true, tenant: { id: t.id, name: t.name, webhook_configured: Boolean(t.webhook_url), webhook_host: host, created_at: iso(t.created_at) } } };
  }

  async function setWebhook(auth, { url, rotate_secret = false }) {
    if (url != null) {
      try {
        await assertWebhookUrlAllowed(url);
      } catch (err) {
        throw new GovernError(422, "webhook_url_refused", err.message);
      }
    }
    return withTx(pool, async (client) => {
      const at = now();
      // NO KEY UPDATE, not UPDATE: every audit insert takes FOR KEY SHARE on the
      // tenant row (sv_events' foreign key), and FOR UPDATE would conflict with
      // that and deadlock against any transaction already holding the audit lock.
      const { rows } = await client.query("SELECT webhook_secret FROM sv_tenants WHERE id = $1 FOR NO KEY UPDATE", [auth.tenantId]);
      let secret = rows[0].webhook_secret;
      let issued = null;
      if (url == null) {
        secret = null;
      } else if (!secret || rotate_secret) {
        secret = `whsec_${randomBytes(24).toString("hex")}`;
        issued = secret;
      }
      await client.query("UPDATE sv_tenants SET webhook_url = $2, webhook_secret = $3 WHERE id = $1", [auth.tenantId, url ?? null, secret]);
      await appendEvent(client, auth.tenantId, { type: "tenant.webhook_updated", actor: `key:${auth.keyId}`, data: { configured: url != null, rotated: Boolean(issued) }, at });
      return { status: 200, body: { ok: true, webhook_configured: url != null, ...(issued ? { webhook_secret: issued, note: "shown once; store it to verify SpendVeto-Signature" } : {}) } };
    });
  }

  async function createKey(auth, { scopes, label }) {
    return withTx(pool, async (client) => {
      const key = await insertKey(client, auth.tenantId, { scopes, label });
      await appendEvent(client, auth.tenantId, { type: "key.created", actor: `key:${auth.keyId}`, data: { key_id: key.id, scopes: key.scopes, label: key.label }, at: now() });
      return { status: 201, body: { ok: true, ...key, created_at: iso(key.created_at), note: "the key is shown once; only its hash is stored" } };
    });
  }

  async function listKeys(auth) {
    const { rows } = await pool.query(
      "SELECT id, key_prefix, scopes, label, created_at, revoked_at FROM sv_api_keys WHERE tenant_id = $1 ORDER BY created_at",
      [auth.tenantId]
    );
    return { status: 200, body: { ok: true, keys: rows.map((k) => ({ ...k, created_at: iso(k.created_at), revoked_at: iso(k.revoked_at) })) } };
  }

  async function revokeKey(auth, keyId) {
    if (keyId === auth.keyId) throw new GovernError(409, "cannot_revoke_self", "a key cannot revoke itself; use another admin key (or the CLI on the host)");
    return withTx(pool, async (client) => {
      const { rows } = await client.query(
        "UPDATE sv_api_keys SET revoked_at = $3 WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id",
        [keyId, auth.tenantId, now()]
      );
      if (!rows[0]) throw new GovernError(404, "unknown_key", "no active key with that id in this tenant");
      await appendEvent(client, auth.tenantId, { type: "key.revoked", actor: `key:${auth.keyId}`, data: { key_id: keyId }, at: now() });
      return { status: 200, body: { ok: true, revoked: keyId } };
    });
  }

  return {
    upsertBudget, syncBudgets, archiveBudget, getBudget, listBudgets,
    getReservation, listReservations, getApproval, listApprovals,
    usage, listEvents, getTenant, setWebhook, createKey, listKeys, revokeKey,
  };
}

// Used by the operator endpoint and the CLI. Returns the tenant and its first
// admin key (shown once).
export async function createTenant(pool, { name }) {
  return withTx(pool, async (client) => {
    const { rows } = await client.query("INSERT INTO sv_tenants (name) VALUES ($1) RETURNING id, name, created_at", [String(name).slice(0, 200)]);
    const tenant = rows[0];
    const key = await insertKey(client, tenant.id, { scopes: ["admin"], label: "initial admin key" });
    await appendEvent(client, tenant.id, { type: "tenant.created", actor: "operator", data: { name: tenant.name, admin_key_id: key.id }, at: new Date() });
    return { tenant: { ...tenant, created_at: iso(tenant.created_at) }, admin_key: key.key, admin_key_id: key.id };
  });
}

export async function mintKeyForTenant(pool, tenantId, { scopes, label }) {
  return withTx(pool, async (client) => {
    const { rows } = await client.query("SELECT id FROM sv_tenants WHERE id = $1", [tenantId]);
    if (!rows[0]) throw new GovernError(404, "unknown_tenant", "no such tenant");
    const key = await insertKey(client, tenantId, { scopes, label });
    await appendEvent(client, tenantId, { type: "key.created", actor: "operator", data: { key_id: key.id, scopes: key.scopes, label: key.label }, at: new Date() });
    return key;
  });
}
