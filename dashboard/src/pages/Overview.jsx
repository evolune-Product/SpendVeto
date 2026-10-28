import { money, short, when } from "../format.js";
import { EmptyRow, StatRow, Tag } from "../ui.jsx";

export const frozenSet = (freezes) => new Set(freezes.filter((f) => !f.unfrozen).map((f) => f.address.toLowerCase()));

export default function Overview({ data, actions }) {
  const s = data?.stats;
  const stats = s && [
    ["Governed spend", money(s.paid.usd), "green"],
    ["Blocked before it moved", money(s.blocked.usd), "copper"],
    ["Paid around the gate", money(s.unmanaged?.usd || 0), s.unmanaged?.usd ? "rust" : ""],
    ["Stopped attempts", <>{s.blocked.count} <span className="hint">of {s.totalAttempts}</span></>, "copper"],
    ["Failed attempts", s.failed.count, "rust"],
    ["Wallets frozen", s.frozenWallets, s.frozenWallets ? "rust" : ""],
  ];
  return (
    <>
      <header><h1>Overview</h1><p>The governance layer at a glance — live, refreshed every 2s.</p></header>
      <StatRow stats={stats} />
      <div className="two-col">
        <div className="card"><h2>Catalog</h2><div>{data && <Catalog data={data} />}</div></div>
        <div className="card"><h2>Wallet balances <span className="hint">per chain · freeze = kill switch</span></h2><div>{data && <Balances data={data} freeze={actions.freeze} />}</div></div>
      </div>
      <div className="card"><h2>Recent activity</h2><table className="tbl"><thead><tr><th>time</th><th>wallet</th><th>resource</th><th>amount</th><th>status</th><th>detail</th></tr></thead><tbody>{data && <Recent entries={data.entries} />}</tbody></table></div>
    </>
  );
}

function Catalog({ data }) {
  if (!data.tools.length) return <p className="empty">No tools.</p>;
  const threshold = data.policy?.requireApprovalAboveUSD ?? 1;
  return data.tools.map((t) => (
    <div className="kv" key={t.id}>
      <span className="k">{t.label} <span className="hint">{t.id}</span></span>
      <span className="v">${t.price} {Number(t.price) > threshold ? <Tag c="rust">needs approval</Tag> : <Tag c="green">auto</Tag>}</span>
    </div>
  ));
}

function Balances({ data, freeze }) {
  const rows = Object.entries(data.balances);
  if (!rows.length) return <p className="empty">No calls yet — run <code>npm run call</code>.</p>;
  const frozen = frozenSet(data.freezes);
  return rows.map(([addr, bal]) => {
    const per = typeof bal === "object" && bal !== null ? Object.entries(bal).map(([c, u]) => `${c} ${money(u)}`).join(" · ") : money(bal);
    return (
      <div className="kv" key={addr}>
        <span className="k addr">{short(addr)}</span>
        <span className="v">{per} {frozen.has(addr) ? <Tag c="rust">frozen</Tag> : <button className="btn deny mini" onClick={() => freeze(addr)}>Freeze</button>}</span>
      </div>
    );
  });
}

function Recent({ entries }) {
  if (!entries.length) return <EmptyRow cols={6}>No activity yet.</EmptyRow>;
  return entries.slice(-12).reverse().map((e, i) => (
    <tr key={e.entryHash || i}>
      <td>{when(e.ts)}</td><td className="addr">{short(e.address)}</td>
      <td>{e.resource || "—"}{e.chain && <> <Tag>{e.chain}</Tag></>}</td>
      <td className="num">{money(e.amount)}</td><td className={`status-${e.status}`}>{e.status}</td><td>{e.reason || e.mode || ""}</td>
    </tr>
  ));
}
