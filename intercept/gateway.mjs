// Universal interception gateway: governs AI-agent payments made by code that never imported
// SpendVeto at all. Every other integration surface in this repo (the SDK, the MCP server, the
// enforcement proxy) requires the agent's own code to call SpendVeto. This one doesn't — it's a
// local HTTP(S)-intercepting proxy, in the mold of mitmproxy/Charles/Fiddler/HTTP Toolkit: point
// an agent's standard HTTP(S)_PROXY environment variable at it, and every x402 payment attempt it
// makes gets evaluated against the real governance pipeline (client/policy.js's checkPolicy — the
// SAME function the SDK and the enforcement proxy call, not a reimplementation of it) before the
// payment ever reaches the real server. A denied call never leaves this machine.
//
// This is the "govern what you didn't build" move described in launch material: a self-hosted,
// self-hosted, auditable tool can credibly ask an operator to trust a local MITM proxy with their
// own traffic in a way a closed SaaS cannot — the operator can read every line of what's
// intercepting their agent's calls, because it's this file.
//
// Built on mockttp (https://github.com/httptoolkit/mockttp), the same TLS-interception engine
// behind HTTP Toolkit — not hand-rolled TLS termination, which would be the wrong place to take a
// shortcut. See README.md for the trust model, what's intercepted vs. passed through untouched,
// and the one known upstream dependency vulnerability (unreachable from this code path, disclosed
// there in full rather than silently ignored).

import * as mockttp from "mockttp";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyMessage } from "viem";
import { checkPolicy } from "../client/policy.js";
import { waitForApproval, withWalletLock } from "../client/pay.js";
import { TOOLS, findChain, DEFAULT_CHAIN } from "../shared-config.js";

const DATA_DIR = fileURLToPath(new URL("./data", import.meta.url));
const CA_PATH = fileURLToPath(new URL("./data/ca.json", import.meta.url));
const GATEWAY_PORT = Number(process.env.INTERCEPT_PORT) || 8405;
const APPROVAL_TIMEOUT_MS = Number(process.env.INTERCEPT_APPROVAL_TIMEOUT_MS) || 30000;

// ---------------------------------------------------------------------------------------------
// CA certificate: generated once, cached on disk, reused across restarts. This is the trust
// surface in plain terms — anything that trusts this CA will trust TLS certificates this process
// generates on the fly for any domain, which is exactly what "transparent HTTPS interception"
// means and exactly why it needs to be opt-in, visible, and limited to hosts the operator actually
// means to govern (see ALLOWED_HOSTS below). The private key never leaves this file; nothing here
// transmits it anywhere.
// ---------------------------------------------------------------------------------------------

