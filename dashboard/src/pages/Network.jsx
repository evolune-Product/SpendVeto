import { Fragment, useState } from "react";
import { api, sendJson } from "../api.js";
import { short, when } from "../format.js";
import { EmptyRow, StatRow, Tag } from "../ui.jsx";

/* ---------- Network: attestations, reputation, policy schema ---------- */
export default function Network({ data, refresh, actions }) {
  const [repNote, setRepNote] = useState("");
  const a = data?.attestations;
  const r = data?.reputation;
  const v = data?.policyCheck;
  const hasA = Boolean(a && a.issuer);
  const hasR = Boolean(r && r.settings);
  const hasV = Boolean(v && Array.isArray(v.errors));

  async function report(ev) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = new FormData(form);
    const { ok, body } = await api("/api/reputation/reports", sendJson("POST", { subject: f.get("subject"), kind: f.get("kind"), severity: f.get("severity"), reason: f.get("reason") }));
    setRepNote(ok ? `Reported. Payments to it are now ${body.report?.severity === "block" ? "refused" : "sent to a human"} on every rail.` : body.reason || body.error || "Couldn't save the report.");
    if (ok) form.reset();
    await refresh();
  }

  const stats = data && [
    ["Attestations issued", a ? a.issued : "—", "green"],
    ["Counterparty reports", r ? (r.reports || []).length : "—", ""],
    ["Imported feeds", r ? (r.feeds || []).length : "—", ""],
    ["Policy", v ? (v.valid ? (v.warnings.length ? "warnings" : "valid") : "invalid") : "—", v && !v.valid ? "rust" : v && v.warnings.length ? "copper" : "green"],
  ];
  const trusted = hasR ? r.settings.trustedPublishers || [] : [];

  return (
    <>
      <header><h1>Network</h1><p>The open trust layer: attestations a seller verifies offline, counterparty reports shared across companies as signed hashes, and the policy schema.</p></header>
      <StatRow stats={stats} />
      <div className="two-col">
        <div className="card">
          <h2>Issuer identity <span className="hint">sellers pin this address to accept your attestations</span></h2>
          <div>{hasA && <>
            <div className="addr">{a.issuer}</div>
            <p className="hint" style={{ marginTop: "0.5rem" }}>{a.persistent ? "persistent key (SERVER_SIGNER_KEY)" : "per-process key — set SERVER_SIGNER_KEY so this address survives restarts"} · attestations last {a.settings.ttlSeconds}s · {a.settings.requireOnCatalog ? "required on this catalog" : "optional on this catalog"} · <a href="/.well-known/spendveto-issuer.json" target="_blank">issuer document ↗</a></p>
          </>}</div>
          <h2 style={{ marginTop: "1.4rem" }}>Recent attestations</h2>
          <div className="tbl-scroll"><table className="tbl"><thead><tr><th>when</th><th>payer</th><th>payee</th><th>resource</th><th>ceiling</th><th>decision</th></tr></thead><tbody>
            {hasA && ((a.recent || []).length ? a.recent.slice(0, 12).map((x, n) => (
              <tr key={x.jti || n}>
                <td>{when(x.iat * 1000)}</td><td className="addr">{short(x.sub)}</td><td className="addr">{x.aud ? short(x.aud) : <span className="hint">catalog</span>}</td>
                <td>{x.res}</td><td className="num">${x.amt}</td>
                <td>{x.dec === "approved" ? <Tag c="copper" title="a human approved this spend">approved</Tag> : <Tag c="green">allowed</Tag>}</td>
              </tr>
            )) : <EmptyRow cols={6}>None yet — every governed x402 payment carries one.</EmptyRow>)}
          </tbody></table></div>
        </div>
        <div className="card">
          <h2>Policy check <span className="hint">the live policy against spendveto.com/schemas/policy-v1.json</span></h2>
          <div>{hasV && <PolicyCheck v={v} />}</div>
        </div>
      </div>
      <div className="card">
        <h2>Report a counterparty <span className="hint">refused (block) or sent to a human (review) on every rail</span></h2>
        {/* id kept: style.css lays this form out by it */}
        <form id="rep-form" className="inline-form" onSubmit={report}>
          <input name="subject" type="text" placeholder="0x… · name@upi · IBAN · domain · card-merchant:id" required />
          <select name="kind"><option>scam</option><option>fraud</option><option value="prompt_injection">prompt injection</option><option value="non_delivery">non-delivery</option><option>chargeback</option><option>malware</option><option>impersonation</option><option>other</option></select>
          <select name="severity"><option value="block">block</option><option value="review">review</option></select>
          <input name="reason" type="text" placeholder="internal note (never published)" />
          <button className="btn go" type="submit">Report</button>
        </form>
        <p className="form-note">{repNote}</p>
        <table className="tbl"><thead><tr><th>counterparty</th><th>kind</th><th>severity</th><th>count</th><th>last seen</th><th>in feed</th><th></th></tr></thead><tbody>
          {hasR && ((r.reports || []).length ? r.reports.map((x) => (
            <tr key={x.id}>
              <td className="addr">{x.subject}</td><td>{x.kind}</td><td>{x.severity === "block" ? <Tag c="rust">block</Tag> : <Tag c="copper">review</Tag>}</td>
              <td className="num">{x.count}</td><td>{when(x.lastSeen)}</td><td>{x.share ? "yes" : "no"}</td>
              <td><button className="btn ghost mini" onClick={() => actions.removeReport(x.id)}>remove</button></td>
            </tr>
          )) : <EmptyRow cols={7}>No reports. A reported counterparty is refused on every rail.</EmptyRow>)}
        </tbody></table>
      </div>
      <div className="card">
        <h2>Trusted publishers &amp; imported feeds <span className="hint">a feed is accepted only from an address on the trusted list</span></h2>
        <div>{hasR && (
          <p className="hint" style={{ marginBottom: "0.8rem" }}>Publishing as <b>{r.settings.publisherName || "SpendVeto instance"}</b> ({short(r.publisher)}) · imported blocks <b>{r.settings.importedAction}</b> · trusted publishers: {trusted.length ? trusted.map((p, n) => <Fragment key={p}>{n ? ", " : ""}<span className="addr">{short(p)}</span></Fragment>) : "none, so no feed is accepted"} · <a href="/api/reputation/feed" target="_blank">your signed feed ↗</a></p>
        )}</div>
        <table className="tbl"><thead><tr><th>publisher</th><th>name</th><th>entries</th><th>issued</th><th>imported</th><th>status</th></tr></thead><tbody>
          {hasR && ((r.feeds || []).length ? r.feeds.map((f) => (
            <tr key={f.publisher}>
              <td className="addr">{short(f.publisher)}</td><td>{f.name}</td><td className="num">{f.entries}</td><td>{when(f.issuedAt)}</td><td>{when(f.importedAt)}</td>
              <td>{f.trusted ? <Tag c="green">trusted</Tag> : <Tag>untrusted — ignored</Tag>}</td>
            </tr>
          )) : <EmptyRow cols={6}>No imported feeds.</EmptyRow>)}
        </tbody></table>
      </div>
    </>
  );
}

function PolicyCheck({ v }) {
  if (v.valid && !v.warnings.length) return <p><Tag c="green">valid</Tag> every key is one the engine reads, and no limits contradict each other.</p>;
  return (
    <>
      <p>{v.valid ? <Tag c="copper">valid, with warnings</Tag> : <><Tag c="rust">invalid</Tag> a key the engine never reads is a limit that isn't enforced.</>}</p>
      <ul className="hint" style={{ margin: "0.6rem 0 0 1.1rem" }}>
        {v.errors.map((e, n) => <li key={`e${n}`}><b>{e.path}</b> {e.message}</li>)}
        {v.warnings.map((w, n) => <li key={`w${n}`}>{w.path} {w.message}</li>)}
      </ul>
    </>
  );
}
