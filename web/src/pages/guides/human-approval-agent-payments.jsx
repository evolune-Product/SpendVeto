import "../../styles/pages.css";
import "./human-approval-agent-payments.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "Human Approval for AI Agent Payments | SpendVeto",
  "description": "Pause agent payments above a threshold, or to a new payee, until a human approves. Approvals fail closed, are single-use, and can need two approvers.",
  "path": "/guides/human-approval-agent-payments",
  "ogTitle": "How to require human approval for AI agent payments",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/human-approval-agent-payments#article",
          "headline": "How to require human approval for AI agent payments",
          "description": "Pause agent payments above a threshold, or to a new payee, until a human approves. Approvals fail closed, are single-use, and can need two approvers.",
          "url": "https://spendveto.com/guides/human-approval-agent-payments",
          "datePublished": "2026-10-18",
          "dateModified": "2026-10-18",
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
            "human in the loop",
            "payment approvals",
            "agent payments"
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
              "name": "Human approval for agent payments",
              "item": "https://spendveto.com/guides/human-approval-agent-payments"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to require human approval for AI agent payments",
          "description": "Set an approval threshold in the policy and SpendVeto pauses any agent payment above it until a human approves in the Console. No answer in time means denied, never allowed. Payouts to a payee not on your allowlist always wait for a human, and an approval is single-use: it authorizes exactly one payment.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto"
            }
          ],
          "step": [
            {
              "@type": "HowToStep",
              "position": 1,
              "name": "Set the threshold",
              "text": "requireApprovalAboveUSD for x402 payments; payouts.requireApprovalAboveUSD and payouts.allowedPayees for fiat payouts; llm.approvalAboveUSD for expensive model calls."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Decide in the Console",
              "text": "Pending approvals appear on the Approvals page; approve or deny."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Harden it",
              "text": "approversRequired: 2 for two-person approval; requireWorldIdForApproval for proof of personhood."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "How do I add human-in-the-loop approval to an AI agent's payments?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Set an approval threshold in the policy; payments above it pause until a human approves in the Console, and time out as denied."
              }
            },
            {
              "@type": "Question",
              "name": "Can I require two people to approve?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes — approversRequired: 2. A single deny is final; an approval needs two distinct approvers."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function HumanApprovalAgentPaymentsPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs">
          <a href="/">SpendVeto</a>
          {" "}/{" "}
          <a href="/guides">Guides</a>
          {" "}/ Human approval for agent payments
        </p>
        <h1>How to require human approval for AI agent payments</h1>
        <p className="answer">
          Set an approval threshold in the policy and SpendVeto pauses any agent payment above it until a human approves in the Console. No answer in time means{" "}
          <b>denied</b>
          , never allowed. Payouts to a payee not on your allowlist always wait for a human, and an approval is single-use: it authorizes exactly one payment.
        </p>
        <h2>Where approvals apply</h2>
        <table className="t">
          <tbody>
            <tr><th>Spend</th><th>Pauses when</th><th>If nobody answers</th></tr>
            <tr>
              <td>x402 payments</td>
              <td>
                Price above{" "}
                <code>requireApprovalAboveUSD</code>
                , or the payee is flagged for review by reputation
              </td>
              <td>Fails closed after the agent's timeout</td>
            </tr>
            <tr>
              <td>Fiat payouts (Stripe, RazorpayX, PayPal, Modern Treasury)</td>
              <td>A new payee, or an amount above <code>payouts.requireApprovalAboveUSD</code></td>
              <td>Expires after 24 hours (configurable) and is never paid</td>
            </tr>
            <tr>
              <td>Model calls</td>
              <td>Estimated cost above <code>llm.approvalAboveUSD</code></td>
              <td>Refused after <code>approvalTimeoutMs</code></td>
            </tr>
          </tbody>
        </table>
        <pre className="term">
          {"{\n  \"$schema\": \"https://spendveto.com/schemas/policy-v1.json\",\n  \"requireApprovalAboveUSD\": 0.10,\n  \"approversRequired\": 2,\n  \"payouts\": { \"requireApprovalAboveUSD\": 500, \"allowedPayees\": [\"fa_vendor_1\"] },\n  \"llm\": { \"approvalAboveUSD\": 2 }\n}"}
        </pre>
        <h2>Why "fail closed" matters</h2>
        <p>
          An autonomous agent can't wait forever, and "no answer means yes" turns an approval flow into a delay. In SpendVeto a timeout is a denial. A deny is final the moment one approver makes it, and an approval lands only when enough distinct approvers have agreed. Approvals are consumed by the payment they authorize, so one approval can't be replayed against a second payment. The unauthenticated one-click links in alerts can never approve a real-money payout.
        </p>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>How do I add human-in-the-loop approval to an AI agent's payments?</summary>
            <p>
              Set an approval threshold in the policy; payments above it pause until a human approves in the Console, and time out as denied.
            </p>
          </details>
          <details>
            <summary>Can I require two people to approve?</summary>
            <p>
              Yes —{" "}
              <code>approversRequired: 2</code>
              . A single deny is final; an approval needs two distinct approvers.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/verify-governed-ai-agents">
            Verify governed agents (sellers)
            <span>
              Sellers verify a signed attestation that the buyer's policy allowed the payment — offline, one middleware.
            </span>
          </a>
          <a href="/guides/claude-code-spending-limit">
            Claude Code spending limit
            <span>
              Daily, hourly, per-request and per-session caps for interactive Claude Code, with one environment variable.
            </span>
          </a>
          <a href="/guides/openai-api-spending-limit">
            OpenAI API spending limit
            <span>
              Per-agent daily, hourly and per-request caps for Codex and the OpenAI SDKs, enforced before each request.
            </span>
          </a>
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/console/">Open the console demo</a>
        </div>
        <p className="meta">Updated 2026-10-18 · SpendVeto v0.29.0</p>
      </article>
    </Page>
  );
}
