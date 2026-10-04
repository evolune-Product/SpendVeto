// A stand-in for literally any third-party x402 seller on the internet. SpendVeto has no
// relationship with this server — it imports nothing from client/, server/, or shared-config.js,
// and implements its own (simplified) x402 challenge/verify logic independently, the way a real
// unrelated seller would. Its only job in these tests is to prove the gateway governs traffic to a
// destination that has never heard of SpendVeto and never will.
//
// Protocol (deliberately simpler than this repo's own server/simulate.js — a different, independent
// implementation, on purpose): GET /paid-resource with no X-PAYMENT header -> 402 with a JSON
// challenge {price, resource}. Same request WITH an "X-PAYMENT: 0xAddress:<signature>" header,
// where <signature> is a viem personal_sign of the string "pay:/paid-resource:<price>" -> verifies
// the signature really belongs to that address, and if so returns 200 with a fulfillment body.
// Every request this server receives is appended to `receivedLog` so a test can assert on exactly
// what did or didn't arrive — the ground truth for "did the gateway actually stop this, or did it
// just get denied after reaching the seller."

import http from "node:http";
import https from "node:https";
import { verifyMessage } from "viem";
import selfsigned from "selfsigned";

const RESOURCE_PATH = "/paid-resource";

// Price varies per request via ?price=, read consistently on both the 402 challenge and the
// signature check — a realistic stand-in for a seller with variable per-resource pricing, and the
// only way to exercise both an allowed and a denied governance outcome against one seller.
export function signedMessageFor(price) {
  return `pay:${RESOURCE_PATH}:${price}`;
}

export async function startMockSeller({ httpPort, httpsPort }) {
  const receivedLog = [];

  const handler = async (req, res) => {
    receivedLog.push({ method: req.method, url: req.url, headers: { ...req.headers }, at: Date.now() });

    const reqUrl = new URL(req.url, "http://placeholder");
    if (reqUrl.pathname !== RESOURCE_PATH) {
      res.writeHead(404);
      return res.end("not found");
    }
    const price = Number(reqUrl.searchParams.get("price")) || 0.05;

    const paymentHeader = req.headers["x-payment"];
    if (!paymentHeader) {
      res.writeHead(402, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ price, resource: RESOURCE_PATH, seller: "mock-third-party-seller (no SpendVeto relationship)" }));
    }

    // "address:price:signature" — matching gateway.mjs's generic X-PAYMENT format, since the
    // governed price now has to be part of what's actually signed (see the gateway's own audit
    // notes on parseGenericPaymentHeader for why). This seller still uses its OWN price (from the
    // query string, its own source of truth), not the header's claimed one — a seller has no
    // reason to trust a buyer's self-reported price any more than the gateway trusts the seller's.
    const headerParts = paymentHeader.split(":");
    const [address] = headerParts;
    const signature = headerParts.slice(2).join(":");
    let valid = false;
    try {
      valid = await verifyMessage({ address, message: signedMessageFor(price), signature });
    } catch {
      valid = false;
    }
    if (!valid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_signature" }));
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ fulfilled: true, resource: RESOURCE_PATH, paidBy: address }));
  };

  const servers = {};
  servers.receivedLog = receivedLog;
  servers.resourcePath = RESOURCE_PATH;
  servers.defaultPrice = 0.05;

  const startPromises = [];

  if (httpPort) {
    const httpServer = http.createServer(handler);
    servers.http = httpServer;
    startPromises.push(new Promise((resolve) => httpServer.listen(httpPort, resolve)));
  }

  if (httpsPort) {
    // A fresh, throwaway self-signed leaf cert for the seller's OWN identity — entirely separate
    // from the gateway's CA. The gateway terminates the CLIENT's TLS connection using its own
    // generated cert (that's the interception); it then makes its own, normal TLS connection to
    // this seller as any HTTPS client would, so this cert just needs to exist, not be trusted by
    // anyone in particular (the gateway's upstream connection ignores its validity for this
    // localhost test, same as any dev proxy pointed at a self-signed backend).
    const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1 });
    const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, handler);
    servers.https = httpsServer;
    startPromises.push(new Promise((resolve) => httpsServer.listen(httpsPort, resolve)));
  }

  servers.ready = Promise.all(startPromises);
  servers.stop = () =>
    Promise.all([servers.http ? new Promise((r) => servers.http.close(r)) : null, servers.https ? new Promise((r) => servers.https.close(r)) : null].filter(Boolean));

  return servers;
}
