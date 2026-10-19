import { findChain } from "../shared-config.js";
import { getSvmSigner, getAptosSigner, getStellarSigner, getHederaSigner, getXrplSigner } from "../client/wallet.js";
import { loadOptional, railFamilies } from "../server/optional.js";

export const SETTLEMENT = Symbol.for("spendveto.settlement");

// x402 v2 live settlement — registry-driven, not hardcoded to one chain. The
// client side signs for whichever registry chain the call asks for; whether
// settlement actually happens is decided by the REAL boundary: the server's
// 402 only advertises networks its configured facilitator supports (the gate
// asks the facilitator at boot — see server/index.js), so an unsupported
// chain fails with the protocol's own "no matching payment requirements"
// error, not an artificial block in this file. Today: the public facilitator
// settles base-sepolia; a CDP facilitator key brings its mainnet set live with
// zero code changes here.
export default {
  id: "x402-live",
  name: "x402 v2 — live settlement",
  status: "live",
  note: "real on-chain USDC/stablecoin settlement on every registry chain the configured facilitator supports (public facilitator: base-sepolia, solana-devnet, aptos-testnet, stellar-testnet, hedera-testnet and xrpl-testnet today; XRPL mainnet only on explicit opt-in; a CDP facilitator key unlocks EVM mainnets)",
  // Which chain families' optional SDKs are installed here, and the command
  // for the ones that aren't — surfaced on GET /api/rails and `spendveto rails`.
  availability() {
    const families = railFamilies();
    return { installed: families.find((f) => f.family === "evm").installed, families };
  },
  async pay({ tool, account, chain, baseUrl, query, attestation }) {
    const c = findChain(chain);
    if (!c?.caip2) {
      throw new Error(`chain "${chain}" is not in the registry — see shared-config.js CHAINS`);
    }
    // Governance identity (budgets, caps, ledger keying) is always
    // `account.address` — the secp256k1 wallet — regardless of which chain
    // settles. Every non-EVM family needs its own keypair purely to produce
    // the on-chain transfer signature, resolved only when its branch runs.
    // Each family's x402 package loads here too: chain SDKs are optional
    // (server/optional.js), and a missing one refuses this payment with the
    // install command — it never falls through to another family's scheme.
    const { wrapFetchWithPaymentFromConfig } = await loadOptional("@x402/fetch");
    let client;
    switch (c.family) {
      case "svm":
        client = new (await loadOptional("@x402/svm")).ExactSvmScheme(await getSvmSigner());
        break;
      case "aptos":
        client = new (await loadOptional("@x402/aptos")).ExactAptosScheme(await getAptosSigner());
        break;
      case "stellar":
        client = new (await loadOptional("@x402/stellar")).ExactStellarScheme(await getStellarSigner());
        break;
      case "hedera":
        client = new (await loadOptional("@x402/hedera")).ExactHederaScheme(await getHederaSigner());
        break;
      case "xrpl":
        client = new (await loadOptional("@x402/xrpl")).ExactXrplScheme(await getXrplSigner());
        break;
      default:
        client = new (await loadOptional("@x402/evm")).ExactEvmScheme(account);
    }
    const fetchWithPay = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: c.caip2, client }],
    });
    const url = new URL(`${baseUrl}${tool.path}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    // The wrapper clones this request for its paid retry, so a governed-spend
    // attestation set here reaches the seller with the payment.
    const response = await fetchWithPay(url, attestation ? { headers: { "X-SpendVeto-Attestation": attestation } } : undefined);
    if (!response.ok) {
      throw new Error(`request failed: ${response.status}`);
    }
    const data = await response.json();
    // The facilitator's settlement — its transaction hash is how out-of-band
    // detection (server/outofband.js) recognises this payment on-chain as one
    // SpendVeto governed. Attached under a symbol so a seller's JSON is never
    // altered; client/pay.js reads it.
    const header = response.headers.get("payment-response") || response.headers.get("x-payment-response");
    if (header && data && typeof data === "object") {
      try {
        const { decodePaymentResponseHeader } = await loadOptional("@x402/core/http");
        Object.defineProperty(data, SETTLEMENT, { value: decodePaymentResponseHeader(header), enumerable: false });
      } catch {
        // A malformed header loses the hash, not the payment: matching falls back to payer, amount and time.
      }
    }
    return data;
  },
};
