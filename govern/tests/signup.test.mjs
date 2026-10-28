// Self-serve signup: email → one-time link → tenant + first admin key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { freshDb, makeClock, startApp, client } from "./helpers.mjs";
import { mailerFromEnv } from "../mailer.js";
import { SIGNUP_ACCEPTED } from "../signup.js";

let pool;
before(async () => { pool = await freshDb(); });
after(async () => { await pool?.end(); });

// A mailer that records instead of sending.
function mockMailer() {
  const sent = [];
  return { sent, send: async (msg) => { sent.push(msg); }, linkTo: (to) => [...sent].reverse().find((m) => m.to === to)?.text.match(/#token=([\w-]+)/)?.[1] };
}
const tenants = async () => (await pool.query("SELECT count(*)::int AS n FROM sv_tenants")).rows[0].n;

test("unconfigured email delivery: signup refuses honestly instead of creating unverified accounts", async () => {
  const app = await startApp(pool, { mailer: null });
  try {
    const res = await client(app.url).post("/signup", { email: "a@example.com", org_name: "Acme" });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "signup_unavailable");
  } finally { await app.close(); }
});

test("signup → link → tenant and a working admin key, once", async () => {
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer, signupVerifyUrl: "https://spendveto.com/signup/verify" });
  try {
    const anon = client(app.url);
    const before = await tenants();
    const req = await anon.post("/signup", { email: "Founder@Acme.example", org_name: "Acme Robotics" });
    assert.equal(req.status, 202);
    assert.equal(req.body.message, SIGNUP_ACCEPTED);
    assert.equal(await tenants(), before, "nothing is created until the link is opened");
    const mail = mailer.sent.at(-1);
    assert.equal(mail.to, "founder@acme.example");
    assert.match(mail.text, /^Finish creating the SpendVeto account for Acme Robotics:\n\nhttps:\/\/spendveto\.com\/signup\/verify#token=/);
    const token = mailer.linkTo("founder@acme.example");
    const stored = (await pool.query("SELECT token_hash FROM sv_signups WHERE email = $1", ["founder@acme.example"])).rows[0].token_hash;
    assert.notEqual(stored, token, "the token is stored as its digest");

    const ok = await anon.post("/signup/verify", { token });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.tenant.name, "Acme Robotics");
    assert.match(ok.body.admin_key, /^svk_/);
    const me = await client(app.url, ok.body.admin_key).get("/tenant");
    assert.equal(me.status, 200);
    assert.equal(me.body.tenant?.name ?? me.body.name, "Acme Robotics");

    const again = await anon.post("/signup/verify", { token });
    assert.equal(again.status, 400, "a link creates at most one account");
    assert.equal(again.body.code, "invalid_token");
    assert.equal(await tenants(), before + 1);
  } finally { await app.close(); }
});

test("an address with an account gets the same answer and an email — never a second tenant", async () => {
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer });
  try {
    const anon = client(app.url);
    const before = await tenants();
    const res = await anon.post("/signup", { email: "founder@acme.example", org_name: "Acme Again" });
    assert.equal(res.status, 202);
    assert.equal(res.body.message, SIGNUP_ACCEPTED, "identical answer: no account enumeration");
    assert.equal(mailer.sent.at(-1).subject, "You already have a SpendVeto account");
    assert.ok(!/#token=/.test(mailer.sent.at(-1).text));
    assert.equal(await tenants(), before);
  } finally { await app.close(); }
});

test("links expire after 24 hours, and asking again replaces the old link", async () => {
  const clock = makeClock();
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer, now: clock.now });
  try {
    const anon = client(app.url);
    await anon.post("/signup", { email: "late@example.com", org_name: "Late Co" });
    const first = mailer.linkTo("late@example.com");
    clock.advance(24 * 3600 + 1);
    assert.equal((await anon.post("/signup/verify", { token: first })).status, 400, "expired");
    await anon.post("/signup", { email: "late@example.com", org_name: "Late Co" });
    const second = mailer.linkTo("late@example.com");
    assert.notEqual(second, first);
    assert.equal((await anon.post("/signup/verify", { token: first })).status, 400, "the old link stays dead");
    assert.equal((await anon.post("/signup/verify", { token: second })).status, 201);
  } finally { await app.close(); }
});

