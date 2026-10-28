import { readFileSync, writeFileSync, existsSync, mkdirSync } from "./store.js";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dataPath } from "../shared-config.js";
import { usersExist, sessionUser, sessionTokenFrom } from "./users.js";

// API-key auth for the admin surface (issue #10). The management API — rewrite
// policy, unfreeze wallets, mint delegations, register tools — was previously
// wide open to anyone who could reach the port. It now sits behind bearer keys
// with roles, using the same "open until configured" pattern the proxy already
// uses for agent identities: with ZERO keys the server is in open mode
// (zero-setup demos and the verify suite keep working), and the moment the
// first key exists (or SPENDVETO_REQUIRE_AUTH=1), every admin-surface endpoint
// requires `Authorization: Bearer <key>` with a sufficient role. Mint the first
// key from the trusted host with `npm run apikey` — it can't be minted over the
// API, by design (no privilege bootstrap from an unauthenticated request).

const KEYS_PATH = dataPath("api-keys.json");

// viewer < approver < admin. A key satisfies an endpoint if its role ranks at
// or above the endpoint's minimum.
const ROLE_RANK = { viewer: 1, approver: 2, admin: 3 };
export const ROLES = Object.keys(ROLE_RANK);

// Keys are stored as SHA-256 digests, never as the key: a copied or backed-up
// data directory doesn't hand over admin access. (Keys are 192 random bits, so
// a fast hash is the right one — there's nothing to brute-force.) A file from
// before this — or one written by hand — holding plaintext `key` fields is
// rewritten to digests the first time it's read.
const hashKey = (key) => createHash("sha256").update(String(key)).digest("hex");
const hintOf = (key) => `${String(key).slice(0, 8)}…`;

export function readKeys() {
  if (!existsSync(KEYS_PATH)) return [];
  let keys;
  try {
    keys = JSON.parse(readFileSync(KEYS_PATH, "utf8"));
  } catch {
    return [];
  }
  if (Array.isArray(keys) && keys.some((k) => k.key)) {
    keys = keys.map(({ key, ...rest }) => (key ? { ...rest, keyHash: hashKey(key), hint: hintOf(key) } : rest));
    writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  }
  return Array.isArray(keys) ? keys : [];
}

// Any API key or Console user (even one only invited) turns auth on.
export function authEnabled() {
  return readKeys().length > 0 || usersExist() || process.env.SPENDVETO_REQUIRE_AUTH === "1";
}

// A Console session rides in a cookie the browser attaches by itself, so a
// write on one must prove it came from the Console: a custom header (which a
// cross-site form or fetch can't add without a CORS preflight this server
// never grants) and, when the browser names it, this server's own origin.
// API keys sent as Authorization aren't ambient, so they don't need this.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function sameOriginWrite(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  if (req.get("x-spendveto-request") !== "1") return false;
  const origin = req.get("origin");
  return !origin || origin === `${req.protocol}://${req.get("host")}`;
}

export function createKey({ role = "admin", label = "" } = {}) {
  if (!ROLE_RANK[role]) throw new Error(`role must be one of: ${ROLES.join(", ")}`);
  const keys = readKeys();
  const key = `tgk_${randomBytes(24).toString("hex")}`;
  const stored = {
    id: randomUUID(),
    keyHash: hashKey(key),
    hint: hintOf(key),
    role,
    label: String(label).slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  keys.push(stored);
  mkdirSync(dirname(KEYS_PATH), { recursive: true });
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  return { ...stored, key }; // full key returned once, like every API-key flow
}

// Constant-time match: digests first, so differing lengths leak nothing either.
const digest = (v) => createHash("sha256").update(String(v)).digest();
const sameSecret = (a, b) => timingSafeEqual(digest(a), digest(b));

// Express middleware factory. requireAuth("admin") on an endpoint means: in
// open mode, pass through; otherwise require a valid key ranked >= admin.
// The server's own per-boot token (SPENDVETO_INTERNAL_TOKEN, client/api-auth.js)
// counts as a viewer: enough for its in-process policy checks to read, never
// enough to write.
export function requireAuth(minRole = "admin") {
  const need = ROLE_RANK[minRole] || ROLE_RANK.admin;
  return (req, res, next) => {
    if (!authEnabled()) return next(); // open mode — no keys configured
    const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const internal = process.env.SPENDVETO_INTERNAL_TOKEN;
    let key = token
      ? (internal && sameSecret(token, internal) ? { id: "internal", role: "viewer", label: "server-internal" } : readKeys().find((k) => k.keyHash && sameSecret(k.keyHash, hashKey(token))))
      : null;
    if (!token) {
      const user = sessionUser(sessionTokenFrom(req));
      if (user) {
        if (!sameOriginWrite(req)) return res.status(403).json({ code: "csrf", error: "a Console session can only make changes from the Console itself" });
        key = { id: user.id, role: user.role, label: user.email };
        req.user = user;
      }
    }
    if (!key) {
      return res.status(401).json({ code: "auth_required", error: "sign in to the Console, or send Authorization: Bearer <key> (mint one on the host with `npm run apikey`)" });
    }
    if ((ROLE_RANK[key.role] || 0) < need) {
      return res.status(403).json({ error: `this endpoint requires the "${minRole}" role or higher; this key is "${key.role}"` });
    }
    req.apiKey = { id: key.id, role: key.role, label: key.label };
    next();
  };
}
