// Tenant-scoped API keys for the Governance API.
//
// Scopes, not a single rank, because the split that matters is between
// SPENDING and APPROVING: a key that can request spend must not be able to
// wave its own request through. That is the same separation Evolune OS draws
// between runs:write and runs:approve.
//
//   spend       authorize / settle / void reservations
//   approve     decide pending approvals, as this key (one vote per key)
//   approve_as  decide on behalf of a named `actor` — for a trusted service
//               (e.g. Evolune's backend) that authenticates its own humans.
//               Without it, a key's vote is always recorded as the key itself,
//               so one key can never fill an N-approver rule on its own.
//   manage      budgets, freezes, tenant webhook
//   read        reports, reservations, approvals, audit log
//   admin       everything above, plus minting and revoking keys
//
// Independently of scopes, the key that requested a spend can never approve
// that spend — which also stops an admin key approving its own request.
//
// Keys are stored only as SHA-256 hashes. The raw key is returned once.
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { GovernError, sha256 } from "./util.js";

export const SCOPES = ["spend", "approve", "approve_as", "manage", "read", "admin"];

export function hasScope(auth, scope) {
  return auth.scopes.includes("admin") || auth.scopes.includes(scope);
}

export function generateKey() {
  const raw = `svk_${randomBytes(24).toString("hex")}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 12) };
}

export async function insertKey(client, tenantId, { scopes, label = "" }) {
  const bad = scopes.filter((s) => !SCOPES.includes(s));
  if (!scopes.length || bad.length) throw new GovernError(400, "invalid_scopes", `scopes must be a non-empty subset of: ${SCOPES.join(", ")}`);
  const key = generateKey();
  const { rows } = await client.query(
    `INSERT INTO sv_api_keys (tenant_id, key_hash, key_prefix, scopes, label)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, key_prefix, scopes, label, created_at`,
    [tenantId, key.hash, key.prefix, [...new Set(scopes)], String(label).slice(0, 120)]
  );
  return { ...rows[0], key: key.raw };
}

export async function resolveKey(pool, raw) {
  if (!raw || !raw.startsWith("svk_")) return null;
  const { rows } = await pool.query(
    `SELECT id, tenant_id, scopes, label FROM sv_api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [sha256(raw)]
  );
  return rows[0] ? { keyId: rows[0].id, tenantId: rows[0].tenant_id, scopes: rows[0].scopes, label: rows[0].label } : null;
}

function bearer(req) {
  const h = req.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

// Operator key (env SPENDVETO_OPERATOR_KEY) creates tenants. It is a deploy-
// time secret, compared in constant time over fixed-length digests. With the
// env var unset the operator surface does not exist (404).
export function requireOperator() {
  return (req, res, next) => {
    const configured = process.env.SPENDVETO_OPERATOR_KEY;
    if (!configured) return res.status(404).json({ ok: false, code: "not_found", error: "operator API is disabled on this deployment" });
    const given = bearer(req) || "";
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(configured).digest();
    if (!given || !timingSafeEqual(a, b)) return res.status(401).json({ ok: false, code: "unauthorized", error: "invalid operator key" });
    next();
  };
}
