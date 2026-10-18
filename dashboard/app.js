// SpendVeto Console — multi-page governance control surface over the local API.
// Hash-routed pages; state polled every 2s; every button hits a real endpoint.
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—");
const money = (n) => `$${Number(n || 0).toFixed(4).replace(/0{1,2}$/, "")}`;
const when = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "—");

const S = { entries: [], balances: {}, mode: "…", stats: null, tools: [], approvals: [], delegations: [], freezes: [], chains: [], analytics: null, policy: null, packs: [] };
const frozenSet = () => new Set(S.freezes.filter((f) => !f.unfrozen).map((f) => f.address.toLowerCase()));

/* ---------- router ---------- */
const PAGES = ["overview", "ai", "costs", "payouts", "approvals", "budgets", "ledger", "chains", "analytics", "trust", "network", "policy", "agents", "report"];
const PROXY_BASE = "http://localhost:8404";
function route() {
  const page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  document.querySelectorAll("main > section").forEach((s) => (s.hidden = s.dataset.page !== page));
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
}
window.addEventListener("hashchange", route);

/* ---------- actions ---------- */
const api = (path, opts) => fetch(path, opts).then((r) => r.json().catch(() => ({})).then((body) => ({ ok: r.ok, body })));
async function act(path, opts) { await api(path, opts); await refresh(); }
window.decide = (id, decision) => act(`/api/approvals/${id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
window.freezeAddr = (address) => act(`/api/freezes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, reason: "manual freeze from console" }) });
window.unfreeze = (id) => act(`/api/freezes/${id}/unfreeze`, { method: "POST" });
window.revoke = (id) => act(`/api/delegations/${id}/revoke`, { method: "POST" });
window.applyPack = async (name) => {
  await act(`/api/policy/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pack: name }) });
  fillPolicyForm(true);
};

/* ---------- renderers ---------- */
function renderOverview() {
  const s = S.stats;
  if (s) {
    $("stat-row").innerHTML = [
      ["Governed spend", money(s.paid.usd), "green"],
      ["Blocked before it moved", money(s.blocked.usd), "copper"],
      ["Stopped attempts", s.blocked.count, "copper"],
      ["Failed attempts", s.failed.count, "rust"],
      ["Wallets frozen", s.frozenWallets, s.frozenWallets ? "rust" : ""],
      ["Total attempts", s.totalAttempts, ""],
    ].map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join("");
  }
  $("ov-catalog").innerHTML = S.tools.map((t) =>
    `<div class="kv"><span class="k">${esc(t.label)} <span class="hint">${esc(t.id)}</span></span><span class="v">$${esc(t.price)}${Number(t.price) > (S.policy?.requireApprovalAboveUSD ?? 1) ? ' <span class="tag rust">needs approval</span>' : ' <span class="tag green">auto</span>'}</span></div>`).join("") || `<p class="empty">No tools.</p>`;

  const frozen = frozenSet();
  const rows = Object.entries(S.balances);
  $("ov-balances").innerHTML = rows.length ? rows.map(([addr, bal]) => {
    const per = typeof bal === "object" && bal !== null ? Object.entries(bal).map(([c, u]) => `${esc(c)} ${money(u)}`).join(" · ") : money(bal);
    const ctl = frozen.has(addr) ? `<span class="tag rust">frozen</span>` : `<button class="btn deny mini" onclick="freezeAddr('${esc(addr)}')">Freeze</button>`;
    return `<div class="kv"><span class="k addr">${short(addr)}</span><span class="v">${per} ${ctl}</span></div>`;
  }).join("") : `<p class="empty">No calls yet — run <code>npm run call</code>.</p>`;

  $("ov-recent").innerHTML = S.entries.slice(-12).reverse().map((e) =>
    `<tr><td>${when(e.ts)}</td><td class="addr">${short(e.address)}</td><td>${esc(e.resource) || "—"}${e.chain ? ` <span class="tag">${esc(e.chain)}</span>` : ""}</td><td class="num">${money(e.amount)}</td><td class="status-${esc(e.status)}">${esc(e.status)}</td><td>${esc(e.reason || e.mode || "")}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No activity yet.</td></tr>`;
}

function renderApprovals() {
  const pending = S.approvals.filter((a) => a.status === "pending");
  $("nav-approvals-badge").hidden = pending.length === 0;
  $("nav-approvals-badge").textContent = pending.length;
  $("ap-pending").innerHTML = pending.length ? pending.map((a) =>
    `<div class="appr"><span class="what"><b>${short(a.address)}</b> wants ${esc(a.resource)} for <b>$${esc(a.price)}</b></span><span class="acts"><button class="btn go mini" onclick="decide('${a.id}','approved')">Approve</button><button class="btn deny mini" onclick="decide('${a.id}','denied')">Deny</button></span></div>`).join("")
    : `<p class="empty">Nothing pending. Trigger one: <code>npm run call -- summarize</code></p>`;
  $("ap-history").innerHTML = S.approvals.filter((a) => a.status !== "pending").slice(-20).reverse().map((a) =>
    `<tr><td>${when(a.decidedAt || a.createdAt)}</td><td class="addr">${short(a.address)}</td><td>${esc(a.resource)}</td><td class="num">$${esc(a.price)}</td><td class="status-${a.status === "approved" ? "paid" : "blocked"}">${esc(a.status)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No decisions yet.</td></tr>`;
}

function renderBudgets() {
  const dels = S.delegations;
  const frozen = frozenSet();
  const paidOf = (addr) => S.entries.filter((e) => e.status === "paid" && e.address?.toLowerCase() === addr.toLowerCase()).reduce((t, e) => t + Number(e.amount || 0), 0);
  const kidsOf = (addr) => dels.filter((d) => !d.revoked && d.parentAddress.toLowerCase() === addr.toLowerCase());
  const subtree = (addr, seen = new Set()) => {
    if (seen.has(addr.toLowerCase())) return 0;
    seen.add(addr.toLowerCase());
    return paidOf(addr) + kidsOf(addr).reduce((t, d) => t + subtree(d.childAddress, seen), 0);
  };
  const bar = (spent, cap) => {
    const pct = Math.min(100, (spent / cap) * 100);
    return `<div class="bar"><i class="${pct > 80 ? "hot" : ""}" style="width:${pct}%"></i></div><div class="bar-cap">${money(spent)} / ${money(cap)}</div>`;
  };
  const node = (d, depth) => `<div class="tree-child" style="padding-left:${depth * 1.1}rem"><span class="tree-child-name">├─ ${esc(d.label || short(d.childAddress))}${frozen.has(d.childAddress.toLowerCase()) ? ' <span class="tag rust">frozen</span>' : ""}${d.expiresAt ? ` <span class="tree-note">ttl→${when(d.expiresAt)}</span>` : ""}</span>${bar(subtree(d.childAddress), d.capUSD)}</div>` + kidsOf(d.childAddress).map((k) => node(k, depth + 1)).join("");
  const active = dels.filter((d) => !d.revoked);
  const childSet = new Set(active.map((d) => d.childAddress.toLowerCase()));
  const roots = [...new Set(active.filter((d) => !childSet.has(d.parentAddress.toLowerCase())).map((d) => d.parentAddress))];
  $("bu-tree").innerHTML = roots.length ? roots.map((r) =>
    `<div class="tree-parent"><div class="tree-parent-name">${short(r)} <span class="tree-note">root · own spend ${money(paidOf(r))}</span></div>${kidsOf(r).map((d) => node(d, 0)).join("")}</div>`).join("") : `<p class="empty">No delegations yet — create one on the left.</p>`;

  $("bu-grants").innerHTML = dels.slice().reverse().map((d) => {
    const scopes = [d.allowedTools ? `tools: ${d.allowedTools.join(",")}` : null, d.allowedChains ? `chains: ${d.allowedChains.join(",")}` : null].filter(Boolean).join(" · ") || "all";
    const expired = d.expiresAt && Date.now() > new Date(d.expiresAt).getTime();
    const status = d.revoked ? `<span class="tag rust">revoked</span>` : expired ? `<span class="tag rust">expired</span>` : `<span class="tag green">active</span>`;
    const actBtn = d.revoked || expired ? "" : `<button class="btn deny mini" onclick="revoke('${d.id}')">Revoke</button>`;
    return `<tr><td>${esc(d.label || "—")}</td><td class="addr">${short(d.childAddress)}</td><td class="num">${money(d.capUSD)}</td><td>${esc(scopes)}</td><td>${d.expiresAt ? when(d.expiresAt) : "never"}</td><td>${status}</td><td>${actBtn}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">No grants yet.</td></tr>`;
}

function renderLedger() {
  const st = $("lf-status").value, ch = $("lf-chain").value, q = $("lf-q").value.toLowerCase();
  const chainSel = $("lf-chain");
  if (chainSel.options.length <= 1 && S.chains.length) {
    for (const c of S.chains) chainSel.add(new Option(c.id, c.id));
  }
  const rows = S.entries.filter((e) =>
    (!st || e.status === st) && (!ch || (e.chain || "base-sepolia") === ch) &&
    (!q || `${e.address} ${e.resource} ${e.reason}`.toLowerCase().includes(q)));
  $("le-body").innerHTML = rows.slice(-200).reverse().map((e) =>
    `<tr><td>${when(e.ts)}</td><td class="addr">${short(e.address)}</td><td>${esc(e.resource) || "—"}</td><td><span class="tag">${esc(e.chain || "base-sepolia")}</span></td><td class="num">${money(e.amount)}</td><td class="status-${esc(e.status)}">${esc(e.status)}</td><td>${esc(e.reason || "")}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">Nothing matches.</td></tr>`;
}

function renderChains() {
  const byChain = Object.fromEntries((S.analytics?.byChain || []).map((r) => [r.key, r]));
  const sortedChains = [...S.chains].sort((a, b) => {
    const liveA = a.status === "live" || a.settlement === "live";
    const liveB = b.status === "live" || b.settlement === "live";
    return (liveA ? 0 : 1) - (liveB ? 0 : 1);
  });
  const families = new Set(S.chains.map((c) => c.family || "evm")).size;
  $("ch-count").textContent = `${S.chains.length} registered chains across ${families} signature families`;
  $("ch-grid").innerHTML = sortedChains.map((c) => {
    const a = byChain[c.id];
    const live = c.status === "live" || c.settlement === "live";
    return `<div class="chain-card"><h3>${esc(c.name)} <span class="tag ${live ? "green" : ""}">${live ? "LIVE" : "READY"}</span></h3><div class="usdc">${esc(c.stablecoin || "USDC")} ${esc(c.usdc)}</div><div class="note">${esc(c.note || (live ? "" : "fully governed today (simulate settles locally); goes live when the configured facilitator supports it"))}</div>${a ? `<div class="note">paid ${a.paidCount} (${money(a.paidUSD)})${a.blockedCount ? ` · blocked ${a.blockedCount}` : ""}</div>` : ""}</div>`;
  }).join("");
  $("ch-rails").innerHTML = (S.rails || []).map((r) =>
    `<div class="kv"><span class="k">${esc(r.name)} <span class="hint">${esc(r.note || "")}</span></span><span class="v"><span class="tag ${r.status === "live" ? "green" : ""}">${r.status === "live" ? "LIVE" : "SLOT"}</span></span></div>`).join("");
  $("ch-analytics").innerHTML = (S.analytics?.byChain || []).map((r) =>
    `<tr><td>${esc(r.key)}</td><td class="num">${r.paidCount}</td><td class="num">${money(r.paidUSD)}</td><td class="num">${r.blockedCount}</td><td class="num">${money(r.blockedUSD)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No activity yet.</td></tr>`;
}

function renderAnalytics() {
  const tbl = (rows, keyFmt) => rows.map((r) => `<tr><td>${keyFmt(r.key)}</td><td class="num">${r.paidCount}</td><td class="num">${money(r.paidUSD)}</td><td class="num">${r.blockedCount}</td><td class="num">${money(r.blockedUSD)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No data.</td></tr>`;
  $("an-tool").innerHTML = tbl(S.analytics?.byTool || [], esc);
  $("an-wallet").innerHTML = tbl(S.analytics?.byWallet || [], (k) => `<span class="addr">${short(k)}</span>`);
  $("an-freezes").innerHTML = S.freezes.slice().reverse().map((f) =>
    `<tr><td>${when(f.createdAt)}</td><td class="addr">${short(f.address)}</td><td>${esc(f.source)}</td><td>${esc(f.reason)}</td><td>${f.unfrozen ? `<span class="tag">unfrozen</span>` : `<span class="tag rust">FROZEN</span>`}</td><td>${f.unfrozen ? "" : `<button class="btn mini" onclick="unfreeze('${f.id}')">Unfreeze</button>`}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No freezes — a healthy fleet.</td></tr>`;
}

async function renderTrustList() {
  const addrs = Object.keys(S.balances).slice(0, 12);
  const scores = await Promise.all(addrs.map((a) => fetch(`/api/trust/${a}`).then((r) => r.json()).catch(() => null)));
  $("trust-list").innerHTML = scores.filter(Boolean).sort((a, b) => b.score - a.score).map((t) =>
    `<tr><td class="addr">${short(t.address)}</td><td class="num">${t.score}</td><td><span class="grade ${t.grade}">${t.grade}</span></td><td class="num">${t.signals.paid}</td><td class="num">${t.signals.blocked}</td><td class="num">${t.signals.failed}</td><td class="num">${t.signals.freezes}${t.signals.frozenNow ? ' <span class="tag rust">now</span>' : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">No wallets seen yet.</td></tr>`;
}

function fillPolicyForm(force) {
  const p = S.policy;
  if (!p) return;
  const form = $("policy-form");
  if (!force && form.contains(document.activeElement)) return; // don't clobber typing
  for (const k of ["maxPerCallUSD", "maxPerHourUSD", "maxCallsPerHour", "requireApprovalAboveUSD"]) form.elements[k].value = p[k] ?? "";
  form.elements.allowedChains.value = Array.isArray(p.allowedChains) ? p.allowedChains.join(",") : "";
  $("policy-raw").textContent = JSON.stringify(p, null, 2);
  $("packs-list").innerHTML = S.packs.map((pk) =>
    `<div class="pack"><span class="desc"><b>${esc(pk.name)}</b>${esc(pk.$description || "")}</span><button class="btn mini" onclick="applyPack('${esc(pk.name)}')">Apply</button></div>`).join("");
}

/* ---------- forms ---------- */
$("grant-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const csv = (v) => (v.value.trim() ? v.value.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  const { ok, body } = await api("/api/delegations/wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capUSD: Number(f.capUSD.value), label: f.label.value.trim(), parent: f.parent.value.trim() || undefined, allowedTools: csv(f.tools), allowedChains: csv(f.chains), ttlSeconds: f.ttl.value ? Number(f.ttl.value) : undefined }),
  });
  const note = $("grant-result");
  note.classList.toggle("err", !ok);
  note.textContent = ok ? `Wallet ${short(body.childAddress)} granted ${money(body.capUSD)} — spend with: ${body.spendWith}` : body.error || "failed";
  if (ok) ev.target.reset();
  refresh();
});

$("policy-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const chains = f.allowedChains.value.trim() ? f.allowedChains.value.split(",").map((x) => x.trim()).filter(Boolean) : [];
  const { ok, body } = await api("/api/policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxPerCallUSD: f.maxPerCallUSD.value, maxPerHourUSD: f.maxPerHourUSD.value, maxCallsPerHour: f.maxCallsPerHour.value, requireApprovalAboveUSD: f.requireApprovalAboveUSD.value, allowedChains: chains }),
  });
  const note = $("policy-result");
  note.classList.toggle("err", !ok);
  note.textContent = ok ? "Saved — applies to the next payment attempt." : body.error || "failed";
  refresh().then(() => fillPolicyForm(true));
});

