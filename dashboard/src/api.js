// The Console's only I/O: the local API (same origin) and the proxy on :8404.
// `fetch` is looked up per call, never captured, so the demo's patched
// window.fetch (demo-api.js) answers every request.
export const PROXY_BASE = "http://localhost:8404";

// Same-origin calls say they come from the Console: a signed-in session's
// writes are refused without it (server/auth.js), and a cross-site page can't
// add it. Not sent to the proxy — a custom header there would need a CORS
// preflight it doesn't answer.
const request = (path, opts = {}) => fetch(path, path.startsWith("/") ? { ...opts, headers: { "X-SpendVeto-Request": "1", ...(opts.headers || {}) } } : opts);

// A 401 on a read means the session is gone: the Console shows sign-in.
export class AuthRequired extends Error {}
const getJson = (path) => request(path).then((r) => { if (r.status === 401) throw new AuthRequired(); return r.json(); });
const optional = (path) => getJson(path).catch((e) => { if (e instanceof AuthRequired) throw e; return null; });

export const api = (path, opts) => request(path, opts).then((r) => r.json().catch(() => ({})).then((body) => ({ ok: r.ok, status: r.status, body })));
export const sendJson = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// One poll: every page's data at once. The core reads must all succeed (a
// failure leaves the last good state on screen); newer surfaces are optional.
export async function fetchState(costsGroup) {
  const [ledger, stats, catalog, approvals, delegations, freezes, chains, analytics, policy, packs, rails, llm, costs, costsRail, rebilling, payouts, attestations, reputation, policyCheck] = await Promise.all([
    getJson("/api/ledger"),
    getJson("/api/stats"),
    getJson("/api/catalog"),
    getJson("/api/approvals"),
    getJson("/api/delegations"),
    getJson("/api/freezes"),
    getJson("/api/chains"),
    getJson("/api/analytics"),
    getJson("/api/policy"),
    getJson("/api/policy-packs"),
    getJson("/api/rails"),
    optional("/api/llm/summary"),
    optional(`/api/costs?groupBy=${encodeURIComponent(costsGroup)}&days=30`),
    optional("/api/costs?groupBy=rail&days=30"),
    optional("/api/rebilling"),
    optional("/api/payouts"),
    optional("/api/attestations"),
    optional("/api/reputation"),
    optional("/api/policy/validate"),
  ]);
  return {
    entries: ledger.entries || [], balances: ledger.balances || {}, mode: ledger.mode, stats, tools: catalog.tools || [],
    approvals: approvals.approvals || [], delegations: delegations.delegations || [], freezes: freezes.freezes || [],
    chains: chains.chains || [], analytics, policy, packs: packs.packs || [], rails: rails.rails || [],
    llm, costs, costsRail, rebilling, payouts, attestations, reputation, policyCheck,
  };
}

export const fetchTrust = (addr) => getJson(`/api/trust/${addr}`);
export const fetchReport = (days) => getJson(`/api/report?days=${days}`);
export const fetchLlmConnect = () => getJson("/api/llm/connect");
export const fetchAgents = () => getJson(`${PROXY_BASE}/proxy/agents`);

// Sign-in (server/accounts.js). The session is an HttpOnly cookie, so the
// Console never holds it — it only learns who is signed in.
export const fetchAuthState = () => request("/api/auth/state").then((r) => r.json()).then((b) => ({ authRequired: Boolean(b.authRequired), user: b.user || null })).catch(() => ({ authRequired: false, user: null }));
export const signIn = (email, password) => api("/api/auth/login", sendJson("POST", { email, password }));
export const signOut = () => api("/api/auth/logout", { method: "POST" });
export const acceptInvite = (token, name, password) => api("/api/auth/accept-invite", sendJson("POST", { token, name, password }));
export const changePassword = (current, next) => api("/api/auth/password", sendJson("POST", { current, next }));
// Wallet sign-in: the server writes the message, the wallet signs it.
export const wallets = {
  challenge: (address, purpose) => api("/api/auth/wallet/challenge", sendJson("POST", { address, purpose })),
  login: (message, signature) => api("/api/auth/wallet/login", sendJson("POST", { message, signature })),
  link: (message, signature) => api("/api/auth/wallet/link", sendJson("POST", { message, signature })),
  unlink: (address) => api(`/api/auth/wallet/${address}`, { method: "DELETE" }),
};
export const users = {
  list: () => getJson("/api/users"),
  invite: (email, role) => api("/api/users/invite", sendJson("POST", { email, role })),
  update: (id, patch) => api(`/api/users/${id}`, sendJson("PATCH", patch)),
  remove: (id) => api(`/api/users/${id}`, { method: "DELETE" }),
};
