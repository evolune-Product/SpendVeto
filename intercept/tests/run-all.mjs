// Three real tests of the universal interception gateway, against a mock third-party x402 seller
// that imports nothing from SpendVeto (tests/mock-seller.mjs) and a test client that imports
// nothing from SpendVeto's governance code either (just viem, a generic crypto library, and
// undici's ProxyAgent, a generic HTTP client) — proving the actual claim: an agent that never
// adopted SpendVeto, paying a seller that never adopted SpendVeto, still gets governed, because
// the gateway sits transparently in between.
//
// Test 1 (HTTP, deny):  an over-cap payment is blocked before it ever reaches the seller.
// Test 2 (HTTP, allow): an in-policy payment passes through and the seller actually fulfills it.
// Test 3 (HTTPS, deny): the same block, over a real TLS connection the gateway had to terminate
//                        and re-originate using its own generated certificate — proving the MITM
//                        mechanism itself, not just the governance logic.
//
// Requires nothing already running — this script starts the real SpendVeto server, the mock
// seller, and the gateway itself, and tears all three down when it's done.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { readFileSync } from "node:fs";
import { startMockSeller, signedMessageFor } from "./mock-seller.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MOCK_HTTP_PORT = 8491;
const MOCK_HTTPS_PORT = 8492;
const GATEWAY_PORT = 8495;
const SERVER_PORT = 8402;

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  if (ok) {
    passes++;
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail !== undefined ? " — " + detail : ""}`);
  }
}

async function payThroughGateway({ scheme, host, port, price, account, extraTlsOpts }) {
  const base = `${scheme}://${host}:${port}`;
  const proxyAgent = new ProxyAgent({ uri: `http://localhost:${GATEWAY_PORT}`, requestTls: extraTlsOpts });

  // Step 1: unpaid request — passthrough, lets the gateway observe the real 402 challenge and
  // learn this resource's price (this repo's own catalog tools skip this; a third-party seller's
  // resource doesn't, by design — see gateway.mjs's priceFor()).
  const challenge = await undiciFetch(`${base}/paid-resource?price=${price}`, { dispatcher: proxyAgent });
  if (challenge.status !== 402) return { step: "challenge", status: challenge.status, body: await challenge.text() };

  // Step 2: sign the real payment (genuine ECDSA, same as every other client in this repo) and
  // retry with it — this is the request the gateway actually governs.
  const signature = await account.signMessage({ message: signedMessageFor(price) });
  const paid = await undiciFetch(`${base}/paid-resource?price=${price}`, {
    dispatcher: proxyAgent,
    headers: { "X-PAYMENT": `${account.address}:${price}:${signature}` },
  });
  const body = await paid.json().catch(() => null);
  return { step: "payment", status: paid.status, body };
}

