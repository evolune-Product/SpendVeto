// Self-serve signup: email → one-time link → tenant + first admin key.
//
//   POST /v1/signup/wallet  { address }                             → 201 { message } (optional first step)
//   POST /v1/signup         { email, org_name, turnstile_token?, wallet? }  → 202, always the same answer
//   POST /v1/signup/verify  { token }                               → 201 { tenant, admin_key } once
//
// Wallet-first is optional: a browser wallet signs a challenge this service
// wrote (Sign-In with Ethereum, EIP-4361 — the site's domain, a single-use
// nonce, a ten-minute expiry), the signed message rides along with the email,
// and the tenant the link creates records that wallet as its owner. The email
// link is still what creates the account: a wallet costs nothing to make, so
// it can't be the abuse limit, and the address is how the account is reached.
// One tenant per wallet. Personal-account (EOA) signatures only.
//
// The request answers identically whether or not the address already has an
// account (no enumeration); an address that does gets a "you already have an
// account" email instead of a second tenant. Abuse is bounded three ways: a
// per-client limit, at most 3 links per address per hour, and — when
// GOVERN_TURNSTILE_SECRET is set — a Cloudflare Turnstile check. The link's
// token is stored as its SHA-256; verifying consumes it in the same
// transaction that creates the tenant, so a link makes at most one account.
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, recoverMessageAddress } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { withTx } from "./db.js";
import { insertTenant } from "./admin.js";
import { GovernError, sha256 } from "./util.js";

const LINK_TTL_MS = 24 * 3600e3;
const CHALLENGE_TTL_MS = 10 * 60e3;
const PER_EMAIL_PER_HOUR = 3;
const PER_CLIENT_PER_HOUR = 10;

export const SIGNUP_ACCEPTED = "If that address can receive email, a link to finish signing up is on its way. It works once, for 24 hours.";

// Cloudflare Turnstile, verified server-side. Absent a secret, no check.
export function turnstileFromEnv(env = process.env, fetchImpl = fetch) {
  const secret = env.GOVERN_TURNSTILE_SECRET;
  if (!secret) return null;
  return async (token, ip) => {
    if (!token) return false;
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: String(token), ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    return Boolean((await res.json().catch(() => ({}))).success);
  };
}

