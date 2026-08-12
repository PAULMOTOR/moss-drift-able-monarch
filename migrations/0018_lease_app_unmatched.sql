-- Parsed identity + full body so unmatched TAdvantage financing forms can retry
ALTER TABLE email_imports ADD COLUMN IF NOT EXISTS parsed_name text;
ALTER TABLE email_imports ADD COLUMN IF NOT EXISTS parsed_email text;
ALTER TABLE email_imports ADD COLUMN IF NOT EXISTS parsed_phone text;
ALTER TABLE email_imports ADD COLUMN IF NOT EXISTS parsed_company text;
ALTER TABLE email_imports ADD COLUMN IF NOT EXISTS raw_body text;

CREATE INDEX IF NOT EXISTS email_imports_unmatched_idx
  ON email_imports (status, created_at DESC)
  WHERE status = 'skipped';
