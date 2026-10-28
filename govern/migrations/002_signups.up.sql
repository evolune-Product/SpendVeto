-- Self-serve signup: an email asks for an account, a one-time link proves it
-- owns the address, and verifying creates the tenant and its first admin key.
--
-- The link's token is stored as its SHA-256, never as itself. One row per
-- email: asking again replaces the pending token. Once verified, the email
-- holds its tenant for good — a second signup never creates a second tenant.
CREATE TABLE sv_signups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  org_name      text NOT NULL,
  token_hash    char(64) UNIQUE,
  expires_at    timestamptz,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  requests      integer NOT NULL DEFAULT 1,
  verified_at   timestamptz,
  tenant_id     uuid REFERENCES sv_tenants(id) ON DELETE SET NULL,
  CONSTRAINT sv_signups_verified_has_tenant CHECK (verified_at IS NULL OR tenant_id IS NOT NULL)
);
