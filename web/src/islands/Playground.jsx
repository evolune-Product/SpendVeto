import { useEffect, useReducer, useRef, useState } from "react";

// The playground's policy controls and governed console. The decision is a
// faithful re-implementation of client/policy.js's order (see decide()); the
// window state lives in a ref because the burst and auto-run timers fire
// faster than renders and must always read the latest numbers.
const round = (n) => Math.round(n * 1e6) / 1e6;
const fmt = (n) => "$" + n.toFixed(3);
const fresh = () => ({ spent: 0, calls: 0, paidUSD: 0, blockedUSD: 0, frozen: false, burstTimes: [], log: [], pending: [] });

const ACTIONS = [
  { tool: "translate", label: "translate", price: 0.005, payee: "trusted", note: "$0.005 · trusted" },
  { tool: "review", label: "review", price: 0.01, payee: "trusted", note: "$0.01 · trusted" },
  { tool: "summarize", label: "summarize", price: 0.02, payee: "trusted", note: "$0.02 · trusted" },
  { tool: "premium-data", label: "premium data", price: 0.08, payee: "trusted", note: "$0.08 · trusted" },
  { tool: "unknown-vendor", label: "pay an unknown vendor", price: 0.03, payee: "unknown", note: "$0.03 · payee NOT on allowlist", warn: true },
];
const BURST = { tool: "scrape", price: 0.01, payee: "trusted" };

