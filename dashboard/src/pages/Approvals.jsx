import { short, when } from "../format.js";
import { EmptyRow } from "../ui.jsx";

export default function Approvals({ data, actions }) {
  const pending = data ? data.approvals.filter((a) => a.status === "pending") : [];
  const history = data ? data.approvals.filter((a) => a.status !== "pending").slice(-20).reverse() : [];
  return (
    <>
      <header><h1>Approvals</h1><p>Spends above the policy threshold pause here. No decision in 30s → the call fails closed.</p></header>
      <div className="card"><h2>Pending</h2><div>
        {data && (pending.length ? pending.map((a) => (
          <div className="appr" key={a.id}>
            <span className="what"><b>{short(a.address)}</b> wants {a.resource} for <b>${a.price}</b></span>
            <span className="acts"><button className="btn go mini" onClick={() => actions.decide(a.id, "approved")}>Approve</button><button className="btn deny mini" onClick={() => actions.decide(a.id, "denied")}>Deny</button></span>
          </div>
        )) : <p className="empty">Nothing pending. Trigger one: <code>npm run call -- summarize</code></p>)}
      </div></div>
      <div className="card"><h2>History</h2><table className="tbl"><thead><tr><th>when</th><th>wallet</th><th>resource</th><th>price</th><th>outcome</th></tr></thead><tbody>
        {data && (history.length ? history.map((a) => (
          <tr key={a.id}><td>{when(a.decidedAt || a.createdAt)}</td><td className="addr">{short(a.address)}</td><td>{a.resource}</td><td className="num">${a.price}</td><td className={a.status === "approved" ? "status-paid" : "status-blocked"}>{a.status}</td></tr>
        )) : <EmptyRow cols={5}>No decisions yet.</EmptyRow>)}
      </tbody></table></div>
    </>
  );
}
