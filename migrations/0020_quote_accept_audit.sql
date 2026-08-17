-- Lessee quote acceptance: token link + audit (who, when, IP, exact option).
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS accept_token text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS accept_option_invited int;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS accepted_ip text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS accepted_user_agent text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS accepted_by_kind text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS accepted_snapshot text;

CREATE UNIQUE INDEX IF NOT EXISTS lease_quotes_accept_token_uidx
  ON lease_quotes (accept_token)
  WHERE accept_token IS NOT NULL;
