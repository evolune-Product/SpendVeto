import { useEffect, useState } from "react";
import { changePassword, users, wallets } from "../api.js";
import { signWalletChallenge, WalletButton } from "../Auth.jsx";
import { EmptyRow, FormNote, NO_NOTE } from "../ui.jsx";

/* ---------- Users (Console accounts) ---------- */
// Admins invite people and set their role; everyone can change their own
// password. Inviting the first user turns sign-in on for this Console.
const ROLES = ["viewer", "approver", "admin"];
const dateTime = (ts) => new Date(ts).toLocaleString();

export default function Users({ auth, onSignedOut, onUserChange }) {
  const [list, setList] = useState(null);
  const [note, setNote] = useState(NO_NOTE);
  const [invite, setInvite] = useState(null);
  const [pwNote, setPwNote] = useState(NO_NOTE);
  const [walletNote, setWalletNote] = useState(NO_NOTE);
  const isAdmin = !auth.required || auth.user?.role === "admin";

  const load = () => users.list().then((b) => setList(b.users || [])).catch(() => setList(null));
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  const result = (out, okText) => {
    if (out.ok) { setNote({ err: false, text: okText }); load(); }
    else setNote({ err: true, text: out.body.error || "failed" });
  };

  async function sendInvite(e) {
    e.preventDefault();
    const f = e.currentTarget;
    const out = await users.invite(f.email.value.trim(), f.role.value);
    if (out.ok) { setInvite(out.body); f.reset(); load(); setNote(NO_NOTE); }
    else { setInvite(null); setNote({ err: true, text: out.body.error || "invite failed" }); }
  }
  async function savePassword(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (f.next.value !== f.confirm.value) return setPwNote({ err: true, text: "the two new passwords don't match" });
    const out = await changePassword(f.current.value, f.next.value);
    if (out.ok) onSignedOut();
    else setPwNote({ err: true, text: out.body.error || "failed" });
  }

  return (
    <>
      <header><h1>Users</h1><p>Who can sign in to this Console, and what they may do: viewers read, approvers also decide approvals, admins change everything.</p></header>
      {isAdmin && (
        <div className="two-col">
          <div className="card">
            <h2>Invite someone <span className="hint">they set their own password from the link</span></h2>
            <form className="form" onSubmit={sendInvite}>
              <label>Email <input type="email" name="email" required /></label>
              <label>Role <select name="role" defaultValue="viewer">{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
              <button className="btn go" type="submit">Create invite link</button>
            </form>
            {invite && (
              <div className="invite-link">
                {invite.emailed ? (
                  <p className="form-note">Emailed the invite to {invite.user.email}. The link works once, until {dateTime(invite.expiresAt)} — if the email doesn't arrive, send them this yourself (it isn't shown again):</p>
                ) : (
                  <p className="hint">
                    {invite.reason === "send_failed" ? `Couldn't email it (${invite.error}). ` : "Email isn't set up on this server. "}
                    Send this to {invite.user.email} yourself — it works once, until {dateTime(invite.expiresAt)}. It isn't shown again.
                  </p>
                )}
                <code>{invite.inviteUrl}</code>
              </div>
            )}
            {!auth.required && <p className="hint">Sign-in is off: no user exists yet. Inviting the first admin turns it on for this Console.</p>}
          </div>
          <div className="card">
            <h2>Accounts</h2>
            <table className="tbl">
              <thead><tr><th>email</th><th>role</th><th>status</th><th>last sign-in</th><th></th></tr></thead>
              <tbody>
                {list && list.length ? list.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}{u.id === auth.user?.id ? " (you)" : ""}</td>
                    <td><select value={u.role} onChange={async (e) => result(await users.update(u.id, { role: e.target.value }), `${u.email} is now ${e.target.value}`)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td>
                    <td>{u.status}</td>
                    <td>{u.lastLoginAt ? dateTime(u.lastLoginAt) : "never"}</td>
                    <td>
                      <button className="btn mini" onClick={async () => result(await users.update(u.id, { disabled: u.status !== "disabled" }), `${u.email} ${u.status === "disabled" ? "enabled" : "disabled and signed out"}`)}>{u.status === "disabled" ? "Enable" : "Disable"}</button>{" "}
                      <button className="btn mini deny" onClick={async () => result(await users.remove(u.id), `${u.email} removed`)}>Remove</button>
                    </td>
                  </tr>
                )) : <EmptyRow cols={5}>{list ? "No accounts yet." : "…"}</EmptyRow>}
              </tbody>
            </table>
            <FormNote note={note} />
          </div>
        </div>
      )}
      {auth.user && (
        <div className="card">
          <h2>Your password <span className="hint">changing it signs you out everywhere</span></h2>
          <form className="form narrow" onSubmit={savePassword}>
            <label>Current password <input type="password" name="current" autoComplete="current-password" required /></label>
            <label>New password <span className="hint">at least 12 characters</span> <input type="password" name="next" autoComplete="new-password" minLength={12} required /></label>
            <label>Confirm new password <input type="password" name="confirm" autoComplete="new-password" minLength={12} required /></label>
            <button className="btn go" type="submit">Change password</button>
            <FormNote note={pwNote} />
          </form>
        </div>
      )}
      {auth.user && (
        <div className="card">
          <h2>Your wallets <span className="hint">sign in with a signature from any of them instead of your password</span></h2>
          <table className="tbl">
            <tbody>
              {auth.user.wallets?.length ? auth.user.wallets.map((address) => (
                <tr key={address}>
                  <td><code>{address}</code></td>
                  <td>
                    <button className="btn mini deny" onClick={async () => {
                      const out = await wallets.unlink(address);
                      if (out.ok) { onUserChange(out.body.user); setWalletNote({ err: false, text: "Wallet unlinked — it no longer signs you in." }); }
                      else setWalletNote({ err: true, text: out.body.error || "failed" });
                    }}>Unlink</button>
                  </td>
                </tr>
              )) : <EmptyRow cols={2}>No wallet linked yet.</EmptyRow>}
            </tbody>
          </table>
          <WalletButton
            label="Link a wallet"
            run={async (wallet) => {
              const signed = await signWalletChallenge(wallet, "link");
              const out = await wallets.link(signed.message, signed.signature);
              if (!out.ok) return out.body.error || "couldn't link the wallet";
              onUserChange(out.body.user);
              setWalletNote({ err: false, text: `Linked ${signed.address} — it can sign you in from now on.` });
            }}
          />
          <FormNote note={walletNote} />
        </div>
      )}
      {!isAdmin && !auth.user && <div className="card"><p className="hint">Sign in to manage accounts.</p></div>}
    </>
  );
}
