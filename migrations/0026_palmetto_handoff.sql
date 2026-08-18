-- Palmetto site → CRM lease Apply (server-to-server). Idempotent on referenceId.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS leads_external_ref_uidx
  ON leads (external_ref)
  WHERE external_ref IS NOT NULL AND btrim(external_ref) <> '';
