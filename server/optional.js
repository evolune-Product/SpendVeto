// Optional chain SDKs — what keeps `npx spendveto` fast.
//
// SpendVeto's own trust primitives (receipts, attestations, reputation feeds,
// the hash-chained ledger) are EIP-191 signatures, so viem is the only chain
// library the engine needs. The x402 LIVE settlement rails are different: each
// chain family brings its own SDK, and together they were most of the install —
// 480 of 630 packages, ~700 MB and 77 s from a clean cache, with Hedera's SDK
// alone pulling in React Native and Metro — for a feature most users never
// switch on. So they are optional peer dependencies. The default install
// carries the LLM spend guard, the policy engine, approvals, cards, payouts and
// the MCP server, and the code that settles on a chain loads that chain's
// packages at the moment it needs them. A missing package is an error that
// names the install command: never a crash at boot, never a silent fallback to
// a different chain.
//
// A git checkout installs every family (they are devDependencies too), so
// `npm run verify` and testnet mode from a clone behave exactly as before.

// Every live x402 settlement needs these four: the protocol core, the client's
// paying fetch, the server's Express gate, and the EVM scheme (Base Sepolia is
// the gate's fallback chain, so EVM is never optional once x402 is on).
const X402_BASE = ["@x402/core", "@x402/fetch", "@x402/express", "@x402/evm"];

// Each non-EVM family adds its x402 scheme package plus the chain SDK that
// client/wallet.js uses to make that chain's keypair. Install them side by side
// in one tree (a project, or a clone): two copies of a chain SDK — one beside
// spendveto, one nested under its @x402 package — can disagree about whose key
// object is whose.
const FAMILY_PACKAGES = {
  evm: [],
  svm: ["@x402/svm", "@solana/kit"],
  aptos: ["@x402/aptos", "@aptos-labs/ts-sdk"],
  stellar: ["@x402/stellar", "@stellar/stellar-sdk"],
  hedera: ["@x402/hedera", "@hiero-ledger/sdk"],
  xrpl: ["@x402/xrpl", "xrpl"],
};

export const RAIL_FAMILIES = Object.keys(FAMILY_PACKAGES);
export const OPTIONAL_PACKAGES = [...X402_BASE, ...Object.values(FAMILY_PACKAGES).flat()];

// "@x402/evm/exact/server" → "@x402/evm"; "xrpl" → "xrpl".
export function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function familyOf(pkg) {
  return RAIL_FAMILIES.find((f) => FAMILY_PACKAGES[f].includes(pkg)) || "evm";
}

export function packagesFor(family) {
  if (!(family in FAMILY_PACKAGES)) throw new Error(`unknown rail family "${family}" — known: ${RAIL_FAMILIES.join(", ")}`);
  return [...X402_BASE, ...FAMILY_PACKAGES[family]];
}

export function installCommand(packages) {
  return `npm install ${packages.join(" ")}`;
}

export class RailPackageMissing extends Error {
  constructor(pkg, family) {
    const packages = packagesFor(family);
    super(
      `the x402 ${family === "evm" ? "" : `${family} `}rail needs ${pkg}, which isn't installed. Chain SDKs are optional so the default install stays small — ` +
        `add them next to spendveto: ${installCommand(packages)} (or run from a clone of the repo, where npm install brings every rail)`
    );
    this.code = "rail_package_missing";
    this.package = pkg;
    this.family = family;
    this.packages = packages;
    this.install = installCommand(packages);
  }
}

// Load an optional rail package (or one of its subpaths). Only the package
// itself being absent becomes RailPackageMissing: a package that IS installed
// but fails inside — a missing transitive dependency, a bad build — keeps its
// real error, so a broken install is never misreported as an uninstalled one.
export async function loadOptional(specifier) {
  const pkg = packageName(specifier);
  if (!OPTIONAL_PACKAGES.includes(pkg)) throw new Error(`${pkg} is not one of the optional rail packages`);
  try {
    return await import(specifier);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(`'${pkg}'`)) throw new RailPackageMissing(pkg, familyOf(pkg));
    throw err;
  }
}

// Resolution only — nothing is imported, so asking costs no SDK load time.
export function isInstalled(pkg) {
  try {
    import.meta.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

export function railFamilies() {
  return RAIL_FAMILIES.map((family) => {
    const packages = packagesFor(family);
    const missing = packages.filter((p) => !isInstalled(p));
    return { family, installed: missing.length === 0, missing, install: installCommand(packages) };
  });
}
