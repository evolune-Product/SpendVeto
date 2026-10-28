// Federated counterparty reputation: a fraud report filed at one company
// protects every other company that chooses to trust it.
//
// server/trust.js scores a payee from THIS instance's own ledger. That signal
// stops at the organization's edge, and the payee that just drained one
// company's agent is, by definition, new to the next one. This module moves
// the signal across organizations without moving anyone's data:
//
//   - an operator reports a counterparty — a crypto address, UPI VPA, IBAN,
//     email, domain, card merchant id — as "block" or "review";
//   - the instance publishes its reports as a signed feed of subject HASHES:
//     no raw identifiers, no free-text reasons, no amounts, no customers;
//   - another instance imports a feed only if the publisher's address is on
//     its own policy.reputation.trustedPublishers (fail closed), and from then
//     on its policy engine, payouts and card authorizations refuse — or hand
//     to a human — any payment to a matching counterparty, on every rail.
//
// Honest limits: hashing keeps identifiers out of a casual reader's hands,
// not out of a determined one's — an email or a VPA is guessable, and anyone
// can hash a candidate and look it up. A feed says "this publisher flagged
// this counterparty" and nothing more; whether that is enough to refuse a
// payment is the subscriber's call (importedAction), never the publisher's.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "./store.js";
import { recoverMessageAddress } from "viem";

export const FEED_SPEC = "spendveto-reputation-feed/v1";
export const FEED_MESSAGE_PREFIX = "spendveto-reputation-feed:v1:";
export const REPUTATION_KINDS = ["scam", "fraud", "prompt_injection", "non_delivery", "chargeback", "malware", "impersonation", "other"];
export const REPUTATION_SEVERITIES = ["block", "review"];
export const REPUTATION_DEFAULTS = { enabled: true, trustedPublishers: [], importedAction: "deny", publisherName: null };
const MAX_FEED_ENTRIES = 10000;

const isEvm = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));
const lower = (s) => String(s || "").toLowerCase();

export function reputationSettings(policy) {
  const p = policy?.reputation || {};
  return {
    ...REPUTATION_DEFAULTS,
    ...p,
    trustedPublishers: Array.isArray(p.trustedPublishers) ? p.trustedPublishers.filter(isEvm) : [],
    importedAction: p.importedAction === "review" ? "review" : "deny",
  };
}

// IBAN check digits (ISO 13616 mod-97), so only a real IBAN is upper-cased —
// a base58 address that merely looks like one keeps its case.
function ibanValid(iban) {
  const r = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const digits = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

// One canonical spelling per counterparty, so two organizations that write
// the same payee differently still compute the same hash:
//   0x-hex (EVM, Aptos)  → lowercase        name@handle / email → lowercase
//   https://shop.example → shop.example     valid IBAN          → upper, no spaces
//   kind:value           → lowercase kind   anything else (base58, XRP, Hedera, ids) → as written
export function canonicalSubject(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s.toLowerCase();
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).hostname.toLowerCase();
    } catch {
      return s.toLowerCase();
    }
  }
  if (s.includes("@")) return s.toLowerCase();
  const prefixed = s.match(/^([a-z][a-z0-9-]{1,31}):(.+)$/i);
  if (prefixed) return `${prefixed[1].toLowerCase()}:${prefixed[2].trim()}`;
  const compact = s.replace(/\s+/g, "").toUpperCase();
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact) && ibanValid(compact)) return compact;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) && /[a-z]/i.test(s)) return s.toLowerCase();
  return s;
}

export function subjectHash(raw) {
  const c = canonicalSubject(raw);
  return c ? createHash("sha256").update(`spendveto-rep:v1:${c}`).digest("hex") : null;
}

function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

export function feedDigest({ spec, publisher, name, issuedAt, entries }) {
  return createHash("sha256").update(canonicalJson({ spec, publisher, name, issuedAt, entries })).digest("hex");
}

const fail = (status, code, reason) => ({ ok: false, status, code, reason });

