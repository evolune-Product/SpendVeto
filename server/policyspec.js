// The SpendVeto policy file as an open, versioned standard: a JSON Schema
// (spec/policy-v1.schema.json, served at spendveto.com/schemas/policy-v1.json)
// plus this validator, which the API (POST /api/policy/validate), the CLI
// (`spendveto validate`) and CI all share.
//
// Why a validator at all: a typo in a policy file fails OPEN. "maxPerHourUsd"
// is not "maxPerHourUSD" — the engine never reads it, the default applies, and
// the agent runs on a budget nobody wrote. Strict keys catch that, with a
// did-you-mean.
//
// The validator implements exactly the JSON Schema keywords the schema uses
// and refuses to load a schema that uses any other — a keyword it silently
// ignored would be a rule nobody enforces. Other JSON Schema tools read the
// same file unchanged; semantic checks the schema can't express (registered
// chain ids, caps that contradict each other) are layered on top here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHAINS } from "../shared-config.js";
import { MPP_NETWORK_IDS } from "./mpp.js";

export const POLICY_SCHEMA_PATH = fileURLToPath(new URL("../spec/policy-v1.schema.json", import.meta.url));
export const POLICY_SCHEMA_ID = "https://spendveto.com/schemas/policy-v1.json";

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "$defs", "title", "description"]);
const ASSERTIONS = new Set(["$ref", "type", "enum", "properties", "patternProperties", "additionalProperties", "required", "items", "minItems", "maxItems", "uniqueItems", "minimum", "maximum", "exclusiveMinimum", "pattern", "minLength", "maxLength"]);
export const SUPPORTED_KEYWORDS = [...ANNOTATIONS, ...ASSERTIONS];

let cached = null;
export function loadPolicySchema() {
  if (!cached) {
    cached = JSON.parse(readFileSync(POLICY_SCHEMA_PATH, "utf8"));
    const unsupported = unsupportedKeywords(cached);
    if (unsupported.length) throw new Error(`policy schema uses keywords this validator does not implement: ${unsupported.join(", ")}`);
  }
  return cached;
}

