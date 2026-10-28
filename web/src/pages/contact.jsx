import "../styles/pages.css";
import "./contact.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "SpendVeto — Contact",
  "description": "Get in touch with SpendVeto — design partners, security reports, press, or general questions.",
  "path": "/contact"
};

export default function ContactPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="doc-wrap">
        <h1>Contact</h1>
        <p className="lede">
          Every claim on this site is covered by SpendVeto's automated test suite. Reach out directly — a real person reads every message.
        </p>
        <div className="contact-grid">
          <div className="ccard">
            <span className="tag">General / partnerships</span>
            <h2>Design partners &amp; integrations</h2>
            <p>
              Building an agent that pays for things and want governance in front of it before you ship? Book a 30-minute call — bring the workflow that spends money and I'll show you what governing it looks like. Free while I'm working with design partners.
            </p>
            <a className="mail" href="https://calendly.com/revanthrajeev2004/30min" target="_blank" rel="noopener">
              Book a 30-minute call →
            </a>
            {" "}
            <a className="mail" href="mailto:foundersoffice@evolune.in?subject=SpendVeto%20design%20partner" style={{ opacity: ".7" }}>
              or foundersoffice@evolune.in
            </a>
          </div>
          <div className="ccard">
            <span className="tag">Security</span>
            <h3>Report a vulnerability</h3>
            <p>
              Found a way past a policy check, an approval bypass, or a signature issue? Please report privately first.
            </p>
            <a className="mail" href="mailto:foundersoffice@evolune.in?subject=Security%20report">
              foundersoffice@evolune.in
            </a>
          </div>
          <div className="ccard">
            <span className="tag">Investors</span>
            <h3>Funding &amp; pitch</h3>
            <p>
              See the{" "}
              <a href="/pitch" style={{ color: "var(--green)" }}>pitch page</a>
              {" "}for the funding doc — every number on it is cited.
            </p>
            <a className="mail" href="mailto:foundersoffice@evolune.in?subject=SpendVeto%20investors">
              foundersoffice@evolune.in
            </a>
          </div>
          <div className="ccard">
            <span className="tag">Everything else</span>
            <h3>Press, questions, feedback</h3>
            <p>Bug reports, feature requests, or just want to talk about agentic payments — all welcome.</p>
            <a className="mail" href="mailto:foundersoffice@evolune.in?subject=SpendVeto">foundersoffice@evolune.in</a>
          </div>
        </div>
      </div>
    </Page>
  );
}
