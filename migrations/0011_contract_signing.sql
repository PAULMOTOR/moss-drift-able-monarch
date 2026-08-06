-- Lease contracts generated after GSM approval + DocuSign envelope tracking

ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS contract_pdf_name text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS contract_pdf_data text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS contract_style text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS contract_generated_at timestamptz;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS contract_generated_by text;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS contract_status text DEFAULT 'none';
-- none | ready | sent_docusign | signed | voided

CREATE TABLE IF NOT EXISTS contract_envelopes (
  id text PRIMARY KEY,
  lead_id text NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  quote_id text REFERENCES lease_quotes (id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'docusign',
  envelope_id text,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN (
      'created', 'sent', 'delivered', 'completed', 'declined', 'voided', 'error'
    )),
  signer_email text,
  signer_name text,
  guarantor_email text,
  guarantor_name text,
  idv_enabled boolean NOT NULL DEFAULT false,
  envelope_uri text,
  error text,
  created_by text REFERENCES profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS contract_envelopes_lead_idx ON contract_envelopes (lead_id);
CREATE INDEX IF NOT EXISTS contract_envelopes_env_idx ON contract_envelopes (envelope_id);
