import { money, when } from "../format.js";
import { EmptyRow, StatRow, Tag } from "../ui.jsx";

const statusClass = (s) => (s === "executed" ? "paid" : s === "failed" || s === "denied" ? "blocked" : "pending");

export default function Payouts({ data }) {
  const p = data?.payouts;
  const live = Boolean(p && p.providers);
  const stats = live && [
    ["Paid out", money(p.totals.executedUSD), "green"],
    ["Awaiting approval", p.totals.awaitingApproval, p.totals.awaitingApproval ? "copper" : ""],
    ["Failed", p.totals.failed, p.totals.failed ? "rust" : ""],
    ["Denied", p.totals.denied, ""],
  ];
  return (
    <>
      <header><h1>Payouts</h1><p>Agents paying people and vendors in real money — Stripe, RazorpayX (UPI / IMPS / NEFT / RTGS), PayPal, Modern Treasury (ACH / RTP / wire). New payees and large amounts wait in Approvals.</p></header>
      <StatRow stats={stats} />
      <div className="card"><h2>Providers</h2><table className="tbl"><thead><tr><th>provider</th><th>status</th><th>needs</th></tr></thead><tbody>
        {live && p.providers.map((x) => (
          <tr key={x.label}><td>{x.label}</td><td>{x.configured ? <Tag c="green">configured</Tag> : <Tag>not configured</Tag>}</td><td className="hint">{x.needs}</td></tr>
        ))}
      </tbody></table></div>
      <div className="card"><h2>Recent payouts</h2><table className="tbl"><thead><tr><th>when</th><th>agent</th><th>provider</th><th>payee</th><th>amount</th><th>USD</th><th>status</th><th>provider ref</th></tr></thead><tbody>
        {live && (p.payouts?.length ? p.payouts.map((x, n) => (
          <tr key={x.id || n}>
            <td>{when(x.createdAt)}</td><td>{x.agent}</td><td>{x.provider}</td><td className="addr">{x.payee}</td>
            <td className="num">{x.amount} {x.currency}</td><td className="num">{money(x.amountUSD)}</td>
            <td className={`status-${statusClass(x.status)}`}>{x.status}{x.providerStatus && <> <span className="hint">{x.providerStatus}</span></>}</td>
            <td className="hint">{x.providerId || x.approvalReason || ""}</td>
          </tr>
        )) : <EmptyRow cols={8}>No payouts yet.</EmptyRow>)}
      </tbody></table></div>
    </>
  );
}