// Checks a feed someone handed us. Fail closed: no trusted publishers means
// no feed is accepted, whoever signed it.
export async function verifyFeed(feed, { trustedPublishers = [], now = Date.now() } = {}) {
  if (!feed || typeof feed !== "object" || feed.spec !== FEED_SPEC) return fail(400, "feed_malformed", `not a ${FEED_SPEC} document`);
  if (!isEvm(feed.publisher) || typeof feed.signature !== "string" || !Array.isArray(feed.entries) || !Date.parse(feed.issuedAt)) {
    return fail(400, "feed_malformed", "a feed needs publisher, issuedAt, entries and signature");
  }
  if (feed.entries.length > MAX_FEED_ENTRIES) return fail(400, "feed_too_large", `more than ${MAX_FEED_ENTRIES} entries`);
  const bad = feed.entries.findIndex((e) => !/^[0-9a-f]{64}$/.test(e?.subject || "") || !REPUTATION_SEVERITIES.includes(e?.severity));
  if (bad >= 0) return fail(400, "feed_malformed", `entry ${bad} needs a 64-hex subject hash and a severity of block or review`);
  const digest = feedDigest(feed);
  if (feed.digest && feed.digest !== digest) return fail(400, "feed_digest_mismatch", "the feed's content does not match its digest — it was altered after signing");
  let signer = null;
  try {
    signer = await recoverMessageAddress({ message: `${FEED_MESSAGE_PREFIX}${digest}`, signature: feed.signature });
  } catch {
    signer = null;
  }
  if (!signer || lower(signer) !== lower(feed.publisher)) return fail(400, "feed_bad_signature", "the signature does not recover to the publisher the feed names");
  const trusted = trustedPublishers.filter(isEvm).map(lower);
  if (!trusted.length) return fail(403, "feed_no_trusted_publishers", "this instance trusts no reputation publishers — add the publisher's address to policy.reputation.trustedPublishers first (fail closed)");
  if (!trusted.includes(lower(signer))) return fail(403, "feed_publisher_not_trusted", `publisher ${signer} is not on policy.reputation.trustedPublishers`);
  if (Date.parse(feed.issuedAt) > now + 5 * 60e3) return fail(400, "feed_from_future", `issuedAt ${feed.issuedAt} is in the future`);
  return { ok: true, publisher: lower(signer), digest };
}

