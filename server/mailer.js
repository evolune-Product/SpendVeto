// Transactional email — dependency-free: each provider is one HTTPS call.
// Shared by the core server (Console invites) and the Governance API (signup
// links, welcome). Chosen by SPENDVETO_MAIL_PROVIDER, sent from
// SPENDVETO_MAIL_FROM ("SpendVeto <noreply@spendveto.com>"), replies to
// SPENDVETO_MAIL_REPLY_TO when set (a noreply sender can't receive them):
//
//   brevo     BREVO_API_KEY          (BREVO_API_BASE overrides https://api.brevo.com)
//   resend    RESEND_API_KEY
//   postmark  POSTMARK_SERVER_TOKEN
//   console   prints each email to stderr instead — local development only:
//             links in it are live, so never use it where others read the logs
//
// Unconfigured, mailerFromEnv() returns null: signup refuses honestly (503
// signup_unavailable) rather than creating accounts nobody verified, and the
// Console hands the invite link to the admin instead of emailing it.

// "SpendVeto <noreply@x>" → { name, email }
function parseAddress(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].replace(/^"|"$/g, ""), email: m[2] } : { email: from.trim() };
}

const PROVIDERS = {
  brevo: (env) => env.BREVO_API_KEY && {
    url: `${(env.BREVO_API_BASE || "https://api.brevo.com").replace(/\/$/, "")}/v3/smtp/email`,
    headers: { "api-key": env.BREVO_API_KEY, Accept: "application/json" },
    body: ({ from, replyTo, to, subject, text, html, tag }) => ({
      sender: parseAddress(from), to: [{ email: to }], subject, htmlContent: html, textContent: text,
      ...(replyTo ? { replyTo: parseAddress(replyTo) } : {}), ...(tag ? { tags: [tag] } : {}),
    }),
  },
  resend: (env) => env.RESEND_API_KEY && {
    url: "https://api.resend.com/emails",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: ({ from, replyTo, to, subject, text, html, tag }) => ({
      from, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}), ...(tag ? { tags: [{ name: "category", value: tag }] } : {}),
    }),
  },
  postmark: (env) => env.POSTMARK_SERVER_TOKEN && {
    url: "https://api.postmarkapp.com/email",
    headers: { "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN, Accept: "application/json" },
    body: ({ from, replyTo, to, subject, text, html, tag }) => ({
      From: from, To: to, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: "outbound", ...(replyTo ? { ReplyTo: replyTo } : {}), ...(tag ? { Tag: tag } : {}),
    }),
  },
};

export function mailerFromEnv(env = process.env, fetchImpl = fetch) {
  const name = String(env.SPENDVETO_MAIL_PROVIDER || "").toLowerCase();
  const from = env.SPENDVETO_MAIL_FROM;
  const replyTo = env.SPENDVETO_MAIL_REPLY_TO || null;
  if (name === "console" && from) {
    return {
      provider: "console",
      async send({ to, subject, text }) {
        process.stderr.write(`\n[mail] ${from} → ${to}\n[mail] ${subject}\n${text}\n`);
      },
    };
  }
  const config = PROVIDERS[name] && from ? PROVIDERS[name](env) : null;
  if (!config) return null;
  return {
    provider: name,
    // `tag` groups messages in the provider's dashboard (signup-link, welcome, console-invite…).
    async send({ to, subject, text, html, tag }) {
      const res = await fetchImpl(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...config.headers },
        body: JSON.stringify(config.body({ from, replyTo, to, subject, text, html, tag })),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`mail provider answered ${res.status}`);
    },
  };
}

// ---- One layout for every email ----
// Callers pass content, never markup: every string is escaped here, so a name
// or an org typed into a form can't inject HTML. Returns both parts — the
// plain-text one is what a careful reader (or a filter) sees.
//
//   heading     one line
//   preheader   the line an inbox shows next to the subject
//   brand       the word after the wordmark ("console" for the Console's emails)
//   paragraphs  strings
//   details     [[label, value], …] — a small key/value table
//   steps       [{ title, code? }, …] — numbered, code shown as a block
//   button      { label, url }  — also written out as a plain link
//   closing     strings after the rest (security notes, "didn't ask for this?")
//   footer      one line
//
// The product's own palette (web/src/styles: --bg, --page, --ink, --dim,
// --faint, --green), dark like the site and the Console. Colors are set on
// every element and repeated as bgcolor attributes, because email clients
// drop stylesheets and some repaint backgrounds; the wordmark is text, not an
// image, so it shows even where images are blocked.
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const C = { bg: "#070a08", card: "#0e130f", panel: "#141a15", line: "#1f2721", ink: "#eef3ed", dim: "#93a094", faint: "#5c675e", green: "#46d68c", onGreen: "#070a08" };
const font = "-apple-system,BlinkMacSystemFont,Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const display = `'Space Grotesk',${font}`;
const mono = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace";

