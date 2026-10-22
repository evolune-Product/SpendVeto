// Webhooks via a transactional outbox.
//
// enqueue() runs inside the caller's transaction, so a webhook exists if and
// only if the state change it describes committed. A background worker then
// delivers with an HMAC signature and retries with backoff. Several server
// processes can run the worker at once: rows are claimed with
// FOR UPDATE SKIP LOCKED and leased by pushing next_attempt_at forward.
//
// Signature: header `SpendVeto-Signature: t=<unix seconds>,v1=<hex>` where
// v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Receivers should reject a t
// more than a few minutes old to stop replays.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHmac } from "node:crypto";
import { guardedLookup, guardEnabled, isBlockedAddress } from "./netguard.js";

const MAX_ATTEMPTS = 6;
const LEASE_SECONDS = 60;

export async function enqueueWebhook(client, tenantId, eventType, payload) {
  const { rows } = await client.query("SELECT webhook_url FROM sv_tenants WHERE id = $1", [tenantId]);
  if (!rows[0]?.webhook_url) return false;
  await client.query(
    "INSERT INTO sv_webhook_outbox (tenant_id, event_type, payload) VALUES ($1, $2, $3)",
    [tenantId, eventType, { type: eventType, tenant_id: tenantId, ...payload }]
  );
  return true;
}

export function signPayload(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function post(url, body, headers, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    // An IP literal skips DNS (and therefore guardedLookup), so judge it here.
    if (guardEnabled() && net.isIP(host) && isBlockedAddress(host)) {
      return reject(Object.assign(new Error(`refused: ${host} is a private, loopback or reserved address`), { code: "ESPENDVETO_SSRF" }));
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers }, lookup: guardedLookup, timeout: timeoutMs },
      (res) => {
        res.resume(); // drain; we only care about the status
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("timeout", () => req.destroy(new Error("webhook delivery timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

// Delivers up to `limit` due webhooks. Returns how many were attempted.
export async function deliverDue(pool, { limit = 20 } = {}) {
  const client = await pool.connect();
  let claimed;
  try {
    await client.query("BEGIN");
    ({ rows: claimed } = await client.query(
      `SELECT o.id, o.tenant_id, o.event_type, o.payload, o.attempts, t.webhook_url, t.webhook_secret
       FROM sv_webhook_outbox o JOIN sv_tenants t ON t.id = o.tenant_id
       WHERE o.status = 'pending' AND o.next_attempt_at <= now()
       ORDER BY o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,
      [limit]
    ));
    if (claimed.length) {
      await client.query(
        `UPDATE sv_webhook_outbox SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
         WHERE id = ANY($1)`,
        [claimed.map((r) => r.id), LEASE_SECONDS]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const row of claimed) {
    const attempt = row.attempts + 1;
    let error = null;
    if (!row.webhook_url || !row.webhook_secret) {
      error = "tenant webhook is no longer configured";
    } else {
      const body = JSON.stringify({ id: String(row.id), ...row.payload });
      const t = Math.floor(Date.now() / 1000);
      try {
        const status = await post(row.webhook_url, body, {
          "SpendVeto-Event": row.event_type,
          "SpendVeto-Delivery": String(row.id),
          "SpendVeto-Signature": `t=${t},v1=${signPayload(row.webhook_secret, t, body)}`,
        });
        if (status < 200 || status >= 300) error = `receiver answered HTTP ${status}`;
      } catch (err) {
        error = err.message;
      }
    }
    if (!error) {
      await pool.query("UPDATE sv_webhook_outbox SET status='delivered', delivered_at=now(), last_error=NULL WHERE id=$1", [row.id]);
    } else if (attempt >= MAX_ATTEMPTS || /tenant webhook is no longer configured/.test(error)) {
      await pool.query("UPDATE sv_webhook_outbox SET status='failed', last_error=$2 WHERE id=$1", [row.id, error.slice(0, 500)]);
    } else {
      const backoff = 5 * 2 ** (attempt - 1); // 5s, 10s, 20s, 40s, 80s
      await pool.query(
        "UPDATE sv_webhook_outbox SET last_error=$2, next_attempt_at = now() + make_interval(secs => $3) WHERE id=$1",
        [row.id, error.slice(0, 500), backoff]
      );
    }
  }
  return claimed.length;
}
