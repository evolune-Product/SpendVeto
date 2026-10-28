import "../../styles/pages.css";
import "./x402-spending-limits.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "x402 Spending Limits for AI Agent Payments | SpendVeto",
  "description": "Per-call caps, hourly budgets, approvals and payee and chain allowlists for agents paying with x402, enforced by the payment gate on 20 chains.",
  "path": "/guides/x402-spending-limits",
  "ogTitle": "How to put spending limits on x402 agent payments",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/x402-spending-limits#article",
          "headline": "How to put spending limits on x402 agent payments",
          "description": "Per-call caps, hourly budgets, approvals and payee and chain allowlists for agents paying with x402, enforced by the payment gate on 20 chains.",
          "url": "https://spendveto.com/guides/x402-spending-limits",
          "datePublished": "2026-10-18",
          "dateModified": "2026-10-19",
          "author": {
            "@type": "Organization",
            "@id": "https://spendveto.com/#org",
            "name": "SpendVeto"
          },
          "publisher": {
            "@type": "Organization",
            "@id": "https://spendveto.com/#org",
            "name": "SpendVeto"
          },
          "about": [
            "x402",
            "agent payments",
            "stablecoin spend control"
          ],
          "proficiencyLevel": "Beginner"
        },
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
              "name": "Guides",
              "item": "https://spendveto.com/guides"
            },
            {
              "@type": "ListItem",
              "position": 3,
              "name": "x402 spending limits",
              "item": "https://spendveto.com/guides/x402-spending-limits"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to put spending limits on x402 agent payments",
          "description": "Write the limits into a SpendVeto policy — per-call cap, hourly budget, call rate, approval threshold, allowed chains and payees — and pay through SpendVeto's SDK, MCP server or proxy. Policy is checked before anything is signed, and the payment gate re-checks it server-side, so an agent with its own key and a hand-rolled client still can't overspend.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto"
            },
            {
              "@type": "HowToTool",
              "name": "x402"
            }
          ],
          "step": [
            {
              "@type": "HowToStep",
              "position": 1,
              "name": "Write the policy",
              "text": "maxPerCallUSD, maxPerHourUSD, maxCallsPerHour, requireApprovalAboveUSD, allowedChains, allowedPayees, categoryCapsUSD, allowedHoursUTC."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Validate it",
              "text": "spendveto validate policy.json — typos and unregistered chain ids are errors."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Pay through the governed path",
              "text": "SDK pay(), the MCP server, or the keyless proxy run policy → approval → payment."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Delegate smaller budgets",
              "text": "npm run delegate -- 0.03 \"intern\" --tools translate --chains base-sepolia gives a sub-agent a capped, scoped allowance."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "How do I limit an AI agent's x402 payments?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Give it a policy (per-call cap, hourly budget, approval threshold, allowlists) and pay through a governed path that checks the policy before signing and again at the payment gate."
              }
            },
            {
              "@type": "Question",
              "name": "Which chains are supported?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Twenty registered chains across eight signature families; on-chain settlement is live on six testnets through x402's public facilitator, and the rest settle locally until a facilitator supports them."
              }
            },
            {
              "@type": "Question",
              "name": "What if the agent holds its own private key?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "The payment gate re-runs the policy server-side and requires a real, single-use approval above the threshold, so a client that skips its own checks is still refused."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function X402SpendingLimitsPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs"><a href="/">SpendVeto</a> / <a href="/guides">Guides</a> / x402 spending limits</p>
        <h1>How to put spending limits on x402 agent payments</h1>
        <p className="answer">
          Write the limits into a SpendVeto policy — per-call cap, hourly budget, call rate, approval threshold, allowed chains and payees — and pay through SpendVeto's SDK, MCP server or proxy. Policy is checked before anything is signed, and the payment gate re-checks it server-side, so an agent with its own key and a hand-rolled client still can't overspend.
        </p>
        <h2>The policy</h2>
        <pre className="term">
          {"{\n  \"$schema\": \"https://spendveto.com/schemas/policy-v1.json\",\n  \"maxPerCallUSD\": 0.25,\n  \"maxPerHourUSD\": 2,\n  \"maxCallsPerHour\": 60,\n  \"requireApprovalAboveUSD\": 0.10,\n  \"allowedChains\": [\"base\", \"solana-devnet\"],\n  \"allowedPayees\": [\"0xVendorA…\", \"vendor.eth\"],\n  \"categoryCapsUSD\": { \"data\": 1 },\n  \"anomaly\": { \"burstAttempts\": 20, \"burstWindowSeconds\": 10 }\n}"}
        </pre>
        <h2>What is enforced, and where</h2>
        <ul>
          <li>
            <b>Before signing</b>
            : the agent's own pipeline runs the full check (freeze, OFAC sanctions screening, chain and payee allowlists, trading hours, caps, delegation scopes) and asks a human above the approval line, failing closed on timeout.
          </li>
          <li>
            <b>At the payment gate</b>
            : the server re-runs the same policy and consumes the single-use approval, so a client that skips its own check is still refused.
          </li>
          <li>
            <b>Holds</b>
            : an open{" "}
            <code>upto</code>
            {" "}ceiling or{" "}
            <code>auth-capture</code>
            {" "}escrow counts against the hourly budget until it settles.
          </li>
          <li>
            <b>Proof for the seller</b>
            : the payment carries a{" "}
            <a className="inline" href="/guides/verify-governed-ai-agents">governed-spend attestation</a>
            .
          </li>
          <li>
            <b>Around the gate</b>
            : governed wallets are reconciled against their on-chain USDC transfers; a payment SpendVeto never authorized counts against the same budget and delegation caps, and can freeze the wallet.
          </li>
        </ul>
        <h2>How this differs from wallet-level limits</h2>
        <p>
          Wallet providers offer allowances on their own wallets. Coinbase's{" "}
          <a className="inline" href="https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions" rel="noopener">
            Spend Permissions
          </a>
          {" "}grant an allowance per period, and its Agentic Wallets cap per session and per transaction. SpendVeto's policy is wallet-agnostic and covers 20 chains across eight signature families. It adds human approvals, payee allowlists with ENS names, delegated budgets that cascade, and the same budget for the agent's model and card spend.
        </p>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>How do I limit an AI agent's x402 payments?</summary>
            <p>
              Give it a policy (per-call cap, hourly budget, approval threshold, allowlists) and pay through a governed path that checks the policy before signing and again at the payment gate.
            </p>
          </details>
          <details>
            <summary>Which chains are supported?</summary>
            <p>
              Twenty registered chains across eight signature families; on-chain settlement is live on six testnets through x402's public facilitator, and the rest settle locally until a facilitator supports them.
            </p>
          </details>
          <details>
            <summary>What if the agent holds its own private key?</summary>
            <p>
              The payment gate re-runs the policy server-side and requires a real, single-use approval above the threshold, so a client that skips its own checks is still refused.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/ai-agent-card-controls">
            AI agent card controls
            <span>
              Real-time decisions on Stripe Issuing and Lithic swipes: caps, daily budgets, velocity, MCC blocks, kill switch.
            </span>
          </a>
          <a href="/guides/human-approval-agent-payments">
            Human approval for agent payments
            <span>
              Threshold and new-payee approvals that fail closed, are single-use, and can require two approvers.
            </span>
          </a>
          <a href="/guides/verify-governed-ai-agents">
            Verify governed agents (sellers)
            <span>
              Sellers verify a signed attestation that the buyer's policy allowed the payment — offline, one middleware.
            </span>
          </a>
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/console/">Open the console demo</a>
        </div>
        <p className="meta">Updated 2026-10-19 · SpendVeto v0.31.0</p>
      </article>
    </Page>
  );
}
