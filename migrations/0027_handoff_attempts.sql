ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS leads_external_ref_uidx
  ON leads (external_ref)
  WHERE external_ref IS NOT NULL AND btrim(external_ref) <> '';

CREATE TABLE IF NOT EXISTS handoff_attempts (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  status int NOT NULL,
  reference_id text,
  name text,
  error text
);
