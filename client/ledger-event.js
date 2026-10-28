import { randomUUID } from "node:crypto";

// Events a client reports to /api/ledger/event are signed by the wallet they
// are about. Without that, anyone who could reach the server could write
// ledger rows naming any wallet: spoofed "blocked" rows trip another wallet's
// runaway auto-freeze, spoofed "paid" rows burn its budget. The signature
// covers every field the server keeps, a timestamp (stale events are refused)
// and a nonce (each signed event is accepted once).
export const LEDGER_EVENT_FIELDS = ["address", "resource", "price", "chain", "category", "status", "reason", "txHash", "payTo"];
export const LEDGER_EVENT_MAX_AGE_MS = 5 * 60e3;

export function ledgerEventMessage(event, ts, nonce) {
  const fields = LEDGER_EVENT_FIELDS.map((k) => event[k] ?? null);
  return `spendveto-ledger-event:v1:${ts}:${nonce}:${JSON.stringify(fields)}`;
}

export async function signLedgerEvent(account, event) {
  const body = { ...event, address: account.address };
  const ts = Date.now();
  const nonce = randomUUID();
  const signature = await account.signMessage({ message: ledgerEventMessage(body, ts, nonce) });
  return { ...body, auth: { ts, nonce, signature } };
}