export function createSignup({ pool, mailer, verifyHuman, now = () => new Date(), verifyUrl = process.env.GOVERN_SIGNUP_VERIFY_URL || "https://spendveto.com/signup/verify" }) {
  const clients = new Map(); // ip -> request times in the last hour (per process)

  function limitClient(ip) {
    const t = now().getTime();
    const recent = (clients.get(ip) || []).filter((x) => t - x < 3600e3);
    if (recent.length >= PER_CLIENT_PER_HOUR) throw new GovernError(429, "rate_limited", "too many signup requests from this client — try again later");
    recent.push(t);
    clients.set(ip, recent);
    if (clients.size > 10000) for (const [k, v] of clients) if (!v.some((x) => t - x < 3600e3)) clients.delete(k);
  }

  // `origin` is the page asking (already checked against the site's origins by
  // the caller): its host is the domain the wallet shows and checks.
  async function walletChallenge({ address }, origin, ip) {
    if (!mailer) throw new GovernError(503, "signup_unavailable", "self-serve signup isn't available on this deployment yet (email delivery isn't configured)");
    if (!origin) throw new GovernError(400, "wallet_origin_required", "wallet signup runs from the SpendVeto site's signup page");
    if (!isAddress(address)) throw new GovernError(400, "invalid_request", "a wallet address (0x…) is required");
    limitClient(ip);
    const at = now();
    const nonce = randomBytes(16).toString("hex");
    const expires = new Date(at.getTime() + CHALLENGE_TTL_MS);
    const message = createSiweMessage({
      domain: new URL(origin).host, uri: origin, address: getAddress(address), version: "1", chainId: 1, nonce, issuedAt: at, expirationTime: expires,
      statement: "Create a SpendVeto account owned by this wallet. Nothing is created until you open the link we email you.",
    });
    await pool.query("DELETE FROM sv_wallet_challenges WHERE expires_at < $1", [at]);
    await pool.query("INSERT INTO sv_wallet_challenges (nonce, address, message, expires_at) VALUES ($1, $2, $3, $4)", [nonce, address.toLowerCase(), message, expires]);
    return { status: 201, body: { ok: true, message, expires_at: expires.toISOString() } };
  }

  // Checks the signature outside the transaction (it's pure CPU); the
  // challenge itself is redeemed inside it, so one is spent exactly once.
  async function walletProof(wallet) {
    if (!wallet) return null;
    let signer, nonce;
    try {
      signer = (await recoverMessageAddress({ message: wallet.message, signature: wallet.signature })).toLowerCase();
      nonce = parseSiweMessage(wallet.message).nonce;
    } catch {}
    if (!signer || !nonce) throw new GovernError(400, "wallet_proof_invalid", "the wallet signature couldn't be checked — connect your wallet again");
    return { signer, nonce, message: wallet.message };
  }
  async function redeemWallet(client, proof, at) {
    const { rows } = await client.query("DELETE FROM sv_wallet_challenges WHERE nonce = $1 RETURNING address, message, expires_at", [proof.nonce]);
    const c = rows[0];
    if (!c || c.message !== proof.message || c.address !== proof.signer) throw new GovernError(400, "wallet_proof_invalid", "that wallet signature doesn't match a request we made — connect your wallet again");
    if (c.expires_at < at) throw new GovernError(400, "wallet_proof_expired", "the wallet signature expired (they last ten minutes) — connect your wallet again");
    const owned = await client.query("SELECT 1 FROM sv_tenants WHERE owner_wallet = $1", [c.address]);
    if (owned.rows.length) throw new GovernError(409, "wallet_taken", "that wallet already owns a SpendVeto account — use another wallet, or sign up with email alone");
    return c.address;
  }

  async function request({ email, org_name, turnstile_token, wallet }, ip) {
    if (!mailer) throw new GovernError(503, "signup_unavailable", "self-serve signup isn't available on this deployment yet (email delivery isn't configured)");
    if (verifyHuman && !(await verifyHuman(turnstile_token, ip))) throw new GovernError(400, "bot_check_failed", "the human check didn't pass — reload the page and try again");
    limitClient(ip);
    const proof = await walletProof(wallet);
    const address = email.trim().toLowerCase();
    const at = now();
    const outcome = await withTx(pool, async (client) => {
      const walletAddress = proof ? await redeemWallet(client, proof, at) : null;
      const { rows } = await client.query("SELECT * FROM sv_signups WHERE email = $1 FOR UPDATE", [address]);
      const row = rows[0];
      if (row?.verified_at) return { kind: "existing" };
      const sameHour = row && at - row.requested_at < 3600e3;
      if (sameHour && row.requests >= PER_EMAIL_PER_HOUR) return { kind: "quiet" };
      const token = randomBytes(32).toString("base64url");
      const expires = new Date(at.getTime() + LINK_TTL_MS);
      if (row) {
        await client.query(
          "UPDATE sv_signups SET org_name = $2, token_hash = $3, expires_at = $4, requested_at = $5, requests = $6, wallet_address = $7 WHERE id = $1",
          [row.id, org_name, sha256(token), expires, sameHour ? row.requested_at : at, sameHour ? row.requests + 1 : 1, walletAddress]
        );
      } else {
        await client.query("INSERT INTO sv_signups (email, org_name, token_hash, expires_at, requested_at, wallet_address) VALUES ($1, $2, $3, $4, $5, $6)", [address, org_name, sha256(token), expires, at, walletAddress]);
      }
      return { kind: "link", token, walletAddress };
    });
    // A provider outage is the caller's to retry, not a silent success. The
    // stored link stays valid, and a retry counts toward the hourly 3.
    const deliver = (msg) => mailer.send(msg).catch(() => { throw new GovernError(502, "mail_failed", "couldn't send the email just now — try again in a minute"); });
    if (outcome.kind === "link") {
      const link = `${verifyUrl}#token=${outcome.token}`;
      const owner = outcome.walletAddress ? getAddress(outcome.walletAddress) : null;
      await deliver({
        to: address,
        subject: "Finish creating your SpendVeto account",
        text: `Finish creating the SpendVeto account for ${org_name}:\n\n${link}\n\n${owner ? `It will be owned by the wallet ${owner}, which signed the request.\n\n` : ""}The link works once, for 24 hours. If you didn't ask for this, ignore this email — nothing is created until the link is opened.\n`,
        html: `<p>Finish creating the SpendVeto account for <b>${escapeHtml(org_name)}</b>:</p><p><a href="${link}">Create my account</a></p>${owner ? `<p>It will be owned by the wallet <code>${owner}</code>, which signed the request.</p>` : ""}<p>The link works once, for 24 hours. If you didn't ask for this, ignore this email — nothing is created until the link is opened.</p>`,
      });
    } else if (outcome.kind === "existing") {
      await deliver({
        to: address,
        subject: "You already have a SpendVeto account",
        text: "Someone — hopefully you — tried to create a SpendVeto account with this address, which already has one. No second account was created. Lost your API key? An admin key of your account can mint a new one (POST /v1/keys); if you have none left, reply to this email.\n",
        html: "<p>Someone — hopefully you — tried to create a SpendVeto account with this address, which already has one. No second account was created.</p><p>Lost your API key? An admin key of your account can mint a new one (<code>POST /v1/keys</code>); if you have none left, reply to this email.</p>",
      });
    }
    return { status: 202, body: { ok: true, message: SIGNUP_ACCEPTED } };
  }

  async function verify({ token }, ip) {
    limitClient(ip);
    try {
      return await withTx(pool, async (client) => {
        const { rows } = await client.query("SELECT * FROM sv_signups WHERE token_hash = $1 FOR UPDATE", [sha256(token)]);
        const row = rows[0];
        if (!row || row.verified_at || row.expires_at < now()) throw new GovernError(400, "invalid_token", "this link is invalid, already used, or expired — sign up again for a new one");
        const created = await insertTenant(client, { name: row.org_name, actor: `signup:${row.email}`, at: now(), ownerWallet: row.wallet_address });
        await client.query("UPDATE sv_signups SET verified_at = $2, tenant_id = $3, token_hash = NULL, expires_at = NULL WHERE id = $1", [row.id, now(), created.tenant.id]);
        return { status: 201, body: { ok: true, email: row.email, ...created } };
      });
    } catch (err) {
      // Two pending signups signed by one wallet: the first link opened wins.
      if (err.code === "23505" && err.constraint === "sv_tenants_owner_wallet") throw new GovernError(409, "wallet_taken", "the wallet that signed this signup already owns a SpendVeto account — sign up again with email alone, or with another wallet");
      throw err;
    }
  }

  return { walletChallenge, request, verify };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
