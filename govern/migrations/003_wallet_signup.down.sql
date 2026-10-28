DROP INDEX IF EXISTS sv_tenants_owner_wallet;
ALTER TABLE sv_tenants DROP COLUMN IF EXISTS owner_wallet;
ALTER TABLE sv_signups DROP COLUMN IF EXISTS wallet_address;
DROP TABLE IF EXISTS sv_wallet_challenges;
