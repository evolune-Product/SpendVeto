# SpendVeto Governance API (`/v1`)

Reserve-then-settle spend control for AI agents' **API and LLM spend**, backed by
Postgres and safe to run as several processes. The caller makes the provider call
itself (its own keys, any provider); SpendVeto only decides whether the call may
happen and keeps the books.

```
authorize  →  (provider call, by the caller)  →  settle   (or void if unused)
reserve the worst case                           replace it with the actual
```

It is a separate service from the x402 server (`server/`, `proxy/`). It shares
no storage with them and changes nothing about how they behave.

## Run it

```bash
# Postgres 13+ (any). A dedicated database is recommended; tables are prefixed sv_.
export SPENDVETO_DATABASE_URL=postgres://spendveto:...@localhost:5432/spendveto

npm run govern:admin -- create-tenant --name "Acme"     # prints the first admin key (once)
npm run govern                                          # :8405, migrates on boot

# or, with Docker (opt-in profile; plain `docker compose up` is unchanged):
GOVERN_DB_PASSWORD=... docker compose --profile govern up -d
docker compose exec govern node govern/cli.js create-tenant --name "Acme"
```

Mint narrower keys with the admin key (`POST /v1/keys`) or on the host
(`npm run govern:admin -- mint-key --tenant <id> --scopes spend,read`).

## Model

- **Tenant**: everything is scoped to one. Another tenant's ids answer 404, never 403.
- **Budget**: a node in a tree (org → department → team → agent → …, max 16 levels),
  addressed by your own `external_id`. Every field is optional:

  | field | meaning |
  |---|---|
  | `cap_micros` + `period` | spend cap per calendar window in UTC: `hour` `day` `week` (ISO, Monday) `month` `total` |
  | `per_call_max_micros` | the most a single call may reserve |
  | `approval_above_micros` + `approvals_required` | above this, a human must approve (N distinct approvers) |
  | `max_calls_per_period` | call count cap per window |
  | `burst_per_minute` | more attempts than this in a minute auto-freezes the budget |

  **A call is checked against every budget from its leaf to the root.** A department
  cap binds every team and agent under it; freezing a node stops its whole subtree.
- **Money** is integer micro-USD (`1 USD = 1,000,000`) everywhere. Floats are rejected.

## Endpoints

| scope | method + path | |
|---|---|---|
| — | `GET /v1/health` | DB reachability |
| spend | `POST /v1/authorize` | `{budget, estimate_micros, idempotency_key?, operation?, provider?, model?, metadata?, ttl_seconds=900, approval_ttl_seconds=3600}` → **201** allow · **202** needs_approval · **403** deny |
| spend | `POST /v1/reservations/:id/settle` | `{actual_micros, input_tokens?, output_tokens?, metadata?}` |
| spend | `POST /v1/reservations/:id/void` | release an unused reservation |
| read, spend | `GET /v1/reservations/:id` | |
| read | `GET /v1/reservations?status=&budget=&before=&limit=` | |
| read, approve | `GET /v1/approvals?status=pending` | |
| read, approve, spend | `GET /v1/approvals/:id` | |
| approve | `POST /v1/approvals/:id/decide` | `{decision: approve\|deny, actor?, reason?}` |
| manage | `PUT /v1/budgets/:external_id` | upsert; omitted fields keep their value, `null` clears |
| manage | `POST /v1/budgets/sync` | `{budgets:[{budget, parent, ...}]}`, ≤500, one transaction, parents first |
| manage | `DELETE /v1/budgets/:external_id` | archive (spend refused; `PUT` restores) |
| manage | `POST /v1/budgets/:id/freeze` · `/unfreeze` | kill switch |
| read, spend | `GET /v1/budgets/:external_id` | current window usage for the budget and every ancestor |
| read | `GET /v1/budgets` | |
| read | `GET /v1/usage?from=&to=&budget=&include_descendants=&group_by=budget\|model\|provider\|operation\|day` | settled spend (chargeback) |
| read | `GET /v1/events?after_seq=` · `GET /v1/events/verify` | hash-chained audit log |
| read | `GET /v1/tenant` | |
| admin | `PUT /v1/tenant/webhook` | `{url\|null, rotate_secret?}` → secret shown once |
| admin | `POST/GET /v1/keys`, `DELETE /v1/keys/:id` | |
| operator | `POST /v1/operator/tenants`, `POST /v1/operator/tenants/:id/keys` | only when `SPENDVETO_OPERATOR_KEY` is set |

