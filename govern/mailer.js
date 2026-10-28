// Transactional email for self-serve signup — dependency-free: each provider
// is one HTTPS call. Chosen by SPENDVETO_MAIL_PROVIDER, sent from
// SPENDVETO_MAIL_FROM ("SpendVeto <noreply@spendveto.com>"):
//
//   resend    RESEND_API_KEY
//   postmark  POSTMARK_SERVER_TOKEN
//
// Unconfigured, mailerFromEnv() returns null and signup refuses honestly
// (503 signup_unavailable) rather than creating accounts nobody verified.
const PROVIDERS = {
  resend: (env) => env.RESEND_API_KEY && {
    url: "https://api.resend.com/emails",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: ({ from, to, subject, text, html }) => ({ from, to: [to], subject, text, html }),
  },
  postmark: (env) => env.POSTMARK_SERVER_TOKEN && {
    url: "https://api.postmarkapp.com/email",
    headers: { "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN, Accept: "application/json" },
    body: ({ from, to, subject, text, html }) => ({ From: from, To: to, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: "outbound" }),
  },
};

export function mailerFromEnv(env = process.env, fetchImpl = fetch) {
  const provider = PROVIDERS[String(env.SPENDVETO_MAIL_PROVIDER || "").toLowerCase()];
  const from = env.SPENDVETO_MAIL_FROM;
  const config = provider && from ? provider(env) : null;
  if (!config) return null;
  return {
    async send({ to, subject, text, html }) {
      const res = await fetchImpl(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...config.headers },
        body: JSON.stringify(config.body({ from, to, subject, text, html })),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`mail provider answered ${res.status}`);
    },
  };
}
