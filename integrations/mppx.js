// SpendVeto for mppx — the official Machine Payments Protocol client.
//
// mppx pays an MPP server's 402 by itself; its docs point at the onChallenge
// hook as the place to "apply a spending policy before paying". This puts
// SpendVeto there: the offer goes to POST /api/mpp/evaluate first, and mppx
// creates the credential only on "allow". A denial throws SpendVetoMppDenied
// before anything is signed. "requires_approval" files the request with the
// approval queue, waits for a human, and evaluates again.
//
//   import { Mppx, tempo } from "mppx/client";
//   import { governMppx } from "spendveto/integrations/mppx.js";
//
//   const governed = governMppx({ address: account.address });
//   const mppx = Mppx.create({ methods: [tempo({ account })], onChallenge: governed.onChallenge, polyfill: false });
//   const res = await governed.fetch(mppx, "https://api.example.com/search");
//
// governed.fetch() runs mppx.fetch and reports how the payment ended — paid
// (with the server's Payment-Receipt), or failed — so the hold SpendVeto placed
// becomes a booked payment or is released. A call made through mppx.fetch
// directly is still governed; its hold is booked as paid when the challenge
// expires, because an unreported payment must not vanish from the budget.
// Session deposits stay held until you close the session (closeSession), with
// the cumulative amount of the last voucher.
//
// No dependencies: mppx stays the caller's install.
import { AsyncLocalStorage } from "node:async_hooks";

export class SpendVetoMppDenied extends Error {
  constructor(verdict) {
    super(`SpendVeto refused this MPP payment (${verdict.code || verdict.decision}): ${verdict.reason}`);
    this.name = "SpendVetoMppDenied";
    this.code = verdict.code;
    this.suggestion = verdict.suggestion;
    this.verdict = verdict;
  }
}

export function governMppx({ address, spendveto = process.env.SPENDVETO_URL || "http://127.0.0.1:8402", apiKey, deposit, approvalTimeoutMs = 5 * 60 * 1000, pollMs = 1000, onDecision } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) throw new Error("governMppx needs the agent's 0x wallet address — the identity SpendVeto budgets");
  const base = spendveto.replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  // Per-call context, so concurrent governed fetches never report each
  // other's payments: onChallenge runs inside mppx.fetch's async chain.
  const calls = new AsyncLocalStorage();

  async function call(method, path, body) {
    const r = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await r.json().catch(() => ({}));
    if (r.status >= 500 || r.status === 400 || r.status === 401) throw new Error(`SpendVeto ${path}: HTTP ${r.status}${json.error ? ` — ${json.error}` : ""}`);
    return json;
  }
  const evaluate = (challenge) => call("POST", "/api/mpp/evaluate", { address, challenge, ...(deposit != null ? { deposit: String(deposit) } : {}) });
  const report = (chargeId, body) => call("POST", `/api/mpp/charges/${chargeId}/report`, body).catch(() => null);

  async function approved(verdict) {
    const record = await call("POST", "/api/approvals", { address, resource: verdict.approval.resource, price: verdict.approval.price });
    const deadline = Date.now() + approvalTimeoutMs;
    while (Date.now() < deadline) {
      const a = await call("GET", `/api/approvals/${record.id}`);
      if (a.status === "approved") return true;
      if (a.status && a.status !== "pending") return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  async function onChallenge(challenge, { createCredential }) {
    let verdict = await evaluate(challenge);
    if (verdict.decision === "requires_approval") {
      if (!(await approved(verdict))) throw new SpendVetoMppDenied({ ...verdict, decision: "deny", code: "approval_not_granted", reason: "no human approved this MPP payment before the timeout" });
      verdict = await evaluate(challenge);
    }
    onDecision?.(verdict);
    if (verdict.decision !== "allow") throw new SpendVetoMppDenied(verdict);
    let credential;
    try {
      credential = await createCredential();
    } catch (err) {
      // Nothing was signed, so nothing can have been paid: release the hold.
      if (verdict.chargeId) await report(verdict.chargeId, { outcome: "failed" });
      throw err;
    }
    calls.getStore()?.push(verdict);
    return credential;
  }

  async function governedFetch(mppx, input, init) {
    const sent = [];
    const response = await calls.run(sent, () => mppx.fetch(input, init));
    // A credential went out. A Payment-Receipt (servers send one only on
    // success) or any 2xx means paid; a 402 means the server refused the
    // credential. Anything else is ambiguous and stays held — and is booked as
    // paid at expiry — rather than being released on a guess.
    const receipt = response.headers.get("payment-receipt");
    for (const v of sent) {
      if (!v.chargeId) continue;
      if (receipt || response.ok) await report(v.chargeId, { outcome: "paid", ...(receipt ? { receipt } : {}) });
      else if (response.status === 402) await report(v.chargeId, { outcome: "failed" });
    }
    return response;
  }

  const voucher = (sessionId, cumulative) => call("POST", `/api/mpp/sessions/${sessionId}/voucher`, { cumulative: String(cumulative) });
  const closeSession = (sessionId, cumulative) => call("POST", `/api/mpp/sessions/${sessionId}/close`, cumulative != null ? { cumulative: String(cumulative) } : {});

  return { onChallenge, fetch: governedFetch, evaluate, voucher, closeSession };
}