test("abuse limits: 3 links per address per hour, 10 requests per client per hour", async () => {
  const clock = makeClock(new Date("2026-04-01T09:00:00Z"));
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer, now: clock.now });
  try {
    const anon = client(app.url);
    for (let i = 0; i < 5; i++) assert.equal((await anon.post("/signup", { email: "spam@example.com", org_name: "Spam" })).status, 202);
    assert.equal(mailer.sent.filter((m) => m.to === "spam@example.com").length, 3, "the 4th and 5th send nothing, but answer the same");
    for (let i = 0; i < 5; i++) await anon.post("/signup", { email: `x${i}@example.com`, org_name: "X" });
    const limited = await anon.post("/signup", { email: "y@example.com", org_name: "Y" });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "rate_limited");
    clock.advance(3601);
    assert.equal((await anon.post("/signup", { email: "spam@example.com", org_name: "Spam" })).status, 202, "the window rolls over");
    assert.equal(mailer.sent.filter((m) => m.to === "spam@example.com").length, 4);
  } finally { await app.close(); }
});

test("with a human check configured, a failed check sends nothing", async () => {
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer, verifyHuman: async (token) => token === "human" });
  try {
    const anon = client(app.url);
    const bot = await anon.post("/signup", { email: "bot@example.com", org_name: "Bot" });
    assert.equal(bot.status, 400);
    assert.equal(bot.body.code, "bot_check_failed");
    assert.equal(mailer.sent.length, 0);
    assert.equal((await anon.post("/signup", { email: "person@example.com", org_name: "Person", turnstile_token: "human" })).status, 202);
  } finally { await app.close(); }
});

test("two verifications racing on one link create exactly one tenant", async () => {
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer });
  try {
    const anon = client(app.url);
    await anon.post("/signup", { email: "race@example.com", org_name: "Race" });
    const token = mailer.linkTo("race@example.com");
    const results = await Promise.all(Array.from({ length: 6 }, () => anon.post("/signup/verify", { token })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sv_tenants WHERE name = 'Race'")).rows[0].n, 1);
  } finally { await app.close(); }
});

test("invalid input and a failing mail provider answer clearly", async () => {
  const app = await startApp(pool, { mailer: { send: async () => { throw new Error("provider down"); } } });
  try {
    const anon = client(app.url);
    assert.equal((await anon.post("/signup", { email: "not-an-email", org_name: "X" })).status, 400);
    assert.equal((await anon.post("/signup", { email: "a@b.example", org_name: "" })).status, 400);
    assert.equal((await anon.post("/signup/verify", { token: "short" })).status, 400);
    const down = await anon.post("/signup", { email: "down@example.com", org_name: "Down" });
    assert.equal(down.status, 502);
    assert.equal(down.body.code, "mail_failed");
  } finally { await app.close(); }
});

test("CORS answers the site's origins on the signup routes only", async () => {
  const app = await startApp(pool, { mailer: mockMailer() });
  try {
    const preflight = (path, origin) => fetch(app.url + path, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    const site = await preflight("/signup", "https://spendveto.com");
    assert.equal(site.status, 204);
    assert.equal(site.headers.get("access-control-allow-origin"), "https://spendveto.com");
    assert.equal((await preflight("/signup", "https://evil.example")).headers.get("access-control-allow-origin"), null);
    assert.equal((await preflight("/budgets", "https://spendveto.com")).headers.get("access-control-allow-origin"), null);
  } finally { await app.close(); }
});

// Wallet-first signup: the site asks for a challenge, the wallet signs it.
const SITE = { Origin: "https://spendveto.com" };
const newWallet = () => privateKeyToAccount(generatePrivateKey());
async function walletProof(anon, account, signer = account) {
  const res = await anon.post("/signup/wallet", { address: account.address }, SITE);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { message: res.body.message, signature: await signer.signMessage({ message: res.body.message }) };
}
const ownerWallet = newWallet();

test("wallet-first signup: the wallet signs a challenge for the site's domain, the email link creates a tenant that wallet owns", async () => {
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer });
  try {
    const anon = client(app.url);
    const proof = await walletProof(anon, ownerWallet);
    assert.match(proof.message, /^spendveto\.com wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n/);
    assert.ok(proof.message.includes(ownerWallet.address) && /\nURI: https:\/\/spendveto\.com\n/.test(proof.message) && /\nExpiration Time: /.test(proof.message));
    const req = await anon.post("/signup", { email: "wallet@acme.example", org_name: "Wallet Co", wallet: proof });
    assert.equal(req.status, 202);
    assert.equal(req.body.message, SIGNUP_ACCEPTED, "the same answer as an email-only signup");
    assert.ok(mailer.sent.at(-1).text.includes(`owned by the wallet ${ownerWallet.address}`), "the email names the wallet");
    const made = await anon.post("/signup/verify", { token: mailer.linkTo("wallet@acme.example") });
    assert.equal(made.status, 201);
    assert.equal(made.body.tenant.owner_wallet, ownerWallet.address.toLowerCase());
    const me = await client(app.url, made.body.admin_key).get("/tenant");
    assert.equal(me.body.tenant.owner_wallet, ownerWallet.address.toLowerCase());
  } finally { await app.close(); }
});

