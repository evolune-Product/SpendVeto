// Governed-spend attestations — proof, for the SELLER, that a payment was
// checked by the buyer's spend policy before it was sent.
//
// Every signed artifact SpendVeto produced until now (receipts, verdicts,
// consents, request bindings) is evidence for the buyer's own audit trail.
// None of it is something a seller can ask for at the door. An attestation
// is: a short-lived token, minted only after the server-side policy check
// passed (and, above the approval line, only once a human approved), naming
// the payer, the payee, the resource and a ceiling. The seller verifies it
// offline — one secp256k1 signature check against an issuer address it chose
// to trust — and never has to call SpendVeto, share data with it, or run it.
// The shape is 3-D Secure's, for agents: the buyer's side vouches, the seller
// decides whether to require the vouching.
//
// What it proves: the named issuer's policy engine allowed a spend of up to
// `amt` USD by `sub` to `aud` for `res`, under policy version `pol`, at `iat`.
// What it does not prove: that the issuer's policy is strict — the seller
// learns the policy's hash, deliberately not its limits (a seller who could
// read a buyer's budget could price to it) — or that the payment happened;
// that is the rail's job, and the attestation rides along with it.
//
// This file is pure — no state, no I/O, only viem — so a seller can verify
// with it without running the rest of SpendVeto (integrations/seller-express.js).

import { recoverMessageAddress } from "viem";

export const ATTESTATION_PREFIX = "sva1";
export const ATTESTATION_HEADER = "X-SpendVeto-Attestation";
export const ATTESTATION_MESSAGE_PREFIX = "spendveto-attestation:v1:";
export const ATTESTATION_DEFAULT_TTL_SECONDS = 300;
export const ATTESTATION_MAX_TTL_SECONDS = 900;
export const ATTESTATION_RAILS = ["x402", "card", "payout", "llm", "api", "ap2", "acp", "mpp"];

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s) => Buffer.from(s, "base64url").toString("utf8");
const isEvm = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));
// EVM addresses compare case-insensitively (checksum casing is presentation);
// everything else — base58 addresses, URLs, account ids — compares exactly.
const sameId = (a, b) => (isEvm(a) && isEvm(b) ? a.toLowerCase() === b.toLowerCase() : String(a) === String(b));

// The signature covers the exact base64url bytes of the payload, so there is
// no canonicalization step for two implementations to disagree on.
export function attestationMessage(payloadB64) {
  return `${ATTESTATION_MESSAGE_PREFIX}${payloadB64}`;
}

// signMessage: async (message: string) => 0x-signature (EIP-191 personal_sign).
export async function mintAttestation(claims, signMessage) {
  const payload = b64url(JSON.stringify(claims));
  const signature = await signMessage(attestationMessage(payload));
  return `${ATTESTATION_PREFIX}.${payload}.${signature}`;
}

export function decodeAttestation(token) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== ATTESTATION_PREFIX) return null;
  const [, payload, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    const claims = JSON.parse(unb64url(payload));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? { claims, payload, signature } : null;
  } catch {
    return null;
  }
}

// Single-use per verifier: a seller that accepted an attestation once must
// not accept the same one again inside its validity window.
export function createReplayCache() {
  const seen = new Map(); // jti -> expiry ms
  return {
    has(jti) {
      const exp = seen.get(jti);
      return exp != null && exp > Date.now();
    },
    add(jti, expMs) {
      const now = Date.now();
      if (seen.size > 10000) for (const [k, v] of seen) if (v <= now) seen.delete(k);
      seen.set(jti, expMs);
    },
  };
}

const fail = (code, reason) => ({ ok: false, code, reason });

// Ordered so the code names the root cause: a forged token reports a bad
// signature, not an untrusted issuer; an expired token is not a replay.
export async function verifyAttestation(token, opts = {}) {
  const {
    trustedIssuers = [],
    audience,
    resource,
    amountUSD,
    payer,
    now = Date.now(),
    clockSkewSeconds = 60,
    maxTtlSeconds = ATTESTATION_MAX_TTL_SECONDS,
    replay = null,
  } = opts;
  if (!token) return fail("attestation_missing", `no ${ATTESTATION_HEADER} header — this seller only accepts payments whose spend was governed`);
  const decoded = decodeAttestation(token);
  if (!decoded) return fail("attestation_malformed", `not a ${ATTESTATION_PREFIX} token (expected ${ATTESTATION_PREFIX}.<base64url claims>.<0x signature>)`);
  const { claims, payload, signature } = decoded;
  if (claims.v !== 1) return fail("attestation_unsupported_version", `attestation version ${claims.v} is not supported (this verifier speaks v1)`);
  if (!isEvm(claims.iss) || !claims.sub || !claims.res || !claims.jti || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || !(Number(claims.amt) >= 0)) {
    return fail("attestation_malformed", "attestation is missing a required claim (iss, sub, res, amt, iat, exp, jti)");
  }
  const trusted = (Array.isArray(trustedIssuers) ? trustedIssuers : [trustedIssuers]).filter(isEvm);
  if (!trusted.length) return fail("attestation_no_trusted_issuers", "this verifier trusts no issuers — configure the issuer addresses you accept (fail closed)");

  let signer = null;
  try {
    signer = await recoverMessageAddress({ message: attestationMessage(payload), signature });
  } catch {
    signer = null;
  }
  if (!signer || !sameId(signer, claims.iss)) return fail("attestation_bad_signature", "the signature does not recover to the issuer the attestation names");
  if (!trusted.some((t) => sameId(t, signer))) return fail("attestation_untrusted_issuer", `issuer ${signer} is not one this verifier trusts`);

  const nowS = Math.floor(now / 1000);
  if (claims.iat > nowS + clockSkewSeconds) return fail("attestation_not_yet_valid", `issued at ${claims.iat}, in the future`);
  if (claims.exp <= nowS - clockSkewSeconds) return fail("attestation_expired", `expired at ${new Date(claims.exp * 1000).toISOString()}`);
  if (claims.exp - claims.iat > maxTtlSeconds) return fail("attestation_ttl_too_long", `valid for ${claims.exp - claims.iat}s, over this verifier's ${maxTtlSeconds}s maximum — long-lived attestations are coupons, not proof`);

  const aud = audience == null ? [] : (Array.isArray(audience) ? audience : [audience]).filter(Boolean);
  if (aud.length && !(claims.aud && aud.some((a) => sameId(a, claims.aud)))) {
    return fail("attestation_audience_mismatch", `attestation is for ${claims.aud || "no named payee"}, not this seller (${aud.join(", ")})`);
  }
  if (resource != null && String(resource) !== String(claims.res)) return fail("attestation_resource_mismatch", `attestation covers ${claims.res}, not ${resource}`);
  if (amountUSD != null && Number(claims.amt) + 1e-9 < Number(amountUSD)) return fail("attestation_amount_insufficient", `attestation covers up to $${claims.amt}, the price is $${amountUSD}`);
  if (payer != null && !sameId(payer, claims.sub)) return fail("attestation_payer_mismatch", `attestation was issued for ${claims.sub}, but ${payer} is paying`);
  if (replay) {
    if (replay.has(claims.jti)) return fail("attestation_replayed", `attestation ${claims.jti} was already presented here`);
    replay.add(claims.jti, (claims.exp + clockSkewSeconds) * 1000);
  }
  return { ok: true, claims, issuer: signer };
}
