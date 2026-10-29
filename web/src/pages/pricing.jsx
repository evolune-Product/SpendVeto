import "../styles/pages.css";
import "./pricing.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "SpendVeto Pricing — Free Self-Hosted AI Agent Spend Governance to Hosted",
  "description": "SpendVeto is free to self-host. Hosted AI agent spend governance launch pricing: Desk $49/mo, Team $199/mo + 0.5% of governed spend, Money Path at basis points on volume.",
  "path": "/pricing",
  "keywords": "SpendVeto pricing, AI agent governance pricing, x402 hosted platform, self-hosted AI agent spend control",
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
          "name": "Pricing",
          "item": "https://spendveto.com/pricing"
        }
      ]
    }
  ]
};

export default function PricingPage() {
  return (
    <Page note={<>Self-hosting is free. Hosted tiers are launch pricing, subject to change at GA.</>}>
      <header style={{ textAlign: "center", padding: "4.5rem 1.2rem 2.4rem" }}>
        <h1 style={{ fontSize: "clamp(2rem,5vw,3rem)" }}>Free to govern yourself.<br />Paid when we run it for you.</h1>
      </header>
      <div className="banner">
        <b>Launch pricing.</b>
        {" "}Hosted tiers aren't self-serve yet — we set each team up directly, at these prices. The self-hosted core is free; nothing below removes anything from it.
      </div>
      <div className="tiers">
        <div className="tier">
          <h2>Self-host</h2>
          <div className="price">$0 <span>forever</span></div>
          <div className="per">Your machine, your keys</div>
          <ul>
            <li>Every control in the repo — all 511 verified behaviors</li>
            <li>Unlimited agents, wallets, budgets, chains</li>
            <li>Marketplace, console, MCP, proxy, API rail</li>
            <li>Community support</li>
          </ul>
          <a className="cta" href="/docs#quickstart">Run it in 60 seconds</a>
        </div>
        <div className="tier">
          <h2>Desk</h2>
          <div className="price">$49 <span>/ month</span></div>
          <div className="per">For solo operators &amp; trading desks</div>
          <ul>
            <li>Hosted console + managed proxy</li>
            <li>10 agent identities, wallet-bound tokens</li>
            <li>Daily allowances, trading-hours windows</li>
            <li>Slack/Telegram approvals + alerts</li>
            <li>90-day audit retention</li>
          </ul>
          <a className="cta" href="https://calendly.com/revanthrajeev2004/30min" target="_blank" rel="noopener">
            Talk to us
          </a>
        </div>
        <div className="tier hot">
          <h2>Team</h2>
          <div className="price">$199 <span>/ month</span></div>
          <div className="per">+ 0.5% of governed API/LLM spend</div>
          <ul>
            <li>Everything in Desk, unlimited identities</li>
            <li>Category caps, N-approver rules, policy packs</li>
            <li>Team seats + roles, 1-year audit retention</li>
            <li>Trust scores across your whole fleet</li>
            <li>Priority support</li>
          </ul>
          <a className="cta" href="https://calendly.com/revanthrajeev2004/30min" target="_blank" rel="noopener">
            Talk to us
          </a>
        </div>
        <div className="tier">
          <h2>Money Path</h2>
          <div className="price">10–25 <span>bps on governed volume</span></div>
          <div className="per">Custody proxy on the payment rail — custom</div>
          <ul>
            <li>Managed custody, keyless agent fleets</li>
            <li>Mainnet settlement (CDP facilitator)</li>
            <li>SLAs, SSO, dedicated support</li>
            <li>SOC 2 on the funded roadmap — stated honestly</li>
          </ul>
          <a className="cta" href="mailto:revanthrajeev2004@gmail.com?subject=SpendVeto%20Money%20Path">Talk to us</a>
        </div>
      </div>
      <p className="foot-note">
        Why these prices: observability tools that only{" "}
        <em>watch</em>
        {" "}agent spend charge $20–500/mo — SpendVeto{" "}
        <em>enforces before the money moves</em>
        , and one prevented runaway loop typically covers a year of Desk. The 0.5% take on governed API spend and the basis-point Money Path track how spend-management platforms actually monetize: on the volume they protect, not the seats they count.
      </p>
    </Page>
  );
}