test("wallet challenges come only from the site, and a proof is refused unless it's the issued message, signed by its wallet, once", async () => {
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer });
  try {
    const anon = client(app.url);
    const w = newWallet();
    assert.equal((await anon.post("/signup/wallet", { address: w.address })).body.code, "wallet_origin_required", "no Origin: not from a browser on the site");
    assert.equal((await anon.post("/signup/wallet", { address: w.address }, { Origin: "https://evil.example" })).body.code, "wallet_origin_required");
    const wrongKey = await anon.post("/signup", { email: "a1@example.com", org_name: "A", wallet: await walletProof(anon, w, newWallet()) });
    assert.equal(wrongKey.status, 400);
    assert.equal(wrongKey.body.code, "wallet_proof_invalid", "signed by a key other than the address the challenge names");
    const issued = await walletProof(anon, w);
    const forged = issued.message.replace("spendveto.com wants", "evil.example wants");
    assert.equal((await anon.post("/signup", { email: "a2@example.com", org_name: "A", wallet: { message: forged, signature: await w.signMessage({ message: forged }) } })).body.code, "wallet_proof_invalid", "a message the service didn't write");
    const good = await walletProof(anon, w);
    assert.equal((await anon.post("/signup", { email: "a3@example.com", org_name: "A", wallet: good })).status, 202);
    assert.equal((await anon.post("/signup", { email: "a4@example.com", org_name: "A", wallet: good })).body.code, "wallet_proof_invalid", "single-use");
    assert.equal(mailer.sent.length, 1);
  } finally { await app.close(); }
});

test("one account per wallet, and wallet proofs expire after ten minutes", async () => {
  const clock = makeClock();
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer, now: clock.now });
  try {
    const anon = client(app.url);
    const taken = await anon.post("/signup", { email: "second@acme.example", org_name: "Again", wallet: await walletProof(anon, ownerWallet) });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, "wallet_taken");
    const late = await walletProof(anon, newWallet());
    clock.advance(601);
    assert.equal((await anon.post("/signup", { email: "late-wallet@example.com", org_name: "Late", wallet: late })).body.code, "wallet_proof_expired");
    assert.equal(mailer.sent.length, 0);
  } finally { await app.close(); }
});

test("two pending signups signed by one wallet: the first link opened gets it, the second is refused", async () => {
  const mailer = mockMailer();
  const app = await startApp(pool, { mailer });
  try {
    const anon = client(app.url);
    const w = newWallet();
    await anon.post("/signup", { email: "first@twin.example", org_name: "Twin", wallet: await walletProof(anon, w) });
    await anon.post("/signup", { email: "second@twin.example", org_name: "Twin", wallet: await walletProof(anon, w) });
    assert.equal((await anon.post("/signup/verify", { token: mailer.linkTo("second@twin.example") })).status, 201);
    const loser = await anon.post("/signup/verify", { token: mailer.linkTo("first@twin.example") });
    assert.equal(loser.status, 409);
    assert.equal(loser.body.code, "wallet_taken");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sv_tenants WHERE owner_wallet = $1", [w.address.toLowerCase()])).rows[0].n, 1);
  } finally { await app.close(); }
});

test("mail providers: Resend and Postmark requests, and none without config", async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  assert.equal(mailerFromEnv({}, fake), null);
  assert.equal(mailerFromEnv({ SPENDVETO_MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" }, fake), null, "needs a From address too");
  await mailerFromEnv({ SPENDVETO_MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", SPENDVETO_MAIL_FROM: "SpendVeto <noreply@spendveto.com>" }, fake).send({ to: "a@b.example", subject: "s", text: "t", html: "h" });
  await mailerFromEnv({ SPENDVETO_MAIL_PROVIDER: "postmark", POSTMARK_SERVER_TOKEN: "pm_x", SPENDVETO_MAIL_FROM: "noreply@spendveto.com" }, fake).send({ to: "a@b.example", subject: "s", text: "t", html: "h" });
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_x");
  assert.deepEqual(JSON.parse(calls[0].init.body).to, ["a@b.example"]);
  assert.equal(calls[1].url, "https://api.postmarkapp.com/email");
  assert.equal(calls[1].init.headers["X-Postmark-Server-Token"], "pm_x");
  assert.equal(JSON.parse(calls[1].init.body).To, "a@b.example");
});
