// The seller's side of governed-spend attestations: one Express middleware
// that refuses an agent whose spend wasn't checked by a policy engine the
// seller trusts.
//
//   import { requireGovernedAgent } from "spendveto/integrations/seller-express.js";
//   app.get("/api/report", requireGovernedAgent({
//     trustedIssuers: ["0xIssuer…"],          // the buyers' SpendVeto issuer addresses you accept
//     audience: "0xYourPayTo…",               // your payout address (or list of them)
//     price: 0.25,                            // USD — or (req) => price
//   }), handler);
//
// Verification is offline: a signature check against the issuer addresses
// above, using only server/attestations.js (pure, viem-only). The seller
// never calls SpendVeto, never shares data with it, and doesn't run it.
// Each attestation is accepted once (per process); the verified claims are
// on req.spendveto for logging or for pricing a risk tier.
//
// Order with a payment middleware: put this FIRST, so an ungoverned agent is
// refused before it is asked to pay, and pass `payer` once you know who paid
// (e.g. from your x402 settlement) so a borrowed attestation can't vouch for
// someone else's payment.

import { verifyAttestation, createReplayCache, ATTESTATION_HEADER } from "../server/attestations.js";

const valueOf = (v, req) => (typeof v === "function" ? v(req) : v);

export function requireGovernedAgent({ trustedIssuers, audience, price, resource, payer, header = ATTESTATION_HEADER, status = 402, maxTtlSeconds } = {}) {
  if (!Array.isArray(trustedIssuers) || !trustedIssuers.length) {
    throw new Error("requireGovernedAgent: pass trustedIssuers — the SpendVeto issuer addresses whose attestations you accept");
  }
  const replay = createReplayCache();
  return async function governedAgentGate(req, res, next) {
    const result = await verifyAttestation(req.get(header), {
      trustedIssuers,
      audience: valueOf(audience, req),
      resource: resource === undefined ? (req.originalUrl || req.url).split("?")[0] : valueOf(resource, req),
      amountUSD: valueOf(price, req),
      payer: valueOf(payer, req),
      maxTtlSeconds,
      replay,
    });
    if (!result.ok) {
      return res.status(status).json({
        error: "governed_agent_required",
        code: result.code,
        reason: result.reason,
        suggestion: `send a ${header} header minted by a SpendVeto instance this seller trusts (POST /api/attestations on the buyer's SpendVeto, after its policy check passes)`,
      });
    }
    req.spendveto = result.claims;
    next();
  };
}