$("trust-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const t = await fetch(`/api/trust/${ev.target.elements.addr.value.trim()}`).then((r) => r.json());
  $("trust-result").innerHTML = `<div class="score-big"><span class="n">${t.score}</span><span class="grade ${t.grade}">grade ${t.grade}</span><span class="hint">paid ${t.signals.paid} · blocked ${t.signals.blocked} · failed ${t.signals.failed} · freezes ${t.signals.freezes}${t.signals.frozenNow ? " · FROZEN NOW" : ""}</span></div>`;
});

["lf-status", "lf-chain", "lf-q"].forEach((id) => $(id).addEventListener("input", renderLedger));

/* ---------- agents + marketplace (talk to the proxy on :8404) ---------- */
async function renderAgentsList() {
  try {
    const { agents } = await fetch(`${PROXY_BASE}/proxy/agents`).then((r) => r.json());
    $("agents-list").innerHTML = agents.length
      ? `<h2 style="margin-top:1.2rem">Minted identities</h2>` +
        agents.map((a) => `<div class="kv"><span class="k">${esc(a.label)} <span class="hint">${a.child ? `bound → ${esc(a.child)}` : "custody wallet"}</span></span><span class="v mono">${esc(a.token)}</span></div>`).join("")
      : "";
  } catch {
    $("agents-list").innerHTML = `<p class="empty">Proxy not reachable at :8404 — run <code>npm run proxy</code>.</p>`;
  }
}

