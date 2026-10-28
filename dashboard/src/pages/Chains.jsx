import { money } from "../format.js";
import { SpendRows, Tag } from "../ui.jsx";

const isLive = (c) => c.status === "live" || c.settlement === "live";

export default function Chains({ data }) {
  const byChainRows = data?.analytics?.byChain || [];
  const byChain = Object.fromEntries(byChainRows.map((r) => [r.key, r]));
  // Live chains first; sort is stable, so registry order holds within each group.
  const sorted = data ? [...data.chains].sort((a, b) => (isLive(a) ? 0 : 1) - (isLive(b) ? 0 : 1)) : [];
  const families = data ? new Set(data.chains.map((c) => c.family || "evm")).size : 0;
  return (
    <>
      <header><h1>Chains</h1><p><span>{data ? `${data.chains.length} registered chains across ${families} signature families` : "Every registered chain"}</span>. The chain rides inside every signed authorization; balances and analytics are per chain.</p></header>
      <div className="chain-grid">
        {sorted.map((c) => {
          const a = byChain[c.id];
          const live = isLive(c);
          return (
            <div className="chain-card" key={c.id}>
              <h3>{c.name} <Tag c={live ? "green" : ""}>{live ? "LIVE" : "READY"}</Tag></h3>
              <div className="usdc">{c.stablecoin || "USDC"} {c.usdc}</div>
              <div className="note">{c.note || (live ? "" : "fully governed today (simulate settles locally); goes live when the configured facilitator supports it")}</div>
              {a && <div className="note">paid {a.paidCount} ({money(a.paidUSD)}){a.blockedCount ? ` · blocked ${a.blockedCount}` : ""}</div>}
            </div>
          );
        })}
      </div>
      <div className="card"><h2>Rails <span className="hint">one pay() contract — governance never cares which rail settles</span></h2><div>
        {data?.rails.map((r) => (
          <div className="kv" key={r.name}><span className="k">{r.name} <span className="hint">{r.note || ""}</span></span><span className="v"><Tag c={r.status === "live" ? "green" : ""}>{r.status === "live" ? "LIVE" : "SLOT"}</Tag></span></div>
        ))}
      </div></div>
      <div className="card"><h2>Spend by chain</h2><table className="tbl"><thead><tr><th>chain</th><th>paid</th><th>paid $</th><th>blocked</th><th>blocked $</th></tr></thead><tbody>
        {data && <SpendRows rows={byChainRows} empty="No activity yet." />}
      </tbody></table></div>
    </>
  );
}
