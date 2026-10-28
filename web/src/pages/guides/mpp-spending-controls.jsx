import "../../styles/pages.css";
import "./mpp-spending-controls.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "MPP Spending Controls for AI Agents (Stripe + Tempo) | SpendVeto",
  "description": "Govern Machine Payments Protocol payments before mppx pays: every offer priced, session deposits capped, split payees checked, subscriptions sent to a human.",
  "path": "/guides/mpp-spending-controls",
  "ogTitle": "How to put spending controls on MPP (Machine Payments Protocol) agent payments",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/mpp-spending-controls#article",
          "headline": "How to put spending controls on MPP agent payments",
          "description": "Govern Machine Payments Protocol payments before mppx pays: every offer priced, session deposits capped, split payees checked, subscriptions sent to a human.",
          "url": "https://spendveto.com/guides/mpp-spending-controls",
          "datePublished": "2026-10-19",
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
            "Machine Payments Protocol",
            "MPP",
            "mppx",
            "Tempo",
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
              "name": "MPP spending controls",
              "item": "https://spendveto.com/guides/mpp-spending-controls"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to put spending controls on MPP agent payments",
          "description": "Plug SpendVeto into the mppx client's onChallenge hook. Every offer an MPP server makes — a charge, a session deposit or a subscription — goes to SpendVeto's policy engine before mppx creates a credential. It is priced in USD or refused, checked against your budgets, approval line and payee rules, and the money it allows stays held against the budget until the payment is reported.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto"
            },
            {
              "@type": "HowToTool",
              "name": "mppx"
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
              "name": "Write the policy",
              "text": "Budgets, approval line, payee and chain allowlists, plus an mpp section: maxSessionDepositUSD, maxUnitPriceUSD, allowedMethods."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Hook it into mppx",
              "text": "Pass governMppx({ address }).onChallenge to Mppx.create, and fetch through governed.fetch so each payment's outcome is reported."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Close sessions",
              "text": "closeSession(sessionId, lastVoucher) books what a session consumed and releases the rest of its deposit."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "Does SpendVeto replace mppx?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "No. mppx still creates the credential and pays the server. SpendVeto decides first, inside mppx's own onChallenge hook, and books the outcome from the server's Payment-Receipt."
              }
            },
            {
              "@type": "Question",
              "name": "Which MPP payment methods are priced?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Tempo (OUSD, pathUSD and USDC.e on mainnet and the Moderato testnet), EVM (the chain's registered USDC), and Stripe and card offers in USD. Any other method or token is refused rather than guessed."
              }
            },
            {
              "@type": "Question",
              "name": "How is a session's spend counted?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "The whole deposit is held against the hourly budget while the session is open. Vouchers are cumulative and can't exceed the approved deposit; closing the session books what was consumed and releases the rest."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function MppSpendingControlsPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs"><a href="/">SpendVeto</a> / <a href="/guides">Guides</a> / MPP spending controls</p>
        <h1>How to put spending controls on MPP agent payments</h1>
        <p className="answer">
          Plug SpendVeto into the mppx client's{" "}
          <code>onChallenge</code>
          {" "}hook. Every offer an MPP server makes — a charge, a session deposit or a subscription — goes to SpendVeto's policy engine before mppx creates a credential. It is priced in USD or refused, checked against your budgets, approval line and payee rules, and the money it allows stays held against the budget until the payment is reported.
        </p>
        <h2>Plug it into mppx</h2>
        <p>
          MPP is the HTTP 402 payment standard Stripe and Tempo launched on March 18, 2026. A server answers{" "}
          <code>402</code>
          {" "}with one{" "}
          <code>WWW-Authenticate: Payment</code>
          {" "}challenge per offer, and the official client,{" "}
          <code>mppx</code>
          , pays one by itself. Its docs point at the{" "}
          <code>onChallenge</code>
          {" "}hook as the place to apply a spending policy before paying — that is where SpendVeto goes:
        </p>
        <pre className="term">
          {"import { Mppx, tempo } from \"mppx/client\";\nimport { governMppx } from \"spendveto/integrations/mppx.js\";\n\nconst governed = governMppx({ address: account.address });\nconst mppx = Mppx.create({\n  methods: [tempo({ account })],\n  onChallenge: governed.onChallenge,   // decided before a credential exists\n  polyfill: false,\n});\nconst res = await governed.fetch(mppx, \"https://api.example.com/search\");"}
        </pre>
        <p>
          A refused offer throws before mppx signs anything. An offer above your approval line waits for a human, then is decided again.{" "}
          <code>governed.fetch</code>
          {" "}reports how each payment ended, with the server's{" "}
          <code>Payment-Receipt</code>
          {" "}kept as evidence.
        </p>
        <h2>The policy</h2>
        <pre className="term">
          {"{\n  \"$schema\": \"https://spendveto.com/schemas/policy-v1.json\",\n  \"maxPerCallUSD\": 0.50,\n  \"maxPerHourUSD\": 5,\n  \"requireApprovalAboveUSD\": 1,\n  \"allowedChains\": [\"tempo\", \"base\"],\n  \"allowedPayees\": [\"0xVendorA…\"],\n  \"mpp\": {\n    \"maxSessionDepositUSD\": 2,\n    \"maxUnitPriceUSD\": 0.001,\n    \"allowedMethods\": [\"tempo\", \"stripe\"]\n  }\n}"}
        </pre>
        <h2>What each MPP intent is decided on</h2>
        <table className="t">
          <tbody>
            <tr><th>Intent</th><th>Decided on</th><th>Also enforced</th></tr>
            <tr>
              <td><code>charge</code></td>
              <td>The amount, in USD</td>
              <td>
                Every{" "}
                <code>splits</code>
                {" "}recipient must pass the payee rules too — a split can't route money to an address the policy never approved.
              </td>
            </tr>
            <tr>
              <td><code>session</code></td>
              <td>The deposit it locks — not the per-unit price</td>
              <td>
                Capped by{" "}
                <code>mpp.maxSessionDepositUSD</code>
                ; the escrow must be Tempo's channel reserve; the deposit is held until the session closes; vouchers are cumulative and can't exceed the approved deposit.
              </td>
            </tr>
            <tr>
              <td><code>subscription</code></td>
              <td>The first period</td>
              <td>
                Always a human approval, shown with the total until the subscription ends; a Tempo offer billing monthly is refused.
              </td>
            </tr>
          </tbody>
        </table>
        <h2>What the client library lets through</h2>
        <p>
          mppx parses some challenges the protocol says a client must not pay. SpendVeto refuses them before signing:
        </p>
        <ul>
          <li>A challenge that has already expired.</li>
          <li>
            A challenge asking for the credential in a header other than{" "}
            <code>Authorization</code>
            {" "}or{" "}
            <code>Payment-Authorization</code>
            .
          </li>
          <li>
            A Tempo offer with no{" "}
            <code>chainId</code>
            {" "}— the method drafts disagree on the default (testnet for charges, mainnet for sessions).
          </li>
          <li>A token or payment method SpendVeto can't price. Nothing is assumed to be worth a dollar.</li>
        </ul>
        <h2>Why the budget still sees MPP money</h2>
        <p>
          SpendVeto isn't in an MPP payment's path — mppx pays the server directly. So everything it allows is held against the same hourly budget as your x402 payments, cards, payouts and model tokens until the outcome is reported. An allowed charge nobody reports is booked as paid when its challenge expires: unreported spend never disappears from the budget.
        </p>
        <h2>MPP and x402</h2>
        <p>
          Both answer an HTTP 402. x402 settles each request on its own; MPP adds sessions (one deposit, many metered calls) and subscriptions, and its docs note that x402's{" "}
          <code>exact</code>
          {" "}scheme maps onto MPP's{" "}
          <code>charge</code>
          . SpendVeto governs both with one policy — see{" "}
          <a className="inline" href="/guides/x402-spending-limits">x402 spending limits</a>
          .
        </p>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>Does SpendVeto replace mppx?</summary>
            <p>
              No. mppx still creates the credential and pays the server. SpendVeto decides first, inside mppx's own onChallenge hook, and books the outcome from the server's Payment-Receipt.
            </p>
          </details>
          <details>
            <summary>Which MPP payment methods are priced?</summary>
            <p>
              Tempo (OUSD, pathUSD and USDC.e on mainnet and the Moderato testnet), EVM (the chain's registered USDC), and Stripe and card offers in USD. Any other method or token is refused rather than guessed.
            </p>
          </details>
          <details>
            <summary>How is a session's spend counted?</summary>
            <p>
              The whole deposit is held against the hourly budget while the session is open. Vouchers are cumulative and can't exceed the approved deposit; closing the session books what was consumed and releases the rest.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/x402-spending-limits">
            x402 spending limits
            <span>
              Caps, approvals, payee and chain allowlists for x402, enforced server-side before anything is signed or settled.
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
        <p className="meta">Updated 2026-10-19 · SpendVeto v0.30.0</p>
      </article>
    </Page>
  );
}