$("agent-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const note = $("agent-result");
  try {
    const res = await fetch(`${PROXY_BASE}/proxy/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: f.label.value.trim(), child: f.child.value.trim() || undefined }),
    });
    const body = await res.json();
    note.classList.toggle("err", !res.ok);
    note.textContent = res.ok ? `Minted — token (shown once): ${body.token}` : body.error || "failed";
    if (res.ok) ev.target.reset();
    renderAgentsList();
  } catch {
    note.classList.add("err");
    note.textContent = "Proxy not reachable at :8404 — run `npm run proxy`.";
  }
});

$("tool-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const { ok, body } = await api("/api/catalog/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: f.id.value.trim(), price: Number(f.price.value), label: f.label.value.trim(), upstreamUrl: f.upstreamUrl.value.trim() || undefined }),
  });
  const note = $("tool-result");
  note.classList.toggle("err", !ok);
  note.textContent = ok ? `Listed — spend it with: npm run call -- ${body.id}` : body.error || "failed";
  if (ok) { ev.target.reset(); refresh(); }
});

/* ---------- report ---------- */
async function renderReport() {
  const days = $("rp-days").value;
  const r = await fetch(`/api/report?days=${days}`).then((res) => res.json());
  $("rp-headline").textContent = r.headline;
  $("rp-stats").innerHTML = [
    ["Governed spend", money(r.paid.usd), "green"],
    ["Blocked before it moved", money(r.blocked.usd), "copper"],
    ["Stopped attempts", r.blocked.count, "copper"],
    ["Wallets frozen", r.frozenWallets, r.frozenWallets ? "rust" : ""],
  ].map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join("");
  const rows = (list) => list.map((x) => `<div class="kv"><span class="k">${esc(x.key)}</span><span class="v">${money(x.usd)}</span></div>`).join("") || `<p class="empty">Nothing yet.</p>`;
  $("rp-cat").innerHTML = rows(r.byCategory);
  $("rp-chain").innerHTML = rows(r.byChain);
  $("rp-reasons").innerHTML = r.topBlockReasons.map((x) => `<tr><td>${esc(x.reason)}</td><td class="num">${x.count}</td></tr>`).join("") || `<tr><td colspan="2" class="empty">Nothing blocked in this window.</td></tr>`;
}
$("rp-days").addEventListener("change", renderReport);

/* ---------- AI spend (LLM guard) ---------- */
let aiFormFilled = false;
let aiConnectLoaded = false;
function renderAi() {
  const s = S.llm;
  if (!s || !s.totals) return;
  $("nav-ai-badge").hidden = !s.totals.blockedDay;
  $("nav-ai-badge").textContent = s.totals.blockedDay;
  $("ai-stats").innerHTML = [
    ["AI spend (24h)", money(s.totals.spentDayUSD), "green"],
    ["Model requests", s.totals.requestsDay, ""],
    ["Blocked before the model", s.totals.blockedDay, s.totals.blockedDay ? "copper" : ""],
    ["Loop freezes", s.totals.loopFreezesDay, s.totals.loopFreezesDay ? "rust" : ""],
    ["Mode", s.mode, s.mode === "observe" ? "copper" : "green"],
    ["In flight", s.totals.inFlight, ""],
  ].map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${esc(v)}</div></div>`).join("");
  $("ai-agents").innerHTML = s.identities.map((i) => {
    const top = Object.entries(i.models || {}).sort((a, b) => b[1] - a[1])[0];
    const ctl = i.frozen ? `<button class="btn go mini" onclick="unfreezeId('${esc(i.frozen.id)}')">Unfreeze</button>` : `<button class="btn deny mini" onclick="freezeAddr('${esc(i.address)}')">Freeze</button>`;
    return `<tr><td>${esc(i.label || short(i.address))} <span class="hint">${esc(i.kind || "")}</span></td><td class="num">${money(i.spentDayUSD)}</td><td class="num">${money(i.spentHourUSD)}</td><td class="num">${money(i.remainingDayUSD)}</td><td class="num">${i.requestsDay}</td><td>${esc(top ? top[0] : "—")}</td><td>${i.frozen ? `<span class="tag rust">frozen</span> <span class="hint">${esc(i.frozen.reason)}</span>` : '<span class="tag green">ok</span>'}</td><td>${ctl}</td></tr>`;
  }).join("") || `<tr><td colspan="8" class="empty">No model traffic yet — point an agent at this server with one of the lines above.</td></tr>`;
  $("ai-decisions").innerHTML = (s.recentDecisions || []).map((d) =>
    `<tr><td>${when(d.ts)}</td><td>${esc(d.agent || "—")}</td><td>${esc(d.model || "—")}</td><td><span class="tag ${d.observeOnly ? "" : "rust"}">${esc(d.code || "")}${d.observeOnly ? " · observe" : ""}</span></td><td>${esc(d.reason || "")}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nothing blocked in the last 24 hours.</td></tr>`;
  if (!aiFormFilled && s.settings) {
    const f = $("ai-form").elements;
    f.dailyBudgetUSD.value = s.settings.dailyBudgetUSD;
    f.hourlyBudgetUSD.value = s.settings.hourlyBudgetUSD;
    f.maxRequestUSD.value = s.settings.maxRequestUSD;
    f.sessionBudgetUSD.value = s.settings.sessionBudgetUSD ?? "";
    f.maxRequestsPerMinute.value = s.settings.maxRequestsPerMinute;
    f.loopThreshold.value = s.settings.loop?.threshold ?? 6;
    f.mode.value = s.mode;
    aiFormFilled = true;
  }
  if (!aiConnectLoaded) {
    aiConnectLoaded = true;
    fetch("/api/llm/connect").then((r) => r.json()).then((c) => {
      if (!c.clients) return;
      $("ai-connect").innerHTML = c.clients.map((x) => `<div class="kv"><span class="k">${esc(x.name)}</span><span class="v"><code>${esc(x.line)}</code></span></div>`).join("");
      $("ai-connect-note").textContent = c.note || "";
    }).catch(() => {});
  }
}
window.unfreezeId = (id) => act(`/api/freezes/${id}/unfreeze`, { method: "POST" });
$("ai-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const body = {
    dailyBudgetUSD: Number(f.dailyBudgetUSD.value), hourlyBudgetUSD: Number(f.hourlyBudgetUSD.value), maxRequestUSD: Number(f.maxRequestUSD.value),
    sessionBudgetUSD: f.sessionBudgetUSD.value ? Number(f.sessionBudgetUSD.value) : null, maxRequestsPerMinute: Number(f.maxRequestsPerMinute.value),
    loop: { threshold: Number(f.loopThreshold.value) }, mode: f.mode.value,
  };
  const { ok, body: out } = await api("/api/llm/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const note = $("ai-form-note");
  note.classList.toggle("err", !ok);
  note.textContent = ok ? "Saved — applies to the next request." : out.error || "failed";
  aiFormFilled = false;
  refresh();
});

/* ---------- Costs (FinOps) + Payouts ---------- */
function renderCosts() {
  const c = S.costs;
  if (c && c.rows) {
    const byRail = Object.fromEntries((S.costsRail?.rows || []).map((r) => [r.key, r.costUSD]));
    $("costs-stats").innerHTML = [
      ["Total (30d)", money(S.costsRail?.totalCostUSD), "green"],
      ["Model tokens", money(byRail["model tokens"]), ""],
      ["x402 / tools", money(byRail["x402 / tools"]), ""],
      ["Cards", money(byRail["cards"]), ""],
      ["Fiat payouts", money(byRail["fiat payouts"]), ""],
      ["Blocked", money(S.costsRail?.totalBlockedUSD), "copper"],
    ].map(([k, v, cl]) => `<div class="stat"><div class="k">${k}</div><div class="v ${cl}">${v}</div></div>`).join("");
    $("costs-rows").innerHTML = c.rows.map((r) => `<tr><td>${esc(r.key)}</td><td class="num">${money(r.costUSD)}</td><td class="num">${r.count}</td><td class="num">${r.blockedCount ? `${money(r.blockedUSD)} · ${r.blockedCount}` : "—"}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No spend in the last 30 days.</td></tr>`;
  }
  const rb = S.rebilling;
  if (rb && rb.settings) {
    $("rebill-settings").textContent = rb.settings.enabled ? `on · markup ${rb.settings.markupPct}% · meter "${rb.settings.eventName}" · customer tag "${rb.settings.customerTag}"` : "off — enable with PUT /api/rebilling { enabled: true, markupPct } and STRIPE_SECRET_KEY";
    $("rebill-rows").innerHTML = (rb.customers || []).map((x) => `<tr><td>${esc(x.customer)}</td><td class="num">${money(x.costUSD)}</td><td class="num">${money(x.billedUSD)}</td><td class="num">${money(x.marginUSD)}</td><td class="num">${x.events}${x.failed ? ` · ${x.failed} failed` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nothing rebilled yet.</td></tr>`;
  }
}
function renderPayouts() {
  const p = S.payouts;
  if (!p || !p.providers) return;
  $("payouts-stats").innerHTML = [
    ["Paid out", money(p.totals.executedUSD), "green"],
    ["Awaiting approval", p.totals.awaitingApproval, p.totals.awaitingApproval ? "copper" : ""],
    ["Failed", p.totals.failed, p.totals.failed ? "rust" : ""],
    ["Denied", p.totals.denied, ""],
  ].map(([k, v, cl]) => `<div class="stat"><div class="k">${k}</div><div class="v ${cl}">${v}</div></div>`).join("");
  $("payout-providers").innerHTML = p.providers.map((x) => `<tr><td>${esc(x.label)}</td><td>${x.configured ? '<span class="tag green">configured</span>' : '<span class="tag">not configured</span>'}</td><td class="hint">${esc(x.needs)}</td></tr>`).join("");
  $("payout-rows").innerHTML = (p.payouts || []).map((x) => `<tr><td>${when(x.createdAt)}</td><td>${esc(x.agent)}</td><td>${esc(x.provider)}</td><td class="addr">${esc(x.payee)}</td><td class="num">${esc(x.amount)} ${esc(x.currency)}</td><td class="num">${money(x.amountUSD)}</td><td class="status-${x.status === "executed" ? "paid" : x.status === "failed" || x.status === "denied" ? "blocked" : "pending"}">${esc(x.status)}${x.providerStatus ? ` <span class="hint">${esc(x.providerStatus)}</span>` : ""}</td><td class="hint">${esc(x.providerId || x.approvalReason || "")}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">No payouts yet.</td></tr>`;
}
$("costs-group").addEventListener("change", () => refresh());

/* ---------- Network: attestations, reputation, policy schema ---------- */
function renderNetwork() {
  const a = S.attestations;
  const r = S.reputation;
  const v = S.policyCheck;
  if (a && a.issuer) {
    $("net-issuer").innerHTML = `<div class="addr">${esc(a.issuer)}</div><p class="hint" style="margin-top:0.5rem">${a.persistent ? "persistent key (SERVER_SIGNER_KEY)" : "per-process key — set SERVER_SIGNER_KEY so this address survives restarts"} · attestations last ${a.settings.ttlSeconds}s · ${a.settings.requireOnCatalog ? "required on this catalog" : "optional on this catalog"} · <a href="/.well-known/spendveto-issuer.json" target="_blank">issuer document ↗</a></p>`;
    $("net-attestations").innerHTML = (a.recent || []).slice(0, 12).map((x) => `<tr><td>${when(x.iat * 1000)}</td><td class="addr">${esc(short(x.sub))}</td><td class="addr">${x.aud ? esc(short(x.aud)) : '<span class="hint">catalog</span>'}</td><td>${esc(x.res)}</td><td class="num">$${esc(x.amt)}</td><td>${x.dec === "approved" ? '<span class="tag copper" title="a human approved this spend">approved</span>' : '<span class="tag green">allowed</span>'}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">None yet — every governed x402 payment carries one.</td></tr>`;
  }
  if (r && r.settings) {
    $("rep-rows").innerHTML = (r.reports || []).map((x) => `<tr><td class="addr">${esc(x.subject)}</td><td>${esc(x.kind)}</td><td>${x.severity === "block" ? '<span class="tag rust">block</span>' : '<span class="tag copper">review</span>'}</td><td class="num">${x.count}</td><td>${when(x.lastSeen)}</td><td>${x.share ? "yes" : "no"}</td><td><button class="btn ghost mini" onclick="removeReport('${esc(x.id)}')">remove</button></td></tr>`).join("") || `<tr><td colspan="7" class="empty">No reports. A reported counterparty is refused on every rail.</td></tr>`;
    const trusted = r.settings.trustedPublishers || [];
    $("rep-settings").innerHTML = `<p class="hint" style="margin-bottom:0.8rem">Publishing as <b>${esc(r.settings.publisherName || "SpendVeto instance")}</b> (${esc(short(r.publisher))}) · imported blocks <b>${esc(r.settings.importedAction)}</b> · trusted publishers: ${trusted.length ? trusted.map((p) => `<span class="addr">${esc(short(p))}</span>`).join(", ") : "none, so no feed is accepted"} · <a href="/api/reputation/feed" target="_blank">your signed feed ↗</a></p>`;
    $("feed-rows").innerHTML = (r.feeds || []).map((f) => `<tr><td class="addr">${esc(short(f.publisher))}</td><td>${esc(f.name)}</td><td class="num">${f.entries}</td><td>${when(f.issuedAt)}</td><td>${when(f.importedAt)}</td><td>${f.trusted ? '<span class="tag green">trusted</span>' : '<span class="tag">untrusted — ignored</span>'}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No imported feeds.</td></tr>`;
  }
  if (v && Array.isArray(v.errors)) {
    const items = [...v.errors.map((e) => `<li><b>${esc(e.path)}</b> ${esc(e.message)}</li>`), ...v.warnings.map((w) => `<li>${esc(w.path)} ${esc(w.message)}</li>`)].join("");
    $("net-policy").innerHTML = v.valid && !v.warnings.length
      ? `<p><span class="tag green">valid</span> every key is one the engine reads, and no limits contradict each other.</p>`
      : `<p>${v.valid ? '<span class="tag copper">valid, with warnings</span>' : '<span class="tag rust">invalid</span> a key the engine never reads is a limit that isn\'t enforced.'}</p><ul class="hint" style="margin:0.6rem 0 0 1.1rem">${items}</ul>`;
  }
  $("net-stats").innerHTML = [
    ["Attestations issued", a ? a.issued : "—", "green"],
    ["Counterparty reports", r ? (r.reports || []).length : "—", ""],
    ["Imported feeds", r ? (r.feeds || []).length : "—", ""],
    ["Policy", v ? (v.valid ? (v.warnings.length ? "warnings" : "valid") : "invalid") : "—", v && !v.valid ? "rust" : v && v.warnings.length ? "copper" : "green"],
  ].map(([k, val, cl]) => `<div class="stat"><div class="k">${k}</div><div class="v ${cl}">${esc(val)}</div></div>`).join("");
}
window.removeReport = (id) => act(`/api/reputation/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
$("rep-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const { ok, body } = await api("/api/reputation/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: f.get("subject"), kind: f.get("kind"), severity: f.get("severity"), reason: f.get("reason") }) });
  $("rep-result").textContent = ok ? `Reported. Payments to it are now ${body.report?.severity === "block" ? "refused" : "sent to a human"} on every rail.` : body.reason || body.error || "Couldn't save the report.";
  if (ok) e.target.reset();
  await refresh();
});

/* ---------- refresh loop ---------- */
let trustTick = 0;
async function refresh() {
  try {
    const [ledger, stats, catalog, approvals, delegations, freezes, chains, analytics, policy, packs, rails, llm, costs, costsRail, rebilling, payoutsSummary, attestations, reputation, policyCheck] = await Promise.all([
      fetch("/api/ledger").then((r) => r.json()),
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/catalog").then((r) => r.json()),
      fetch("/api/approvals").then((r) => r.json()),
      fetch("/api/delegations").then((r) => r.json()),
      fetch("/api/freezes").then((r) => r.json()),
      fetch("/api/chains").then((r) => r.json()),
      fetch("/api/analytics").then((r) => r.json()),
      fetch("/api/policy").then((r) => r.json()),
      fetch("/api/policy-packs").then((r) => r.json()),
      fetch("/api/rails").then((r) => r.json()),
      fetch("/api/llm/summary").then((r) => r.json()).catch(() => null),
      fetch(`/api/costs?groupBy=${encodeURIComponent($("costs-group").value)}&days=30`).then((r) => r.json()).catch(() => null),
      fetch("/api/costs?groupBy=rail&days=30").then((r) => r.json()).catch(() => null),
      fetch("/api/rebilling").then((r) => r.json()).catch(() => null),
      fetch("/api/payouts").then((r) => r.json()).catch(() => null),
      fetch("/api/attestations").then((r) => r.json()).catch(() => null),
      fetch("/api/reputation").then((r) => r.json()).catch(() => null),
      fetch("/api/policy/validate").then((r) => r.json()).catch(() => null),
    ]);
    Object.assign(S, { entries: ledger.entries || [], balances: ledger.balances || {}, mode: ledger.mode, stats, tools: catalog.tools || [], approvals: approvals.approvals || [], delegations: delegations.delegations || [], freezes: freezes.freezes || [], chains: chains.chains || [], analytics, policy, packs: packs.packs || [], rails: rails.rails || [], llm, costs, costsRail, rebilling, payouts: payoutsSummary, attestations, reputation, policyCheck });
    $("mode-badge").textContent = S.mode;
    renderOverview(); renderAi(); renderCosts(); renderPayouts(); renderNetwork(); renderApprovals(); renderBudgets(); renderLedger(); renderChains(); renderAnalytics(); fillPolicyForm(false); renderReport();
    if (trustTick++ % 3 === 0) { renderTrustList(); renderAgentsList(); }
  } catch (err) {
    console.error("console refresh failed", err);
  }
}

route();
refresh();
setInterval(refresh, 2000);
