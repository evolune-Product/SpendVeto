// First-class sanctions/denylist screening: checks a payee address against OFAC's real, published
// Specially Designated Nationals (SDN) list digital-currency-address entries, deterministically and
// locally — no live API call on the enforcement path, no network dependency at decision time. The
// local cache (data/sanctions/ofac-digital-currency.json) is built by scripts/fetch-sanctions-list.mjs
// against OFAC's actual Sanctions List Service (https://sanctionslistservice.ofac.treas.gov), not a
// synthetic sample pretending to be the real thing — see that script's header for provenance.
//
// Classification is by the ADDRESS'S OWN FORMAT, not by which chain OFAC happened to tag it with —
// verified necessary, not a design preference: the real list's own "USDT" tag mixes genuine EVM
// (0x...) addresses with Tron (base58, "T...") addresses under one label, so trusting OFAC's tag
// to decide chain applicability would misclassify real entries. An EVM-format address is screened
// against every SpendVeto EVM chain (Base, Polygon, Arbitrum, Optimism, Avalanche, Arc, Ethereum)
// regardless of which EVM chain OFAC observed it on, because the same 0x address space is valid on
// all of them — not screening every EVM chain would be a real evasion vector (pay the sanctioned
// address on a chain OFAC didn't happen to tag).
//
// What this is NOT: a complete sanctions compliance program. It screens addresses against ONE list
// (OFAC SDN digital currency addresses) by exact match only — no name screening, no the
// Consolidated (non-SDN) list, no EU/UN/UK lists, no fuzzy/alias matching, no beneficial-ownership
// tracing through intermediate wallets. A real compliance program needs all of that; this is the
// one piece that's directly actionable against a blockchain payee address, which is what SpendVeto
// actually governs. The list must be refreshed periodically (npm run sanctions:update) — this
// module never fetches live, and an operator who never refreshes it is screening against a stale
// snapshot, which it reports honestly (see sanctionsListStatus) rather than silently.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dataPath } from "../shared-config.js";

const LIST_PATH = dataPath("sanctions", "ofac-digital-currency.json");

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const XRP_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// SpendVeto's own registered chains, mapped to the address-format family that determines which
// OFAC entries apply — see shared-config.js for the authoritative chain registry this mirrors.
// Chains with no current OFAC digital-currency coverage (aptos, stellar, hedera, algorand, cardano)
// are deliberately absent, not silently mapped to the wrong family — screenAddress reports
// "unsupported_chain_family" for them rather than guessing.
const CHAIN_FAMILY = {
  "base-sepolia": "evm",
  base: "evm",
  ethereum: "evm",
  polygon: "evm",
  arbitrum: "evm",
  optimism: "evm",
  avalanche: "evm",
  "arc-testnet": "evm",
  "solana-devnet": "solana",
  xrpl: "xrp",
};

let cached = null;
let cacheReadAt = 0;
const CACHE_TTL_MS = 60 * 1000; // re-read the file at most once a minute; the list changes on operator refresh, not per-request

function loadList() {
  const now = Date.now();
  if (cached !== null && now - cacheReadAt < CACHE_TTL_MS) return cached;
  if (!existsSync(LIST_PATH)) {
    cached = { loaded: false };
    cacheReadAt = now;
    return cached;
  }
  try {
    const raw = JSON.parse(readFileSync(LIST_PATH, "utf8"));
    cached = { loaded: true, ...raw };
  } catch {
    cached = { loaded: false, error: "sanctions list cache exists but failed to parse" };
  }
  cacheReadAt = now;
  return cached;
}

// Canonicalizes on the ORIGINAL casing, never a pre-lowercased string — EVM addresses are
// case-insensitive by convention (lowercased here, matching how client/policy.js treats every
// other payee comparison), but base58 formats (Solana, XRP) are case-SENSITIVE, and lowercasing
// one first can turn a valid address into something that no longer matches its own format: base58
// excludes '0','O','I','l' specifically to avoid visual ambiguity, so an uppercase 'L' in a real
// address becomes an excluded lowercase 'l' after a blind .toLowerCase() — corrupting the address
// before it's even classified. (This was a real bug here, caught by testing against a real
// SDN-listed Solana address that contains an 'L' — it silently failed to screen until fixed.) Must
// stay in lockstep with scripts/fetch-sanctions-list.mjs's identical canonicalizeAddress, or an
// address stored under one casing rule and looked up under another would silently never match.
function canonicalizeAddress(rawAddress) {
  if (EVM_ADDRESS.test(rawAddress)) return { address: rawAddress.toLowerCase(), family: "evm" };
  if (XRP_ADDRESS.test(rawAddress)) return { address: rawAddress, family: "xrp" };
  if (SOLANA_ADDRESS.test(rawAddress)) return { address: rawAddress, family: "solana" };
  return { address: rawAddress, family: null };
}

// Status for dashboards/ops — answers "is screening actually active, and against what, as of
// when" rather than leaving an operator to assume a loaded-looking module means a current list.
export function sanctionsListStatus() {
  const list = loadList();
  if (!list.loaded) {
    return { active: false, reason: list.error || "no local sanctions list cache — run `npm run sanctions:update`" };
  }
  return {
    active: true,
    source: list.source,
    listPublishDate: list.listPublishDate,
    uniqueAddressCount: list.uniqueAddressCount,
    fetchedAt: list.fetchedAt,
    ageDays: list.fetchedAt ? Math.floor((Date.now() - new Date(list.fetchedAt).getTime()) / 86400000) : null,
  };
}

// Pure and deterministic given the loaded cache. Returns:
//   { sanctioned: false, screened: true, listStatus }                         — clean
//   { sanctioned: true,  screened: true, match: {...}, listStatus }           — hit
//   { sanctioned: false, screened: false, reason: "...", listStatus }         — couldn't screen (no list, or address/chain not in a known family)
// "screened: false" is never treated as "sanctioned: false, safe to proceed" by the caller — see
// client/policy.js's use of this: a payment is only allowed on an explicit screened:true, clean
// result, never on "couldn't check."
export function screenAddress(address, chain) {
  const listStatus = sanctionsListStatus();
  if (!address || typeof address !== "string") {
    return { sanctioned: false, screened: false, reason: "no address supplied", listStatus };
  }
  if (!listStatus.active) {
    return { sanctioned: false, screened: false, reason: listStatus.reason, listStatus };
  }

  const { address: canonical, family: actualFamily } = canonicalizeAddress(address);
  const expectedFamily = chain ? CHAIN_FAMILY[chain] : undefined;
  if (chain && expectedFamily === undefined) {
    // A registered SpendVeto chain with no current OFAC digital-currency coverage for its family
    // (aptos/stellar/hedera/algorand/cardano today) — honestly "not screened", not "clean".
    return { sanctioned: false, screened: false, reason: `no OFAC digital-currency-address coverage mapped for chain "${chain}"`, listStatus };
  }
  if (!actualFamily) {
    return { sanctioned: false, screened: false, reason: "address format not recognized as EVM, Solana, or XRP", listStatus };
  }

  const list = loadList();
  const hits = list.addresses?.[canonical];
  if (!hits || hits.length === 0) {
    return { sanctioned: false, screened: true, listStatus };
  }
  // A hit is a hit regardless of which specific OFAC token tag it carries — see module header on
  // why the tag alone isn't trusted for chain applicability, only for the match provenance here.
  return {
    sanctioned: true,
    screened: true,
    match: { address: canonical, entries: hits },
    listStatus,
  };
}
