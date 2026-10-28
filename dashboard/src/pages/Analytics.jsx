import { short, when } from "../format.js";
import { EmptyRow, SpendRows, Tag } from "../ui.jsx";

const walletCell = (k) => <span className="addr">{short(k)}</span>;

export default function Analytics({ data, actions }) {
  const freezes = data ? data.freezes.slice().reverse() : [];
  return (
    <>
      <header><h1>Analytics</h1><p>Where the money went — and where the governance layer stopped it.</p></header>
      <div className="two-col">
        <div className="card"><h2>By tool</h2><table className="tbl"><thead><tr><th>tool</th><th>paid</th><th>paid $</th><th>blocked</th><th>blocked $</th></tr></thead><tbody>{data && <SpendRows rows={data.analytics?.byTool || []} empty="No data." />}</tbody></table></div>
        <div className="card"><h2>By wallet</h2><table className="tbl"><thead><tr><th>wallet</th><th>paid</th><th>paid $</th><th>blocked</th><th>blocked $</th></tr></thead><tbody>{data && <SpendRows rows={data.analytics?.byWallet || []} keyCell={walletCell} empty="No data." />}</tbody></table></div>
      </div>
      <div className="card"><h2>Freeze log</h2><table className="tbl"><thead><tr><th>when</th><th>wallet</th><th>source</th><th>reason</th><th>status</th><th></th></tr></thead><tbody>
        {data && (freezes.length ? freezes.map((f) => (
          <tr key={f.id}>
            <td>{when(f.createdAt)}</td><td className="addr">{short(f.address)}</td><td>{f.source}</td><td>{f.reason}</td>
            <td>{f.unfrozen ? <Tag>unfrozen</Tag> : <Tag c="rust">FROZEN</Tag>}</td>
            <td>{f.unfrozen ? null : <button className="btn mini" onClick={() => actions.unfreeze(f.id)}>Unfreeze</button>}</td>
          </tr>
        )) : <EmptyRow cols={6}>No freezes — a healthy fleet.</EmptyRow>)}
      </tbody></table></div>
    </>
  );
}
