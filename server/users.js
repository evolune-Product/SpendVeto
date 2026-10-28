import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "./store.js";
import { dirname } from "node:path";
import { getAddress, isAddress, recoverMessageAddress } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { dataPath } from "../shared-config.js";

// Console accounts: email + password, a role (viewer < approver < admin, the
// same ranks as API keys), and sessions in an HttpOnly cookie. Nothing secret
// is stored as itself: passwords are scrypt hashes, and session ids and invite
// tokens are stored as SHA-256 digests — a copied data directory hands over
// no logins. Users are invited, never self-registered: the first admin with
// `npm run user -- invite <email> admin` on the host, the rest from the
// Console's Users page. Any user record turns auth on (server/auth.js).
//
// Both files are re-read when they change on disk, so the CLI (another
// process) can invite the first admin while the server runs.
const USERS_PATH = dataPath("users.json");
const SESSIONS_PATH = dataPath("sessions.json");
export const ROLE_RANK = { viewer: 1, approver: 2, admin: 3 };
export const SESSION_COOKIE = "sv_session";
export const SESSION_TTL_MS = 12 * 3600e3;
const INVITE_TTL_MS = 48 * 3600e3;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60e3;
export const MIN_PASSWORD = 12;

// scrypt N=2^15, r=8, p=1: ~32 MB and tens of ms per hash — slow enough to
// make a stolen hash expensive, fast enough for a login.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = (pw, salt, len) => new Promise((res, rej) => scrypt(pw, salt, len, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const sameHex = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password), salt, 64);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
async function checkPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(hash, "base64url");
  const got = await new Promise((res, rej) => scrypt(String(password), Buffer.from(salt, "base64url"), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (e, k) => (e ? rej(e) : res(k))));
  return got.length === want.length && timingSafeEqual(got, want);
}
// Spent on unknown emails so a login takes as long whether or not the account exists.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));

function cachedJson(path) {
  let cache = null, mtime = -1;
  return {
    read() {
      const m = existsSync(path) ? statSync(path).mtimeMs : 0;
      if (m !== mtime) { mtime = m; try { cache = m ? JSON.parse(readFileSync(path, "utf8")) : []; } catch { cache = []; } }
      return cache;
    },
    write(value) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value, null, 2));
      cache = value; mtime = statSync(path).mtimeMs;
    },
  };
}
const usersFile = cachedJson(USERS_PATH);
const sessionsFile = cachedJson(SESSIONS_PATH);

const normEmail = (e) => String(e || "").trim().toLowerCase();
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name || null, role: u.role, status: u.disabled ? "disabled" : u.passwordHash ? "active" : "invited", createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, wallets: (u.wallets || []).map((w) => w.address) });

export const usersExist = () => usersFile.read().length > 0;
export const listUsers = () => usersFile.read().map(publicUser);

function saveUser(next) {
  const users = usersFile.read().filter((u) => u.id !== next.id);
  usersFile.write([...users, next]);
}
const activeAdmins = (except) => usersFile.read().filter((u) => u.role === "admin" && !u.disabled && u.id !== except).length;

// An invite is a one-time, 48-hour token; accepting it sets the password.
// Re-inviting an existing, not-yet-active user replaces their token.
export function inviteUser({ email, role = "viewer", name = "" }) {
  const e = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw Object.assign(new Error("a valid email is required"), { status: 400 });
  if (!ROLE_RANK[role]) throw Object.assign(new Error("role must be viewer, approver or admin"), { status: 400 });
  const existing = usersFile.read().find((u) => u.email === e);
  if (existing?.passwordHash) throw Object.assign(new Error("this user already has an account"), { status: 409 });
  const invite = token();
  const user = { ...(existing || { id: randomUUID(), createdAt: new Date().toISOString() }), email: e, name: String(name || existing?.name || "").slice(0, 80), role, passwordHash: null, invite: { tokenHash: sha256(invite), expiresAt: Date.now() + INVITE_TTL_MS }, failed: 0, lockedUntil: 0 };
  saveUser(user);
  return { user: publicUser(user), token: invite, expiresAt: new Date(user.invite.expiresAt).toISOString() };
}

