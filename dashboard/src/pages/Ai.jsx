import { useEffect, useRef, useState } from "react";
import { api, fetchLlmConnect, sendJson } from "../api.js";
import { money, short, when } from "../format.js";
import { EmptyRow, FormNote, NO_NOTE, StatRow, Tag } from "../ui.jsx";

/* ---------- AI spend (LLM guard) ---------- */
const BLANK = { dailyBudgetUSD: "", hourlyBudgetUSD: "", maxRequestUSD: "", sessionBudgetUSD: "", maxRequestsPerMinute: "", loopThreshold: "", mode: "enforce" };

export default function Ai({ data, refresh, actions }) {
  const s = data?.llm;
  const live = Boolean(s && s.totals);
  const [form, setForm] = useState(BLANK);
  const [note, setNote] = useState(NO_NOTE);
  const [connect, setConnect] = useState(null);
  // Filled from the server once, then left to the operator until they save —
  // a poll must never overwrite a budget someone is halfway through typing.
  const filled = useRef(false);
  const connectLoaded = useRef(false);

  useEffect(() => {
    if (!live) return;
    if (!filled.current && s.settings) {
      const st = s.settings;
      const v = (x) => String(x ?? "");
      setForm({
        dailyBudgetUSD: v(st.dailyBudgetUSD), hourlyBudgetUSD: v(st.hourlyBudgetUSD), maxRequestUSD: v(st.maxRequestUSD), sessionBudgetUSD: v(st.sessionBudgetUSD),
        maxRequestsPerMinute: v(st.maxRequestsPerMinute), loopThreshold: v(st.loop?.threshold ?? 6), mode: s.mode,
      });
      filled.current = true;
    }
    if (!connectLoaded.current) {
      connectLoaded.current = true;
      fetchLlmConnect().then((c) => c.clients && setConnect(c)).catch(() => {});
    }
  }, [data]);

  const field = (name) => ({ name, value: form[name], onChange: (e) => setForm((f) => ({ ...f, [name]: e.target.value })) });

  async function save(ev) {
    ev.preventDefault();
    const body = {
      dailyBudgetUSD: Number(form.dailyBudgetUSD), hourlyBudgetUSD: Number(form.hourlyBudgetUSD), maxRequestUSD: Number(form.maxRequestUSD),
      sessionBudgetUSD: form.sessionBudgetUSD ? Number(form.sessionBudgetUSD) : null, maxRequestsPerMinute: Number(form.maxRequestsPerMinute),
      loop: { threshold: Number(form.loopThreshold) }, mode: form.mode,
    };
    const { ok, body: out } = await api("/api/llm/settings", sendJson("PUT", body));
    setNote({ err: !ok, text: ok ? "Saved — applies to the next request." : out.error || "failed" });
    filled.current = false;
    refresh();
  }

  const stats = live && [
    ["AI spend (24h)", money(s.totals.spentDayUSD), "green"],
    ["Model requests", s.totals.requestsDay, ""],
    ["Blocked before the model", s.totals.blockedDay, s.totals.blockedDay ? "copper" : ""],
    ["Loop freezes", s.totals.loopFreezesDay, s.totals.loopFreezesDay ? "rust" : ""],
    ["Mode", s.mode, s.mode === "observe" ? "copper" : "green"],
    ["In flight", s.totals.inFlight, ""],
  ];

  return (
    <>
      <header><h1>AI spend</h1><p>Every model call your agents make — checked against its budget before it reaches the provider, booked at the provider's own usage numbers after.</p></header>
      <StatRow stats={stats} />
      <div className="two-col">
        <div className="card">
          <h2>Connect an agent <span className="hint">one line · your key passes through, never stored</span></h2>
          <div>{connect && connect.clients.map((x) => <div className="kv" key={x.name}><span className="k">{x.name}</span><span className="v"><code>{x.line}</code></span></div>)}</div>
          <p className="hint">{connect?.note || ""}</p>
        </div>
        <div className="card">
          <h2>Budgets <span className="hint">per agent · applies to every request</span></h2>
          <form className="form" onSubmit={save}>
            <label>Daily budget (USD, rolling 24h) <input {...field("dailyBudgetUSD")} type="number" step="0.01" min="0.01" /></label>
            <label>Hourly budget (USD) <input {...field("hourlyBudgetUSD")} type="number" step="0.01" min="0.01" /></label>
            <label>Max per request (USD, worst case) <input {...field("maxRequestUSD")} type="number" step="0.01" min="0.01" /></label>
            <label>Per-session budget (USD) <span className="hint">Claude Code sessions · blank = off</span> <input {...field("sessionBudgetUSD")} type="number" step="0.01" min="0.01" /></label>
            <label>Requests per minute <input {...field("maxRequestsPerMinute")} type="number" step="1" min="1" /></label>
            <label>Loop freeze after N identical tool results <input {...field("loopThreshold")} type="number" step="1" min="2" /></label>
            <label>Mode <select {...field("mode")}><option value="enforce">enforce — block</option><option value="observe">observe — record only</option></select></label>
            <button className="btn go" type="submit">Save budgets</button>
            <FormNote note={note} className="note" />
          </form>
        </div>
      </div>
      <div className="card"><h2>Agents <span className="hint">last 24 hours</span></h2><table className="tbl"><thead><tr><th>agent</th><th>spent 24h</th><th>last hour</th><th>left today</th><th>requests</th><th>mostly</th><th>status</th><th></th></tr></thead><tbody>{live && <Identities list={s.identities} actions={actions} />}</tbody></table></div>
      <div className="card"><h2>Recent decisions <span className="hint">blocks, and what observe mode would have blocked</span></h2><table className="tbl"><thead><tr><th>time</th><th>agent</th><th>model</th><th>code</th><th>reason</th></tr></thead><tbody>{live && <Decisions list={s.recentDecisions || []} />}</tbody></table></div>
    </>
  );
}

function Identities({ list, actions }) {
  if (!list.length) return <EmptyRow cols={8}>No model traffic yet — point an agent at this server with one of the lines above.</EmptyRow>;
  return list.map((i) => {
    const top = Object.entries(i.models || {}).sort((a, b) => b[1] - a[1])[0];
    return (
      <tr key={i.address}>
        <td>{i.label || short(i.address)} <span className="hint">{i.kind || ""}</span></td>
        <td className="num">{money(i.spentDayUSD)}</td><td className="num">{money(i.spentHourUSD)}</td><td className="num">{money(i.remainingDayUSD)}</td><td className="num">{i.requestsDay}</td>
        <td>{top ? top[0] : "—"}</td>
        <td>{i.frozen ? <><Tag c="rust">frozen</Tag> <span className="hint">{i.frozen.reason}</span></> : <Tag c="green">ok</Tag>}</td>
        <td>{i.frozen ? <button className="btn go mini" onClick={() => actions.unfreeze(i.frozen.id)}>Unfreeze</button> : <button className="btn deny mini" onClick={() => actions.freeze(i.address)}>Freeze</button>}</td>
      </tr>
    );
  });
}

function Decisions({ list }) {
  if (!list.length) return <EmptyRow cols={5}>Nothing blocked in the last 24 hours.</EmptyRow>;
  return list.map((d, n) => (
    <tr key={n}>
      <td>{when(d.ts)}</td><td>{d.agent || "—"}</td><td>{d.model || "—"}</td>
      <td><Tag c={d.observeOnly ? "" : "rust"}>{d.code || ""}{d.observeOnly ? " · observe" : ""}</Tag></td><td>{d.reason || ""}</td>
    </tr>
  ));
}