export function renderEmail({ heading, preheader = "", brand = "", paragraphs = [], button, details = [], steps = [], closing = [], footer = "" }) {
  const p = (t, color = C.ink) => `<p style="margin:0 0 16px;font:15px/1.65 ${font};color:${color}">${escapeHtml(t)}</p>`;
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
<style>:root{color-scheme:dark}a{color:${C.green}}</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};color:${C.ink}" bgcolor="${C.bg}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${escapeHtml(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.bg}" style="background:${C.bg}"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
<tr><td style="padding:0 6px 18px;font:700 15px/1 ${display};letter-spacing:.14em;color:${C.ink}">SPENDVETO<span style="color:${C.green}">_</span>${brand ? `<span style="color:${C.green};font-weight:500;letter-spacing:.04em;font-family:${font}"> ${escapeHtml(brand)}</span>` : ""}</td></tr>
<tr><td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:34px 32px 18px">
<h1 style="margin:0 0 18px;font:700 24px/1.25 ${display};letter-spacing:-.01em;color:${C.ink}">${escapeHtml(heading)}</h1>
${paragraphs.map((t) => p(t)).join("\n")}
${details.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;border-top:1px solid ${C.line}">${details.map(([k, v]) => `<tr><td style="padding:10px 14px 10px 0;border-bottom:1px solid ${C.line};font:600 11px/1.4 ${mono};letter-spacing:.08em;text-transform:uppercase;color:${C.faint};white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:10px 0;border-bottom:1px solid ${C.line};font:13px/1.45 ${mono};color:${C.ink};overflow-wrap:anywhere">${escapeHtml(v)}</td></tr>`).join("")}</table>` : ""}
${steps.map((s, i) => `<p style="margin:0 0 8px;font:600 15px/1.5 ${font};color:${C.ink}"><span style="color:${C.green};font-family:${mono}">${i + 1}.</span> ${escapeHtml(s.title)}</p>${s.code ? `<pre style="margin:0 0 18px;padding:12px 14px;background:${C.panel};border:1px solid ${C.line};border-radius:9px;font:12px/1.6 ${mono};color:${C.ink};white-space:pre-wrap;word-break:break-all">${escapeHtml(s.code)}</pre>` : ""}`).join("\n")}
${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 10px"><tr><td bgcolor="${C.green}" style="background:${C.green};border-radius:99px"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:14px 26px;font:700 15px/1 ${font};color:${C.onGreen};text-decoration:none;border-radius:99px">${escapeHtml(button.label)} &rarr;</a></td></tr></table>
<p style="margin:0 0 22px;font:12px/1.55 ${font};color:${C.faint}">Or open this link: <a href="${escapeHtml(button.url)}" style="color:${C.dim};word-break:break-all">${escapeHtml(button.url)}</a></p>` : ""}
${closing.map((t) => p(t, C.dim)).join("\n")}
</td></tr>
${footer ? `<tr><td style="padding:18px 6px 0;font:12px/1.6 ${font};color:${C.faint}">${escapeHtml(footer)}</td></tr>` : ""}
</table></td></tr></table></body></html>`;

  const text = [
    heading,
    ...paragraphs,
    ...(details.length ? [details.map(([k, v]) => `${k}: ${v}`).join("\n")] : []),
    ...steps.map((s, i) => `${i + 1}. ${s.title}${s.code ? `\n\n${s.code.replace(/^/gm, "   ")}` : ""}`),
    ...(button ? [`${button.label}:\n${button.url}`] : []),
    ...closing,
    ...(footer ? [`—\n${footer}`] : []),
  ].join("\n\n") + "\n";
  return { html, text };
}
