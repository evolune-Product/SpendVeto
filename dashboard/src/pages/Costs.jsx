import { DEMO } from "../build.js";
import { money } from "../format.js";
import { EmptyRow, StatRow } from "../ui.jsx";

/* ---------- Costs (FinOps) ---------- */
const GROUPS = ["rail", "team", "customer", "agent", "model", "provider"];

// Same as the ledger CSV: the public demo has no server to generate the file.
const focusLink = DEMO ? { href: "#costs", title: "FOCUS export needs a running server" } : { href: "/api/costs/focus.csv" };

export default function Costs({ data, costsGroup, setGroup }) {
  const c = data?.costs;
  const rail = data?.costsRail;
  const rb = data?.rebilling;
  const hasCosts = Boolean(c && c.rows);
  const hasRebill = Boolean(rb && rb.settings);
  const byRail = Object.fromEntries((rail?.rows || []).map((r) => [r.key, r.costUSD]));
  const stats = hasCosts && [
    ["Total (30d)", money(rail?.totalCostUSD), "green"],
    ["Model tokens", money(byRail["model tokens"]), ""],
    ["x402 / tools", money(byRail["x402 / tools"]), ""],
    ["Cards", money(byRail["cards"]), ""],
    ["Fiat payouts", money(byRail["fiat payouts"]), ""],
    ["Blocked", money(rail?.totalBlockedUSD), "copper"],
  ];
  return (
    <>
      <header><h1>Costs</h1><p>Every rail in one view — model tokens, x402 tools, cards, fiat payouts — allocated by team, customer, agent or model. Model spend exports as FOCUS v1.4 for your FinOps tools.</p></header>
      <StatRow stats={stats} />
      <div className="card">
        <h2>Spend by <select value={costsGroup} onChange={(e) => setGroup(e.target.value)}>{GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}</select> <span className="hint">last 30 days · tag requests with <code>x-spendveto-tags: team=…,customer=…</code></span> <a className="btn ghost mini" {...focusLink}>Download FOCUS CSV</a></h2>
        <table className="tbl"><thead><tr><th>key</th><th>cost</th><th>count</th><th>blocked</th></tr></thead><tbody>{hasCosts && <CostRows rows={c.rows} />}</tbody></table>
      </div>
      <div className="card">
        <h2>Rebilling <span className="hint">customer-tagged model spend → Stripe Billing meter events, at your markup</span></h2>
        <div className="hint">{hasRebill && (rb.settings.enabled ? `on · markup ${rb.settings.markupPct}% · meter "${rb.settings.eventName}" · customer tag "${rb.settings.customerTag}"` : "off — enable with PUT /api/rebilling { enabled: true, markupPct } and STRIPE_SECRET_KEY")}</div>
        <table className="tbl"><thead><tr><th>customer</th><th>cost</th><th>billed</th><th>margin</th><th>events</th></tr></thead><tbody>{hasRebill && <RebillRows rows={rb.customers || []} />}</tbody></table>
      </div>
    </>
  );
}

function CostRows({ rows }) {
  if (!rows.length) return <EmptyRow cols={4}>No spend in the last 30 days.</EmptyRow>;
  return rows.map((r) => (
    <tr key={r.key}><td>{r.key}</td><td className="num">{money(r.costUSD)}</td><td className="num">{r.count}</td><td className="num">{r.blockedCount ? `${money(r.blockedUSD)} · ${r.blockedCount}` : "—"}</td></tr>
  ));
}

function RebillRows({ rows }) {
  if (!rows.length) return <EmptyRow cols={5}>Nothing rebilled yet.</EmptyRow>;
  return rows.map((x) => (
    <tr key={x.customer}><td>{x.customer}</td><td className="num">{money(x.costUSD)}</td><td className="num">{money(x.billedUSD)}</td><td className="num">{money(x.marginUSD)}</td><td className="num">{x.events}{x.failed ? ` · ${x.failed} failed` : ""}</td></tr>
  ));
}
