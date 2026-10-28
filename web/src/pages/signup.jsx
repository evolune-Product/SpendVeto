import "../styles/pages.css";
import "./signup.css";
import Page from "../components/Page.jsx";
import Island from "../components/Island.jsx";
import { SignupForm } from "../islands/Signup.jsx";

export const head = {
  "title": "Get Started with SpendVeto — AI Agent Spend Governance",
  "description": "Start governing what your AI agents spend in one command: npx spendveto. Budgets, approvals and a kill switch for LLM tokens, x402/USDC, cards and payouts — free to self-host.",
  "path": "/signup",
  "keywords": "SpendVeto get started, npx spendveto, AI agent spending limit, x402 governance, Claude Code budget",
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
          "name": "Get started",
          "item": "https://spendveto.com/signup"
        }
      ]
    }
  ]
};

// Behaviour lives in signup.client.js (hydrates the signup form island).
export const client = true;

// The hosted Governance API the signup form talks to (build-time setting).
const GOVERN_URL = process.env.SPENDVETO_GOVERN_URL || "https://govern.spendveto.com";

const STEPS = [
  ["Start the gate.", <><span className="mono">npx spendveto</span> runs the API and the console on your machine.</>],
  ["Point your agent at it.", <>Claude Code: <span className="mono">ANTHROPIC_BASE_URL=http://127.0.0.1:8402</span>. Codex: <span className="mono">OPENAI_BASE_URL=…/v1</span>.</>],
  ["Set the budget.", <><span className="mono">npx spendveto budget 10</span> — $10 a day per agent, checked before each request reaches the provider.</>],
];
const RAILS = ["Claude Code", "Codex", "OpenAI & Anthropic SDKs", "MCP servers", "x402 · 20 chains", "Stripe Issuing & Lithic cards", "Stripe · RazorpayX · PayPal payouts"];

export default function SignupPage() {
  return (
    <Page cta="signin" note={<>The self-hosted core runs today — every claim covered by <span className="mono">npm run verify</span>.</>}>
      <div className="auth-wrap">
        <div className="auth-side">
          <h2>Give your agents a budget, not a blank check.</h2>
          <p>
            One command starts the gate, the console and the LLM spend guard on your own machine. Your keys and your ledger never leave it, and nothing below needs an account.
          </p>
          <div className="side-points">
            <span>510 end-to-end checks on every claim</span>
            {" "}
            <span>Claude Code, Codex, MCP and x402 in front of the same budget</span>
            {" "}
            <span>Free to self-host, unlimited agents</span>
          </div>
          <div className="side-card">
            <span className="side-tag">How it works</span>
            <ol className="side-steps">
              {STEPS.map(([title, body]) => <li key={title}><b>{title}</b> {body}</li>)}
            </ol>
          </div>
          <div className="side-card">
            <span className="side-tag">Governs spend on</span>
            <div className="side-chips">{RAILS.map((r) => <span key={r}>{r}</span>)}</div>
          </div>
        </div>
        <div className="auth-main">
          <div className="auth-box">
            <h1>Get started</h1>
            <p className="sub">
              SpendVeto runs on your machine in under a minute, or as a hosted API you can sign up for right here. Talk to us when you want the whole thing run for your team.
            </p>
            <div className="step primary">
              <span className="tag">Free · runs now</span>
              <h2>Run it on your machine</h2>
              <p>
                Starts the API and console on{" "}
                <span className="mono">127.0.0.1:8402</span>
                {" "}and prints the one-line setup for Claude Code, Codex and the SDKs.
              </p>
              <pre className="block">
                <span className="p">{"$"}</span>
                {" npx spendveto              "}
                <span className="c">{"# API + console"}</span>
                {"\n"}
                <span className="p">{"$"}</span>
                {" npx spendveto budget 10    "}
                <span className="c">{"# $10/day per agent"}</span>
                {"\n"}
                <span className="p">{"$"}</span>
                {" npx spendveto status       "}
                <span className="c">{"# what every agent spent today"}</span>
              </pre>
              <a className="go" href="/docs#quickstart">Read the quickstart →</a>
            </div>
            <div className="step">
              <span className="tag">Hosted API · self-serve</span>
              <h2>Get a Governance API key</h2>
              <p>Budgets, approvals and an audit trail for your agents' API spend, as a hosted API: your own isolated account and admin key, used from the Node or Python SDK. Sign up with your email, or connect a wallet first to make it the account's owner.</p>
              <Island name="signup" component={SignupForm} props={{ api: GOVERN_URL }} />
            </div>
            <div className="step">
              <span className="tag">Hosted Console · for teams</span>
              <h2>Have us run it for you</h2>
              <p>
                The hosted Console isn't self-serve yet. We set it up directly with each team: bring the workflow that spends money and we'll show you what governing it looks like.
              </p>
              <a className="go ghost" href="https://calendly.com/revanthrajeev2004/30min" target="_blank" rel="noopener">
                Book a 30-minute call →
              </a>
              {" "}
              <span className="mail">
                or email{" "}
                <a href="mailto:foundersoffice@evolune.in?subject=Hosted%20SpendVeto">foundersoffice@evolune.in</a>
              </span>
            </div>
            <p className="alt">Already have hosted access? <a href="/signin">Sign in</a></p>
          </div>
        </div>
      </div>
    </Page>
  );
}