// Every keyword used anywhere in a schema that this validator doesn't
// implement. Property NAMES inside properties/patternProperties/$defs are
// data, not keywords, so those maps are walked one level down.
export function unsupportedKeywords(schema) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (!ANNOTATIONS.has(k) && !ASSERTIONS.has(k)) found.add(k);
      if (k === "properties" || k === "patternProperties" || k === "$defs") for (const sub of Object.values(v || {})) walk(sub);
      else if (k === "items" || k === "additionalProperties") walk(v);
    }
  };
  walk(schema);
  return [...found].sort();
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeMatches = (v, t) => t === typeOf(v) || (t === "number" && typeof v === "number" && Number.isFinite(v));
const pointer = (path) => (path.length ? "/" + path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/") : "/");

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function suggestion(key, known) {
  const exact = known.find((k) => k.toLowerCase() === key.toLowerCase());
  if (exact) return exact;
  let best = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = levenshtein(key.toLowerCase(), k.toLowerCase());
    if (d < bestD) [best, bestD] = [k, d];
  }
  return bestD <= Math.max(2, Math.floor(key.length / 4)) ? best : null;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`only local $refs are supported, got ${ref}`);
  return ref.slice(2).split("/").reduce((n, seg) => n?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

function validateNode(value, schema, path, root, errors) {
  if (schema.$ref) return validateNode(value, resolveRef(root, schema.$ref), path, root, errors);
  const at = pointer(path);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push({ path: at, message: `must be ${types.join(" or ")}, got ${typeOf(value)}` });
      return;
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push({ path: at, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push({ path: at, message: `must be ≥ ${schema.minimum}` });
    if (schema.maximum != null && value > schema.maximum) errors.push({ path: at, message: `must be ≤ ${schema.maximum}` });
    if (schema.exclusiveMinimum != null && !(value > schema.exclusiveMinimum)) errors.push({ path: at, message: `must be > ${schema.exclusiveMinimum}` });
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push({ path: at, message: `must be at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}` });
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push({ path: at, message: `must match ${schema.pattern}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push({ path: at, message: `needs at least ${schema.minItems} item(s)` });
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push({ path: at, message: `allows at most ${schema.maxItems} items` });
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push({ path: at, message: "items must be unique" });
    if (schema.items) value.forEach((item, i) => validateNode(item, schema.items, [...path, i], root, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const req of schema.required || []) if (!(req in value)) errors.push({ path: at, message: `missing required key "${req}"` });
    const props = schema.properties || {};
    const patterns = Object.entries(schema.patternProperties || {}).map(([p, s]) => [new RegExp(p, "u"), s]);
    for (const [k, v] of Object.entries(value)) {
      let matched = false;
      if (props[k]) {
        validateNode(v, props[k], [...path, k], root, errors);
        matched = true;
      }
      for (const [re, s] of patterns) {
        if (re.test(k)) {
          validateNode(v, s, [...path, k], root, errors);
          matched = true;
        }
      }
      if (matched) continue;
      if (schema.additionalProperties === false) {
        const near = suggestion(k, Object.keys(props));
        errors.push({ path: pointer([...path, k]), message: `unknown key "${k}" — the engine never reads it, so whatever it was meant to limit is not limited${near ? `; did you mean "${near}"?` : ""}` });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateNode(v, schema.additionalProperties, [...path, k], root, errors);
      }
    }
  }
}

// Checks the schema can't state: references to things that must exist, and
// limits that contradict each other (legal JSON, but almost always a mistake).
function semanticChecks(p, errors, warnings) {
  // MPP's Tempo networks are chains a policy can allow too (server/mpp.js), though x402 never settles there.
  const chainIds = new Set([...CHAINS.map((c) => c.id), ...MPP_NETWORK_IDS]);
  if (Array.isArray(p.allowedChains)) {
    p.allowedChains.forEach((c, i) => {
      if (typeof c === "string" && !chainIds.has(c)) errors.push({ path: `/allowedChains/${i}`, message: `"${c}" is not a registered chain id (see GET /api/chains)` });
    });
  }
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  if (num(p.maxPerCallUSD) && num(p.maxPerHourUSD) && p.maxPerCallUSD > p.maxPerHourUSD) {
    warnings.push({ path: "/maxPerCallUSD", message: `per-call cap $${p.maxPerCallUSD} is above the hourly cap $${p.maxPerHourUSD}, so the hourly cap is the real per-call limit` });
  }
  if (num(p.requireApprovalAboveUSD) && num(p.maxPerCallUSD) && p.requireApprovalAboveUSD >= p.maxPerCallUSD) {
    warnings.push({ path: "/requireApprovalAboveUSD", message: `approval threshold $${p.requireApprovalAboveUSD} is at or above the per-call cap $${p.maxPerCallUSD}, so no payment will ever reach a human` });
  }
  if (p.allowedHoursUTC && p.allowedHoursUTC.start === p.allowedHoursUTC.end) {
    warnings.push({ path: "/allowedHoursUTC", message: "start equals end: the window is empty and nothing can spend" });
  }
  if (num(p.llm?.hourlyBudgetUSD) && num(p.llm?.dailyBudgetUSD) && p.llm.hourlyBudgetUSD > p.llm.dailyBudgetUSD) {
    warnings.push({ path: "/llm/hourlyBudgetUSD", message: `hourly model budget $${p.llm.hourlyBudgetUSD} is above the daily budget $${p.llm.dailyBudgetUSD}` });
  }
  if (num(p.payouts?.requireApprovalAboveUSD) && num(p.payouts?.maxPerPayoutUSD) && p.payouts.requireApprovalAboveUSD >= p.payouts.maxPerPayoutUSD) {
    warnings.push({ path: "/payouts/requireApprovalAboveUSD", message: "payout approval threshold is at or above the per-payout cap, so only new payees ever reach a human" });
  }
}

export function validatePolicy(policy) {
  const schema = loadPolicySchema();
  const errors = [];
  const warnings = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    errors.push({ path: "/", message: `a policy is a JSON object, got ${typeOf(policy)}` });
  } else {
    validateNode(policy, schema, [], schema, errors);
    semanticChecks(policy, errors, warnings);
  }
  return { valid: errors.length === 0, schema: POLICY_SCHEMA_ID, errors, warnings };
}
