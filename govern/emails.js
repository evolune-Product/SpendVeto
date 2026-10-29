// The Governance API's emails (signup.js sends them through server/mailer.js).
// Content only — renderEmail() owns the layout and escapes every value.
import { getAddress } from "viem";
import { renderEmail } from "../server/mailer.js";

const FOOTER = "SpendVeto by Evolune EdgeTech LLP · spendveto.com";
const docsUrl = () => process.env.GOVERN_DOCS_URL || "https://spendveto.com/docs";
const apiUrl = () => (process.env.GOVERN_PUBLIC_URL || "https://govern.spendveto.com").replace(/\/$/, "");

export function signupLinkEmail({ to, orgName, link, ownerWallet }) {
  return {
    to,
    tag: "signup-link",
    subject: "Finish creating your SpendVeto account",
    ...renderEmail({
      heading: `Finish creating the SpendVeto account for ${orgName}`,
      preheader: "One click creates your account. The link works once, for 24 hours.",
      paragraphs: [
        "Open the link below to create the account. You'll see your admin API key once, on that page — copy it into your secrets manager.",
        ...(ownerWallet ? [`The account will be owned by the wallet ${getAddress(ownerWallet)}, which signed the request.`] : []),
      ],
      button: { label: "Create my account", url: link },
      closing: ["The link works once, for 24 hours. If you didn't ask for this, ignore this email — nothing is created until the link is opened."],
      footer: FOOTER,
    }),
  };
}

export function existingAccountEmail({ to }) {
  return {
    to,
    tag: "signup-existing",
    subject: "You already have a SpendVeto account",
    ...renderEmail({
      heading: "You already have a SpendVeto account",
      preheader: "Someone tried to sign up again with this address. No second account was created.",
      paragraphs: [
        "Someone — hopefully you — tried to create a SpendVeto account with this address, which already has one. No second account was created.",
        "Lost your API key? An admin key of your account can mint a new one (POST /v1/keys); if you have none left, reply to this email.",
      ],
      footer: FOOTER,
    }),
  };
}

// Sent once the link has created the account. Never carries the key itself —
// only its first characters, so the reader can tell which key is meant.
export function welcomeEmail({ to, tenant, keyPrefix }) {
  const api = apiUrl();
  return {
    to,
    tag: "welcome",
    subject: "Welcome to SpendVeto — your account is ready",
    ...renderEmail({
      heading: `Welcome to SpendVeto, ${tenant.name}`,
      preheader: "Your account is ready: its details and the first three calls to make.",
      paragraphs: [
        "Your Governance API account is ready. Every call your agents make that costs money can now be checked against a budget before it runs — and anything over the line can wait for a human.",
      ],
      details: [
        ["Account", tenant.name],
        ["Account ID", tenant.id],
        ["Admin key", `${keyPrefix}… (shown once at signup; we never email keys)`],
        ...(tenant.owner_wallet ? [["Owner wallet", getAddress(tenant.owner_wallet)]] : []),
        ["API", `${api}/v1`],
      ],
      steps: [
        { title: "Check your admin key works", code: `curl ${api}/v1/tenant \\\n  -H "Authorization: Bearer $SPENDVETO_ADMIN_KEY"` },
        { title: "Give an agent a budget — here $10 a day", code: `curl -X PUT ${api}/v1/budgets/my-agent \\\n  -H "Authorization: Bearer $SPENDVETO_ADMIN_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"cap_micros": 10000000, "period": "day"}'` },
        { title: "Mint the agent its own key, limited to spending", code: `curl -X POST ${api}/v1/keys \\\n  -H "Authorization: Bearer $SPENDVETO_ADMIN_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"scopes": ["spend"], "label": "my-agent"}'` },
        { title: "Before each paid call, the agent asks POST /v1/authorize — then settles the actual cost" },
      ],
      button: { label: "Read the docs", url: docsUrl() },
      closing: [
        "Keep the admin key for administration and give each agent a narrower one. Lost the admin key? Any other admin key on the account can mint a new one.",
        "Didn't create this account? Reply to this email and we'll close it.",
      ],
      footer: FOOTER,
    }),
  };
}
