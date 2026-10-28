import "../styles/pages.css";
import "./terms.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "SpendVeto — Terms of Service",
  "description": "Terms of service for the SpendVeto marketing site and software.",
  "path": "/terms"
};

export default function TermsPage() {
  return (
    <Page>
      <div className="doc-wrap">
        <h1>Terms of Service</h1>
        <p className="updated">Last updated October 2026</p>
        <p>
          These terms cover two distinct things: using{" "}
          <span className="mono">spendveto</span>
          's marketing site, and using the SpendVeto software.
        </p>
        <h2>The website</h2>
        <p>
          This site is provided for information. Contacting us or booking a call does not create a contract for future service, pricing, or availability — hosted service starts only under a separate written agreement.
        </p>
        <h2>The software</h2>
        <p>
          SpendVeto is proprietary software of Evolune EdgeTech LLP, licensed under the{" "}
          <b>SpendVeto Proprietary License</b>
          : you may run a copy we provide you to govern your own organization's agent spending, and you may not copy, modify, redistribute, resell or offer it as a service without our written permission. The license text ships with the software and governs over any summary here. Versions released before 25 October 2026 remain under the Apache License 2.0 for those who received them.
        </p>
        <div className="callout">
          <b>Pre-audit software:</b>
          {" "}SpendVeto has not yet undergone an external security audit. It is provided{" "}
          <b>"as is," without warranty of any kind</b>
          , express or implied — including, without limitation, fitness for a particular purpose or non-infringement. You are solely responsible for evaluating it before connecting it to real funds, and for any losses arising from its use, misuse, misconfiguration, or from bugs in policy logic, signature verification, or approval flows.
          <p></p>
          <h2>No financial advice, no custody by us</h2>
          <p>
            SpendVeto is infrastructure software, not a financial service. We do not custody funds, execute trades, or provide investment advice. In self-hosted operation, any wallet keys and funds are entirely under your control and our control ends at the code we publish.
          </p>
          <h2>Limitation of liability</h2>
          <p>
            To the maximum extent permitted by applicable law, in no event will Revanth Rajeev, Evolune EdgeTech LLP, or any contributor to this project be liable for any direct, indirect, incidental, special, consequential, or exemplary damages — including lost funds, lost profits, lost data, or business interruption — arising from your use of, or inability to use, the SpendVeto software or this website, however caused and under any theory of liability (contract, tort, negligence, or otherwise), even if advised of the possibility of such damages. This is infrastructure software; you assume all risk of running it, forking it, or connecting it to real funds.
          </p>
          <h2>Indemnification</h2>
          <p>
            You agree to indemnify and hold harmless Revanth Rajeev, Evolune EdgeTech LLP, and any contributor from any claim, loss, liability, or expense (including reasonable legal fees) arising from your use of the software, your violation of these terms, or your violation of any applicable law or third-party right — including any deployment or modification of SpendVeto that you operate or distribute.
          </p>
          <h2>Not responsible for third-party use</h2>
          <p>
            Earlier versions of SpendVeto were released under Apache-2.0, and copies of them may be run, modified, or redistributed by others without our knowledge or involvement. We do not operate, monitor, or control third-party deployments, and we bear no responsibility for how any other party configures, deploys, or misuses the software, including any illegal use by a downstream operator. This does not extend to our own conduct: nothing here excuses fraud, gross negligence, or a knowing violation of law by us.
          </p>
          <h2>Global use, sanctions, and fraud by third parties</h2>
          <p>SpendVeto is published for use by anyone, anywhere, subject to the following:</p>
          <ul>
            <li>
              <b>
                We are not a money transmitter, broker-dealer, custodian, exchange, financial institution, or fiduciary
              </b>
              {" "}in any jurisdiction. SpendVeto does not hold, move, or have custody of any funds in a self-hosted deployment — it is governance logic that decides whether a payment is allowed, not a party to the payment itself.
            </li>
            <li>
              <b>You are solely responsible for your own legal and regulatory compliance</b>
              {" "}— including local licensing requirements, anti-money-laundering (AML) and know-your-customer (KYC) obligations, tax reporting, and any sanctions or export-control regimes that apply to you (including, without limitation, those administered by the U.S. Treasury's OFAC, the EU, the UN, and the UK). If you are a sanctioned person, located in a comprehensively sanctioned jurisdiction, or barred by law from using software like this, you may not use it.
            </li>
            <li>
              <b>We are not responsible for fraud, scams, or theft carried out by any third party</b>
              {" "}— including someone else's modified copy, someone else's hosted deployment, a compromised private key, a social-engineering attack, or a malicious actor impersonating this project. If you did not receive software or instructions directly from{" "}
              <span className="mono">spendveto.com</span>
              {" "}or the official{" "}
              <span className="mono">spendveto</span>
              {" "}npm package, we have no relationship to it and no responsibility for it.
            </li>
            <li>
              <b>This is not financial, legal, or tax advice</b>
              , in any country. Nothing on this site or in the software's documentation should be relied on as such; consult your own qualified professionals before connecting real funds to any deployment, by us or anyone else.
            </li>
            <li>
              These terms apply regardless of where in the world you access this site or run this software. If any part of them is unenforceable in your jurisdiction, the remainder still applies, and you remain solely responsible for ensuring your own use complies with the laws that apply to you.
            </li>
          </ul>
          <h2>Acceptable use</h2>
          <ul>
            <li>
              Don't use SpendVeto to circumvent sanctions, facilitate fraud, or process payments for illegal goods or services.
            </li>
            <li>
              Don't misrepresent SpendVeto's verification status — the "510/510" claim refers specifically to the assertions in SpendVeto's test suite at the time of the build; modified deployments should re-verify independently.
            </li>
          </ul>
          <h2>Governing law</h2>
          <p>
            These terms are governed by the laws of India, without regard to conflict-of-law principles. Any dispute arising from these terms or your use of the software will be subject to the exclusive jurisdiction of the courts of Karnataka, India, except where applicable law requires otherwise.
          </p>
          <h2>Changes</h2>
          <p>
            These terms may be updated as the product evolves; the "last updated" date reflects the latest revision. Continued use after a change constitutes acceptance of the revised terms.
          </p>
          <h2>Contact</h2>
          <p>
            Questions about these terms:{" "}
            <a href="mailto:foundersoffice@evolune.in" style={{ color: "var(--green)" }}>foundersoffice@evolune.in</a>
            .
          </p>
        </div>
        <footer>
          <span className="wordmark">SPENDVETO<span className="tick">_</span></span>
          {" "}
          <span>
            Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.
          </span>
          <div className="backers">
            <a className="inception" href="https://www.nvidia.com/en-us/startups/" target="_blank" rel="noopener">
              <img src="/assets/nvidia-inception-badge.png" alt="NVIDIA Inception Program member badge" width="91" height="36" loading="lazy" />
              <span>Built by Evolune EdgeTech LLP, a member of NVIDIA Inception.</span>
            </a>
            {" "}
            <a href={"https://www.producthunt.com/products/spendveto?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-spendveto"} target="_blank" rel="noopener noreferrer">
              <img src="/assets/producthunt-featured.svg" alt="SpendVeto on Product Hunt" width="167" height="36" loading="lazy" />
            </a>
          </div>
          <div className="links">
            <a href="/use-cases">Use cases</a>
            <a href="/playground">Playground</a>
            {" "}
            <a href="/about">About</a>
            {" "}
            <a href="/security">Security</a>
            {" "}
            <a href="/contact">Contact</a>
            {" "}
            <a href="/docs">Docs</a>
            {" "}
            <a href="/pitch">Pitch</a>
            {" "}
            <a href="/privacy">Privacy</a>
            {" "}
            <a href="/terms">Terms</a>
          </div>
          <p className="tm">
            © 2026 NVIDIA, the NVIDIA logo, and NVIDIA Inception are trademarks and/or registered trademarks of NVIDIA Corporation in the U.S. and other countries.
          </p>
        </footer>
      </div>
      {/* /canvas-frame */}
    </Page>
  );
}
