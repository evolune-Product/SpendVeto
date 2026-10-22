-- SpendVeto Governance API — initial schema.
--
-- Every table is prefixed sv_ so the schema can share a database with
-- something else without colliding, though a dedicated database is the
-- recommended deployment. Money is integer micro-USD (1 USD = 1,000,000) in
-- BIGINT everywhere: no floats anywhere on the money path.

CREATE TABLE sv_tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  webhook_url     text,
  -- Must be stored recoverably: it is the HMAC key we sign deliveries with.
  webhook_secret  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sv_api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES sv_tenants(id) ON DELETE CASCADE,
  -- SHA-256 of the full key. Keys carry 192 bits of entropy, so a plain hash
  -- is sufficient; the raw key is shown once at creation and never stored.
  key_hash    char(64) NOT NULL UNIQUE,
  key_prefix  text NOT NULL,
  scopes      text[] NOT NULL,
  label       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CONSTRAINT sv_api_keys_scopes_valid CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['spend','approve','approve_as','manage','read','admin']::text[]
  )
);

CREATE TABLE sv_budgets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES sv_tenants(id) ON DELETE CASCADE,
  external_id           text NOT NULL,
  parent_id             uuid,
  kind                  text NOT NULL DEFAULT 'scope',
  label                 text NOT NULL DEFAULT '',
  cap_micros            bigint CHECK (cap_micros IS NULL OR cap_micros >= 0),
  period                text NOT NULL DEFAULT 'month'
                        CHECK (period IN ('total','hour','day','week','month')),
  per_call_max_micros   bigint CHECK (per_call_max_micros IS NULL OR per_call_max_micros >= 0),
  approval_above_micros bigint CHECK (approval_above_micros IS NULL OR approval_above_micros >= 0),
  approvals_required    int NOT NULL DEFAULT 1 CHECK (approvals_required BETWEEN 1 AND 10),
  max_calls_per_period  int CHECK (max_calls_per_period IS NULL OR max_calls_per_period > 0),
  burst_per_minute      int CHECK (burst_per_minute IS NULL OR burst_per_minute > 0),
  frozen_at             timestamptz,
  frozen_reason         text,
  frozen_source         text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sv_budgets_external_unique UNIQUE (tenant_id, external_id),
  CONSTRAINT sv_budgets_tenant_id_unique UNIQUE (tenant_id, id),
  -- Composite FK: a parent can only ever be a budget of the SAME tenant. This
  -- is enforced by the database, not only by the application code.
  CONSTRAINT sv_budgets_parent_same_tenant
    FOREIGN KEY (tenant_id, parent_id) REFERENCES sv_budgets (tenant_id, id),
  CONSTRAINT sv_budgets_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX sv_budgets_parent_idx ON sv_budgets (tenant_id, parent_id);

-- One row per (budget, window). For period='total' the window starts at the
-- epoch. spent = settled actuals; reserved = authorized but not yet settled.
CREATE TABLE sv_budget_windows (
  budget_id        uuid NOT NULL REFERENCES sv_budgets(id) ON DELETE CASCADE,
  window_start     timestamptz NOT NULL,
  spent_micros     bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  reserved_micros  bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  calls            int NOT NULL DEFAULT 0 CHECK (calls >= 0),
  alerted_pct      int NOT NULL DEFAULT 0,
  PRIMARY KEY (budget_id, window_start)
);

-- Attempts per budget per minute, for runaway (burst) detection.
CREATE TABLE sv_burst_counters (
  budget_id     uuid NOT NULL REFERENCES sv_budgets(id) ON DELETE CASCADE,
  minute_start  timestamptz NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  PRIMARY KEY (budget_id, minute_start)
);

CREATE TABLE sv_reservations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES sv_tenants(id) ON DELETE CASCADE,
  budget_id        uuid NOT NULL,
  idempotency_key  text,
  request_hash     char(64) NOT NULL,
  status           text NOT NULL
                   CHECK (status IN ('held','pending_approval','settled','voided','expired','denied')),
  decision         text NOT NULL CHECK (decision IN ('allow','deny','needs_approval')),
  deny_code        text,
  deny_reason      text,
  deny_suggestion  text,
  deny_budget      text,
  estimate_micros  bigint NOT NULL CHECK (estimate_micros >= 0),
  actual_micros    bigint CHECK (actual_micros IS NULL OR actual_micros >= 0),
  holds            jsonb NOT NULL DEFAULT '[]'::jsonb,
  operation        text,
  provider         text,
  model            text,
  input_tokens     int,
  output_tokens    int,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_id      uuid,
  -- The key that requested the spend. That key may never approve it.
  created_by_key   uuid,
  ttl_seconds      int NOT NULL,
  expires_at       timestamptz,
  late_settle      boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL,
  resolved_at      timestamptz,
  CONSTRAINT sv_reservations_idem_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT sv_reservations_budget_same_tenant
    FOREIGN KEY (tenant_id, budget_id) REFERENCES sv_budgets (tenant_id, id)
);
CREATE INDEX sv_reservations_expiry_idx ON sv_reservations (status, expires_at)
  WHERE status IN ('held','pending_approval');
CREATE INDEX sv_reservations_budget_idx ON sv_reservations (tenant_id, budget_id, created_at DESC);
CREATE INDEX sv_reservations_resolved_idx ON sv_reservations (tenant_id, status, resolved_at);

CREATE TABLE sv_approvals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES sv_tenants(id) ON DELETE CASCADE,
  reservation_id      uuid NOT NULL REFERENCES sv_reservations(id) ON DELETE CASCADE,
  status              text NOT NULL
                      CHECK (status IN ('pending','approved','denied','expired','cancelled')),
  required_approvals  int NOT NULL CHECK (required_approvals BETWEEN 1 AND 10),
  approvers           jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_reason      text,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL,
  decided_at          timestamptz
);
CREATE INDEX sv_approvals_pending_idx ON sv_approvals (tenant_id, status, created_at DESC);

-- Hash-chained, append-only audit log, one chain per tenant.
CREATE TABLE sv_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES sv_tenants(id),
  seq             bigint NOT NULL,
  type            text NOT NULL,
  reservation_id  uuid,
  budget_id       uuid,
  amount_micros   bigint,
  actor           text,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL,
  prev_hash       char(64) NOT NULL,
  entry_hash      char(64) NOT NULL,
  CONSTRAINT sv_events_seq_unique UNIQUE (tenant_id, seq)
);

-- The database itself refuses to rewrite history. The hash chain still
-- detects tampering by anyone able to disable this trigger (a superuser);
-- the trigger stops everyone else, including a bug in this service.
CREATE FUNCTION sv_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sv_events is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sv_events_no_update_delete
  BEFORE UPDATE OR DELETE ON sv_events
  FOR EACH ROW EXECUTE FUNCTION sv_events_append_only();

-- Transactional outbox: a webhook is enqueued in the same transaction as the
-- state change it describes, so a crash can never lose one or invent one.
CREATE TABLE sv_webhook_outbox (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES sv_tenants(id) ON DELETE CASCADE,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX sv_webhook_outbox_due_idx ON sv_webhook_outbox (next_attempt_at) WHERE status = 'pending';