async function main() {
  console.log("Starting the real SpendVeto server (needed for checkPolicy's own state lookups)...");
  const server = spawn("node", ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, SPENDVETO_MODE: "simulate" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d));
  server.stderr.on("data", (d) => (serverOutput += d));
  for (let i = 0; i < 25 && !serverOutput.includes("SpendVeto server"); i++) await sleep(200);
  if (!serverOutput.includes("SpendVeto server")) {
    console.error("Server failed to boot:", serverOutput);
    process.exit(1);
  }
  console.log("Server up.\n");

  console.log("Starting the mock third-party seller (zero SpendVeto imports)...");
  const seller = await startMockSeller({ httpPort: MOCK_HTTP_PORT, httpsPort: MOCK_HTTPS_PORT });
  await seller.ready;
  console.log(`Seller up: http://localhost:${MOCK_HTTP_PORT} and https://localhost:${MOCK_HTTPS_PORT}\n`);

  console.log("Starting the interception gateway...");
  process.env.INTERCEPT_HOSTS = `localhost:${MOCK_HTTP_PORT},localhost:${MOCK_HTTPS_PORT}`;
  process.env.INTERCEPT_PORT = String(GATEWAY_PORT);
  // The mock seller's HTTPS leg uses a throwaway self-signed cert (tests/mock-seller.mjs) that
  // nothing trusts — correctly, mockttp's own upstream TLS verification refuses it by default.
  // This opts in to trusting it, scoped to localhost only, for this test's own disposable seller —
  // not a statement that the gateway should trust self-signed certs in general (see gateway.mjs).
  process.env.INTERCEPT_IGNORE_UPSTREAM_CERT_ERRORS = "localhost";
  const { startGateway } = await import("../gateway.mjs");
  await startGateway(GATEWAY_PORT);
  const gatewayCa = JSON.parse(readFileSync(fileURLToPath(new URL("../data/ca.json", import.meta.url)), "utf8"));
  console.log("");

  try {
    // --- Test 1: HTTP, over-cap payment denied, zero trace left on the seller ---
    console.log("--- Test 1: HTTP — over-cap payment blocked before reaching the seller ---");
    const denyAccount = privateKeyToAccount(generatePrivateKey());
    const beforeLogLen = seller.receivedLog.length;
    const result1 = await payThroughGateway({ scheme: "http", host: "localhost", port: MOCK_HTTP_PORT, price: 0.08, account: denyAccount });
    check("test 1: the governed payment attempt is refused (not 200)", result1.step === "payment" && result1.status !== 200, `status=${result1.status}`);
    check("test 1: the refusal is attributed to this gateway, with the real policy denial code", result1.body?.interceptedBySpendVeto === true && result1.body?.code === "per_call_cap", JSON.stringify(result1.body));
    const sellerSawPayment = seller.receivedLog.slice(beforeLogLen).some((r) => r.headers["x-payment"]);
    check("test 1: the seller's own request log never received the paid attempt at all — the gateway stopped it, the seller didn't", !sellerSawPayment, `seller received ${seller.receivedLog.slice(beforeLogLen).length} requests, x-payment present in any: ${sellerSawPayment}`);

    // --- Test 2: HTTP, in-policy payment allowed, real round trip to the seller ---
    console.log("\n--- Test 2: HTTP — in-policy payment passes through and the seller fulfills it ---");
    const allowAccount = privateKeyToAccount(generatePrivateKey());
    const result2 = await payThroughGateway({ scheme: "http", host: "localhost", port: MOCK_HTTP_PORT, price: 0.01, account: allowAccount });
    check("test 2: the governed payment is allowed through (200)", result2.status === 200, `status=${result2.status} body=${JSON.stringify(result2.body)}`);
    check("test 2: the 200 response is the SELLER's real fulfillment, not a synthetic gateway response", result2.body?.fulfilled === true && result2.body?.paidBy?.toLowerCase() === allowAccount.address.toLowerCase(), JSON.stringify(result2.body));
    const sellerFulfilled = seller.receivedLog.some((r) => r.headers["x-payment"]?.toLowerCase().startsWith(allowAccount.address.toLowerCase()));
    check("test 2: the seller's own log confirms it actually received and processed this payment", sellerFulfilled);

    // --- Test 3: HTTPS, same deny, proving the TLS-interception mechanism itself ---
    console.log("\n--- Test 3: HTTPS — over-cap payment blocked over a real TLS connection the gateway terminated ---");
    const httpsAccount = privateKeyToAccount(generatePrivateKey());
    const beforeHttpsLogLen = seller.receivedLog.length;
    const result3 = await payThroughGateway({
      scheme: "https",
      host: "localhost",
      port: MOCK_HTTPS_PORT,
      price: 0.08,
      account: httpsAccount,
      extraTlsOpts: { ca: gatewayCa.cert },
    });
    // A 502 here would mean the client<->gateway TLS leg worked (no exception was thrown reaching
    // this point — a cert the client didn't trust would have made undici throw) but the SEPARATE
    // gateway<->seller leg failed; distinguishing the two legs is the point of this check.
    check("test 3: the TLS handshake through the gateway's generated certificate succeeded (the client trusted it, no connection-level failure)", result3.status !== 502, `step=${result3.step} status=${result3.status}`);
    check("test 3: the governed HTTPS payment attempt is refused", result3.step === "payment" && result3.status !== 200, `status=${result3.status}`);
    check("test 3: the HTTPS refusal is attributed to this gateway, same denial code as the HTTP case", result3.body?.interceptedBySpendVeto === true && result3.body?.code === "per_call_cap", JSON.stringify(result3.body));
    const sellerSawHttpsPayment = seller.receivedLog.slice(beforeHttpsLogLen).some((r) => r.headers["x-payment"]);
    check("test 3: the seller's HTTPS log never received the paid attempt either", !sellerSawHttpsPayment);
  } finally {
    await seller.stop();
    server.kill();
  }

  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
