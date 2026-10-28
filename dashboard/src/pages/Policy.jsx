import { useEffect, useRef, useState } from "react";
import { api, sendJson } from "../api.js";
import { csv } from "../format.js";
import { FormNote, NO_NOTE } from "../ui.jsx";

const LIMITS = ["maxPerCallUSD", "maxPerHourUSD", "maxCallsPerHour", "requireApprovalAboveUSD"];
const BLANK = { maxPerCallUSD: "", maxPerHourUSD: "", maxCallsPerHour: "", requireApprovalAboveUSD: "", allowedChains: "" };
const fromPolicy = (p) => ({
  ...Object.fromEntries(LIMITS.map((k) => [k, String(p[k] ?? "")])),
  allowedChains: Array.isArray(p.allowedChains) ? p.allowedChains.join(",") : "",
});

export default function Policy({ data, refresh, actions }) {
  const [form, setForm] = useState(BLANK);
  const [note, setNote] = useState(NO_NOTE);
  const formRef = useRef(null);
  const p = data?.policy;

  // Every poll re-reads the live policy into the form, except while the
  // operator is in it — don't clobber typing. `force` is for after a save or
  // a pack apply, when the server's copy is the one to show.
  const fill = (policy, force) => {
    if (!policy) return;
    if (!force && formRef.current?.contains(document.activeElement)) return;
    setForm(fromPolicy(policy));
  };
  useEffect(() => fill(p, false), [data]);

  async function save(ev) {
    ev.preventDefault();
    const { ok, body } = await api("/api/policy", sendJson("PUT", {
      maxPerCallUSD: form.maxPerCallUSD, maxPerHourUSD: form.maxPerHourUSD, maxCallsPerHour: form.maxCallsPerHour,
      requireApprovalAboveUSD: form.requireApprovalAboveUSD, allowedChains: csv(form.allowedChains) || [],
    }));
    setNote({ err: !ok, text: ok ? "Saved — applies to the next payment attempt." : body.error || "failed" });
    const next = await refresh();
    fill(next ? next.policy : p, true);
  }

  async function applyPack(name) {
    const next = await actions.applyPack(name);
    fill(next ? next.policy : p, true);
  }

  const field = (name) => ({ name, value: form[name], onChange: (e) => setForm((f) => ({ ...f, [name]: e.target.value })) });
  return (
    <>
      <header><h1>Policy</h1><p>The live spend rules. Edits apply to the very next payment attempt.</p></header>
      <div className="two-col">
        <div className="card">
          <h2>Edit live policy</h2>
          <form className="form" ref={formRef} onSubmit={save}>
            <label>Max per call (USD) <input {...field("maxPerCallUSD")} type="number" step="0.001" min="0.001" required /></label>
            <label>Max per hour (USD) <input {...field("maxPerHourUSD")} type="number" step="0.001" min="0.001" required /></label>
            <label>Max calls / hour <input {...field("maxCallsPerHour")} type="number" min="1" required /></label>
            <label>Human approval above (USD) <input {...field("requireApprovalAboveUSD")} type="number" step="0.001" min="0.001" required /></label>
            <label>Allowed chains <span className="hint">comma-sep, blank = all</span> <input {...field("allowedChains")} type="text" placeholder="base-sepolia,base" /></label>
            <button className="btn go" type="submit">Save policy</button>
            <FormNote note={note} />
          </form>
        </div>
        <div className="card">
          <h2>Policy packs</h2>
          <p className="hint" style={{ marginBottom: "0.8rem" }}>Importable presets — applying one backs the current policy up to <code>policy.json.bak</code>.</p>
          <div>{p && data.packs.map((pk) => (
            <div className="pack" key={pk.name}><span className="desc"><b>{pk.name}</b>{pk.$description || ""}</span><button className="btn mini" onClick={() => applyPack(pk.name)}>Apply</button></div>
          ))}</div>
          <h2 style={{ marginTop: "1.6rem" }}>Raw</h2>
          <pre className="raw">{p ? JSON.stringify(p, null, 2) : ""}</pre>
        </div>
      </div>
    </>
  );
}
