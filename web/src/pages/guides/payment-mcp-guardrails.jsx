import "../../styles/pages.css";
import "./payment-mcp-guardrails.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "Guardrails for Razorpay, Stripe and PayPal MCP Servers | SpendVeto",
  "description": "Razorpay, Stripe, PayPal, Cashfree and Square MCP servers let AI agents refund and transfer money. Put budgets, approvals and a kill switch in front of them.",
  "path": "/guides/payment-mcp-guardrails",
  "ogTitle": "How to put guardrails on payment MCP servers (Razorpay, Stripe, PayPal)",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/payment-mcp-guardrails#article",
          "headline": "How to put guardrails on payment MCP servers",
          "description": "Razorpay, Stripe, PayPal, Cashfree and Square MCP servers let AI agents refund and transfer money. Put budgets, approvals and a kill switch in front of them.",
          "url": "https://spendveto.com/guides/payment-mcp-guardrails",
          "datePublished": "2026-10-23",
          "dateModified": "2026-10-23",
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
            "MCP",
            "Razorpay MCP server",
            "Stripe MCP server",
            "PayPal MCP server",
            "AI agent payments"
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
              "name": "Payment MCP guardrails",
              "item": "https://spendveto.com/guides/payment-mcp-guardrails"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to put guardrails on payment MCP servers",
          "description": "Launch spendveto guard in place of the provider's MCP server. The agent still sees Razorpay's, Stripe's or PayPal's own tools, but every call that isn't a read is decided by SpendVeto first: refunds and transfers are priced and checked against your budget, risky changes wait for a human, unknown tools are refused, and nothing but reads gets through if SpendVeto is down.",
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
              "name": "Run SpendVeto",
              "text": "npx spendveto starts the policy engine on 127.0.0.1:8402."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Swap the server in your MCP config",
              "text": "Replace the provider's server with: npx -y spendveto guard razorpay (or stripe, paypal, cashfree, square), keeping the provider's keys in env."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Set the limits",
              "text": "policy.mcpGuard: maxPerCallUSD, dailyBudgetUSD, requireApprovalAboveUSD; policy.payouts.fxRates for INR and other currencies."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Approve what needs a human",
              "text": "Risky changes and spends above the approval line wait in the SpendVeto Console; the agent repeats the call after approval."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "Which payment MCP servers does the guard support?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Razorpay, Stripe, PayPal, Cashfree and Square have built-in profiles, plus a generic profile for any other MCP server. Each profile knows which of the provider's tools read, collect money, move money out, or change something risky."
              }
            },
            {
              "@type": "Question",
              "name": "What happens when the agent asks for a refund above the limit?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "The guard refuses the call before the provider sees it and returns a tool error with a code and a fix. Above the approval line it waits for a human instead: they approve in the SpendVeto Console and the agent repeats the same call."
              }
            },
            {
              "@type": "Question",
              "name": "Does SpendVeto hold my Razorpay or Stripe keys?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "No. The keys stay in the guard's environment on your machine, the same place the provider's own MCP server would read them. SpendVeto's server only sees the tool name, its arguments and the decision."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function PaymentMcpGuardrailsPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs"><a href="/">SpendVeto</a> / <a href="/guides">Guides</a> / Payment MCP guardrails</p>
        <h1>How to put guardrails on payment MCP servers</h1>
        <p className="answer">
          Launch{" "}
          <code>spendveto guard</code>
          {" "}in place of the provider's MCP server. The agent still sees Razorpay's, Stripe's or PayPal's own tools, but every call that isn't a read is decided by SpendVeto first: refunds and transfers are priced and checked against your budget, risky changes wait for a human, unknown tools are refused, and nothing but reads gets through if SpendVeto is down.
        </p>
        <h2>Why this matters</h2>
        <p>
          Payment providers now publish MCP servers so AI agents can work with them directly: Razorpay launched India's first, and Stripe, PayPal, Cashfree and Square followed. With a merchant key, an agent can refund a payment, transfer to a connected account or accept a dispute in one tool call. The provider checks that the key is valid. Nobody checks whether the agent should be doing it, at that amount, today.
        </p>
        <h2>Swap one line in your MCP config</h2>
        <pre className="term">
          {"{\n  \"mcpServers\": {\n    \"razorpay\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"spendveto\", \"guard\", \"razorpay\"],\n      \"env\": {\n        \"RAZORPAY_KEY_ID\": \"rzp_live_…\",\n        \"RAZORPAY_KEY_SECRET\": \"…\",\n        \"SPENDVETO_AGENT\": \"support-agent\"\n      }\n    }\n  }\n}"}
        </pre>
        <p>
          Use{" "}
          <code>stripe</code>
          ,{" "}
          <code>paypal</code>
          ,{" "}
          <code>cashfree</code>
          {" "}or{" "}
          <code>square</code>
          {" "}the same way, or{" "}
          <code>generic --url …</code>
          {" "}for any other MCP server. The keys stay in the guard's environment on your machine; SpendVeto only sees the tool name, its arguments and the decision.
        </p>
        <h2>What the guard decides</h2>
        <table className="t">
          <tbody>
            <tr><th>Kind</th><th>Examples</th><th>Default</th></tr>
            <tr>
              <td>Read</td>
              <td><code>fetch_payment</code>, <code>list_*</code>, <code>stripe_api_read</code></td>
              <td>Passes through</td>
            </tr>
            <tr><td>Money in</td><td>Payment links, orders, invoices, captures</td><td>Allowed</td></tr>
            <tr>
              <td>Money out</td>
              <td>Refunds, transfers, payouts</td>
              <td>
                Priced in USD at your declared rate, then the per-call cap, daily budget, velocity limit and kill switch; a human above the approval line or for a new recipient
              </td>
            </tr>
            <tr>
              <td>Risky</td>
              <td>
                Accepting a dispute, cancelling a subscription, revoking a saved card, sweeping the balance to the bank
              </td>
              <td>A human approves</td>
            </tr>
            <tr><td>Unknown</td><td>A tool the profile doesn't recognise</td><td>Refused, never guessed</td></tr>
          </tbody>
        </table>
        <h2>The details that matter for real money</h2>
        <ul>
          <li>
            <b>Full refunds.</b>
            {" "}A refund with no amount refunds everything, so the guard reads the payment first and prices that.
          </li>
          <li>
            <b>One-tool APIs.</b>
            {" "}Stripe exposes most actions through a single{" "}
            <code>stripe_api_write</code>
            {" "}tool; the guard classifies each call by the API it hits, so a refund is governed and a product update isn't.
          </li>
          <li>
            <b>Rupees and other currencies.</b>
            {" "}Amounts count against your USD budgets only at an exchange rate you declare. With no rate, the money doesn't move.
          </li>
          <li><b>Fail closed.</b> If SpendVeto isn't running, only reads pass.</li>
        </ul>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>Which payment MCP servers does the guard support?</summary>
            <p>
              Razorpay, Stripe, PayPal, Cashfree and Square have built-in profiles, plus a generic profile for any other MCP server. Each profile knows which of the provider's tools read, collect money, move money out, or change something risky.
            </p>
          </details>
          <details>
            <summary>What happens when the agent asks for a refund above the limit?</summary>
            <p>
              The guard refuses the call before the provider sees it and returns a tool error with a code and a fix. Above the approval line it waits for a human instead: they approve in the SpendVeto Console and the agent repeats the same call.
            </p>
          </details>
          <details>
            <summary>Does SpendVeto hold my Razorpay or Stripe keys?</summary>
            <p>
              No. The keys stay in the guard's environment on your machine, the same place the provider's own MCP server would read them. SpendVeto's server only sees the tool name, its arguments and the decision.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/human-approval-agent-payments">
            Human approval for agent payments
            <span>
              Threshold and new-payee approvals that fail closed, are single-use, and can require two approvers.
            </span>
          </a>
          <a href="/guides/mpp-spending-controls">
            MPP spending controls
            <span>Stripe and Tempo's Machine Payments Protocol governed inside the mppx client.</span>
          </a>
          <a href="/guides/ai-agent-budget">
            AI agent budgets
            <span>
              Per-agent caps, team and customer tag budgets across agents, and one cost report across providers.
            </span>
          </a>
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/console/">Open the console demo</a>
        </div>
        <p className="meta">Updated 2026-10-23 · SpendVeto v0.32.0</p>
      </article>
    </Page>
  );
}
