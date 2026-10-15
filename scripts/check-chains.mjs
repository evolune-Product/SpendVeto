// Registry drift check against the live chains — `npm run check-chains`.
//
// Every EVM entry in shared-config.js makes four claims a typo can silently
// break: its chain id, its stablecoin contract, that the contract supports
// EIP-3009 (the transferWithAuthorization path x402's `exact` scheme signs),
// and the contract's EIP-712 domain (name, version) that signature is bound
// to. This script asks each chain's own RPC. It found, on its first run
// (2026-10-15), that every Circle mainnet USDC signs as "USD Coin" while the
// gate was hardcoding "USDC" — a bug no local test could see, because the
// truth lives on-chain.
//
// Not part of `npm run verify`: it needs the network, and a public RPC being
// down must never fail the suite a fresh clone runs. Run it whenever the
// registry changes. Exit code 1 if any chain disagrees with the registry; a
// chain whose RPC is unreachable is reported as UNREACHABLE, not as a pass.
import { keccak256, toHex, encodeAbiParameters } from "viem";
import { CHAINS } from "../shared-config.js";

const rpc = async (url, method, params) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const abiString = (hex) => {
  const b = Buffer.from(hex.slice(2), "hex");
  const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex")));
  return b.subarray(64, 64 + len).toString("utf8");
};
const domainSeparator = (name, version, chainId, verifyingContract) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toHex(name)), keccak256(toHex(version)), chainId, verifyingContract]
    )
  );

let failed = 0;
let unreachable = 0;
for (const c of CHAINS.filter((c) => !c.family)) {
  const problems = [];
  try {
    const chainId = BigInt(await rpc(c.rpc, "eth_chainId", []));
    if (chainId !== BigInt(c.caip2.split(":")[1])) problems.push(`eth_chainId ${chainId} ≠ ${c.caip2}`);
    if (c.chainIdHex && BigInt(c.chainIdHex) !== chainId) problems.push(`chainIdHex ${c.chainIdHex} ≠ ${chainId}`);
    const call = (data) => rpc(c.rpc, "eth_call", [{ to: c.usdc, data }, "latest"]);
    const decimals = parseInt(await call("0x313ce567"), 16);
    if (decimals !== 6) problems.push(`decimals ${decimals}, the gate prices in 6`);
    const symbol = abiString(await call("0x95d89b41"));
    const expected = c.stablecoin || "USDC";
    if (symbol !== expected) problems.push(`symbol "${symbol}" ≠ "${expected}"`);
    // authorizationState(address,bytes32) exists only on EIP-3009 tokens.
    const auth = await call("0xe94a0102" + "0".repeat(128)).catch(() => null);
    if (!auth || auth.length < 66) problems.push("no EIP-3009 authorizationState — x402 exact can't settle this token");
    const sep = await call("0x3644e515").catch(() => null);
    if (!c.eip712) problems.push("registry has no eip712 domain");
    else if (!sep) problems.push("token exposes no DOMAIN_SEPARATOR() to check the eip712 domain against");
    else if (domainSeparator(c.eip712.name, c.eip712.version, chainId, c.usdc) !== sep) problems.push(`eip712 ${JSON.stringify(c.eip712)} does not reproduce the token's DOMAIN_SEPARATOR`);
    if (problems.length) failed++;
    console.log(`${problems.length ? "DRIFT" : "OK   "} ${c.id.padEnd(14)} ${c.caip2.padEnd(16)} ${symbol}/${decimals} ${c.eip712 ? `${c.eip712.name} v${c.eip712.version}` : ""}${problems.length ? "\n      " + problems.join("\n      ") : ""}`);
  } catch (err) {
    unreachable++;
    console.log(`UNREACHABLE ${c.id.padEnd(14)} ${c.rpc} — ${err.message.slice(0, 80)}`);
  }
}
console.log(`\n${failed ? `${failed} chain(s) drifted from the registry` : "no drift"}${unreachable ? `; ${unreachable} unreachable (not checked)` : ""}`);
process.exit(failed ? 1 : 0);
