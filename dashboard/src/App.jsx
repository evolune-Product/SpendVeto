// SpendVeto Console — multi-page governance control surface over the local API.
// Hash-routed pages; state polled every 2s; every button hits a real endpoint.
// Rendering never touches window/location/fetch (effects only), so the same
// tree prerenders at build time and hydrates without a mismatch.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, AuthRequired, fetchAuthState, fetchState, sendJson, signOut } from "./api.js";
import { AcceptInvite, SignIn } from "./Auth.jsx";
import { DEMO, DOCS_URL, SITE_URL } from "./build.js";
import Overview from "./pages/Overview.jsx";
import Ai from "./pages/Ai.jsx";
import Costs from "./pages/Costs.jsx";
import Payouts from "./pages/Payouts.jsx";
import Approvals from "./pages/Approvals.jsx";
import Budgets from "./pages/Budgets.jsx";
import Ledger from "./pages/Ledger.jsx";
import Chains from "./pages/Chains.jsx";
import Analytics from "./pages/Analytics.jsx";
import Trust from "./pages/Trust.jsx";
import Network from "./pages/Network.jsx";
import Policy from "./pages/Policy.jsx";
import Agents from "./pages/Agents.jsx";
import Report from "./pages/Report.jsx";
import Users from "./pages/Users.jsx";

export const PAGES = [
  ["overview", "Overview", Overview], ["ai", "AI spend", Ai], ["costs", "Costs", Costs], ["payouts", "Payouts", Payouts],
  ["approvals", "Approvals", Approvals], ["budgets", "Budgets", Budgets], ["ledger", "Ledger", Ledger], ["chains", "Chains", Chains],
  ["analytics", "Analytics", Analytics], ["trust", "Trust", Trust], ["network", "Network", Network], ["policy", "Policy", Policy],
  ["agents", "Agents", Agents], ["report", "Report", Report], ["users", "Users", Users],
];

/* ---------- router ---------- */
const subscribeHash = (cb) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); };
// The prerender has no URL, so it (and hydration) always shows Overview; the
// real hash takes over on the first client render after hydration.
function usePage() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash.slice(1), () => "");
  return PAGES.some(([id]) => id === hash) ? hash : "overview";
}

// An invite link opens the Console at #accept-invite=<token>.
const inviteFromHash = () => (location.hash.startsWith("#accept-invite=") ? location.hash.slice("#accept-invite=".length) : "");

const Badge = ({ n }) => <b className="badge" hidden={!n}>{n || 0}</b>;

export default function App() {
  const page = usePage();
  const inviteToken = useSyncExternalStore(subscribeHash, inviteFromHash, () => "");
  // Sign-in state. Until it's known the prerendered shell stays on screen and
  // nothing is fetched; when sign-in is on and nobody is, the sign-in screen
  // replaces it.
  const [auth, setAuth] = useState({ checked: false, required: false, user: null });
  const signedIn = auth.checked && (!auth.required || auth.user);
  // null until the first poll lands — every page renders its empty shell
  // until then, which is exactly what the prerender ships.
  const [data, setData] = useState(null);
  // Counts successful polls: the Report refetches on each, trust scores and
  // the proxy's agent list on every third (they fan out one request per row).
  const [tick, setTick] = useState(0);
  const [costsGroup, setCostsGroup] = useState("rail");
  const costsGroupRef = useRef(costsGroup);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchState(costsGroupRef.current);
      setData(next);
      setTick((t) => t + 1);
      return next;
    } catch (err) {
      if (err instanceof AuthRequired) setAuth((a) => ({ ...a, checked: true, required: true, user: null }));
      else console.error("console refresh failed", err);
      return null;
    }
  }, []);

  useEffect(() => { fetchAuthState().then((s) => setAuth({ checked: true, required: s.authRequired, user: s.user })); }, []);
  useEffect(() => {
    if (!signedIn) return;
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh, signedIn]);

  const onSignedIn = (user) => {
    setAuth({ checked: true, required: true, user });
    if (inviteToken) location.hash = "#overview";
  };
  const leave = async () => {
    await signOut();
    setData(null);
    setAuth({ checked: true, required: true, user: null });
  };

  /* ---------- actions ---------- */
  const act = useCallback(async (path, opts) => { await api(path, opts); return refresh(); }, [refresh]);
  const actions = {
    decide: (id, decision) => act(`/api/approvals/${id}/decide`, sendJson("POST", { decision })),
    freeze: (address) => act("/api/freezes", sendJson("POST", { address, reason: "manual freeze from console" })),
    unfreeze: (id) => act(`/api/freezes/${id}/unfreeze`, { method: "POST" }),
    revoke: (id) => act(`/api/delegations/${id}/revoke`, { method: "POST" }),
    applyPack: (name) => act("/api/policy/apply", sendJson("POST", { pack: name })),
    removeReport: (id) => act(`/api/reputation/reports/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
  const setGroup = (g) => { costsGroupRef.current = g; setCostsGroup(g); refresh(); };

  const pending = data ? data.approvals.filter((a) => a.status === "pending").length : 0;
  const aiBlocked = data?.llm?.totals?.blockedDay;
  const props = {
    data, tick, refresh, actions, costsGroup, setGroup, auth,
    onSignedOut: () => setAuth({ checked: true, required: true, user: null }),
    onUserChange: (user) => setAuth((a) => ({ ...a, user })),
  };

  if (inviteToken) return <AcceptInvite token={inviteToken} onSignedIn={onSignedIn} />;
  if (auth.checked && auth.required && !auth.user) return <SignIn onSignedIn={onSignedIn} />;

  return (
    <>
      {DEMO && (
        <div className="demo-banner">Demo console — real decisions captured from a local SpendVeto run (simulate-mode crypto; model, payout and billing calls answered by local test providers), no server behind this page. Clicks change this tab only. <a href="/playground">Playground</a> · <a href="/docs">Run your own</a></div>
      )}
      <div className="shell">
        <aside className="side">
          <div className="brand">SPENDVETO<span> console</span></div>
          <nav>
            {PAGES.map(([id, label]) => (
              <a key={id} href={`#${id}`} className={id === page ? "active" : undefined}>
                {label}
                {id === "ai" && <> <Badge n={aiBlocked} /></>}
                {id === "approvals" && <> <Badge n={pending} /></>}
              </a>
            ))}
          </nav>
          <div className="side-foot">
            {auth.user && (
              <span className="who"><span className="who-email">{auth.user.email}</span><span>{auth.user.role}</span><button className="btn mini" onClick={leave}>Sign out</button></span>
            )}
            <span className="mode">mode: <b>{data ? data.mode : "…"}</b></span>
            <a href={SITE_URL} target="_blank">Site ↗</a>
            <a href={DOCS_URL} target="_blank">Docs ↗</a>
          </div>
        </aside>

        <main>
          {PAGES.map(([id, , Page]) => (
            <section key={id} data-page={id} hidden={id !== page}>
              <Page {...props} />
            </section>
          ))}
        </main>
      </div>
    </>
  );
}
