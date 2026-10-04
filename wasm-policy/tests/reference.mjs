// Pure JS mirror of assembly/index.ts's evaluateInternal — NOT client/policy.js itself (that one
// does real I/O and stays the production code), but a from-scratch reference built by reading
// checkPolicy's logic the same way the AssemblyScript port was. This file is the "spec" the WASM
// module is checked against in parity.mjs: if the two ever disagree on the same input, one of them
// has a bug, and the whole point of this test is to make that impossible to miss.
//
// Deliberately duplicates the port rather than importing it from anywhere, so a bug in one isn't
// silently inherited by the other — two independent-but-faithful readings of the same rules.

function toFixed4(v) {
  const scaled = Math.round(v * 10000) / 10000;
  return scaled.toFixed(4);
}

function numToStr(v) {
  return Number.isInteger(v) ? String(v) : String(v);
}

function deny(code, reason, suggestion) {
  return { allowed: false, code, reason, suggestion };
}

export function evaluateReference(input) {
  const price = Number(input.proposedPriceUSD) || 0;
  const toolId = input.toolId ?? null;
  const chain = input.chain ?? null;
  const category = input.category ?? null;
  const payeeRaw = input.payee ?? null;
  // Independent audit finding (fixed here): real checkPolicy gates every one of chain/payee/
  // toolId/category on JS truthiness (`if (x && ...)`), not `!= null` — an empty string "" is
  // falsy, so the real system SKIPS the corresponding check for "", where `!= null` wrongly
  // ENFORCES it. This reference was independently written by reading checkPolicy too, and made
  // the same mistake the WASM port did — exactly the "shared misreading" risk a parity test
  // against only itself can't catch, since both sides would agree and both be wrong.
  const payee = payeeRaw ? String(payeeRaw).toLowerCase() : null;
  const policy = input.policy;

  if (!policy) return deny("policy_missing", "no policy object supplied", "send the effective policy alongside the call context");

  if (input.frozen && input.frozen.isFrozen) {
    const source = input.frozen.source ?? "unknown";
    const reason = input.frozen.reason ?? "no reason on record";
    return deny(
      "frozen",
      `wallet frozen (${source}): ${reason} — unfreeze from the dashboard`,
      "do not retry; a human must unfreeze this wallet from the dashboard after reviewing why it was frozen"
    );
  }

  if (chain && Array.isArray(policy.allowedChains) && !policy.allowedChains.includes(chain)) {
    return deny(
      "chain_not_allowed",
      `chain "${chain}" is not in this policy's allowed chains (allowed: ${policy.allowedChains.join(", ")})`,
      `retry the same call with --chain set to one of: ${policy.allowedChains.join(", ")}`
    );
  }

  if (payee && Array.isArray(policy.allowedPayees) && policy.allowedPayees.length > 0 && !policy.allowedPayees.includes(payee)) {
    return deny(
      "payee_not_allowed",
      `payee ${payeeRaw} is not in this policy's allowed payees`,
      "do not retry against this address; a human must add it to allowedPayees after verifying the recipient"
    );
  }

  if (policy.allowedHoursUTC && Number.isInteger(policy.allowedHoursUTC.start) && Number.isInteger(policy.allowedHoursUTC.end)) {
    const { start, end } = policy.allowedHoursUTC;
    const h = Number(input.nowUTCHour) || 0;
    const inside = start <= end ? h >= start && h < end : h >= start || h < end;
    if (!inside) {
      return deny(
        "outside_trading_hours",
        `outside allowed trading hours (UTC ${start}:00–${end}:00, now ${h}:00)`,
        "retry inside the allowed window, or have a human widen allowedHoursUTC in data/policy.json"
      );
    }
  }

  const maxPerCallUSD = policy.maxPerCallUSD ?? 0.05;
  if (price > maxPerCallUSD) {
    return deny(
      "per_call_cap",
      `price $${numToStr(price)} exceeds maxPerCallUSD $${numToStr(maxPerCallUSD)}`,
      `pick a tool priced at or under $${numToStr(maxPerCallUSD)}, or have a human raise maxPerCallUSD in data/policy.json`
    );
  }

  const chainArr = Array.isArray(input.delegationChain) ? input.delegationChain : [];
  for (let depth = 0; depth < chainArr.length; depth++) {
    const hop = chainArr[depth];
    const who = hop.label ?? "ancestor";

    if (hop.revoked) {
      return deny(
        "delegation_revoked",
        depth === 0 ? "delegation revoked by parent" : `ancestor delegation revoked ("${who}")`,
        "do not retry; this budget line was revoked — request a fresh grant from the parent wallet"
      );
    }
    if (hop.expired) {
      const expiresAt = hop.expiresAt ?? "";
      return deny(
        "delegation_expired",
        depth === 0 ? `delegation expired at ${expiresAt}` : `ancestor delegation expired ("${who}" at ${expiresAt})`,
        "do not retry; this was a time-boxed budget — request a fresh grant from the parent wallet"
      );
    }
    if (toolId && hop.allowedTools && !hop.allowedTools.includes(toolId)) {
      const level = depth === 0 ? "this wallet's delegated scope" : `the scope granted to ancestor "${who}"`;
      return deny(
        "tool_scope",
        `tool "${toolId}" is outside ${level} (allowed: ${hop.allowedTools.join(", ")})`,
        `retry with one of the allowed tools (${hop.allowedTools.join(", ")}), or ask the grantor to widen the scope`
      );
    }
    if (chain && hop.allowedChains && !hop.allowedChains.includes(chain)) {
      const level = depth === 0 ? "this wallet's delegated chain scope" : `the chain scope granted to ancestor "${who}"`;
      return deny(
        "chain_scope",
        `chain "${chain}" is outside ${level} (allowed: ${hop.allowedChains.join(", ")})`,
        `retry the same call on an allowed chain (${hop.allowedChains.join(", ")}), or ask the grantor to widen the chain scope`
      );
    }
    if (payee && hop.allowedPayees && !hop.allowedPayees.includes(payee)) {
      const level = depth === 0 ? "this wallet's delegated payee scope" : `the payee scope granted to ancestor "${who}"`;
      return deny(
        "payee_scope",
        `payee ${payeeRaw} is outside ${level} (allowed: ${hop.allowedPayees.join(", ")})`,
        "pay an allowed recipient, or ask the grantor to add this address to the payee scope"
      );
    }
    const capUSD = Number(hop.capUSD) || 0;
    const subtreeSpend = Number(hop.subtreeSpend) || 0;
    const periodSeconds = Number(hop.periodSeconds) || 0;
    if (subtreeSpend + price > capUSD) {
      const level = depth === 0 ? "" : ` granted to ancestor "${who}"`;
      const windowNote = periodSeconds > 0 ? ` in the current ${periodSeconds}s allowance window` : "";
      return deny(
        "delegation_cap",
        `would exceed delegated budget cap $${numToStr(capUSD)}${level} ($${toFixed4(subtreeSpend)} of it already spent${windowNote})`,
        `remaining budget on this line is $${toFixed4(Math.max(0, capUSD - subtreeSpend))} — pick a cheaper tool that fits, or request a top-up grant from "${who}"`
      );
    }
  }

  if (category && policy.categoryCapsUSD && policy.categoryCapsUSD[category] != null) {
    const cap = Number(policy.categoryCapsUSD[category]);
    const catSpent = Number(input.categorySpent) || 0;
    if (catSpent + price > cap) {
      return deny(
        "category_cap",
        `would exceed the hourly cap for category "${category}" ($${numToStr(cap)}; $${toFixed4(catSpent)} already spent)`,
        `wait for the hourly window, use a tool in another category, or raise categoryCapsUSD.${category}`
      );
    }
  }

  const recent = input.recent || { totalUSD: 0, count: 0 };
  const heldUSD = Number(input.heldUSD) || 0;
  const maxCallsPerHour = policy.maxCallsPerHour ?? 10;
  const maxPerHourUSD = policy.maxPerHourUSD ?? 0.2;

  if (recent.count + 1 > maxCallsPerHour) {
    return deny(
      "hourly_rate_cap",
      `would exceed maxCallsPerHour (${maxCallsPerHour})`,
      "wait for the hourly window to roll over before retrying, or have a human raise maxCallsPerHour"
    );
  }
  const committedUSD = recent.totalUSD + heldUSD;
  if (committedUSD + price > maxPerHourUSD) {
    const heldNote = heldUSD > 0 ? `, $${toFixed4(heldUSD)} held by open upto authorizations` : "";
    const releaseNote = heldUSD > 0 ? ", settle or void an open authorization to release its hold" : "";
    return deny(
      "hourly_usd_cap",
      `would exceed maxPerHourUSD $${numToStr(maxPerHourUSD)} (spent $${toFixed4(recent.totalUSD)} so far${heldNote})`,
      `only $${toFixed4(Math.max(0, maxPerHourUSD - committedUSD))} remains in this hour's budget — wait for the window to roll over${releaseNote}, or pick a cheaper tool`
    );
  }

  const requireApprovalAboveUSD = policy.requireApprovalAboveUSD ?? 0.015;
  return { allowed: true, requiresApproval: price > requireApprovalAboveUSD };
}