export default function Playground() {
  // Slider units: cents for the caps, tenths of a cent for the approval line
  // ($0.001–$0.030; the old script divided it by 100, so touching it jumped
  // the line to $0.15), calls for the rate.
  const [policy, setPolicy] = useState({ percall: 5, hourly: 20, rate: 10, appr: 15, allowlist: false });
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const sim = useRef(fresh());
  const [, rerender] = useReducer((n) => n + 1, 0);
  const [autorun, setAutorun] = useState(false);
  const stageRef = useRef(null);
  const timers = useRef(new Set());
  const seq = useRef(0);

  useEffect(() => () => timers.current.forEach(clearInterval), []);
  useEffect(() => {
    if (!autorun) return;
    const pool = ACTIONS.map(({ tool, price, payee }) => ({ tool, price, payee }));
    const t = setInterval(() => fire(pool[Math.floor(Math.random() * pool.length)]), 950);
    return () => clearInterval(t);
  }, [autorun]);

  const limits = () => {
    const p = policyRef.current;
    return { maxPerCallUSD: p.percall / 100, maxPerHourUSD: p.hourly / 100, maxCallsPerHour: p.rate, requireApprovalAboveUSD: p.appr / 1000, allowlist: p.allowlist };
  };

  // ---- the decision (mirrors checkPolicy order) ----
  function decide(action) {
    const s = sim.current, l = limits();
    if (s.frozen) return { verdict: "blocked", reason: "wallet frozen (runaway auto-freeze)" };
    if (action.price > l.maxPerCallUSD) return { verdict: "blocked", reason: "per_call_cap — over the per-call limit" };
    if (l.allowlist && action.payee === "unknown") return { verdict: "blocked", reason: "payee_not_allowed — recipient not on the allowlist" };
    if (s.calls + 1 > l.maxCallsPerHour) return { verdict: "blocked", reason: "rate_cap — too many calls this window" };
    if (s.spent + action.price > l.maxPerHourUSD) return { verdict: "blocked", reason: "hourly_budget — would exceed the window budget" };
    if (action.price > l.requireApprovalAboveUSD) return { verdict: "pending", reason: "needs human approval" };
    return { verdict: "paid", reason: "within policy" };
  }

  // ---- runaway auto-freeze: >8 attempts in 3s (mirrors the burst detector) ----
  function noteAttemptForBurst() {
    const s = sim.current, now = Date.now();
    s.burstTimes = s.burstTimes.filter((t) => now - t < 3000);
    s.burstTimes.push(now);
    if (s.burstTimes.length > 8) s.frozen = true;
  }

  function log(action, verdict, reason) {
    sim.current.log.unshift({ id: ++seq.current, action, verdict, reason });
  }

  // The chip is pure decoration, so it stays imperative: React never renders
  // into the stage after the gate line, and each chip removes itself.
  function flyChip(action, verdict) {
    const stage = stageRef.current;
    if (!stage || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const chip = document.createElement("div");
    chip.className = "pk " + verdict;
    chip.append(document.createElement("i"), `${action.tool} ${fmt(action.price)}`);
    const lane = 22 + Math.random() * 56; // vertical %
    chip.style.top = lane + "%";
    stage.appendChild(chip);
    const midX = stage.clientWidth / 2 - 40;
    const endX = verdict === "blocked" ? midX - 6 : stage.clientWidth + 40;
    chip.animate(
      verdict === "blocked"
        ? [{ transform: "translate(0,0)", opacity: 0 }, { transform: `translate(${midX}px,0)`, opacity: 1, offset: 0.55 }, { transform: `translate(${midX}px,26px)`, opacity: 0 }]
        : [{ transform: "translate(0,0)", opacity: 0 }, { transform: `translate(${midX}px,0)`, opacity: 1, offset: 0.5 }, { transform: `translate(${endX}px,0)`, opacity: verdict === "pending" ? 1 : 0 }],
      { duration: verdict === "pending" ? 900 : 1500, easing: "cubic-bezier(0.3,0.7,0.3,1)", fill: "forwards" },
    ).onfinish = () => { if (verdict !== "pending") chip.remove(); else setTimeout(() => chip.remove(), 400); };
  }

  function settle(action) {
    const s = sim.current;
    s.spent = round(s.spent + action.price);
    s.calls += 1;
    s.paidUSD = round(s.paidUSD + action.price);
  }
  const block = (action) => { sim.current.blockedUSD = round(sim.current.blockedUSD + action.price); };

  function fire(action) {
    noteAttemptForBurst();
    const d = decide(action);
    flyChip(action, d.verdict);
    if (d.verdict === "paid") settle(action);
    else if (d.verdict === "pending") sim.current.pending.push({ id: ++seq.current, action });
    else block(action);
    log(action, d.verdict, d.reason);
    rerender();
  }

  function resolve(item, approved) {
    const s = sim.current;
    s.pending = s.pending.filter((p) => p !== item);
    if (!approved) { log(item.action, "blocked", "denied by human"); block(item.action); flyChip(item.action, "blocked"); }
    else {
      // Re-check budget at approval time — an approval doesn't bypass the caps.
      const d = decide(item.action);
      if (d.verdict === "blocked") { log(item.action, "blocked", d.reason); block(item.action); flyChip(item.action, "blocked"); }
      else { settle(item.action); log(item.action, "paid", "approved"); flyChip(item.action, "paid"); }
    }
    rerender();
  }

  function burst() {
    let i = 0;
    const t = setInterval(() => { fire(BURST); if (++i >= 12) { clearInterval(t); timers.current.delete(t); } }, 180);
    timers.current.add(t);
  }

  const reset = () => { sim.current = fresh(); rerender(); };
  const unfreeze = () => { sim.current.frozen = false; sim.current.burstTimes = []; rerender(); };
  const slide = (key) => (e) => setPolicy((p) => ({ ...p, [key]: +e.target.value }));

  const s = sim.current, l = limits();
  const hp = Math.min(100, (s.spent / l.maxPerHourUSD) * 100);
  const rp = Math.min(100, (s.calls / l.maxCallsPerHour) * 100);
  const meterClass = (pct) => (pct >= 100 ? "full" : pct >= 75 ? "warn" : "");

  return (
    <div className="pg-grid">
      {/* CONTROLS */}
      <div className="panel">
        <h2>Policy</h2>
        <div className="ctl"><label>Per-call cap <b>{fmt(l.maxPerCallUSD)}</b></label> <input type="range" min="1" max="20" step="1" value={policy.percall} onChange={slide("percall")} /></div>
        <div className="ctl"><label>Hourly budget <b>{fmt(l.maxPerHourUSD)}</b></label> <input type="range" min="5" max="100" step="5" value={policy.hourly} onChange={slide("hourly")} /></div>
        <div className="ctl"><label>Max calls / window <b>{l.maxCallsPerHour}</b></label> <input type="range" min="3" max="30" step="1" value={policy.rate} onChange={slide("rate")} /></div>
        <div className="ctl"><label>Approval above <b>{fmt(l.requireApprovalAboveUSD)}</b></label> <input type="range" min="1" max="30" step="1" value={policy.appr} onChange={slide("appr")} /></div>
        <div className="ctl toggle">
          <label style={{ margin: "0" }}>Payee allowlist <b style={{ color: policy.allowlist ? "var(--green)" : "var(--faint)" }}>{policy.allowlist ? "on" : "off"}</b></label>{" "}
          {/* A <label>, so a click on the slider toggles the hidden checkbox (it was a
              <span> on the old page, and the switch did nothing). */}
          <label className="switch"><input type="checkbox" aria-label="Payee allowlist" checked={policy.allowlist} onChange={(e) => setPolicy((p) => ({ ...p, allowlist: e.target.checked }))} /><span className="slider"></span></label>
        </div>
        <h2 style={{ marginTop: "1.6rem" }}>Fire agent spend</h2>
        <div className="actions">
          {ACTIONS.map((a) => (
            <button key={a.tool} className={a.warn ? "abtn warn span2" : "abtn"} onClick={() => fire({ tool: a.tool, price: a.price, payee: a.payee })}>{a.label}<small>{a.note}</small></button>
          ))}
          <button className="abtn warn span2" onClick={burst}>runaway burst — 12× rapid calls<small>$0.01 each · trips the rate limit &amp; auto-freeze</small></button>
        </div>
        <div className="row2">
          <button className="minor" style={autorun ? { color: "var(--green)" } : undefined} onClick={() => setAutorun((on) => !on)}>{autorun ? "⏸ Stop" : "▶ Auto-run"}</button>{" "}
          <button className="minor" onClick={reset}>↺ Reset window</button>
        </div>
      </div>
      {/* OUTPUT */}
      <div className="panel">
        <h2>Governed console</h2>
        <div className={s.frozen ? "frozen-banner on" : "frozen-banner"}>
          <span>⛔ Wallet auto-frozen — runaway burst detected. Nothing spends until a human unfreezes.</span>
          <button onClick={unfreeze}>Unfreeze</button>
        </div>
        <div className="stage" ref={stageRef}>
          <div className="gate-line"></div>
          <div className="gate-label">spendveto</div>
        </div>
        <div className="stats">
          <div className="stat"><div className="v green">{fmt(s.paidUSD)}</div><div className="k">paid</div></div>
          <div className="stat"><div className="v copper">{s.pending.length}</div><div className="k">awaiting approval</div></div>
          <div className="stat"><div className="v rust">{fmt(s.blockedUSD)}</div><div className="k">blocked</div></div>
        </div>
        <div className="meters">
          <div className="meter-row">
            <div className="top"><span>Hourly budget</span><b>{fmt(s.spent)} / {fmt(l.maxPerHourUSD)}</b></div>
            <div className="bar"><span className={meterClass(hp)} style={{ width: hp + "%" }}></span></div>
          </div>
          <div className="meter-row">
            <div className="top"><span>Calls this window</span><b>{s.calls} / {l.maxCallsPerHour}</b></div>
            <div className="bar"><span className={meterClass(rp)} style={{ width: rp + "%" }}></span></div>
          </div>
        </div>
        <div className="pending-q">
          {s.pending.map((item) => (
            <div className="pend" key={item.id}>
              <span className="q"><i>●</i> {item.action.tool} · {fmt(item.action.price)} — needs sign-off</span>
              <button onClick={() => resolve(item, true)}>Approve</button>
              <button className="deny" onClick={() => resolve(item, false)}>Deny</button>
            </div>
          ))}
        </div>
        <div className="log">
          {s.log.length === 0 && <div className="log-empty">No attempts yet — fire some spend on the left.</div>}
          {s.log.map(({ id, action, verdict, reason }) => (
            <div className="logline" key={id}>
              <span className="what">{action.tool} · {fmt(action.price)}{action.payee === "unknown" ? " · ext" : ""}</span>
              <span className={`verdict ${verdict}`}>{verdict === "paid" ? "paid " + fmt(action.price) : verdict === "pending" ? "awaiting human" : "blocked"}{verdict === "blocked" ? " — " + reason.split(" — ")[0] : ""}</span>
            </div>
          ))}
        </div>
        <p className="foot-note">
          This is a faithful re-implementation of <code>client/policy.js</code>'s decision order: freeze → per-call cap → payee allowlist → rate limit → hourly budget → approval threshold. In the real product the same checks run server-side at the payment gate, so an agent can't skip them.{" "}
          <a href="/docs#governance" style={{ color: "var(--green)" }}>See the governance model →</a>
        </p>
      </div>
    </div>
  );
}