async function loadOrCreateCA() {
  if (existsSync(CA_PATH)) {
    return JSON.parse(readFileSync(CA_PATH, "utf8"));
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const ca = await mockttp.generateCACertificate({
    subject: { commonName: "SpendVeto Interception Gateway (local, self-hosted — do not trust this CA outside your own test environment)" },
  });
  writeFileSync(CA_PATH, JSON.stringify(ca, null, 2));
  console.log(`Generated a new local CA at ${CA_PATH}. This file's private key is what lets this`);
  console.log(`gateway terminate HTTPS for domains you point at it — treat it like any other private key.`);
  return ca;
}

// ---------------------------------------------------------------------------------------------
// Host scoping: by default this only intercepts traffic to hosts explicitly listed, never "the
// whole internet." A universal interception gateway that silently MITMs every HTTPS connection on
// the machine (banking sites, email, anything) the moment it's pointed at is not a governance tool,
// it's a surveillance tool wearing a governance tool's clothes — scoping down to the hosts an
// operator actually wants governed is the honest default. Widen via INTERCEPT_HOSTS (comma-separated)
// if you deliberately want broader coverage, e.g. for a sandboxed agent that only ever talks to one
// upstream.
// ---------------------------------------------------------------------------------------------

// Independent audit finding (fixed here): plain string comparison treated "localhost", "127.0.0.1",
// "[::1]", and "localhost." (trailing dot) as four different hosts, so an allowlist of "localhost"
// let an identical request addressed to 127.0.0.1 through with ZERO governance — no checkPolicy
// call, nothing logged, a silent full bypass of the one control this whole file exists to provide.
// This wasn't an exotic attack; 127.0.0.1 instead of localhost is one of the most ordinary ways to
// write a base URL. Every loopback spelling now canonicalizes to the same identity before either
// side of the comparison runs, so an allowlist entry for one loopback form governs all of them.
//
// This does NOT close DNS rebinding for a non-loopback allowlisted hostname (a name that resolves
// to a different IP between the 402 observation and the paid retry) — that needs resolving the
// hostname to an IP and pinning it per in-flight request, which this prototype doesn't do yet.
// Stated here rather than silently left for someone else to discover.
function canonicalHost(hostname) {
  let h = String(hostname).toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (h === "127.0.0.1" || h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return "localhost";
  }
  return h;
}

const ALLOWED_HOSTS = (process.env.INTERCEPT_HOSTS || `localhost:${process.env.SPENDVETO_PORT || 8402}`)
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean)
  .map((entry) => {
    const colon = entry.lastIndexOf(":");
    // "*" and bare hostnames (no port) pass through unchanged; a "host:port" entry gets its host
    // half canonicalized the same way an incoming destination does.
    if (entry === "*" || colon === -1) return entry.toLowerCase();
    return `${canonicalHost(entry.slice(0, colon))}:${entry.slice(colon + 1)}`;
  });

function hostIsGoverned(destination) {
  const canonical = canonicalHost(destination.hostname);
  const host = `${canonical}:${destination.port}`;
  return ALLOWED_HOSTS.includes(host) || ALLOWED_HOSTS.includes(canonical) || ALLOWED_HOSTS.includes("*");
}

