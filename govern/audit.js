// Hash-chained audit log, one chain per tenant — the same construction as the
// original ledger (server/ledger.js), moved into Postgres.
//
// Appends for one tenant are serialized on a transaction-scoped advisory lock,
// so two concurrent decisions can never claim the same sequence number or link
// to the same predecessor. Callers must take every budget/reservation row lock
// they need BEFORE appending: the advisory lock is always acquired last, which
// is what keeps lock ordering acyclic.
import { canonical, sha256, iso } from "./util.js";

const GENESIS = "0".repeat(64);

function digest(row, prevHash) {
  return sha256(
    prevHash +
      canonical({
        tenant_id: row.tenant_id,
        seq: Number(row.seq),
        type: row.type,
        reservation_id: row.reservation_id || null,
        budget_id: row.budget_id || null,
        amount_micros: row.amount_micros ?? null,
        actor: row.actor || null,
        data: row.data || {},
        created_at: iso(row.created_at),
      })
  );
}

export async function appendEvent(client, tenantId, { type, reservationId = null, budgetId = null, amountMicros = null, actor = null, data = {}, at }) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7))", [tenantId]);
  const { rows } = await client.query(
    "SELECT seq, entry_hash FROM sv_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1",
    [tenantId]
  );
  const seq = rows.length ? Number(rows[0].seq) + 1 : 1;
  const prevHash = rows.length ? rows[0].entry_hash : GENESIS;
  const row = { tenant_id: tenantId, seq, type, reservation_id: reservationId, budget_id: budgetId, amount_micros: amountMicros, actor, data, created_at: at };
  const entryHash = digest(row, prevHash);
  await client.query(
    `INSERT INTO sv_events (tenant_id, seq, type, reservation_id, budget_id, amount_micros, actor, data, created_at, prev_hash, entry_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tenantId, seq, type, reservationId, budgetId, amountMicros, actor, data, at, prevHash, entryHash]
  );
  return { seq, entryHash };
}

// Walks a tenant's chain in order. Returns { valid, length, brokenAt } where
// brokenAt is the seq of the first entry whose content or link no longer
// matches its hash.
export async function verifyChain(pool, tenantId) {
  let prevHash = GENESIS;
  let expectedSeq = 1;
  let length = 0;
  const BATCH = 1000;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT tenant_id, seq, type, reservation_id, budget_id, amount_micros, actor, data, created_at, prev_hash, entry_hash
       FROM sv_events WHERE tenant_id = $1 AND seq >= $2 ORDER BY seq LIMIT $3`,
      [tenantId, expectedSeq, BATCH]
    );
    for (const r of rows) {
      if (Number(r.seq) !== expectedSeq || r.prev_hash !== prevHash || digest(r, r.prev_hash) !== r.entry_hash) {
        return { valid: false, length: length + 1, brokenAt: expectedSeq };
      }
      prevHash = r.entry_hash;
      expectedSeq++;
      length++;
    }
    if (rows.length < BATCH) break;
  }
  // A deleted tail is invisible to a forward walk; report the head so a
  // caller can pin it externally (e.g. in their own audit log) and compare.
  return { valid: true, length, brokenAt: null, head: prevHash };
}
