#!/usr/bin/env node
// Console accounts, from the host — the only way to create the first admin
// (there is no unauthenticated way to make one over HTTP, by design).
//
//   npm run user -- invite you@company.com admin   # prints a one-time invite link
//   npm run user -- list
//   npm run user -- reset you@company.com          # new invite link; the old password stops working
//   npm run user -- disable you@company.com
//
// The link opens the Console, where the invitee sets their own password, so
// no password ever passes through a shell or its history. Set
// SPENDVETO_PUBLIC_URL (e.g. https://app.spendveto.com) when the Console isn't
// on this machine's localhost.
import { PORT } from "../shared-config.js";
import { inviteUser, listUsers, updateUser } from "../server/users.js";
import { readFileSync, writeFileSync } from "../server/store.js";
import { dataPath } from "../shared-config.js";
import { closeStore } from "../server/store.js";

const [cmd, email, role] = process.argv.slice(2);
const base = (process.env.SPENDVETO_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const find = (e) => listUsers().find((u) => u.email === String(e || "").trim().toLowerCase());

try {
  if (cmd === "invite") {
    const out = inviteUser({ email, role: role || "viewer" });
    console.log(`\nInvited ${out.user.email} as ${out.user.role}. Open this link to set a password (valid until ${out.expiresAt}, one use):\n\n  ${base}/#accept-invite=${out.token}\n`);
  } else if (cmd === "reset") {
    const user = find(email);
    if (!user) throw new Error(`no user ${email}`);
    // Clearing the password hash is what lets inviteUser issue a fresh link.
    const path = dataPath("users.json");
    writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, "utf8")).map((u) => (u.id === user.id ? { ...u, passwordHash: null } : u)), null, 2));
    const out = inviteUser({ email: user.email, role: user.role });
    console.log(`\n${user.email}'s password no longer works. New link (valid until ${out.expiresAt}, one use):\n\n  ${base}/#accept-invite=${out.token}\n`);
  } else if (cmd === "disable") {
    const user = find(email);
    if (!user) throw new Error(`no user ${email}`);
    updateUser(user.id, { disabled: true });
    console.log(`${user.email} is disabled and signed out everywhere.`);
  } else if (cmd === "list") {
    const users = listUsers();
    if (!users.length) console.log("No Console users yet — `npm run user -- invite you@company.com admin` creates the first.");
    for (const u of users) console.log(`${u.email.padEnd(36)} ${u.role.padEnd(9)} ${u.status.padEnd(9)} last sign-in ${u.lastLoginAt || "never"}${u.wallets.length ? `  wallets ${u.wallets.join(", ")}` : ""}`);
  } else {
    console.log("usage: npm run user -- invite <email> [viewer|approver|admin] | reset <email> | disable <email> | list");
    process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// With Postgres storage, the writes above are committed before the process exits.
await closeStore();
