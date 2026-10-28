import "../../styles/pages.css";
import "./verify-governed-ai-agents.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "Accept Payments Only From Governed AI Agents | SpendVeto",
  "description": "Sellers verify offline that an agent's payment passed its owner's spend policy. One Express middleware; composes with AP2 and Verifiable Intent.",
  "path": "/guides/verify-governed-ai-agents",
  "ogTitle": "How to accept payments only from governed AI agents",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/verify-governed-ai-agents#article",
          "headline": "How to accept payments only from governed AI agents",
          "description": "Sellers verify offline that an agent's payment passed its owner's spend policy. One Express middleware; composes with AP2 and Verifiable Intent.",
          "url": "https://spendveto.com/guides/verify-governed-ai-agents",
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
            "agent payments",
            "verifiable intent",
            "know your agent",
            "seller verification"
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
              "name": "Verify governed agents (sellers)",
              "item": "https://spendveto.com/guides/verify-governed-ai-agents"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to accept payments only from governed AI agents",
          "description": "Require a governed-spend attestation: a five-minute token, signed by the buyer's SpendVeto only after its policy allowed the payment, naming the payer, payee, resource and ceiling. Add requireGovernedAgent({ trustedIssuers, audience, price }) in front of a paid route and it verifies the token offline. It makes no call to SpendVeto, and every check fails closed.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto seller middleware"
            },
            {
              "@type": "HowToTool",
              "name": "Express"
            }
          ],
          "step": [
            {
              "@type": "HowToStep",
              "position": 1,
              "name": "Collect issuer addresses",
              "text": "Each buyer publishes theirs at /.well-known/spendveto-issuer.json; add the ones you trust."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Add the middleware",
              "text": "requireGovernedAgent({ trustedIssuers, audience: yourPayTo, price }) before your paid handler."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Bind the payer",
              "text": "Pass payer once you know who paid (from your x402 settlement) so a borrowed attestation can't vouch for someone else."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Use the claims",
              "text": "req.spendveto carries the payer, ceiling, decision (allowed or human-approved) and policy version."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "How can a merchant verify an AI agent's payment was authorized?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Ask for a signed statement from the buyer's side and verify it against a key you trust. With SpendVeto, the buyer's policy engine signs a governed-spend attestation after it allows the payment, and the seller verifies it offline with one middleware."
              }
            },
            {
              "@type": "Question",
              "name": "Do I need to run SpendVeto to verify attestations?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "No. Verification is a secp256k1 signature check (EIP-191) against the issuer address; it is a standard EIP-191 signature recovery, so any Ethereum library can do the same."
              }
            },
            {
              "@type": "Question",
              "name": "Is this the same as AP2 or Verifiable Intent?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "No — those sign what a user authorized; a SpendVeto attestation signs what the paying organization's policy decided. They answer different questions and can travel together."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function VerifyGovernedAiAgentsPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs">
          <a href="/">SpendVeto</a>
          {" "}/{" "}
          <a href="/guides">Guides</a>
          {" "}/ Verify governed agents (sellers)
        </p>
        <h1>How to accept payments only from governed AI agents</h1>
        <p className="answer">
          Require a{" "}
          <b>governed-spend attestation</b>
          : a five-minute token, signed by the buyer's SpendVeto only after its policy allowed the payment, naming the payer, payee, resource and ceiling. Add{" "}
          <code>requireGovernedAgent(&#123; trustedIssuers, audience, price &#125;)</code>
          {" "}in front of a paid route and it verifies the token offline. It makes no call to SpendVeto, and every check fails closed.
        </p>
        <h2>The middleware</h2>
        <pre className="term">
          {"import { requireGovernedAgent } from \"spendveto/integrations/seller-express.js\";\n\napp.get(\"/api/report\",\n  requireGovernedAgent({\n    trustedIssuers: [\"0xBuyerIssuer…\"],   // buyers' SpendVeto issuer addresses you accept\n    audience: \"0xYourPayTo…\",             // your payout address(es)\n    price: 0.25,                          // USD, or (req) => price\n  }),\n  (req, res) => res.json(buildReport(req.spendveto)));"}
        </pre>
        <h2>What gets refused, with its code</h2>
        <table className="t">
          <tbody>
            <tr><th>Situation</th><th>Code</th></tr>
            <tr><td>No attestation</td><td><code>attestation_missing</code></td></tr>
            <tr>
              <td>Signed by an issuer you don't trust (including a self-minted one)</td>
              <td><code>attestation_untrusted_issuer</code></td>
            </tr>
            <tr><td>Altered after signing</td><td><code>attestation_bad_signature</code></td></tr>
            <tr>
              <td>For another payee, resource or a lower price</td>
              <td>
                <code>attestation_audience_mismatch</code>
                {" "}·{" "}
                <code>attestation_resource_mismatch</code>
                {" "}·{" "}
                <code>attestation_amount_insufficient</code>
              </td>
            </tr>
            <tr>
              <td>Issued to a different wallet than the one paying</td>
              <td><code>attestation_payer_mismatch</code></td>
            </tr>
            <tr>
              <td>Expired, or presented a second time</td>
              <td><code>attestation_expired</code> · <code>attestation_replayed</code></td>
            </tr>
          </tbody>
        </table>
        <p>
          The middleware refuses to start with an empty trust list. Anyone can run an issuer with a permissive policy, so there is no "accept any issuer" mode.
        </p>
        <h2>How this relates to AP2 mandates and Mastercard Verifiable Intent</h2>
        <p>
          Google's{" "}
          <a className="inline" href="https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol" rel="noopener">
            AP2
          </a>
          {" "}signs what a{" "}
          <i>user</i>
          {" "}authorized, with price and timing limits. Mastercard's{" "}
          <a className="inline" href="https://www.pymnts.com/mastercard/2026/mastercard-unveils-open-standard-to-verify-ai-agent-transactions/" rel="noopener">
            Verifiable Intent
          </a>
          {" "}ties together who the user is, what they instructed and what happened. A SpendVeto attestation answers a different question: did the{" "}
          <i>paying organization's</i>
          {" "}policy engine (budgets, approvals, payee rules, kill switch) allow this specific payment on this rail? These are separate claims and they compose: a payment can carry a user mandate and an organization attestation side by side.
        </p>
        <div className="card warn">
          <b>What it proves, and what it doesn't.</b>
          {" "}It proves the named issuer's engine said yes to this payer, payee, resource and ceiling at that time. It doesn't prove the payment happened, or that the issuer's policy is strict. You learn the policy's version, never the buyer's limits. Whether an issuer is trustworthy is your call about that issuer.
        </div>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>How can a merchant verify an AI agent's payment was authorized?</summary>
            <p>
              Ask for a signed statement from the buyer's side and verify it against a key you trust. With SpendVeto, the buyer's policy engine signs a governed-spend attestation after it allows the payment, and the seller verifies it offline with one middleware.
            </p>
          </details>
          <details>
            <summary>Do I need to run SpendVeto to verify attestations?</summary>
            <p>
              No. Verification is a secp256k1 signature check (EIP-191) against the issuer address; it is a standard EIP-191 signature recovery, so any Ethereum library can do the same.
            </p>
          </details>
          <details>
            <summary>Is this the same as AP2 or Verifiable Intent?</summary>
            <p>
              No — those sign what a user authorized; a SpendVeto attestation signs what the paying organization's policy decided. They answer different questions and can travel together.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
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
          <a href="/guides/stop-runaway-ai-agent-loop">
            Stop runaway agent loops
            <span>
              Freeze an agent that repeats the same tool call, plus a kill switch, rate limits and budgets as backstops.
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