Every refusal carries a machine `code`, a human `reason`, a `suggestion` the agent can
act on, and the `budget` that refused: `budget_cap`, `per_call_cap`, `call_limit`,
`budget_frozen`, `burst_frozen`, `budget_archived`, `approval_denied`.

**Scopes.** `spend` · `approve` · `approve_as` · `manage` · `read` · `admin` (= all).
Give the agent runtime a `spend` key and keep approval for the human-facing path.

- A plain `approve` key always votes **as itself**, one vote per key, so an
  N-approver rule needs N keys.
- `approve_as` lets a trusted service, one that authenticates its own users, vote on
  behalf of a named `actor`. Each actor counts once.
- **The key that requested a spend can never approve it**, whatever its scopes. That
  includes an `admin` key.
- An approval re-checks the budget tree before releasing anything. A budget frozen or
  archived while the request waited stays refused.

## Guarantees, and how they are tested

`npm run test:govern` (needs `GOVERN_TEST_DATABASE_URL` pointing at a disposable
database whose name contains `test`; the suite drops and recreates its tables):

- **Caps hold under concurrency across processes.** 200 concurrent requests split
  across two separate server processes against a $50 cap: exactly 50 pass. Shared
  parent caps hold the same way. Row locks in Postgres, taken in a fixed order,
  not a process-local mutex.
- **Idempotency.** One key fired 40× at two processes reserves once; a reused key
  with a different body is a 409; settle is idempotent for the same amount.
- **Fails closed.** Database unreachable, or a lock not granted within
  `lock_timeout`: **503 `governance_unavailable`**. Unanswered approvals and
  unsettled reservations expire and release their holds.
- **Tenant isolation**, checked in the database too: a budget's parent must belong
  to the same tenant (composite foreign key).
- **Audit log**: append-only enforced by a trigger; tampering by anyone able to
  bypass the trigger is detected by the hash chain at the exact entry.
- **Webhooks**: transactional outbox, HMAC-signed, retried with backoff, SSRF-guarded
  on the resolved address at connect time (cloud mode).
- **Migrations** reverse cleanly (up → down → up).
- The Python SDK (`sdk-python/spendveto/govern.py`) runs its own end-to-end tests
  against a live server as part of the suite.

These are **not** part of the published `npm run verify` count. They need Postgres,
and a fresh clone without it must still reproduce the published number (the same
reason the sanctions tests are separate).

## Limits worth knowing

- **Metered at the caller's prices.** SpendVeto books the `actual_micros` the caller
  reports; it does not read provider invoices. An actual above the estimate is
  booked anyway (the money was spent) and flagged `over_estimate`.
- **With `approve_as`, approver identity is asserted by the calling service.** Grant
  that scope only to a service that authenticates its humans. Plain `approve` keys
  cannot name an actor at all.
- **Unapproved spend is never booked.** A settle against a reservation whose approval
  never came is refused (409 `approval_not_granted`), and the attempt is written to
  the audit log.
- **The Python client never releases a hold on an exception.** It cannot know whether
  the provider already charged, so the hold expires instead (a late settle is still
  accepted). Call `spend.void()` when you know nothing was spent.
- **Per-key rate limiting is per process**, and unauthenticated requests are not rate
  limited. Do not expose `:8405` to the internet without a reverse proxy in front.
- **USD only** for now.
- No external security audit.
