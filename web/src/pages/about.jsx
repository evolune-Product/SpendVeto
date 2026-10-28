import "../styles/pages.css";
import "./about.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "About SpendVeto — AI Agent Payment Governance, Verified by Tests",
  "description": "Why SpendVeto exists: x402 and MCP payment rails move an AI agent's money, SpendVeto decides whether it should be allowed to move it. Self-hosted, with every claim covered by its automated test suite.",
  "path": "/about",
  "keywords": "about SpendVeto, AI agent governance founder, x402 spend governance",
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
          "name": "About",
          "item": "https://spendveto.com/about"
        }
      ]
    }
  ]
};

export default function AboutPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="doc-wrap">
        <h1>About SpendVeto</h1>
        <p className="lede">
          AI agents can now hold wallets and pay for things autonomously — tools, APIs, and each other, at machine speed. Every rail (Coinbase, Stripe, Visa, x402) answers{" "}
          <b>how</b>
          {" "}an agent pays. Almost nobody answers the question every team asks first:{" "}
          <b>how do I stop it from overspending?</b>
          {" "}SpendVeto is the buyer-side policy layer that sits above any rail and decides — before a single dollar moves.
        </p>
        <div className="facts">
          <div className="fact">
            <b>510/510</b>
            <span>end-to-end checks, real signatures, run before every claim ships</span>
          </div>
          <div className="fact">
            <b>Self-hosted</b>
            <span>runs on your machine with your keys — nothing leaves it</span>
          </div>
          <div className="fact">
            <b>20 chains</b>
            <span>
              chain-scoped budgets, eight signature families, six testnets live on-chain (Base Sepolia, Solana devnet, Aptos, Stellar, Hedera, XRPL)
            </span>
          </div>
        </div>
        <h2>Why it exists</h2>
        <p>
          An agent with a wallet is a corporate card with no limit, issued to software. Runaway loops don't get tired — they get invoiced. As agent-to-agent and agent-to-service payments become normal, someone has to sit between the agent and its money and ask: is this call within policy, within budget, within scope, and did a human sign off if it needed one? That's the layer every payment rail assumes already exists. It mostly doesn't. SpendVeto builds it.
        </p>
        <h2>How we work</h2>
        <p>
          Every feature on the site is backed by an assertion in SpendVeto's automated test suite — if a control isn't exercised by a real, running test, it doesn't ship as a claim. We'd rather under-promise on the marketing page than ship a control that only works in a demo.
        </p>
        <h2 id="founder">Who's behind it</h2>
        <div className="founder">
          <img src="/assets/founder.jpg" alt="Revanth Rajeev, founder of SpendVeto" width="120" height="120" loading="lazy" />
          <div>
            <h3>Revanth Rajeev</h3>
            <p className="role">Founder, SpendVeto · Co-Founder &amp; Director, Evolune EdgeTech</p>
            <p>
              IIT Guwahati student, and a State Gold Medalist at India Skills 2024 in Mobile Application Development. I've shipped 50+ mobile apps solo, to over 1.5 million installs, while studying — so the habit of getting something finished and in front of people predates this project. I'm also a co-founder of Evolune Edgetech LLP.
            </p>
            <p>
              I've been in crypto since I was 17: trading through the 2021–22 cycle first, then deploying my own contracts on BNB Chain and running staking and DeFi positions. That's the reason I'm building on the buyer side rather than the rail side — I've watched what automated systems do to a wallet when nothing is standing in the way.
            </p>
            <p>
              I wrote SpendVeto's codebase — the policy engine, the x402 gate, the MCP server, the SDK and the 510-assertion suite — and that's the answer I'd rather give than an argument: the repo is public, so you can check whether it holds up.
            </p>
            <p className="founder-links">
              <a href="https://x.com/RevanthRajeev" target="_blank" rel="noopener">X</a>
              {" "}
              <a href="https://www.linkedin.com/in/revanth-rajeev/" target="_blank" rel="noopener">LinkedIn</a>
              {" "}
              <a href="https://github.com/revanthrajeev" target="_blank" rel="noopener">GitHub</a>
              {" "}
              <a href="https://calendly.com/revanthrajeev2004/30min" target="_blank" rel="noopener">
                Book a 30-minute call
              </a>
            </p>
          </div>
        </div>
        <div className="founder">
          <img src="/assets/founder-harshil.jpg" alt="Harshil HK, co-founder of Evolune EdgeTech" width="120" height="120" loading="lazy" />
          <div>
            <h3>Harshil HK</h3>
            <p className="role">Co-Founder, SpendVeto · Co-Founder &amp; Director, Evolune EdgeTech</p>
            <p>
              State Gold Medalist at IndiaSkills 2024 in IT Software Solutions for Business, and a Startup Mahakumbh finalist the same year. I'm Co-Founder &amp; Director at Evolune EdgeTech, building Evolune OS — a governed execution layer that puts a human approval gate between AI agents and production — and Flasqo, a free AI-native API testing platform already live with real usage. The founder instinct predates this venture: I co-founded the Innovation Club at DSATM, and separately, an event planning and production media startup, before I'd written a line of production code professionally.
            </p>
            <p>
              By day, I build enterprise infrastructure for a Fortune 500 client. At a leading enterprise applications organization, I engineer the shipment-tracking platform Illumina runs its global logistics on — 150+ Lambda functions, 20+ carrier integrations, the full AWS backbone. I migrated the entire fleet from Python 3.6 to 3.12, re-architected dependencies through Lambda Layers for a 90% size reduction, and cut production failure rate by 61%. I'm currently leading architecture for new carrier onboarding, and building the multi-agent system meant to automate that process entirely. I don't need to argue that enterprise-grade software can be built by a small, disciplined team — I do it professionally at scale, and at Evolune EdgeTech I'm building the proof that it scales as a product too.
            </p>
            <p className="founder-links">
              <a href="https://x.com/HK3639" target="_blank" rel="noopener">X</a>
              {" "}
              <a href="https://share.google/0cpzW9UZ2KNNeuJwK" target="_blank" rel="noopener">LinkedIn</a>
              {" "}
              <a href="https://www.instagram.com/harshil_hk_5" target="_blank" rel="noopener">Instagram</a>
              {" "}
              <a href="https://harshilhk.com" target="_blank" rel="noopener">harshilhk.com</a>
            </p>
          </div>
        </div>
        <p>
          I'd genuinely like to hear from anyone running agent fleets that spend real money — design partners, security reviewers, or people who just think the buyer side of agentic commerce is being ignored. The{" "}
          <a href="/contact" style={{ color: "var(--green)" }}>contact page</a>
          {" "}has every route in.
        </p>
      </div>
    </Page>
  );
}
