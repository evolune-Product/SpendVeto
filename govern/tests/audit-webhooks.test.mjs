// The audit chain detects tampering; the database refuses rewrites; webhooks
// are signed, delivered from a transactional outbox, and guarded against SSRF.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { freshDb, startApp, client, tenantWithKeys, usd } from "./helpers.mjs";
import { deliverDue } from "../webhooks.js";
import { isBlockedAddress } from "../netguard.js";

let pool, app, t, admin, manage, spend, approve, read;
let receiver, received = [];
let receiverStatus = 200;

before(async () => {
  pool = await freshDb();
  app = await startApp(pool);
  t = await tenantWithKeys(pool);
  admin = client(app.url, t.keys.admin);
  manage = client(app.url, t.keys.manage);
  spend = client(app.url, t.keys.spend);
  approve = client(app.url, t.keys.approve);
  read = client(app.url, t.keys.read);
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(receiverStatus).end();
    });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
});
after(async () => {
  delete process.env.SPENDVETO_DEPLOYMENT;
  await new Promise((r) => receiver.close(r));
  await app?.close();
  await pool?.end();
});

const receiverUrl = () => `http://127.0.0.1:${receiver.address().port}/hooks`;

test("the chain verifies, and every decision appears in it", async () => {
  await manage.put("/budgets/a", { cap_micros: usd(1) });
  const ok = await spend.post("/authorize", { budget: "a", estimate_micros: usd(1) });
  await spend.post("/authorize", { budget: "a", estimate_micros: usd(1) }); // refused
  await spend.post(`/reservations/${ok.body.reservation_id}/settle`, { actual_micros: usd(0.5) });
  const events = (await read.get("/events")).body.events.map((e) => e.type);
  for (const type of ["tenant.created", "budget.created", "reservation.authorized", "reservation.denied", "reservation.settled"]) {
    assert.ok(events.includes(type), `missing ${type} in ${events.join(",")}`);
  }
  const v = await read.get("/events/verify");
  assert.equal(v.body.valid, true);
  assert.equal(v.body.length, events.length);
});

test("the database refuses UPDATE and DELETE on the audit log", async () => {
  await assert.rejects(pool.query("UPDATE sv_events SET type = 'x' WHERE seq = 1"), /append-only/);
  await assert.rejects(pool.query("DELETE FROM sv_events WHERE seq = 1"), /append-only/);
});

test("tampering by someone able to bypass the trigger is still detected, at the exact entry", async () => {
  await pool.query("ALTER TABLE sv_events DISABLE TRIGGER sv_events_no_update_delete");
  try {
    await pool.query("UPDATE sv_events SET amount_micros = 1 WHERE tenant_id = $1 AND type = 'reservation.settled'", [t.id]);
    const { rows } = await pool.query("SELECT seq FROM sv_events WHERE tenant_id = $1 AND type = 'reservation.settled'", [t.id]);
    const v = await read.get("/events/verify");
    assert.equal(v.body.valid, false);
    assert.equal(v.body.brokenAt, Number(rows[0].seq));
  } finally {
    await pool.query("ALTER TABLE sv_events ENABLE TRIGGER sv_events_no_update_delete");
  }
});

test("cloud mode refuses loopback, private and metadata webhook targets", async () => {
  delete process.env.SPENDVETO_DEPLOYMENT; // default = cloud
  for (const url of [receiverUrl(), "http://169.254.169.254/latest", "http://10.0.0.5/x", "http://[::1]/x", "http://localhost:9/x", "ftp://example.com/x", "http://user:pw@example.com/"]) {
    const r = await admin.put("/tenant/webhook", { url });
    assert.equal(r.status, 422, `${url} → ${r.status}`);
    assert.equal(r.body.code, "webhook_url_refused");
  }
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::10.0.0.1", "0.0.0.0",
    // translated forms, in the hex spellings the URL parser and DNS actually produce
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::a00:1", "::7f00:1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2001:0:4136:e378::1", "[::1]", "fe80::1%eth0"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isBlockedAddress(ip), false, ip);
  // The URL parser rewrites a dotted NAT64 literal into hex; it must still be refused.
  assert.equal((await admin.put("/tenant/webhook", { url: "http://[64:ff9b::169.254.169.254]/x" })).body.code, "webhook_url_refused");
});

test("a delivery to a target that became private after configuration is refused at connect time", async () => {
  // Configure while the guard is off, then turn it on: the worker must still refuse.
  process.env.SPENDVETO_DEPLOYMENT = "self_hosted";
  await admin.put("/tenant/webhook", { url: receiverUrl() });
  await manage.post("/budgets/a/freeze", { reason: "x" });
  await manage.post("/budgets/a/unfreeze");
  process.env.SPENDVETO_DEPLOYMENT = "cloud";
  received = [];
  await deliverDue(pool);
  assert.equal(received.length, 0);
  const { rows } = await pool.query("SELECT last_error FROM sv_webhook_outbox WHERE status = 'pending' ORDER BY id");
  assert.ok(rows.length >= 2);
  assert.match(rows[0].last_error, /private, loopback or reserved/);
  await pool.query("DELETE FROM sv_webhook_outbox");
});

