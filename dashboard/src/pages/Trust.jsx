import { useEffect, useState } from "react";
import { fetchTrust } from "../api.js";
import { short } from "../format.js";
import { EmptyRow, Tag } from "../ui.jsx";

export default function Trust({ data, tick }) {
  const [result, setResult] = useState(null);
  const [scores, setScores] = useState(null);

  // One request per wallet, so every third poll rather than every poll.
  useEffect(() => {
    if (!data || (tick - 1) % 3 !== 0) return;
    const addrs = Object.keys(data.balances).slice(0, 12);
    Promise.all(addrs.map((a) => fetchTrust(a).catch(() => null))).then(setScores);
  }, [tick]);

  async function lookup(ev) {
    ev.preventDefault();
    setResult(await fetchTrust(ev.currentTarget.elements.addr.value.trim()));
  }

  const known = scores ? scores.filter(Boolean).sort((a, b) => b.score - a.score) : [];
  return (
    <>
      <header><h1>Trust</h1><p>Every wallet's governance history compressed to a score — the ledger as an agent credit file.</p></header>
      <div className="card">
        <h2>Look up a wallet</h2>
        <form className="inline-form" onSubmit={lookup}><input name="addr" type="text" placeholder="0x…" required /><button className="btn go" type="submit">Score</button></form>
        <div>{result && (
          <div className="score-big"><span className="n">{result.score}</span><span className={`grade ${result.grade}`}>grade {result.grade}</span><span className="hint">paid {result.signals.paid} · blocked {result.signals.blocked} · failed {result.signals.failed} · freezes {result.signals.freezes}{result.signals.frozenNow ? " · FROZEN NOW" : ""}</span></div>
        )}</div>
      </div>
      <div className="card"><h2>Known wallets</h2><table className="tbl"><thead><tr><th>wallet</th><th>score</th><th>grade</th><th>paid</th><th>blocked</th><th>failed</th><th>freezes</th></tr></thead><tbody>
        {scores && (known.length ? known.map((t) => (
          <tr key={t.address}>
            <td className="addr">{short(t.address)}</td><td className="num">{t.score}</td><td><span className={`grade ${t.grade}`}>{t.grade}</span></td>
            <td className="num">{t.signals.paid}</td><td className="num">{t.signals.blocked}</td><td className="num">{t.signals.failed}</td>
            <td className="num">{t.signals.freezes}{t.signals.frozenNow && <> <Tag c="rust">now</Tag></>}</td>
          </tr>
        )) : <EmptyRow cols={7}>No wallets seen yet.</EmptyRow>)}
      </tbody></table></div>
    </>
  );
}
