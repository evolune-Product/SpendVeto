import "../styles/pages.css";
import "./privacy.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "SpendVeto — Privacy Policy",
  "description": "SpendVeto's privacy policy: what data is collected on this site and via the self-hosted product, and what is not.",
  "path": "/privacy"
};

export default function PrivacyPage() {
  return (
    <Page note={<>Prototype — simulate mode by default, x402 testnet on Base Sepolia. Every claim on this page is covered by SpendVeto's automated test suite.</>}>
      <div className="doc-wrap">
        <h1>Privacy Policy</h1>
        <p className="updated">Last updated October 2026</p>
        <p>
          SpendVeto is software you can self-host. This policy covers two separate things: (1) this marketing website, and (2) the SpendVeto software itself when you run it.
        </p>
        <h2>This website</h2>
        <ul>
          <li>
            <b>Contacting us</b>
            {" "}— this site has no signup form. If you email us or book a call, we keep your email address and what you send, solely to reply and follow up about SpendVeto. Emails collected by the earlier waitlist are kept on the same terms. None of it is ever sold or shared with third parties.
          </li>
          <li>
            <b>No tracking cookies, no ad pixels.</b>
            {" "}This site does not run third-party analytics, advertising trackers, or cross-site cookies.
          </li>
          <li>
            <b>Aggregate stats only.</b>
            {" "}The live counters on the homepage (governed spend, blocked spend) come from your own local server if you're running one — this website does not collect that data centrally.
          </li>
        </ul>
        <h2>The SpendVeto software</h2>
        <p>
          SpendVeto is self-hosted by design. When you run it (simulate or testnet mode), all data — the ledger, policy configuration, wallet keys, delegation records — stays on your own infrastructure. We do not operate a hosted version that receives your data, and we have no visibility into how you use your own deployment.
        </p>
        <ul>
          <li>
            <b>Wallet keys</b>
            {" "}generated in simulate mode are stored locally in your own{" "}
            <span className="mono">data/</span>
            {" "}directory and are never transmitted anywhere.
          </li>
          <li>
            <b>Optional webhooks</b>
            {" "}(
            <span className="mono">alertWebhookUrl</span>
            ) you configure send freeze/block/approval events only to the endpoint you specify — that's your infrastructure choice, not ours.
          </li>
          <li>
            <b>Testnet/mainnet payments</b>
            {" "}settle on public blockchains (e.g. Base Sepolia), which are inherently public ledgers by design — that visibility comes from the chain, not from SpendVeto.
          </li>
        </ul>
        <h2>Changes</h2>
        <p>
          If this policy changes materially, the "last updated" date above will change and, where required, we'll notify the people we're in contact with by email.
        </p>
        <h2>Contact</h2>
        <p>
          Questions about this policy:{" "}
          <a href="mailto:foundersoffice@evolune.in" style={{ color: "var(--green)" }}>foundersoffice@evolune.in</a>
          .
        </p>
      </div>
    </Page>
  );
}