export async function acceptInvite({ token: t, password, name }) {
  if (String(password || "").length < MIN_PASSWORD) throw Object.assign(new Error(`choose a password of at least ${MIN_PASSWORD} characters`), { status: 400 });
  const hash = sha256(t || "");
  const user = usersFile.read().find((u) => u.invite && sameHex(u.invite.tokenHash, hash));
  if (!user || user.invite.expiresAt < Date.now() || user.disabled) throw Object.assign(new Error("this invite link is invalid or has expired — ask an admin for a new one"), { status: 400 });
  if (normEmail(password) === user.email) throw Object.assign(new Error("the password can't be your email"), { status: 400 });
  const next = { ...user, name: String(name || user.name || "").slice(0, 80), passwordHash: await hashPassword(password), invite: null };
  saveUser(next);
  return publicUser(next);
}

// Generic failure either way — the response never says whether the email has
// an account. Five wrong passwords lock the account for 15 minutes, even from
// the right password.
export async function login(email, password) {
  const e = normEmail(email);
  const user = usersFile.read().find((u) => u.email === e);
  const fail = { ok: false, error: "email or password is incorrect" };
  if (!user || !user.passwordHash || user.disabled) { await checkPassword(password, DUMMY_HASH); return fail; }
  if (user.lockedUntil > Date.now()) { await checkPassword(password, DUMMY_HASH); return { ok: false, locked: true, error: "too many failed attempts — try again in 15 minutes" }; }
  if (!(await checkPassword(password, user.passwordHash))) {
    const failed = (user.failed || 0) + 1;
    saveUser({ ...user, failed: failed >= LOCK_AFTER ? 0 : failed, lockedUntil: failed >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
    return fail;
  }
  saveUser({ ...user, failed: 0, lockedUntil: 0, lastLoginAt: new Date().toISOString() });
  return { ok: true, user: publicUser(user), session: createSession(user.id) };
}

// ---- Wallet sign-in (Sign-In with Ethereum, EIP-4361) ----
// A signed-in user links a wallet; from then on that wallet's signature signs
// them in, as an alternative to the password. The server writes every message
// itself — this Console's domain, a single-use nonce, a five-minute expiry,
// and a statement saying what the signature is for — and accepts back only a
// message it issued, word for word, signed by the address it was issued to.
// A wallet shows the domain before signing (and warns when it isn't the site
// asking), so a signature collected by a look-alike site is useless here.
// Personal-account (EOA) signatures only: smart-contract wallets sign through
// EIP-1271, which would need a chain read at every sign-in.
const CHALLENGE_TTL_MS = 5 * 60e3;
const challenges = new Map(); // nonce -> { message, address, purpose, userId, expiresAt }
const STATEMENT = {
  login: () => "Sign in to the SpendVeto Console.",
  link: (email) => `Link this wallet to the SpendVeto Console account ${email}.`,
};
const walletFail = { ok: false, error: "that wallet signature can't sign you in — sign the newest request, with a wallet linked to your account" };

export function walletChallenge({ address, purpose, user, host, origin }) {
  if (!isAddress(String(address || ""))) throw Object.assign(new Error("a wallet address (0x…) is required"), { status: 400 });
  if (!STATEMENT[purpose]) throw Object.assign(new Error('purpose must be "login" or "link"'), { status: 400 });
  if (purpose === "link" && !user) throw Object.assign(new Error("sign in to the Console to link a wallet"), { status: 400 });
  const now = Date.now();
  for (const [n, c] of challenges) if (c.expiresAt < now) challenges.delete(n);
  if (challenges.size > 10000) throw Object.assign(new Error("too many sign-in requests in flight — try again in a few minutes"), { status: 429 });
  const nonce = randomBytes(16).toString("hex");
  const message = createSiweMessage({
    domain: host, uri: origin, address: getAddress(address), statement: STATEMENT[purpose](user?.email), version: "1", chainId: 1,
    nonce, issuedAt: new Date(now), expirationTime: new Date(now + CHALLENGE_TTL_MS),
  });
  challenges.set(nonce, { message, address: address.toLowerCase(), purpose, userId: user?.id || null, expiresAt: now + CHALLENGE_TTL_MS });
  return { message, expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString() };
}

// The challenge is spent by any attempt to use it, right or wrong.
async function redeemChallenge(message, signature, purpose) {
  let nonce;
  try { nonce = parseSiweMessage(String(message || "")).nonce; } catch {}
  const c = nonce && challenges.get(nonce);
  if (!c) return null;
  challenges.delete(nonce);
  if (c.message !== message || c.purpose !== purpose || c.expiresAt < Date.now()) return null;
  let signer;
  try { signer = await recoverMessageAddress({ message, signature }); } catch { return null; }
  return signer.toLowerCase() === c.address ? c : null;
}

export async function walletLogin(message, signature) {
  const c = await redeemChallenge(message, signature, "login");
  if (!c) return walletFail;
  const user = usersFile.read().find((u) => (u.wallets || []).some((w) => w.address.toLowerCase() === c.address));
  if (!user || !user.passwordHash || user.disabled) return walletFail;
  saveUser({ ...user, lastLoginAt: new Date().toISOString() });
  return { ok: true, user: publicUser(user), session: createSession(user.id) };
}

export async function linkWallet(userId, message, signature) {
  const c = await redeemChallenge(message, signature, "link");
  if (!c || c.userId !== userId) throw Object.assign(new Error("that signature doesn't match the newest link request — try linking again"), { status: 400 });
  const users = usersFile.read();
  const owner = users.find((u) => (u.wallets || []).some((w) => w.address.toLowerCase() === c.address));
  if (owner && owner.id !== userId) throw Object.assign(new Error("that wallet is already linked to another account"), { status: 409 });
  const user = users.find((u) => u.id === userId);
  if (!user) throw Object.assign(new Error("no such user"), { status: 404 });
  if (owner) return publicUser(user);
  const next = { ...user, wallets: [...(user.wallets || []), { address: getAddress(c.address), linkedAt: new Date().toISOString() }] };
  saveUser(next);
  return publicUser(next);
}

export function unlinkWallet(userId, address) {
  const user = usersFile.read().find((u) => u.id === userId);
  if (!user) throw Object.assign(new Error("no such user"), { status: 404 });
  const next = { ...user, wallets: (user.wallets || []).filter((w) => w.address.toLowerCase() !== String(address || "").toLowerCase()) };
  saveUser(next);
  return publicUser(next);
}

function createSession(userId) {
  const t = token();
  const now = Date.now();
  const live = sessionsFile.read().filter((s) => s.expiresAt > now);
  sessionsFile.write([...live, { idHash: sha256(t), userId, createdAt: now, expiresAt: now + SESSION_TTL_MS }]);
  return t;
}
export function sessionUser(t) {
  if (!t) return null;
  const hash = sha256(t);
  const s = sessionsFile.read().find((x) => sameHex(x.idHash, hash));
  if (!s || s.expiresAt < Date.now()) return null;
  const user = usersFile.read().find((u) => u.id === s.userId);
  return user && !user.disabled && user.passwordHash ? publicUser(user) : null;
}
export function destroySession(t) {
  if (!t) return;
  const hash = sha256(t);
  sessionsFile.write(sessionsFile.read().filter((s) => s.idHash !== hash));
}
const endSessionsOf = (userId) => sessionsFile.write(sessionsFile.read().filter((s) => s.userId !== userId));

export async function changePassword(userId, current, next) {
  const user = usersFile.read().find((u) => u.id === userId);
  if (!user || !(await checkPassword(current, user.passwordHash))) throw Object.assign(new Error("the current password is incorrect"), { status: 400 });
  if (String(next || "").length < MIN_PASSWORD) throw Object.assign(new Error(`choose a password of at least ${MIN_PASSWORD} characters`), { status: 400 });
  saveUser({ ...user, passwordHash: await hashPassword(next) });
  endSessionsOf(userId); // every other device signs in again
}

// Role, disable and remove can never leave the instance without an active admin.
export function updateUser(id, { role, disabled }) {
  const user = usersFile.read().find((u) => u.id === id);
  if (!user) throw Object.assign(new Error("no such user"), { status: 404 });
  if (role !== undefined && !ROLE_RANK[role]) throw Object.assign(new Error("role must be viewer, approver or admin"), { status: 400 });
  const next = { ...user, ...(role !== undefined ? { role } : {}), ...(disabled !== undefined ? { disabled: Boolean(disabled) } : {}) };
  if (user.role === "admin" && (next.role !== "admin" || next.disabled) && activeAdmins(id) === 0) throw Object.assign(new Error("that would leave no active admin"), { status: 409 });
  saveUser(next);
  if (next.disabled || next.role !== user.role) endSessionsOf(id);
  return publicUser(next);
}
export function removeUser(id) {
  const user = usersFile.read().find((u) => u.id === id);
  if (!user) throw Object.assign(new Error("no such user"), { status: 404 });
  if (user.role === "admin" && activeAdmins(id) === 0) throw Object.assign(new Error("that would leave no active admin"), { status: 409 });
  usersFile.write(usersFile.read().filter((u) => u.id !== id));
  endSessionsOf(id);
}

export function sessionTokenFrom(req) {
  for (const part of String(req.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}
