import { useEffect, useState } from "react";
import { discoverWallets, signChallenge, walletErrorText } from "../../../client/browser-wallet.js";

// Self-serve signup for the hosted Governance API (govern/signup.js): the form
// asks for a link by email; the link's page creates the account and shows its
// admin key, once. `api` is the Governance API's origin, fixed at build time.
// Optionally a browser wallet signs first and becomes the account's owner —
// the email link still creates the account.

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The optional wallet step: the Governance API writes the message (this
// site's domain, a nonce, ten minutes to use it), the wallet signs it.
function WalletStep({ api, wallet, onSigned, onClear }) {
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function challengeFor(address) {
    let res;
    try {
      res = await fetch(`${api}/v1/signup/wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
    } catch {
      throw new Error("Couldn't reach the signup service — try again in a minute.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Couldn't start the wallet request.");
    return body.message;
  }
  async function use(w) {
    setBusy(true);
    setErr("");
    try {
      onSigned(await signChallenge(w, challengeFor));
      setFound(null);
    } catch (e) { setErr(walletErrorText(e)); }
    setBusy(false);
  }
  async function start() {
    setErr("");
    const list = await discoverWallets();
    if (!list.length) return setErr("No browser wallet found. Install MetaMask, Rabby or another extension wallet — or just use your email below.");
    if (list.length === 1) return use(list[0]);
    setFound(list);
  }

  if (wallet) {
    return (
      <p className="wallet-chip">
        <span>✓ Wallet <code>{short(wallet.address)}</code> signed — it will own the account.</span>
        <button type="button" className="link-btn" onClick={onClear}>Remove</button>
      </p>
    );
  }
  return (
    <div className="wallet-step">
      {found ? (
        <div className="wallet-list">
          {found.map((w) => (
            <button key={w.id} type="button" className="wallet-opt" disabled={busy} onClick={() => use(w)}>
              {w.icon && <img src={w.icon} alt="" width="20" height="20" />}{w.name}
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className="go ghost" disabled={busy} onClick={start}>{busy ? "Check your wallet…" : "Connect a wallet (optional)"}</button>
      )}
      {busy && found && <p className="signup-note">Check your wallet for the signature request.</p>}
      {err && <p className="signup-note err">{err}</p>}
      <p className="wallet-hint">A signature, never a transaction. The wallet becomes the account's owner; you'll still confirm your email.</p>
    </div>
  );
}

export function SignupForm({ api }) {
  const [state, setState] = useState({ phase: "idle", text: "" });
  const [wallet, setWallet] = useState(null);
  async function submit(e) {
    e.preventDefault();
    const f = e.currentTarget;
    setState({ phase: "sending", text: "" });
    try {
      const res = await fetch(`${api}/v1/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: f.email.value.trim(), org_name: f.org.value.trim(), ...(wallet ? { wallet: { message: wallet.message, signature: wallet.signature } } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return setState({ phase: "sent", text: body.message });
      // A spent, expired or already-used wallet signature: sign again.
      if (/^wallet_/.test(body.code || "")) setWallet(null);
      setState({ phase: "error", text: body.error || "Something went wrong — try again in a minute." });
    } catch {
      setState({ phase: "error", text: "Couldn't reach the signup service — try again in a minute." });
    }
  }
  if (state.phase === "sent") {
    return <p className="signup-note ok">{state.text}{wallet && <> The account will be owned by <code>{short(wallet.address)}</code>.</>}</p>;
  }
  return (
    <form className="signup-form" onSubmit={submit}>
      <WalletStep api={api} wallet={wallet} onSigned={setWallet} onClear={() => setWallet(null)} />
      <label>Work email<input type="email" name="email" autoComplete="email" required /></label>
      <label>Company or project<input type="text" name="org" autoComplete="organization" maxLength={200} required /></label>
      <button className="go" type="submit" disabled={state.phase === "sending"}>{state.phase === "sending" ? "Sending…" : "Email me a sign-up link →"}</button>
      {state.phase === "error" && <p className="signup-note err">{state.text}</p>}
    </form>
  );
}

export function SignupVerify({ api }) {
  const [state, setState] = useState({ phase: "checking" });
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    // The token leaves the address bar at once, so a screenshot or a shared
    // URL can't carry a still-valid link.
    history.replaceState(null, "", location.pathname);
    if (!token) return setState({ phase: "error", text: "This page needs the link from your sign-up email." });
    fetch(`${api}/v1/signup/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) }))
      .then(({ ok, body }) => setState(ok ? { phase: "done", ...body } : { phase: "error", text: body.error || "This link couldn't be used." }))
      .catch(() => setState({ phase: "error", text: "Couldn't reach the signup service — reload to try again." }));
  }, [api]);

  if (state.phase === "checking") return <p className="signup-note">Creating your account…</p>;
  if (state.phase === "error") return <p className="signup-note err">{state.text} <a href="/signup">Start again</a></p>;
  const example = `curl ${api}/v1/tenant \\\n  -H "Authorization: Bearer ${state.admin_key}"`;
  return (
    <div className="key-reveal">
      <p className="signup-note ok">
        Account created for <b>{state.tenant.name}</b> ({state.email}){state.tenant.owner_wallet && <>, owned by wallet <code>{state.tenant.owner_wallet}</code></>}.
      </p>
      <p><b>Your admin API key — shown once.</b> Copy it into your secrets manager now; SpendVeto stores only its fingerprint and can't show it again.</p>
      <code className="key">{state.admin_key}</code>
      <button className="go ghost" type="button" onClick={() => navigator.clipboard?.writeText(state.admin_key)}>Copy key</button>
      <p>Check it works:</p>
      <pre className="block">{example}</pre>
      <p>Use it to mint narrower keys for your agents (<code>POST /v1/keys</code> with <code>spend</code> or <code>read</code> scopes) and keep this one for administration. <a href="/docs">Read the docs →</a></p>
    </div>
  );
}
