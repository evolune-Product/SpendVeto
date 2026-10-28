import "../styles/pages.css";
import "./playground.css";
import Page from "../components/Page.jsx";
import Island from "../components/Island.jsx";
import Playground from "../islands/Playground.jsx";

export const head = {
  "title": "Try SpendVeto — Live AI Agent Spend Governance Playground",
  "description": "Set a budget, fire AI agent spend at it, and watch SpendVeto's real policy engine pass, pause, or block each x402 payment — live in your browser, no install, no signup.",
  "path": "/playground",
  "keywords": "AI agent spend governance demo, x402 playground, try SpendVeto",
  "ogImage": "https://spendveto.com/assets/generated/og-playground.png",
  "jsonLd": [
    {
      "@context": "https://schema.org",
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
          "name": "Playground",
          "item": "https://spendveto.com/playground"
        }
      ]
    }
  ]
};

// Behaviour lives in playground.client.js — plain DOM code, loaded after the static HTML.
export const client = true;

const TRY = [
  ["translate", "($0.005) is inside every limit —", "paid"],
  ["summarize", "($0.02) is above the $0.015 approval line —", "pending"],
  ["premium data", "($0.08) is over the $0.05 per-call cap —", "blocked"],
  ["runaway burst", "trips the rate limit, then freezes the wallet —", "blocked"],
];

export default function PlaygroundPage() {
  return (
    <Page note={<>The real policy logic, running locally in your browser — nothing leaves this page.</>}>
      <div className="pg">
        <div className="pg-top">
          <div className="pg-head">
            <p className="counter"><b>PLAYGROUND</b> the real policy engine, in your browser</p>
            <h1>Give an agent a budget. Watch SpendVeto decide.</h1>
            <p>
              Set the policy, then fire spend at it. This runs the{" "}
              <span className="real">same decision logic</span>
              {" "}as SpendVeto's policy engine — per-call caps, hourly budget, rate limit, approval threshold, payee allowlist, runaway auto-freeze — entirely client-side. Nothing is sent anywhere; no wallet, no install.
            </p>
            <p>
              Want to see what an operator sees?{" "}
              <a href="/console/" style={{ color: "#46d68c", fontWeight: "600" }}>Open the Console demo →</a>
              {" "}all ten pages (approvals, budget tree, ledger, chains, trust, policy, report) on real captured data.
            </p>
          </div>
          {/* With the default policy, each of these lands on a different verdict. */}
          <aside className="pg-try">
            <h2>Try this</h2>
            <ol>
              {TRY.map(([tool, outcome, verdict]) => (
                <li key={tool}><b>{tool}</b> {outcome} <span className={`verdict ${verdict}`}>{verdict === "pending" ? "awaiting human" : verdict}</span></li>
              ))}
            </ol>
            <p className="pg-try-note">Move a slider and fire again — the verdict follows the policy, in the same order the server checks it.</p>
          </aside>
        </div>
        <Island name="playground" component={Playground} />
      </div>
    </Page>
  );
}
