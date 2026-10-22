// Postgres access for the Governance API.
//
// Connection-level timeouts are deliberate: a governance check that hangs is
// worse than one that refuses. A lock wait longer than lock_timeout surfaces
// as an error, the route answers 503 governance_unavailable, and the caller
// fails closed instead of stacking up behind a stuck transaction.
import pg from "pg";

// BIGINT (int8) arrives as a string by default. Every money column is int8, so
// parse it into a Number here and assert it is exactly representable — micro-
// USD values stay far below 2^53 ($9 billion), and anything that doesn't is a
// bug we want to hear about rather than silently round.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds the safe integer range`);
  return n;
});

export function createPool(connectionString, { max } = {}) {
  if (!connectionString) {
    throw new Error("SPENDVETO_DATABASE_URL is required for the Governance API (it stores budgets, reservations and the audit chain in Postgres)");
  }
  return new pg.Pool({
    connectionString,
    max: max || Number(process.env.GOVERN_DB_POOL_MAX) || 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    options: "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000",
  });
}

// Runs fn(client) inside one transaction. Serialization failures and deadlocks
// are retried a few times; both are expected under heavy concurrency and are
// safe to retry because the whole unit rolled back.
const RETRYABLE = new Set(["40001", "40P01"]);
export async function withTx(pool, fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (RETRYABLE.has(err.code) && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

// Errors that mean "the database could not answer", as opposed to a request
// the database rejected. Routes map these to 503 so callers fail closed.
export function isUnavailable(err) {
  if (!err) return false;
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "57P01", "57P03", "53300", "55P03", "57014"].includes(err.code)) return true;
  return /timeout exceeded when trying to connect|Connection terminated/i.test(err.message || "");
}