test("same, for a HOSTNAME that resolves privately (the check runs inside the socket's DNS lookup)", async () => {
  process.env.SPENDVETO_DEPLOYMENT = "self_hosted";
  await admin.put("/tenant/webhook", { url: `http://localhost:${receiver.address().port}/hooks` });
  await manage.post("/budgets/a/freeze", { reason: "y" });
  process.env.SPENDVETO_DEPLOYMENT = "cloud";
  received = [];
  await deliverDue(pool);
  assert.equal(received.length, 0, "nothing reached the private receiver");
  const { rows } = await pool.query("SELECT last_error FROM sv_webhook_outbox WHERE status = 'pending' ORDER BY id DESC LIMIT 1");
  assert.match(rows[0].last_error, /refused: localhost resolves to a private, loopback or reserved address/);
  await pool.query("DELETE FROM sv_webhook_outbox");
  process.env.SPENDVETO_DEPLOYMENT = "self_hosted";
  await manage.post("/budgets/a/unfreeze");
  await pool.query("DELETE FROM sv_webhook_outbox");
});

test("self-hosted: webhooks are signed, and the signature verifies with the secret shown once", async () => {
  process.env.SPENDVETO_DEPLOYMENT = "self_hosted";
  const set = await admin.put("/tenant/webhook", { url: receiverUrl(), rotate_secret: true });
  const secret = set.body.webhook_secret;
  assert.match(secret, /^whsec_/);
  const tenant = await read.get("/tenant");
  assert.equal(tenant.body.tenant.webhook_configured, true);
  assert.ok(!JSON.stringify(tenant.body).includes(secret), "the secret is never read back");
  assert.ok(!JSON.stringify(tenant.body).includes("/hooks"), "only the host is read back");

  await manage.put("/budgets/ap", { approval_above_micros: 0 });
  const a = await spend.post("/authorize", { budget: "ap", estimate_micros: usd(3), model: "m" });
  received = [];
  await deliverDue(pool);
  const hook = received.find((r) => r.headers["spendveto-event"] === "approval.requested");
  assert.ok(hook, "approval.requested delivered");
  const [, ts, sig] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hook.headers["spendveto-signature"]);
  assert.equal(sig, createHmac("sha256", secret).update(`${ts}.${hook.body}`).digest("hex"));
  const payload = JSON.parse(hook.body);
  assert.equal(payload.approval_id, a.body.approval_id);
  assert.equal(payload.estimate_micros, usd(3));

  await approve.post(`/approvals/${a.body.approval_id}/decide`, { decision: "approve" });
  received = [];
  await deliverDue(pool);
  const decided = received.find((r) => r.headers["spendveto-event"] === "approval.decided");
  assert.equal(JSON.parse(decided.body).status, "approved");
});

test("a failing receiver is retried with backoff, then marked failed — never silently dropped", async () => {
  receiverStatus = 500;
  await manage.post("/budgets/ap/freeze", {});
  received = [];
  await deliverDue(pool);
  assert.equal(received.length, 1);
  const { rows } = await pool.query("SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM sv_webhook_outbox ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /HTTP 500/);
  assert.equal(rows[0].later, true, "not retried immediately");
  // Force the remaining attempts to be due.
  for (let i = 0; i < 6; i++) {
    await pool.query("UPDATE sv_webhook_outbox SET next_attempt_at = now() WHERE status = 'pending'");
    await deliverDue(pool);
  }
  const { rows: final } = await pool.query("SELECT status, attempts FROM sv_webhook_outbox ORDER BY id DESC LIMIT 1");
  assert.equal(final[0].status, "failed");
  assert.equal(final[0].attempts, 6);
  receiverStatus = 200;
});

test("budget thresholds alert once each at 50/80/100% of committed spend", async () => {
  await manage.put("/budgets/th", { cap_micros: usd(10) });
  await pool.query("DELETE FROM sv_webhook_outbox");
  for (const d of [4, 1.5, 2.5, 1, 1]) await spend.post("/authorize", { budget: "th", estimate_micros: usd(d) });
  const { rows } = await pool.query("SELECT payload->>'threshold_pct' AS pct FROM sv_webhook_outbox WHERE event_type = 'budget.threshold' AND payload->>'budget' = 'th' ORDER BY id");
  assert.deepEqual(rows.map((r) => Number(r.pct)), [50, 80, 100]);
});

test("removing the webhook clears the secret and stops new outbox rows", async () => {
  await admin.put("/tenant/webhook", { url: null });
  await pool.query("DELETE FROM sv_webhook_outbox");
  await manage.post("/budgets/th/freeze", {});
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM sv_webhook_outbox");
  assert.equal(rows[0].n, 0);
  const { rows: tr } = await pool.query("SELECT webhook_secret FROM sv_tenants WHERE id = $1", [t.id]);
  assert.equal(tr[0].webhook_secret, null);
});
