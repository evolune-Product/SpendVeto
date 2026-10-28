import "../styles/pages.css";
import "./security.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "x402 Security — How SpendVeto Protects AI Agent Wallets From Overspending",
  "description": "Every SpendVeto control that guards AI agent wallets: policy enforcement before payment, chain-scoped signatures, request-integrity binding, tamper-evident ledger, and how to report an x402 or AI agent payment vulnerability.",
  "path": "/security",
  "keywords": "x402 security, AI agent security, AI agent wallet security, prevent AI agent overspending, x402 vulnerability, AI agent payment risk",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "name": "SpendVeto",
              "item": "https://spendveto.com/"
            },
            {
              "@type": "ListItem",
              "position": 2,
              "name": "Security",
              "item": "https://spendveto.com/security"
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "How does SpendVeto secure x402 AI agent payments?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Policy caps, human approvals, and payee allowlists are checked against the live ledger before any payment signature is produced. Chain-scoped signatures make an authorization signed for one chain cryptographically invalid on another. Request-integrity binding ties an authorization to a canonical digest of the exact request it was granted for, so a payload swapped between decision and execution is refused even when the payer, price, and approval all still match."
              }
            },
            {
              "@type": "Question",
              "name": "Has SpendVeto been through an external security audit?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "No. SpendVeto is pre-audit software: simulate mode (the default) uses real ECDSA against a local ledger with no real funds moving, and testnet mode settles real x402 transactions on public testnets. XRPL mainnet settlement is wired but disabled by default — an operator must explicitly opt in, entirely at their own risk. Treat it as pre-audit software until an audit has happened."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function SecurityPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="doc-wrap">
        <h1>Security</h1>
        <p className="lede">
          SpendVeto sits between an agent and its money. That's a position that has to earn trust with evidence, not adjectives. Here's exactly what's enforced, what isn't yet, and how to report a problem.
        </p>
        <h2>What's enforced today</h2>
        <ul>
          <li>
            <b>Policy before payment.</b>
            {" "}Per-call caps, hourly budgets, call-rate limits, and chain/tool scope are checked against the live ledger before any signature is produced — not after.
          </li>
          <li>
            <b>Approvals fail closed.</b>
            {" "}A spend above your threshold pauses for a human decision. No answer within the timeout window means the call is denied, not allowed by default.
          </li>
          <li>
            <b>Nested budget hierarchies.</b>
            {" "}A delegated child's spend counts against its own cap{" "}
            <i>and</i>
            {" "}every ancestor's — a compromised or misbehaving sub-agent can't spend past what its parent was ever granted.
          </li>
          <li>
            <b>Chain-scoped signatures.</b>
            {" "}The chain is inside the signed payment message itself, so an authorization signed for one chain is cryptographically invalid on another — not just filtered by convention.
          </li>
          <li>
            <b>Runaway auto-freeze.</b>
            {" "}A wallet bursting past its call-rate threshold is frozen automatically, mid-loop, without waiting for a human to notice.
          </li>
          <li>
            <b>ECDSA-signed receipts.</b>
            {" "}Every settlement produces an independently verifiable signed receipt; the full ledger exports to CSV for reconciliation.
          </li>
          <li>
            <b>Server-authoritative enforcement.</b>
            {" "}The payment gate runs the full policy pipeline itself, server-side — so an agent holding its own key and running a hand-rolled client that skips its policy check still can't overspend: a validly-signed over-budget payment is refused at the gate, and above-threshold spends require a real, single-use approval record before settlement.
          </li>
          <li>
            <b>Tamper-evident ledger.</b>
            {" "}Every ledger entry is hash-chained to the one before it, so editing, deleting, or reordering any historical row is detectable; a verify-chain endpoint reports the first broken row.
          </li>
          <li>
            <b>Payee allowlisting.</b>
            {" "}Pin which recipient addresses an agent may pay at all — so even a compromised tool or a prompt-injected agent can't send money to an address that isn't on the list. Works globally and as a delegated scope that cascades through the budget tree.
          </li>
          <li>
            <b>Request integrity.</b>
            {" "}Every other control here answers "is this spend allowed?" — this one answers "is this the spend I{" "}
            <i>allowed</i>
            ?". An authorization is bound to a canonical digest of the exact request it was granted for, so a payload changed between the decision and the execution is refused even though the payer, the price and the approval all still match. Bindings are single-use, time-bounded, and valid only for the agent they were issued to.
          </li>
          <li>
            <b>Token scope, not just token validity.</b>
            {" "}A shared payment token (ACP) or a signed intent (AP2) is minted for a purpose: an amount, a merchant, a window. The merchant validates the token; nobody validates the shopping. SpendVeto checks the session or cart against the credential that funds it — wrong merchant, out-of-scope category, a declared total its own line items don't add up to, or a ceiling quoted in a different currency than the charge.
          </li>
          <li>
            <b>Dispute evidence packs.</b>
            {" "}An agent purchase produces no device fingerprint, no IP, no browsing session — the evidence a chargeback is normally defended with simply doesn't exist, so agent transactions lose by default. Every governed spend can be assembled into a signed bundle: the entry pinned between its neighbouring hashes, the policy version in force with any later drift disclosed, the human approval, and the signed consents behind the delegation. Each pack also states what it does{" "}
            <i>not</i>
            {" "}establish — it never implies delivery or satisfaction.
          </li>
          <li>
            <b>Spend around the gate is still counted.</b>
            {" "}An agent holding its own key can pay without asking — a direct transfer, another facilitator. Governed wallets are reconciled against their on-chain transfers, and a payment SpendVeto never authorized is booked against the same budget and delegation caps, alerted, and can freeze the wallet. Detection, not prevention: the keyless proxy below is how nothing gets around the gate.
          </li>
          <li>
            <b>Authenticated admin surface.</b>
            {" "}The endpoints that change policy, freeze wallets, mint budgets, or register tools sit behind bearer keys with roles (viewer / approver / admin). The first key is minted on the trusted host, never over the API, so there's no way to bootstrap privilege from an unauthenticated request.
          </li>
        </ul>
        <h2>Custody model</h2>
        <p>
          SpendVeto can run in two modes. In the default mode, the agent's own keypair signs payments locally after the policy pipeline approves — SpendVeto never holds funds. In the{" "}
          <b>keyless / proxy</b>
          {" "}mode, an enforcement proxy holds custody and signs on the agent's behalf only after governance passes, so an agent can operate without ever touching a private key. In both modes, no payment is possible without a policy decision.
        </p>
        <h2>What's not yet true</h2>
        <p>
          SpendVeto is a prototype.{" "}
          <b>Simulate mode</b>
          {" "}(the default) is real ECDSA against a local ledger — no real funds move.{" "}
          <b>Testnet mode</b>
          {" "}settles real x402 transactions on Base Sepolia, Solana devnet, Aptos testnet, Stellar testnet, and Hedera testnet.{" "}
          <b>XRPL mainnet settlement is wired but disabled by default</b>
          {" "}— real money, in RLUSD (XRPL has no canonical USDC) — an operator has to explicitly configure a payout address to turn it on, and doing so is entirely their own decision and their own risk; we don't run, monitor, or control anyone's deployment. None of this has been through an external security audit yet. Treat this as pre-audit software: don't point it at funds you can't afford to lose until an audit has happened.
        </p>
        <div className="callout">
          <b>Verification, not marketing:</b>
          {" "}every control above is exercised by an assertion in the 510-check suite (
          <span className="mono">npm run verify</span>
          ) on every change to the codebase — see{" "}
          <a href="/docs#verify" style={{ color: "var(--ink)" }}>the verification docs</a>
          .
        </div>
        <h2>Reporting a vulnerability</h2>
        <p>
          If you find a way to bypass a policy check, forge a payment signature, or defeat an approval gate, please report it privately before any public disclosure — email{" "}
          <a href="mailto:foundersoffice@evolune.in?subject=Security%20report" style={{ color: "var(--green)" }}>
            foundersoffice@evolune.in
          </a>
          {" "}(subject: "Security report"). We'll acknowledge within 48 hours.
        </p>
      </div>
    </Page>
  );
}
