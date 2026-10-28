// Small pieces every page reuses. Class names are the stylesheet's contract —
// they match the pre-React Console one for one.
import { money } from "./format.js";

export function StatRow({ stats }) {
  return (
    <div className="stat-row">
      {stats && stats.map(([k, v, c]) => (
        <div className="stat" key={k}><div className="k">{k}</div><div className={`v ${c}`}>{v}</div></div>
      ))}
    </div>
  );
}

export const EmptyRow = ({ cols, children }) => <tr><td colSpan={cols} className="empty">{children}</td></tr>;

// The result line under a form: green on success, rust on failure.
export const NO_NOTE = { err: false, text: "" };
export const FormNote = ({ note, className = "form-note" }) => <p className={note.err ? `${className} err` : className}>{note.text}</p>;

export const Tag = ({ c, children, ...rest }) => <span className={c ? `tag ${c}` : "tag"} {...rest}>{children}</span>;

// Paid/blocked rows, shared by Chains and Analytics.
export function SpendRows({ rows, keyCell = (k) => k, empty }) {
  if (!rows.length) return <EmptyRow cols={5}>{empty}</EmptyRow>;
  return rows.map((r) => (
    <tr key={r.key}><td>{keyCell(r.key)}</td><td className="num">{r.paidCount}</td><td className="num">{money(r.paidUSD)}</td><td className="num">{r.blockedCount}</td><td className="num">{money(r.blockedUSD)}</td></tr>
  ));
}
