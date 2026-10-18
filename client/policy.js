import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PORT, dataPath } from "../shared-config.js";
import { resolvePayeeList } from "./ens.js";
import { screenAddress } from "../server/sanctions.js";

const POLICY_PATH = dataPath("policy.json");

const DEFAULT_POLICY = {
  maxPerCallUSD: 0.05,
  maxPerHourUSD: 0.2,
  maxCallsPerHour: 10,
  requireApprovalAboveUSD: 0.015,
};

export function loadPolicy() {
  if (!existsSync(POLICY_PATH)) {
    writeFileSync(POLICY_PATH, JSON.stringify(DEFAULT_POLICY, null, 2));
    return DEFAULT_POLICY;
  }
  return { ...DEFAULT_POLICY, ...JSON.parse(readFileSync(POLICY_PATH, "utf8")) };
}

// Policy versioning for the audit trail: the SHA-256 of the effective policy
// (canonical key order), stamped onto decisions as they're made. An auditor
// reading the ledger can answer "which policy was in force when this spend was
// allowed?" — the record-keeping detail enterprise governance checklists ask
// for — without trusting anyone's memory of when policy.json changed.
export function policyHash(policy) {
  const p = policy || loadPolicy();
  // Recursive sorted-key canonicalization — a replacer array would silently
  // drop nested keys (anomaly.burstAttempts etc.) and let distinct policies
  // collide on the same hash.
  const canonicalize = (v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`
      : JSON.stringify(v);
  return createHash("sha256").update(canonicalize(p)).digest("hex");
}

// A denial is structured so the AGENT can act on it, not just a human: a
// machine-readable code, the human reason, and a concrete suggestion the
// model can follow to self-correct (retry on an allowed chain, request a
// top-up, wait out the window) instead of crashing or looping.
function deny(code, reason, suggestion, extra = {}) {
  return { allowed: false, code, reason, suggestion, ...extra };
}

// This is the governance wedge: the agent's own spend policy, checked BEFORE
// it attempts to pay for anything — not something imposed by the seller.
// Three outcomes: hard-denied (allowed:false), needs a human's sign-off
// (allowed:true, requiresApproval:true), or clear to pay immediately.
// Delegated child wallets additionally carry a lifetime budget cap granted
// by their parent — enforced here, in the child's own runtime.
// policyOverride lets a caller evaluate a call against a DIFFERENT policy than
// the live one on disk — the mechanism behind shadow mode (server/shadow.js):
// hold delegations, freezes, and spend history constant, swap only the policy
// object, and see what a candidate policy WOULD have decided. Normal callers
// omit it and get the live policy.
export async function checkPolicy(address, proposedPriceUSD, toolId, chain, category, payee, policyOverride) {
  const policy = policyOverride || loadPolicy();
  const price = Number(proposedPriceUSD);
  const normPayee = payee ? String(payee).toLowerCase() : null;

  // Kill switch first: a frozen wallet (manual or anomaly-detected) spends
  // nothing, regardless of what the other rules would say.
  try {
    const { freezes } = await fetch(`http://localhost:${PORT}/api/freezes`).then((r) => r.json());
    const frozen = freezes.find((f) => !f.unfrozen && f.address.toLowerCase() === address.toLowerCase());
    if (frozen) {
      return deny("frozen", `wallet frozen (${frozen.source}): ${frozen.reason} — unfreeze from the dashboard`,
        "do not retry; a human must unfreeze this wallet from the dashboard after reviewing why it was frozen", { policy });
    }
  } catch {
    // freezes endpoint unreachable — the ledger fetch below decides whether the server is up at all
  }

  // Sanctions screening (server/sanctions.js): checked before anything configurable, because this
  // isn't a policy an operator should be able to dial down — it's OFAC's own published SDN digital-
  // currency-address list, checked locally, deterministically, no network call on this path. A hit
  // is absolute: no policy override, no allowlist, no delegation scope can waive it. Only external
  // payees are screened (same scoping as the payee allowlist below) — a first-party catalog tool
  // with no declared payTo has no third-party recipient to screen. An address this deployment can't
  // screen (list not fetched yet, or the chain's address family has no current OFAC coverage) is
  // NOT treated as clean — it's simply not blocked on sanctions grounds, which sanctionsListStatus()
  // reports honestly rather than this silently claiming protection it isn't providing.
  //
  // Passes the RAW `payee`, not the lowercased `normPayee` below — screenAddress does its own
  // format-aware canonicalization (server/sanctions.js), and base58 addresses (Solana, XRP) are
  // case-sensitive, so the EVM-oriented lowercasing normPayee exists for would corrupt one before
  // it was even classified.
  if (payee) {
    const screening = screenAddress(payee, chain);
    if (screening.sanctioned) {
      const entry = screening.match.entries[0];
      const programs = entry.programs?.length ? ` (program: ${entry.programs.join(", ")})` : "";
      return deny("sanctioned_payee", `payee ${payee} matches OFAC's Specially Designated Nationals list${programs} — SDN uid ${entry.sdnUid}`,
        "do not retry against this address under any circumstances; this is a sanctions compliance block, not a configurable policy rule", { policy, screening });
    }
  }

  // Federated reputation (server/reputation.js): a counterparty this
  // organization reported — or one a publisher it explicitly trusts reported —
  // is refused (block) or handed to a human (review) before anything is
  // signed. Same scoping as sanctions: only external payees are checked.
  let reputationReview = null;
  if (payee) {
    try {
      const rep = await fetch(`http://localhost:${PORT}/api/reputation/check?subject=${encodeURIComponent(payee)}`).then((r) => r.json());
      if (rep.verdict === "block") {
        return deny("payee_reputation_block", `payee ${payee} is on a reputation block list (${rep.summary})`,
          "do not retry against this payee; it was reported for fraud or abuse — a human can review the report in the Console", { policy, reputation: rep });
      }
      if (rep.verdict === "review") reputationReview = rep;
    } catch {
      // older server or a transient failure — reputation adds to the controls below, it doesn't replace them
    }
  }

  // Chain allowlist: a policy may pin which chains agents are allowed to pay
  // on at all — settlement rails are a governance decision, not the agent's.
  if (chain && Array.isArray(policy.allowedChains) && !policy.allowedChains.includes(chain)) {
    return deny("chain_not_allowed", `chain "${chain}" is not in this policy's allowed chains (allowed: ${policy.allowedChains.join(", ")})`,
      `retry the same call with --chain set to one of: ${policy.allowedChains.join(", ")}`, { policy });
  }

  // Payee allowlist: pin WHICH addresses an agent may pay at all. Even if a
  // tool is compromised to redirect its payout, or an agent is prompt-injected
  // into paying an attacker, a payment to an address not on this list is
  // refused before anything is signed — the "allowlisting limits blast radius"
  // guardrail. Only external payees (tools that declare a payTo) are checked;
  // first-party catalog tools with no payTo are governed by tool scope instead.
  if (normPayee && Array.isArray(policy.allowedPayees) && policy.allowedPayees.length > 0) {
    // Entries may be raw addresses or .eth names — an allowlist a human can
    // actually audit ("vitalik.eth", not "0xd8dA..."). resolvePayeeList
    // expands names to addresses (cached; see client/ens.js) and drops any
    // that fail to resolve, so an unresolvable name can never accidentally
    // match everything.
    const allowed = await resolvePayeeList(policy.allowedPayees);
    if (!allowed.includes(normPayee)) {
      return deny("payee_not_allowed", `payee ${payee} is not in this policy's allowed payees`,
        "do not retry against this address; a human must add it to allowedPayees after verifying the recipient", { policy });
    }
  }

  // Trading-hours window (UTC): outside it, nothing spends — the "my bot
  // traded at 3am" control. Wrap-around windows (e.g. 22–6) supported.
  if (policy.allowedHoursUTC && Number.isInteger(policy.allowedHoursUTC.start) && Number.isInteger(policy.allowedHoursUTC.end)) {
    const { start, end } = policy.allowedHoursUTC;
    const h = new Date().getUTCHours();
    const inside = start <= end ? h >= start && h < end : h >= start || h < end;
    if (!inside) {
      return deny("outside_trading_hours", `outside allowed trading hours (UTC ${start}:00–${end}:00, now ${h}:00)`,
        `retry inside the allowed window, or have a human widen allowedHoursUTC in data/policy.json`, { policy });
    }
  }

  if (price > policy.maxPerCallUSD) {
    return deny("per_call_cap", `price $${price} exceeds maxPerCallUSD $${policy.maxPerCallUSD}`,
      `pick a tool priced at or under $${policy.maxPerCallUSD}, or have a human raise maxPerCallUSD in data/policy.json`, { policy });
  }

  let recent;
  let entries;
  try {
    const res = await fetch(`http://localhost:${PORT}/api/ledger`);
    ({ entries } = await res.json());
    const cutoff = Date.now() - 60 * 60 * 1000;
    const mine = entries.filter(
      (e) => e.status === "paid" && e.address?.toLowerCase() === address.toLowerCase() && new Date(e.ts).getTime() >= cutoff
    );
    recent = { totalUSD: mine.reduce((s, e) => s + Number(e.amount || 0), 0), count: mine.length };
  } catch {
    return deny("server_unreachable", "could not reach server to check recent spend — is `npm run server` running?",
      "start the SpendVeto server (`npm run server`) and retry", { policy });
  }

  // Money authorized but not yet settled is money already at risk. The x402
  // `upto` scheme lets a buyer sign for a ceiling and the seller charge less,
  // later — so between signature and settlement the ledger shows $0 while the
  // wallet is exposed for the whole ceiling. Counting only settled spend here
  // would let an agent sign ten $50 authorizations under a $60/hour cap and
  // break none of them. Open ceilings are held against the budget the way a
  // card pre-auth holds against a balance, and released on settlement or
  // expiry (see server/upto.js). auth-capture escrows (server/authcapture.js)
  // hold the same way until captured, voided or past their capture deadline.
  let heldUSD = 0;
  try {
    const held = await fetch(`http://localhost:${PORT}/api/upto/holds/${address}`).then((r) => r.json());
    heldUSD = Number(held.heldUSD) || 0;
  } catch {
    // Older server without the endpoint, or a transient failure: fall back to
    // settled-spend-only accounting rather than blocking every call. The gate
    // re-runs this check server-side, where the endpoint is always local.
  }

  // Delegation caps, cascading: if this wallet is a delegated child, walk the
  // grant chain up to the root. At every level, the whole subtree's lifetime
  // spend plus this call must fit that level's cap — a grandchild's spending
  // counts against its own cap AND every ancestor's. A revoked link anywhere
  // on the chain kills the branch.
  let delegations = [];
  try {
    ({ delegations } = await fetch(`http://localhost:${PORT}/api/delegations`).then((r) => r.json()));
  } catch {
    // Server reachable above but delegations fetch failed — treat as no delegation.
  }
  const latestGrantFor = (addr) =>
    delegations
      .filter((d) => d.childAddress.toLowerCase() === addr.toLowerCase())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  const paidSpendOf = (addr, sinceMs = 0) =>
    entries
      .filter((e) => e.status === "paid" && e.address?.toLowerCase() === addr.toLowerCase() && new Date(e.ts).getTime() >= sinceMs)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
  // Subtree = the address plus everything ever delegated beneath it. Revoked
  // grants still count for spend accounting — money already spent is spent.
  const subtreeSpendOf = (addr, sinceMs = 0) => {
    const seen = new Set([addr.toLowerCase()]);
    const queue = [addr.toLowerCase()];
    let total = 0;
    while (queue.length) {
      const current = queue.shift();
      total += paidSpendOf(current, sinceMs);
      for (const d of delegations) {
        const child = d.childAddress.toLowerCase();
        if (d.parentAddress.toLowerCase() === current && !seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return total;
  };

  const delegation = latestGrantFor(address);
  let hopAddress = address;
  let hopGrant = delegation;
  let depth = 0;
  const chainSeen = new Set();
  while (hopGrant && !chainSeen.has(hopAddress.toLowerCase())) {
    chainSeen.add(hopAddress.toLowerCase());
    const who = hopGrant.label || `${hopAddress.slice(0, 8)}…`;
    if (hopGrant.revoked) {
      return deny("delegation_revoked",
        depth === 0 ? "delegation revoked by parent" : `ancestor delegation revoked ("${who}")`,
        "do not retry; this budget line was revoked — request a fresh grant from the parent wallet", { policy, delegation });
    }
    // Time-bound grants: an expired link is as dead as a revoked one, and an
    // ancestor's expiry kills the whole branch below it.
    if (hopGrant.expiresAt && Date.now() > new Date(hopGrant.expiresAt).getTime()) {
      return deny("delegation_expired",
        depth === 0 ? `delegation expired at ${hopGrant.expiresAt}` : `ancestor delegation expired ("${who}" at ${hopGrant.expiresAt})`,
        "do not retry; this was a time-boxed budget — request a fresh grant from the parent wallet", { policy, delegation });
    }
    // Scope check: a grant may whitelist tools, and every ancestor's scope
    // binds the whole subtree — a child can never be granted access its own
    // grantor doesn't have.
    if (toolId && hopGrant.allowedTools && !hopGrant.allowedTools.includes(toolId)) {
      const level = depth === 0 ? "this wallet's delegated scope" : `the scope granted to ancestor "${who}"`;
      return deny("tool_scope", `tool "${toolId}" is outside ${level} (allowed: ${hopGrant.allowedTools.join(", ")})`,
        `retry with one of the allowed tools (${hopGrant.allowedTools.join(", ")}), or ask the grantor to widen the scope`, { policy, delegation });
    }
    // Chain scope works the same way: a grant may pin which chains the child
    // can settle on, and every ancestor's chain scope binds the whole subtree.
    if (chain && hopGrant.allowedChains && !hopGrant.allowedChains.includes(chain)) {
      const level = depth === 0 ? "this wallet's delegated chain scope" : `the chain scope granted to ancestor "${who}"`;
      return deny("chain_scope", `chain "${chain}" is outside ${level} (allowed: ${hopGrant.allowedChains.join(", ")})`,
        `retry the same call on an allowed chain (${hopGrant.allowedChains.join(", ")}), or ask the grantor to widen the chain scope`, { policy, delegation });
    }
    // Payee scope: a grant may pin WHICH recipients the child may pay ("this
    // sub-agent only pays these vendors"), and every ancestor's payee scope
    // binds the whole subtree — the delegated form of the payee allowlist.
    // Same .eth resolution as the global allowlist above (client/ens.js).
    if (normPayee && hopGrant.allowedPayees && !(await resolvePayeeList(hopGrant.allowedPayees)).includes(normPayee)) {
      const level = depth === 0 ? "this wallet's delegated payee scope" : `the payee scope granted to ancestor "${who}"`;
      return deny("payee_scope", `payee ${payee} is outside ${level} (allowed: ${hopGrant.allowedPayees.join(", ")})`,
        "pay an allowed recipient, or ask the grantor to add this address to the payee scope", { policy, delegation });
    }
    // A grant with periodSeconds is a recurring allowance: only spend inside
    // the rolling window counts against the cap.
    const windowStart = hopGrant.periodSeconds ? Date.now() - hopGrant.periodSeconds * 1000 : 0;
    const subtreeSpend = subtreeSpendOf(hopAddress, windowStart);
    if (subtreeSpend + price > hopGrant.capUSD) {
      const level = depth === 0 ? "" : ` granted to ancestor "${who}"`;
      const windowNote = hopGrant.periodSeconds ? ` in the current ${hopGrant.periodSeconds}s allowance window` : "";
      return deny("delegation_cap", `would exceed delegated budget cap $${hopGrant.capUSD}${level} ($${subtreeSpend.toFixed(4)} of it already spent${windowNote})`,
        `remaining budget on this line is $${Math.max(0, hopGrant.capUSD - subtreeSpend).toFixed(4)} — pick a cheaper tool that fits, or request a top-up grant from "${who}"`, { policy, delegation });
    }
    hopAddress = hopGrant.parentAddress;
    hopGrant = latestGrantFor(hopAddress);
    depth++;
  }

  // Ramp-style category caps: hourly budget per spend category, computed
  // from the ledger's own category tags.
  if (category && policy.categoryCapsUSD && policy.categoryCapsUSD[category] != null) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const catSpent = entries
      .filter((e) => e.status === "paid" && e.category === category && e.address?.toLowerCase() === address.toLowerCase() && new Date(e.ts).getTime() >= cutoff)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const cap = Number(policy.categoryCapsUSD[category]);
    if (catSpent + price > cap) {
      return deny("category_cap", `would exceed the hourly cap for category "${category}" ($${cap}; $${catSpent.toFixed(4)} already spent)`,
        `wait for the hourly window, use a tool in another category, or raise categoryCapsUSD.${category}`, { policy, recent });
    }
  }

  if (recent.count + 1 > policy.maxCallsPerHour) {
    return deny("hourly_rate_cap", `would exceed maxCallsPerHour (${policy.maxCallsPerHour})`,
      "wait for the hourly window to roll over before retrying, or have a human raise maxCallsPerHour", { policy, recent });
  }
  const committedUSD = recent.totalUSD + heldUSD;
  if (committedUSD + price > policy.maxPerHourUSD) {
    const heldNote = heldUSD > 0 ? `, $${heldUSD.toFixed(4)} held by open upto authorizations and auth-capture escrows` : "";
    return deny("hourly_usd_cap", `would exceed maxPerHourUSD $${policy.maxPerHourUSD} (spent $${recent.totalUSD.toFixed(4)} so far${heldNote})`,
      `only $${Math.max(0, policy.maxPerHourUSD - committedUSD).toFixed(4)} remains in this hour's budget — wait for the window to roll over${heldUSD > 0 ? ", settle or void an open authorization to release its hold" : ""}, or pick a cheaper tool`, { policy, recent, heldUSD });
  }

  // A payee flagged for review always goes to a human, whatever the amount.
  const requiresApproval = price > policy.requireApprovalAboveUSD || Boolean(reputationReview);
  return { allowed: true, requiresApproval, policy, recent, delegation, heldUSD, ...(reputationReview ? { reputation: reputationReview } : {}) };
}
