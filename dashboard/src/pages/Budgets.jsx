import { useState } from "react";
import { api, sendJson } from "../api.js";
import { csv, money, short, when } from "../format.js";
import { EmptyRow, FormNote, NO_NOTE, Tag } from "../ui.jsx";
import { frozenSet } from "./Overview.jsx";

export default function Budgets({ data, refresh, actions }) {
  const [note, setNote] = useState(NO_NOTE);

  async function grant(ev) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = form.elements;
    const { ok, body } = await api("/api/delegations/wallet", sendJson("POST", {
      capUSD: Number(f.capUSD.value), label: f.label.value.trim(), parent: f.parent.value.trim() || undefined,
      allowedTools: csv(f.tools.value), allowedChains: csv(f.chains.value), ttlSeconds: f.ttl.value ? Number(f.ttl.value) : undefined,
    }));
    setNote({ err: !ok, text: ok ? `Wallet ${short(body.childAddress)} granted ${money(body.capUSD)} — spend with: ${body.spendWith}` : body.error || "failed" });
    if (ok) form.reset();
    refresh();
  }

  return (
    <>
      <header><h1>Budgets</h1><p>IAM for money: capped, scoped, time-boxed grants — every ancestor's limits bind its whole subtree.</p></header>
      <div className="two-col">
        <div className="card">
          <h2>Grant a budget</h2>
          <form className="form" onSubmit={grant}>
            <label>Cap (USD) <input name="capUSD" type="number" step="0.001" min="0.001" defaultValue="0.03" required /></label>
            <label>Label <input name="label" type="text" placeholder="research agent" required /></label>
            <label>Parent <span className="hint">blank = main wallet</span> <input name="parent" type="text" placeholder="label or 0x…" /></label>
            <label>Tool scope <span className="hint">comma-sep, blank = all</span> <input name="tools" type="text" placeholder="translate,review" /></label>
            <label>Chain scope <span className="hint">blank = all</span> <input name="chains" type="text" placeholder="base-sepolia" /></label>
            <label>TTL seconds <span className="hint">blank = never expires</span> <input name="ttl" type="number" min="1" placeholder="600" /></label>
            <button className="btn go" type="submit">Create wallet + grant</button>
            <FormNote note={note} />
          </form>
        </div>
        <div className="card"><h2>Budget tree <span className="hint">live spend vs cap</span></h2><div>{data && <Tree data={data} />}</div></div>
      </div>
      <div className="card"><h2>All grants</h2><table className="tbl"><thead><tr><th>label</th><th>child</th><th>cap</th><th>scopes</th><th>expires</th><th>status</th><th></th></tr></thead><tbody>{data && <Grants list={data.delegations} revoke={actions.revoke} />}</tbody></table></div>
    </>
  );
}

// Spend is rolled up the delegation tree: a parent's bar counts everything
// its children (and theirs) paid, because every ancestor's cap binds them.
function Tree({ data }) {
  const dels = data.delegations;
  const frozen = frozenSet(data.freezes);
  const paidOf = (addr) => data.entries.filter((e) => e.status === "paid" && e.address?.toLowerCase() === addr.toLowerCase()).reduce((t, e) => t + Number(e.amount || 0), 0);
  const kidsOf = (addr) => dels.filter((d) => !d.revoked && d.parentAddress.toLowerCase() === addr.toLowerCase());
  const subtree = (addr, seen = new Set()) => {
    if (seen.has(addr.toLowerCase())) return 0;
    seen.add(addr.toLowerCase());
    return paidOf(addr) + kidsOf(addr).reduce((t, d) => t + subtree(d.childAddress, seen), 0);
  };
  const bar = (spent, cap) => {
    const pct = Math.min(100, (spent / cap) * 100);
    return <><div className="bar"><i className={pct > 80 ? "hot" : ""} style={{ width: `${pct}%` }} /></div><div className="bar-cap">{money(spent)} / {money(cap)}</div></>;
  };
  const node = (d, depth) => [
    <div className="tree-child" style={{ paddingLeft: `${depth * 1.1}rem` }} key={d.id}>
      <span className="tree-child-name">├─ {d.label || short(d.childAddress)}{frozen.has(d.childAddress.toLowerCase()) && <> <Tag c="rust">frozen</Tag></>}{d.expiresAt && <> <span className="tree-note">ttl→{when(d.expiresAt)}</span></>}</span>
      {bar(subtree(d.childAddress), d.capUSD)}
    </div>,
    ...kidsOf(d.childAddress).flatMap((k) => node(k, depth + 1)),
  ];
  const active = dels.filter((d) => !d.revoked);
  const childSet = new Set(active.map((d) => d.childAddress.toLowerCase()));
  const roots = [...new Set(active.filter((d) => !childSet.has(d.parentAddress.toLowerCase())).map((d) => d.parentAddress))];
  if (!roots.length) return <p className="empty">No delegations yet — create one on the left.</p>;
  return roots.map((r) => (
    <div className="tree-parent" key={r}>
      <div className="tree-parent-name">{short(r)} <span className="tree-note">root · own spend {money(paidOf(r))}</span></div>
      {kidsOf(r).flatMap((d) => node(d, 0))}
    </div>
  ));
}

function Grants({ list, revoke }) {
  if (!list.length) return <EmptyRow cols={7}>No grants yet.</EmptyRow>;
  return list.slice().reverse().map((d) => {
    const scopes = [d.allowedTools ? `tools: ${d.allowedTools.join(",")}` : null, d.allowedChains ? `chains: ${d.allowedChains.join(",")}` : null].filter(Boolean).join(" · ") || "all";
    const expired = d.expiresAt && Date.now() > new Date(d.expiresAt).getTime();
    return (
      <tr key={d.id}>
        <td>{d.label || "—"}</td><td className="addr">{short(d.childAddress)}</td><td className="num">{money(d.capUSD)}</td><td>{scopes}</td>
        <td>{d.expiresAt ? when(d.expiresAt) : "never"}</td>
        <td>{d.revoked ? <Tag c="rust">revoked</Tag> : expired ? <Tag c="rust">expired</Tag> : <Tag c="green">active</Tag>}</td>
        <td>{d.revoked || expired ? null : <button className="btn deny mini" onClick={() => revoke(d.id)}>Revoke</button>}</td>
      </tr>
    );
  });
}
