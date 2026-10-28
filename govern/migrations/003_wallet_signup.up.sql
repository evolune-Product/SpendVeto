-- Wallet-first signup: a browser wallet signs a challenge this service wrote
-- (Sign-In with Ethereum, EIP-4361), then the email link finishes the signup
-- as before. The tenant records the wallet that proved it was there.
--
-- A challenge is single-use: redeeming it deletes the row, in the same
-- transaction as the signup it belongs to. Addresses are stored lowercase.
CREATE TABLE sv_wallet_challenges (
  nonce       text PRIMARY KEY,
  address     text NOT NULL CHECK (address = lower(address)),
  message     text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sv_wallet_challenges_expiry ON sv_wallet_challenges (expires_at);

ALTER TABLE sv_signups ADD COLUMN wallet_address text CHECK (wallet_address = lower(wallet_address));

-- One account per wallet, like one per email.
ALTER TABLE sv_tenants ADD COLUMN owner_wallet text CHECK (owner_wallet = lower(owner_wallet));
CREATE UNIQUE INDEX sv_tenants_owner_wallet ON sv_tenants (owner_wallet) WHERE owner_wallet IS NOT NULL;
