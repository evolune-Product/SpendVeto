import "../styles/pages.css";
import "./signin.css";
import Page from "../components/Page.jsx";

export const head = {
  "title": "SpendVeto — Sign in",
  "description": "Sign in to the hosted SpendVeto console, or start self-hosted in one command with npx spendveto.",
  "path": "/signin",
  "robots": "noindex, follow"
};

export default function SigninPage() {
  return (
    <Page note={<>The self-hosted console needs no sign-in: it runs on <span className="mono">127.0.0.1:8402</span>, on your machine.</>}>
      <div className="auth-center">
        <div className="card">
          <div className="app-glyph"><img src="/assets/logo.svg" alt="" width="30" height="30" /></div>
          <h1 style={{ textAlign: "center" }}>Sign in</h1>
          <p className="sub" style={{ textAlign: "center" }}>
            Open your team's hosted console with the login we set up with you.
          </p>
          <a className="connect-big" href="https://app.spendveto.com" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            Open the hosted console →
          </a>
          <div className="or-div"><i></i><span>OR</span><i></i></div>
          <div className="duo">
            <a className="duo-btn" href="/docs#quickstart">Run it locally</a>
            {" "}
            <a className="duo-btn" href="/signup">Get started</a>
          </div>
          <div className="beta-box">
            <b>No hosted access?</b>
            Hosted SpendVeto isn't self-serve yet —{" "}
            <a href="https://calendly.com/revanthrajeev2004/30min" target="_blank" rel="noopener">book a call</a>
            {" "}and we'll set it up with you. Or run the whole thing on your own machine with{" "}
            <span className="mono">npx spendveto</span>
            .
          </div>
        </div>
      </div>
    </Page>
  );
}
