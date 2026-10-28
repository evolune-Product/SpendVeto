import "../../styles/pages.css";
import "../signup.css";
import "./verify.css";
import Page from "../../components/Page.jsx";
import Island from "../../components/Island.jsx";
import { SignupVerify } from "../../islands/Signup.jsx";

export const head = {
  "title": "Finish creating your SpendVeto account",
  "description": "Confirm your email and receive your SpendVeto Governance API admin key.",
  "path": "/signup/verify",
  "robots": "noindex, nofollow"
};

// Behaviour lives in verify.client.js — the island reads the token from the
// link, creates the account, and shows the admin key once.
export const client = true;

const GOVERN_URL = process.env.SPENDVETO_GOVERN_URL || "https://govern.spendveto.com";

export default function SignupVerifyPage() {
  return (
    <Page note={<>Your admin key is shown once and stored only as a fingerprint.</>}>
      <div className="verify-wrap">
        <h1>Your Governance API account</h1>
        <Island name="verify" component={SignupVerify} props={{ api: GOVERN_URL }} />
      </div>
    </Page>
  );
}
