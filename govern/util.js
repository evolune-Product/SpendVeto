import { createHash } from "node:crypto";

// A refusal or client error with a stable machine-readable code. Routes turn
// it into `{ ok:false, code, error, ...extra }` with the given HTTP status.
export class GovernError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Recursive sorted-key JSON. Used for request fingerprints (idempotency) and
// for the audit hash chain, so it must be stable across a JSONB round trip:
// key order is normalised here, and only integers/strings/booleans are ever
// hashed (money is integer micros, never a float).
export function canonical(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
}

export function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

// Budget windows are calendar windows in UTC. A "month" budget resets on the
// 1st at 00:00 UTC, which is what a finance team means by a monthly budget —
// a rolling 30-day window never lines up with an invoice.
const EPOCH = new Date(0);
export function windowStart(period, at) {
  const d = new Date(at.getTime());
  switch (period) {
    case "total":
      return EPOCH;
    case "hour":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()));
    case "day":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    case "week": {
      // ISO week: starts Monday 00:00 UTC.
      const day = (d.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    }
    case "month":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    default:
      throw new Error(`unknown period ${period}`);
  }
}

export function minuteStart(at) {
  return new Date(Math.floor(at.getTime() / 60000) * 60000);
}

export function addSeconds(at, s) {
  return new Date(at.getTime() + s * 1000);
}

export function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

// Human-readable USD for messages only. Never used for arithmetic.
export function usd(micros) {
  return `$${(micros / 1e6).toFixed(micros % 10000 === 0 ? 2 : 6)}`;
}
