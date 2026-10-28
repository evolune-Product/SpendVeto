import { useEffect, useState } from "react";
import { fetchReport } from "../api.js";
import { money } from "../format.js";
import { EmptyRow, StatRow } from "../ui.jsx";

const Rows = ({ list }) => (list.length ? list.map((x) => <div className="kv" key={x.key}><span className="k">{x.key}</span><span className="v">{money(x.usd)}</span></div>) : <p className="empty">Nothing yet.</p>);

export default function Report({ tick }) {
  const [days, setDays] = useState("7");
  const [r, setR] = useState(null);

  // Refetched on every poll and whenever the window changes — the report is
  // computed server-side for the chosen window, not derived from the poll.
  useEffect(() => {
    if (!tick) return;
    fetchReport(days).then(setR, (err) => console.error("report failed", err));
  }, [tick, days]);

  const stats = r && [
    ["Governed spend", money(r.paid.usd), "green"],
    ["Blocked before it moved", money(r.blocked.usd), "copper"],
    ["Stopped attempts", r.blocked.count, "copper"],
    ["Wallets frozen", r.frozenWallets, r.frozenWallets ? "rust" : ""],
  ];
  return (
    <>
      <header><h1>Report</h1><p>The number you forward to whoever owns the budget.</p></header>
      <div className="filter-row"><select value={days} onChange={(e) => setDays(e.target.value)}><option value="1">last 24h</option><option value="7">last 7 days</option><option value="30">last 30 days</option></select></div>
      <div className="card"><p style={{ fontSize: "1.05rem", color: "var(--ink)", lineHeight: 1.6 }}>{r ? r.headline : "…"}</p></div>
      <StatRow stats={stats} />
      <div className="two-col">
        <div className="card"><h2>Paid by category</h2><div>{r && <Rows list={r.byCategory} />}</div></div>
        <div className="card"><h2>Paid by chain / rail</h2><div>{r && <Rows list={r.byChain} />}</div></div>
      </div>
      <div className="card"><h2>What governance stopped</h2><table className="tbl"><thead><tr><th>reason</th><th>times</th></tr></thead><tbody>
        {r && (r.topBlockReasons.length ? r.topBlockReasons.map((x) => <tr key={x.reason}><td>{x.reason}</td><td className="num">{x.count}</td></tr>) : <EmptyRow cols={2}>Nothing blocked in this window.</EmptyRow>)}
      </tbody></table></div>
    </>
  );
}
