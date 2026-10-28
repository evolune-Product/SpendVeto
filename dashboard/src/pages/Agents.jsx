import { useCallback, useEffect, useState } from "react";
import { api, fetchAgents, PROXY_BASE, sendJson } from "../api.js";
import { FormNote, NO_NOTE } from "../ui.jsx";

/* ---------- agents + marketplace (agents live on the proxy, :8404) ---------- */
export default function Agents({ data, tick, refresh }) {
  // null = not asked yet, false = proxy unreachable, else the minted list.
  const [agents, setAgents] = useState(null);
  const [agentNote, setAgentNote] = useState(NO_NOTE);
  const [toolNote, setToolNote] = useState(NO_NOTE);

  const loadAgents = useCallback(() => fetchAgents().then((r) => setAgents(Array.isArray(r.agents) ? r.agents : false), () => setAgents(false)), []);
  useEffect(() => {
    if (data && (tick - 1) % 3 === 0) loadAgents();
  }, [tick]);

  async function mint(ev) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = form.elements;
    try {
      const res = await fetch(`${PROXY_BASE}/proxy/agents`, sendJson("POST", { label: f.label.value.trim(), child: f.child.value.trim() || undefined }));
      const body = await res.json();
      setAgentNote({ err: !res.ok, text: res.ok ? `Minted — token (shown once): ${body.token}` : body.error || "failed" });
      if (res.ok) form.reset();
      loadAgents();
    } catch {
      setAgentNote({ err: true, text: "Proxy not reachable at :8404 — run `npm run proxy`." });
    }
  }

  async function listTool(ev) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = form.elements;
    const { ok, body } = await api("/api/catalog/tools", sendJson("POST", { id: f.id.value.trim(), price: Number(f.price.value), label: f.label.value.trim(), upstreamUrl: f.upstreamUrl.value.trim() || undefined }));
    setToolNote({ err: !ok, text: ok ? `Listed — spend it with: npm run call -- ${body.id}` : body.error || "failed" });
    if (ok) { form.reset(); refresh(); }
  }

  return (
    <>
      <header><h1>Agents &amp; Market</h1><p>Supply side: mint wallet-bound agent identities, and list paid tools behind the gate.</p></header>
      <div className="two-col">
        <div className="card">
          <h2>Mint an agent identity <span className="hint">bearer token · once minted, the proxy requires tokens</span></h2>
          <form className="form" onSubmit={mint}>
            <label>Label <input name="label" type="text" placeholder="desk bot" required /></label>
            <label>Bind to wallet <span className="hint">child label — blank = custody wallet</span> <input name="child" type="text" placeholder="intern" /></label>
            <button className="btn go" type="submit">Mint token</button>
            <FormNote note={agentNote} />
          </form>
          <div style={{ marginTop: "1rem" }}>
            {agents === false && <p className="empty">Proxy not reachable at :8404 — run <code>npm run proxy</code>.</p>}
            {agents && agents.length > 0 && <>
              <h2 style={{ marginTop: "1.2rem" }}>Minted identities</h2>
              {agents.map((a) => (
                <div className="kv" key={a.token}><span className="k">{a.label} <span className="hint">{a.child ? `bound → ${a.child}` : "custody wallet"}</span></span><span className="v mono">{a.token}</span></div>
              ))}
            </>}
          </div>
        </div>
        <div className="card">
          <h2>List a paid tool <span className="hint">marketplace — same 402 gate, receipts, ledger</span></h2>
          <form className="form" onSubmit={listTool}>
            <label>Id <input name="id" type="text" placeholder="haiku" required pattern="[a-z0-9-]{2,40}" /></label>
            <label>Price (USD) <input name="price" type="number" step="0.001" min="0.001" defaultValue="0.01" required /></label>
            <label>Label <input name="label" type="text" placeholder="Haiku writer" /></label>
            <label>Upstream URL <span className="hint">blank = canned response</span> <input name="upstreamUrl" type="url" placeholder="https://…" /></label>
            <button className="btn go" type="submit">Register tool</button>
            <FormNote note={toolNote} />
          </form>
        </div>
      </div>
    </>
  );
}