// Upstream TLS verification is ON by default — this gateway governs the CLIENT's trust of ITS
// certificate, not the gateway's own trust of whatever it's forwarding to, and silently accepting
// an invalid upstream certificate would be exactly the kind of quiet security regression a proxy
// tool must not have as a default. INTERCEPT_IGNORE_UPSTREAM_CERT_ERRORS is an explicit, narrowly
// scoped opt-in (comma-separated hostnames, never a bare "ignore everything") for the one
// legitimate real-world case this matters for: an operator governing their own self-signed
// internal x402 seller.
const IGNORE_UPSTREAM_CERT_ERRORS = (process.env.INTERCEPT_IGNORE_UPSTREAM_CERT_ERRORS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------------------------
// Payment header parsing. Two forms:
//   - "x-sim-payment": this repo's own simulate-mode format, "0xAddress:nonce[:chain]:0xSignature"
//     (duplicated from server/simulate.js's module-private parsePaymentHeader rather than
//     imported — small, stable, well-covered, not worth changing that module's boundary for).
//   - "x-payment": a generic, protocol-agnostic fallback for a THIRD PARTY's own x402 seller —
//     one this gateway has never been told about and never will be. Real x402 v2's PAYMENT-
//     SIGNATURE header carries a base64-encoded EIP-3009 payload, which this prototype does not
//     decode (that's real scope, disclosed honestly in README.md, not pretended at here); what it
//     does handle is "address:price:signature", where signature must verify over
//     "pay:<path>:<price>" — enough to prove the actual claim this feature makes: a seller
//     SpendVeto has no relationship with, paid by an agent that never imported SpendVeto either,
//     still gets governed, because interception doesn't require either side to cooperate.
//
// Independent audit findings (fixed together here, same root cause): the original generic parser
// extracted an address from the header and called checkPolicy with it UNVERIFIED — no signature
// check at all. Two consequences, both real: (1) anyone could claim to be any wallet just by
// putting its address in a header, letting them probe that wallet's private governance state
// (freeze reason, spend-to-date, delegation details — checkPolicy's deny() messages routinely
// include this) with no key, and spam its approval queue; (2) separately, the PRICE governed came
// only from a plaintext 402 body the gateway had observed up to 10 minutes earlier, with nothing
// tying it to what the payment actually authorizes — a seller (or a stale cache) could have the
// gateway govern $0.01 while the real charge was anything. The fix for both: the header must now
// carry the price it was signed for, and the signature is verified — over "pay:<path>:<price>" —
// BEFORE checkPolicy is ever called. A bad signature means the claimed address and price are both
// untrusted, so the request is refused generically, never evaluated against real policy state.
// ---------------------------------------------------------------------------------------------

function parsePaymentHeader(header) {
  const parts = header.split(":");
  if (parts.length < 3 || parts.length > 4) return null;
  const [address, nonce, maybeChain, maybeSig] = parts;
  const chainDeclared = parts.length === 4;
  const chain = chainDeclared ? maybeChain : DEFAULT_CHAIN;
  const signature = chainDeclared ? maybeSig : maybeChain;
  if (!address || !nonce || !chain || !signature) return null;
  return { address, nonce, chain, chainDeclared, signature };
}

// Mirrors server/simulate.js's own message construction exactly — same nonce, same price, same
// chain-declared rule — so a signature that verifies here is the same signature the real gate
// would accept, not an approximation of it.
function simPaymentMessage(nonce, path, price, chain, chainDeclared) {
  return chainDeclared ? `${nonce}:${path}:${price}:${chain}` : `${nonce}:${path}:${price}`;
}

// Independent audit finding (fixed here, same root cause as the generic-path fix below): the
// gateway called checkPolicy with this header's claimed address without ever verifying the
// signature itself — the real downstream gate (server/simulate.js) does verify it, so a forged
// claim here could never actually move money, but by the time that downstream check runs, THIS
// gateway has already made and returned its own governance decision (allow/deny, with full denial
// detail — freeze reason, exact spend-to-date, delegation state) against an unverified identity.
// That is a real information-leak and approval-queue-spam surface on its own, independent of
// whether any payment could ever settle. Verifying here closes it: a request whose signature
// doesn't check out is refused generically, before checkPolicy is ever called.
async function verifySimPayment(req, parsed, priced) {
  if (!priced.nonce) return false; // never observed this exact challenge's nonce — nothing to verify against
  try {
    const message = simPaymentMessage(priced.nonce, pathname(req), priced.priceStr ?? String(priced.price), parsed.chain, parsed.chainDeclared);
    return await verifyMessage({ address: parsed.address, message, signature: parsed.signature });
  } catch {
    return false;
  }
}

function parseGenericPaymentHeader(header) {
  const parts = header.split(":");
  if (parts.length < 3) return null;
  const [address, priceStr, ...rest] = parts;
  const price = Number(priceStr);
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (!(price > 0)) return null;
  const signature = rest.join(":");
  if (!signature) return null;
  return { address, price, chain: DEFAULT_CHAIN, signature };
}

// Resources outside this repo's own tool catalog have no locally-known price — the gateway learns
// it (and, for this repo's own sim-format protocol, the challenge nonce too) by watching the 402
// challenge the real server issues (beforeResponse, below) and remembering it here, keyed by
// exactly the resource the challenge was for. An unknown price is never guessed; see the deny path
// in beforeRequest. For the generic path, this cached quote is also the upper bound a verified
// signed price must not exceed (see beforeRequest) — a signature alone proves WHO authorized WHAT
// price, not that the price was ever legitimately quoted by the destination.
const observedChallenges = new Map(); // `${host}${url}` -> { price, nonce, observedAt }
const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;

// mockttp's req.path is the request-target INCLUDING the query string (confirmed empirically —
// not pathname-only, contrary to what its name suggests), and req.url is the full absolute URL.
// Two different things need two different slices of that: the cache key wants the full request
// target (so ?price=X-style variable pricing, as the test mock seller uses, doesn't collide across
// different prices for the same path) — req.url already provides that. Anything that needs to
// match against a clean resource identifier (the TOOLS catalog, or a signed message that commits
// to "this exact resource" the way the test seller's signedMessageFor() does) wants the query
// string stripped — that's what pathname() is for, and using req.path directly for either of those
// was a real bug: every signature check failed, allow or deny alike, because the message being
// verified ("pay:/paid-resource?price=0.08:...") never matched what was actually signed
// ("pay:/paid-resource:0.08").
function pathname(req) {
  const q = req.path.indexOf("?");
  return q === -1 ? req.path : req.path.slice(0, q);
}

function cacheKey(req) {
  return `${req.headers.host || req.destination?.hostname || ""}${req.url}`;
}

function freshObservation(req) {
  const observed = observedChallenges.get(cacheKey(req));
  return observed && Date.now() - observed.observedAt < PRICE_CACHE_TTL_MS ? observed : null;
}

function priceFor(req) {
  const catalogTool = TOOLS.find((t) => t.path === pathname(req));
  const observed = freshObservation(req);
  if (catalogTool) {
    return { price: Number(catalogTool.price), priceStr: catalogTool.price, toolId: catalogTool.id, nonce: observed?.nonce, source: "catalog" };
  }
  if (observed) {
    return { price: observed.price, priceStr: String(observed.price), toolId: req.path, nonce: observed.nonce, source: "observed-402" };
  }
  return null;
}

// Deliberately generic — no code tied to any real policy state, no address echoed back beyond
// what the request already claimed. An unverified claim never gets checkPolicy's detail (exact
// spend-to-date, freeze reason, delegation terms), on purpose; see the independent audit notes
// above verifySimPayment / parseGenericPaymentHeader for exactly what this is closing.
function signatureInvalidResponse(extra) {
  return {
    response: {
      statusCode: 402,
      json: {
        interceptedBySpendVeto: true,
        blocked: true,
        code: "signature_invalid",
        reason: extra || "the payment header's signature does not verify for the claimed address and price",
        suggestion: "sign the payment with the key that actually controls the claimed address, over the exact price being requested",
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The governance hook. Runs on EVERY intercepted request; only acts on ones carrying a payment
// header — everything else (including the initial, unpaid request that triggers the 402 challenge)
// passes straight through untouched.
// ---------------------------------------------------------------------------------------------

async function beforeRequest(req) {
  if (!hostIsGoverned(req.destination)) return undefined; // not a host this gateway governs — pure passthrough

  const simHeader = req.headers["x-sim-payment"];
  const genericHeader = req.headers["x-payment"];
  if ((!simHeader || typeof simHeader !== "string") && (!genericHeader || typeof genericHeader !== "string")) {
    return undefined; // no payment attempt here — let it through untouched
  }

  const parsed = simHeader ? parsePaymentHeader(simHeader) : parseGenericPaymentHeader(genericHeader);
  if (!parsed) return undefined; // malformed — let the real destination's own validation reject it, not this gateway's business

  const priced = priceFor(req);
  if (!priced) {
    // Fail closed: a payment attempt for a resource this gateway has never seen priced (no catalog
    // entry, no observed 402 challenge) is refused rather than silently waved through. The agent's
    // own retry (after the real server's 402 response is observed, see beforeResponse) will price it.
    return {
      response: {
        statusCode: 402,
        json: {
          interceptedBySpendVeto: true,
          blocked: true,
          code: "price_unknown",
          reason: "this gateway has not yet observed a 402 price challenge for this resource, so it cannot govern a price it doesn't know",
          suggestion: "retry the unpaid request first so the gateway can observe the real 402 challenge, then retry the paid one",
        },
      },
    };
  }

  // Verify BEFORE trusting anything this request claims about itself. A bad signature means the
  // address and price are both unauthenticated input — refused generically, never evaluated
  // against real policy state (see the comments above verifySimPayment / parseGenericPaymentHeader
  // for why this matters even though the real downstream gate would also reject an unsigned claim).
  let governedPrice = priced.price;
  if (simHeader) {
    const verified = await verifySimPayment(req, parsed, priced);
    if (!verified) return signatureInvalidResponse();
  } else {
    if (parsed.price > priced.price + 1e-9) return signatureInvalidResponse("claimed price exceeds the last observed quote for this resource");
    const verified = await verifyMessage({ address: parsed.address, message: `pay:${pathname(req)}:${parsed.price}`, signature: parsed.signature }).catch(() => false);
    if (!verified) return signatureInvalidResponse();
    governedPrice = parsed.price; // the price the signature actually commits to, not merely the cached quote
  }

  const chain = findChain(parsed.chain) ? parsed.chain : DEFAULT_CHAIN;

  return withWalletLock(parsed.address, async () => {
    const verdict = await checkPolicy(parsed.address, governedPrice, priced.toolId, chain);

    if (!verdict.allowed) {
      console.log(`[intercept] BLOCKED ${parsed.address} -> ${req.path} ($${governedPrice}): ${verdict.code}`);
      return {
        response: {
          statusCode: 402,
          json: {
            interceptedBySpendVeto: true,
            blocked: true,
            code: verdict.code,
            reason: verdict.reason,
            suggestion: verdict.suggestion,
          },
        },
      };
    }

    if (verdict.requiresApproval) {
      console.log(`[intercept] PAUSED for approval: ${parsed.address} -> ${req.path} ($${governedPrice})`);
      const { outcome } = await waitForApproval({ path: req.path, price: governedPrice }, { address: parsed.address }, APPROVAL_TIMEOUT_MS);
      if (outcome !== "approved") {
        console.log(`[intercept] BLOCKED (approval ${outcome}): ${parsed.address} -> ${req.path}`);
        return {
          response: {
            statusCode: 402,
            json: {
              interceptedBySpendVeto: true,
              blocked: true,
              code: outcome === "timeout" ? "approval_timeout" : "approval_denied",
              reason: outcome === "timeout" ? "no human decision within the approval window — fails closed" : "a human denied this spend on the dashboard",
              suggestion: "do not retry automatically; a human must act on the dashboard",
            },
          },
        };
      }
    }

    console.log(`[intercept] ALLOWED ${parsed.address} -> ${req.path} ($${governedPrice})`);
    return undefined; // forward the original request, payment header and all, to the real server
  });
}

// ---------------------------------------------------------------------------------------------
// Learns prices (and, for this repo's own sim-format challenges, the nonce the signature needs to
// commit to) from real 402 challenges it observes passing through — never modifies the response,
// only reads it. This is what lets the gateway govern a resource it has no hardcoded knowledge of
// (anything outside this repo's own TOOLS catalog), using the server's own declared price rather
// than guessing.
// ---------------------------------------------------------------------------------------------

async function beforeResponse(res, req) {
  if (res.statusCode !== 402) return undefined;
  try {
    const body = await res.body.getJson();
    const price = Number(body?.price);
    if (price > 0) {
      observedChallenges.set(cacheKey(req), { price, nonce: typeof body?.nonce === "string" ? body.nonce : undefined, observedAt: Date.now() });
    }
  } catch {
    // Not JSON, or not shaped like an x402 challenge this gateway recognizes — nothing learned,
    // nothing broken; the response still passes through to the client unmodified either way.
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

export async function startGateway(port = GATEWAY_PORT) {
  const ca = await loadOrCreateCA();
  const server = mockttp.getLocal({ https: { key: ca.key, cert: ca.cert } });

  await server.forAnyRequest().thenPassThrough({
    beforeRequest,
    beforeResponse,
    ...(IGNORE_UPSTREAM_CERT_ERRORS.length ? { ignoreHostHttpsErrors: IGNORE_UPSTREAM_CERT_ERRORS } : {}),
  });
  await server.start(port);

  console.log(`SpendVeto interception gateway listening on :${port}`);
  console.log(`Governing: ${ALLOWED_HOSTS.join(", ")}`);
  console.log(`CA certificate: ${CA_PATH} (export its "cert" field for a client to trust this gateway's HTTPS interception)`);
  console.log("");
  console.log("Point an agent at it (no SpendVeto import required on the agent's side):");
  console.log(`  HTTP_PROXY=http://localhost:${port} HTTPS_PROXY=http://localhost:${port} <agent command>`);

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch((e) => {
    console.error("Gateway failed to start:", e);
    process.exit(1);
  });
}
