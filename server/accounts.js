import express from "express";
import { requireAuth, authEnabled } from "./auth.js";
import { createRateLimiter } from "./ratelimit.js";
import { consoleOrigin, sendInvite } from "./console-emails.js";
import { acceptInvite, changePassword, destroySession, inviteUser, linkWallet, listUsers, login, removeUser, sessionTokenFrom, sessionUser, SESSION_COOKIE, SESSION_TTL_MS, unlinkWallet, updateUser, walletChallenge, walletLogin } from "./users.js";

// Console sign-in (server/users.js holds the accounts and sessions).
// The session cookie is HttpOnly (no script reads it), SameSite=Strict (no
// other site sends it), Secure whenever the request arrived over HTTPS, and
// lives 12 hours. Invite links carry their token after the #, so it never
// reaches a server log or a Referer header.
export function createAccountsRouter() {
  const r = express.Router();
  // Password guessing from one client is slowed here as well as by the
  // per-account lockout; local callers are exempt like everywhere else.
  const loginLimit = createRateLimiter({ perMinute: 10, burst: 10 });

  const setSession = (req, res, token) => res.set("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${req.secure ? "; Secure" : ""}`);
  const clearSession = (res) => res.set("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : "something went wrong" });

  r.get("/api/auth/state", (req, res) => {
    res.json({ authRequired: authEnabled(), user: sessionUser(sessionTokenFrom(req)) });
  });

  r.post("/api/auth/login", loginLimit, async (req, res) => {
    const { email, password } = req.body || {};
    const out = await login(email, password);
    if (!out.ok) return res.status(out.locked ? 429 : 401).json({ code: out.locked ? "account_locked" : "login_failed", error: out.error });
    setSession(req, res, out.session);
    res.json({ user: out.user });
  });

  r.post("/api/auth/logout", (req, res) => {
    destroySession(sessionTokenFrom(req));
    clearSession(res);
    res.json({ ok: true });
  });

  r.post("/api/auth/accept-invite", loginLimit, async (req, res) => {
    try {
      const { token, password, name } = req.body || {};
      const user = await acceptInvite({ token, password, name });
      const out = await login(user.email, password);
      setSession(req, res, out.session);
      res.json({ user: out.user });
    } catch (e) { fail(res, e); }
  });

  // Wallet sign-in (users.js): a challenge the server writes, signed in the
  // browser's wallet, sent back. Linking one needs a signed-in Console session.
  // The domain the message names is what the wallet checks against the page
  // asking for the signature, so on a public deployment it comes from
  // SPENDVETO_PUBLIC_URL, never from the request's Host header — which
  // whoever sends the request picks.
  const signedIn = requireAuth("viewer");
  r.post("/api/auth/wallet/challenge", loginLimit, (req, res, next) => (req.body?.purpose === "link" ? signedIn(req, res, next) : next()), (req, res) => {
    try {
      const origin = consoleOrigin(req);
      res.json(walletChallenge({ address: req.body?.address, purpose: req.body?.purpose, user: req.user, host: new URL(origin).host, origin }));
    } catch (e) { fail(res, e); }
  });
  r.post("/api/auth/wallet/login", loginLimit, async (req, res) => {
    const out = await walletLogin(req.body?.message, req.body?.signature);
    if (!out.ok) return res.status(401).json({ code: "wallet_login_failed", error: out.error });
    setSession(req, res, out.session);
    res.json({ user: out.user });
  });
  r.post("/api/auth/wallet/link", signedIn, async (req, res) => {
    if (!req.user) return res.status(400).json({ error: "sign in to the Console to link a wallet" });
    try { res.json({ user: await linkWallet(req.user.id, req.body?.message, req.body?.signature) }); } catch (e) { fail(res, e); }
  });
  r.delete("/api/auth/wallet/:address", signedIn, (req, res) => {
    if (!req.user) return res.status(400).json({ error: "sign in to the Console to manage your wallets" });
    try { res.json({ user: unlinkWallet(req.user.id, req.params.address) }); } catch (e) { fail(res, e); }
  });

  r.post("/api/auth/password", requireAuth("viewer"), async (req, res) => {
    if (!req.user) return res.status(400).json({ error: "sign in to the Console to change a password" });
    try {
      await changePassword(req.user.id, req.body?.current, req.body?.next);
      clearSession(res);
      res.json({ ok: true, signedOut: true });
    } catch (e) { fail(res, e); }
  });

  r.get("/api/users", requireAuth("admin"), (req, res) => res.json({ users: listUsers() }));
  // The link is emailed when a mail provider is configured (console-emails.js),
  // and always handed back too, so the admin can pass it on if mail is off or fails.
  r.post("/api/users/invite", requireAuth("admin"), async (req, res) => {
    try {
      const out = inviteUser(req.body || {});
      const consoleUrl = consoleOrigin(req);
      const inviteUrl = `${consoleUrl}/#accept-invite=${out.token}`;
      const delivery = await sendInvite({ user: out.user, inviteUrl, expiresAt: out.expiresAt, invitedBy: req.user?.email, consoleUrl });
      res.status(201).json({ user: out.user, expiresAt: out.expiresAt, inviteUrl, ...delivery });
    } catch (e) { fail(res, e); }
  });
  r.patch("/api/users/:id", requireAuth("admin"), (req, res) => {
    try { res.json({ user: updateUser(req.params.id, req.body || {}) }); } catch (e) { fail(res, e); }
  });
  r.delete("/api/users/:id", requireAuth("admin"), (req, res) => {
    try { removeUser(req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  return r;
}
