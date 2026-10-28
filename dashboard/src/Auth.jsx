import { useState } from "react";
import { discoverWallets, signChallenge, walletErrorText } from "../../client/browser-wallet.js";
import { acceptInvite, signIn, wallets as walletApi } from "./api.js";
import { FormNote, NO_NOTE } from "./ui.jsx";

// Signs the server's challenge for `purpose` ("login" or "link") with the
// chosen wallet. Returns the signed message, or throws with the server's reason.
export const signWalletChallenge = (wallet, purpose) =>
  signChallenge(wallet, async (address) => {
    const out = await walletApi.challenge(address, purpose);
    if (!out.ok) throw new Error(out.body.error || "couldn't start the wallet request");
    return out.body.message;
  });

// A button that finds the browser's wallets and runs `run(wallet)` with the
// one picked (straight away when there's only one). `run` returns an error
// text to show, or nothing on success.
export function WalletButton({ label, run }) {
  const [found, setFound] = useState(null);
  const [note, setNote] = useState(NO_NOTE);
  const [busy, setBusy] = useState(false);
  async function use(wallet) {
    setBusy(true);
    setNote(NO_NOTE);
    try {
      const err = await run(wallet);
      if (err) setNote({ err: true, text: err });
    } catch (e) { setNote({ err: true, text: walletErrorText(e) }); }
    setBusy(false);
  }
  async function start() {
    const list = await discoverWallets();
    if (!list.length) return setNote({ err: true, text: "No browser wallet found. Install MetaMask, Rabby or another extension wallet, then reload." });
    if (list.length === 1) return use(list[0]);
    setFound(list);
  }
  return (
    <div className="wallet-pick">
      {found ? found.map((w) => (
        <button key={w.id} type="button" className="btn wallet-opt" disabled={busy} onClick={() => use(w)}>
          {w.icon && <img src={w.icon} alt="" width="18" height="18" />}{w.name}
        </button>
      )) : <button type="button" className="btn" disabled={busy} onClick={start}>{busy ? "Waiting for your wallet…" : label}</button>}
      {busy && found && <p className="hint">Check your wallet for the signature request.</p>}
      <FormNote note={note} />
    </div>
  );
}

// The two screens the Console shows before anything else when sign-in is on:
// signing in, and setting a password from an invite link. Both take the whole
// window — no page data is fetched until a session exists.
function Screen({ title, sub, children }) {
  return (
    <div className="auth-screen">
      <div className="card auth-card">
        <div className="brand">SPENDVETO<span> console</span></div>
        <h1>{title}</h1>
        <p className="hint">{sub}</p>
        {children}
      </div>
    </div>
  );
}

export function SignIn({ onSignedIn }) {
  const [note, setNote] = useState(NO_NOTE);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const f = e.currentTarget;
    setBusy(true);
    const { ok, body } = await signIn(f.email.value.trim(), f.password.value);
    setBusy(false);
    if (ok) return onSignedIn(body.user);
    f.password.value = "";
    setNote({ err: true, text: body.error || "sign-in failed" });
  }
  return (
    <Screen title="Sign in" sub="Your account was created by an admin of this SpendVeto instance.">
      <form className="form" onSubmit={submit}>
        <label>Email <input type="email" name="email" autoComplete="username" required autoFocus /></label>
        <label>Password <input type="password" name="password" autoComplete="current-password" required /></label>
        <button className="btn go" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <FormNote note={note} />
      </form>
      <div className="auth-or"><span>or</span></div>
      <WalletButton
        label="Sign in with a wallet"
        run={async (wallet) => {
          const signed = await signWalletChallenge(wallet, "login");
          const out = await walletApi.login(signed.message, signed.signature);
          if (out.ok) return onSignedIn(out.body.user);
          return out.body.error || "wallet sign-in failed";
        }}
      />
      <p className="hint">A wallet signs you in once you've linked it to your account (Users page). It's a signature, never a transaction.</p>
      <p className="hint">Forgot your password? An admin can send you a new link (<code>npm run user -- reset you@company.com</code> on the host).</p>
    </Screen>
  );
}

export function AcceptInvite({ token, onSignedIn }) {
  const [note, setNote] = useState(NO_NOTE);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (f.password.value !== f.confirm.value) return setNote({ err: true, text: "the two passwords don't match" });
    setBusy(true);
    const { ok, body } = await acceptInvite(token, f.name.value.trim(), f.password.value);
    setBusy(false);
    if (ok) return onSignedIn(body.user);
    setNote({ err: true, text: body.error || "couldn't accept the invite" });
  }
  return (
    <Screen title="Set your password" sub="You've been invited to this SpendVeto Console. The link works once.">
      <form className="form" onSubmit={submit}>
        <label>Your name <input type="text" name="name" autoComplete="name" /></label>
        <label>Password <span className="hint">at least 12 characters</span> <input type="password" name="password" autoComplete="new-password" minLength={12} required autoFocus /></label>
        <label>Confirm password <input type="password" name="confirm" autoComplete="new-password" minLength={12} required /></label>
        <button className="btn go" type="submit" disabled={busy}>{busy ? "Saving…" : "Set password and sign in"}</button>
        <FormNote note={note} />
      </form>
    </Screen>
  );
}
