import { mailerFromEnv, renderEmail } from "./mailer.js";

// The Console's emails. Any instance sends them — self-hosted ones too — so
// they carry no company's name or contact, only the instance's own address.

const ROLE_TEXT = {
  viewer: "you can see spend, budgets, policies and the ledger",
  approver: "you can see everything a viewer can, and approve or deny agent spend that's waiting on a human",
  admin: "you can change everything, including policies, budgets and who has access",
};

// The address invite links point at, and the domain wallet sign-in names:
// SPENDVETO_PUBLIC_URL on a public deployment, the request's own otherwise.
export function consoleOrigin(req) {
  return new URL(process.env.SPENDVETO_PUBLIC_URL || (req ? `${req.protocol}://${req.get("host")}` : "http://localhost:8402")).origin;
}

export function inviteEmail({ to, role, inviteUrl, expiresAt, invitedBy, consoleUrl }) {
  const who = invitedBy || "An admin";
  const until = new Date(expiresAt).toUTCString().replace(" GMT", " UTC");
  const asRole = `${/^[aeiou]/.test(role) ? "an" : "a"} ${role}`;
  return {
    to,
    tag: "console-invite",
    subject: `${who} invited you to the SpendVeto Console`,
    ...renderEmail({
      heading: "You're invited to the SpendVeto Console",
      preheader: `Set your password to join as ${asRole}. The link works once.`,
      brand: "console",
      paragraphs: [
        `${who} added you (${to}) to the SpendVeto Console at ${new URL(consoleUrl).host} as ${asRole}: ${ROLE_TEXT[role] || ROLE_TEXT.viewer}.`,
        "Open the link to choose your password. Nobody else ever sees it — not even the admin who invited you.",
      ],
      button: { label: "Set your password", url: inviteUrl },
      closing: [
        `The link works once, until ${until}. If it expires, ask an admin for a new one.`,
        "Didn't expect this? Ignore this email — the account can't be used until the link is opened.",
      ],
      footer: `Sent by the SpendVeto Console at ${consoleUrl}`,
    }),
  };
}

// Emails an invite when a provider is configured. Never throws: the invite
// exists either way, and the admin is told whether to pass the link on.
export async function sendInvite({ user, inviteUrl, expiresAt, invitedBy, consoleUrl }) {
  const mailer = mailerFromEnv();
  if (!mailer) return { emailed: false, reason: "not_configured" };
  try {
    await mailer.send(inviteEmail({ to: user.email, role: user.role, inviteUrl, expiresAt, invitedBy, consoleUrl }));
    return { emailed: true };
  } catch (err) {
    return { emailed: false, reason: "send_failed", error: err.message };
  }
}
