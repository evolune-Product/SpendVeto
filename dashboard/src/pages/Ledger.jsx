import { useState } from "react";
import { DEMO } from "../build.js";
import { money, short, when } from "../format.js";
import { EmptyRow, Tag } from "../ui.jsx";

// The demo has no server to stream a CSV from.
const csvLink = DEMO ? { href: "#ledger", title: "CSV export needs a running server" } : { href: "/api/export.csv" };

export default function Ledger({ data }) {
  const [status, setStatus] = useState("");
  const [chain, setChain] = useState("");
  const [q, setQ] = useState("");
  const needle = q.toLowerCase();
  const rows = data ? data.entries.filter((e) =>
    (!status || e.status === status) && (!chain || (e.chain || "base-sepolia") === chain) &&
    (!needle || `${e.address} ${e.resource} ${e.reason}`.toLowerCase().includes(needle))) : [];
  return (
    <>
      <header><h1>Ledger</h1><p>Every attempt, every outcome, every reason — the audit trail.</p></header>
      <div className="filter-row">
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">all statuses</option><option>paid</option><option>blocked</option><option>failed</option></select>
        <select value={chain} onChange={(e) => setChain(e.target.value)}><option value="">all chains</option>{data?.chains.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select>
        <input type="text" placeholder="filter by wallet / resource / reason…" value={q} onChange={(e) => setQ(e.target.value)} />
        <a className="btn ghost" {...csvLink}>Download CSV</a>
      </div>
      <div className="card"><table className="tbl"><thead><tr><th>time</th><th>wallet</th><th>resource</th><th>chain</th><th>amount</th><th>status</th><th>reason</th></tr></thead><tbody>
        {data && (rows.length ? rows.slice(-200).reverse().map((e, n) => (
          <tr key={e.entryHash || n}>
            <td>{when(e.ts)}</td><td className="addr">{short(e.address)}</td><td>{e.resource || "—"}</td><td><Tag>{e.chain || "base-sepolia"}</Tag></td>
            <td className="num">{money(e.amount)}</td><td className={`status-${e.status}`}>{e.status}</td><td>{e.reason || ""}</td>
          </tr>
        )) : <EmptyRow cols={7}>Nothing matches.</EmptyRow>)}
      </tbody></table></div>
    </>
  );
}
