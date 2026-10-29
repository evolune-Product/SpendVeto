#!/usr/bin/env node
// Send a sample of every SpendVeto email to one or more inboxes — to check how
// they look and that the mail provider is set up, without creating an account,
// an invite, or anything else.
//
//   npm run mail:sample -- --to you@example.com
//   npm run mail:sample -- --to a@example.com,b@example.com --org "Acme Robotics"
//   npm run mail:sample -- --to you@example.com --only welcome,invite
//
// Sends, exactly as real users get them but with "[Sample]" in front of the
// subject:
//   signup    the Governance API's sign-up link (the magic link)
//   welcome   the welcome email that follows a sign-up
//   existing  "you already have an account"
//   invite    the Console invite
// Uses the same settings as the server (.env.local: SPENDVETO_MAIL_PROVIDER,
// SPENDVETO_MAIL_FROM, SPENDVETO_MAIL_REPLY_TO and the provider's key). The
// links name no account: the sign-up link answers "invalid, already used, or
// expired", and the invite link can't set a password.
import "./load-env.mjs"; // first: .env.local before anything reads it
import { parseArgs } from "node:util";
import { mailerFromEnv } from "../server/mailer.js";
import { inviteEmail } from "../server/console-emails.js";
import { existingAccountEmail, signupLinkEmail, welcomeEmail } from "../govern/emails.js";

const KINDS = ["signup", "welcome", "existing", "invite"];
const { values: args } = parseArgs({
  options: {
    to: { type: "string" },
    org: { type: "string", default: "Sample Co" },
    only: { type: "string", default: KINDS.join(",") },
    role: { type: "string", default: "approver" },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help || !args.to) {
  console.log("usage: npm run mail:sample -- --to you@example.com[,other@example.com] [--org \"Acme\"] [--only signup,welcome,existing,invite] [--role viewer|approver|admin]");
  process.exit(args.help ? 0 : 1);
}
const recipients = args.to.split(",").map((s) => s.trim()).filter(Boolean);
const bad = recipients.filter((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r));
const kinds = args.only.split(",").map((s) => s.trim()).filter(Boolean);
const unknown = kinds.filter((k) => !KINDS.includes(k));
if (bad.length || unknown.length) {
  console.error([bad.length && `not an email address: ${bad.join(", ")}`, unknown.length && `unknown email: ${unknown.join(", ")} (choose from ${KINDS.join(", ")})`].filter(Boolean).join("\n"));
  process.exit(1);
}

const mailer = mailerFromEnv();
if (!mailer) {
  console.error("Email isn't configured — set SPENDVETO_MAIL_PROVIDER, SPENDVETO_MAIL_FROM and the provider's key (BREVO_API_KEY) in .env.local.");
  process.exit(1);
}

// Links that look real but name no account (the token is the right shape,
// so the page answers "invalid or expired" rather than a validation error).
const SAMPLE_TOKEN = "sample-link-names-no-account-0000000000000";
const verifyUrl = process.env.GOVERN_SIGNUP_VERIFY_URL || "https://spendveto.com/signup/verify";
const consoleUrl = new URL(process.env.SPENDVETO_PUBLIC_URL || "https://app.spendveto.com").origin;

const compose = {
  signup: (to) => signupLinkEmail({ to, orgName: args.org, link: `${verifyUrl}#token=${SAMPLE_TOKEN}` }),
  welcome: (to) => welcomeEmail({ to, tenant: { id: "00000000-0000-4000-8000-000000000000", name: args.org, owner_wallet: null }, keyPrefix: "svk_sample00" }),
  existing: (to) => existingAccountEmail({ to }),
  invite: (to) => inviteEmail({ to, role: args.role, inviteUrl: `${consoleUrl}/#accept-invite=${SAMPLE_TOKEN}`, expiresAt: new Date(Date.now() + 48 * 3600e3).toISOString(), invitedBy: "admin@example.com", consoleUrl }),
};

console.log(`Sending through ${mailer.provider} from ${process.env.SPENDVETO_MAIL_FROM}${process.env.SPENDVETO_MAIL_REPLY_TO ? ` (replies to ${process.env.SPENDVETO_MAIL_REPLY_TO})` : ""}:\n`);
let failed = 0;
for (const to of recipients) {
  for (const kind of kinds) {
    const msg = compose[kind](to);
    try {
      await mailer.send({ ...msg, subject: `[Sample] ${msg.subject}`, tag: `sample-${msg.tag}` });
      console.log(`sent      ${to.padEnd(32)} ${kind.padEnd(9)} ${msg.subject}`);
    } catch (err) {
      failed++;
      console.log(`NOT SENT  ${to.padEnd(32)} ${kind.padEnd(9)} ${err.message}`);
    }
  }
}
if (failed) {
  console.error(`\n${failed} not sent. "answered 401": the API key is wrong or blocked (Brevo → Security → Authorised IPs). "answered 400": the sender isn't verified in the provider.`);
} else {
  console.log("\nAll sent. Check the inbox (and spam) — they should arrive within a minute.");
}
process.exit(failed ? 1 : 0);