// deps: { dataPath, loadPolicy, signer: { address, signMessage(message) } }
export function createReputation({ dataPath, loadPolicy, signer }) {
  const PATH = dataPath("reputation.json");
  let state = null;
  let index = null; // subject hash -> [{ source, name, kind, severity, count }]

  const load = () => {
    if (state) return state;
    try {
      state = existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : null;
    } catch {
      state = null;
    }
    if (!state || typeof state !== "object") state = {};
    state.reports ||= [];
    state.feeds ||= {};
    return state;
  };
  const save = () => {
    writeFileSync(PATH, JSON.stringify(state, null, 2));
    index = null;
  };
  const buildIndex = () => {
    if (index) return index;
    index = new Map();
    const add = (h, m) => (index.get(h) || index.set(h, []).get(h)).push(m);
    const s = load();
    for (const r of s.reports) add(r.subjectHash, { source: "local", name: "this organization", kind: r.kind, severity: r.severity, count: r.count });
    for (const f of Object.values(s.feeds)) for (const e of f.entries) add(e.subject, { source: f.publisher, name: f.name || f.publisher, kind: e.kind, severity: e.severity, count: e.count || 1 });
    return index;
  };

  function report({ subject, kind = "other", severity = "block", reason = "", share = true } = {}) {
    const h = subjectHash(subject);
    if (!h) return { ok: false, status: 400, code: "subject_required", reason: "subject is required — the counterparty identifier (address, VPA, IBAN, email, domain, card-merchant:<id>)" };
    if (!REPUTATION_KINDS.includes(kind)) return { ok: false, status: 400, code: "kind_invalid", reason: `kind must be one of: ${REPUTATION_KINDS.join(", ")}` };
    if (!REPUTATION_SEVERITIES.includes(severity)) return { ok: false, status: 400, code: "severity_invalid", reason: 'severity must be "block" or "review"' };
    const s = load();
    const now = new Date().toISOString();
    let row = s.reports.find((r) => r.subjectHash === h && r.kind === kind);
    const created = !row;
    if (row) {
      row.count += 1;
      row.lastSeen = now;
      if (severity === "block") row.severity = "block"; // escalate, never silently downgrade
      if (reason) row.reason = String(reason).slice(0, 300);
      if (share === false) row.share = false;
    } else {
      row = { id: `rep_${randomUUID().replace(/-/g, "").slice(0, 20)}`, subject: canonicalSubject(subject), subjectHash: h, kind, severity, reason: String(reason || "").slice(0, 300), share: share !== false, count: 1, firstSeen: now, lastSeen: now };
      s.reports.push(row);
    }
    save();
    return { ok: true, created, report: row };
  }

  function removeReport(id) {
    const s = load();
    const before = s.reports.length;
    s.reports = s.reports.filter((r) => r.id !== id);
    if (s.reports.length === before) return false;
    save();
    return true;
  }

  // The published feed: hashes, kinds, severities, counts, dates. Raw
  // subjects and reasons never leave the instance; share:false rows stay home.
  async function exportFeed() {
    const s = load();
    const settings = reputationSettings(loadPolicy());
    const body = {
      spec: FEED_SPEC,
      publisher: signer.address,
      name: settings.publisherName || "SpendVeto instance",
      issuedAt: new Date().toISOString(),
      entries: s.reports.filter((r) => r.share !== false).map((r) => ({ subject: r.subjectHash, kind: r.kind, severity: r.severity, count: r.count, firstSeen: r.firstSeen, lastSeen: r.lastSeen })),
    };
    const digest = feedDigest(body);
    return { ...body, digest, signature: await signer.signMessage(`${FEED_MESSAGE_PREFIX}${digest}`) };
  }

  async function importFeed(feed) {
    const settings = reputationSettings(loadPolicy());
    const v = await verifyFeed(feed, { trustedPublishers: settings.trustedPublishers });
    if (!v.ok) return v;
    if (v.publisher === lower(signer.address)) return fail(400, "feed_is_own", "this is this instance's own feed — its reports already apply here");
    const s = load();
    const prior = s.feeds[v.publisher];
    // Rollback protection: an older feed can't be replayed over a newer one
    // to resurrect — or erase — what the publisher has since changed.
    if (prior && Date.parse(prior.issuedAt) >= Date.parse(feed.issuedAt)) {
      return fail(409, "feed_stale", `already holding this publisher's feed issued ${prior.issuedAt}; this one is from ${feed.issuedAt}`);
    }
    s.feeds[v.publisher] = {
      publisher: v.publisher,
      name: String(feed.name || "").slice(0, 80) || v.publisher,
      issuedAt: feed.issuedAt,
      importedAt: new Date().toISOString(),
      digest: v.digest,
      entries: feed.entries.map((e) => ({ subject: e.subject, kind: REPUTATION_KINDS.includes(e.kind) ? e.kind : "other", severity: e.severity, count: Math.max(1, Math.floor(Number(e.count) || 1)) })),
    };
    save();
    return { ok: true, publisher: v.publisher, name: s.feeds[v.publisher].name, entries: s.feeds[v.publisher].entries.length };
  }

  // Worst verdict across every subject: a local block, or an imported block
  // under importedAction "deny", refuses; any other match asks a human.
  function check(subjects) {
    const list = (Array.isArray(subjects) ? subjects : [subjects]).filter((x) => x != null && String(x).trim());
    const hashes = [...new Set(list.map(subjectHash).filter(Boolean))];
    const settings = reputationSettings(loadPolicy());
    if (!settings.enabled) return { verdict: "clear", disabled: true, subjects: hashes, matches: [], summary: "" };
    const trusted = new Set(settings.trustedPublishers.map(lower));
    const idx = buildIndex();
    const matches = [];
    for (const h of hashes) for (const m of idx.get(h) || []) if (m.source === "local" || trusted.has(m.source)) matches.push({ subject: h, ...m });
    const localBlock = matches.some((m) => m.source === "local" && m.severity === "block");
    const importedBlock = matches.some((m) => m.source !== "local" && m.severity === "block");
    const verdict = localBlock || (importedBlock && settings.importedAction === "deny") ? "block" : matches.length ? "review" : "clear";
    const summary = matches.map((m) => `${m.kind}, reported by ${m.source === "local" ? "this organization" : `${m.name} (${m.source.slice(0, 10)}…)`}`).join("; ");
    return { verdict, subjects: hashes, matches, summary };
  }

  function summary() {
    const s = load();
    const settings = reputationSettings(loadPolicy());
    const trusted = new Set(settings.trustedPublishers.map(lower));
    return {
      settings,
      publisher: signer.address,
      reports: s.reports,
      feeds: Object.values(s.feeds).map((f) => ({ publisher: f.publisher, name: f.name, issuedAt: f.issuedAt, importedAt: f.importedAt, entries: f.entries.length, trusted: trusted.has(f.publisher) })),
    };
  }

  return { report, removeReport, exportFeed, importFeed, check, summary };
}
