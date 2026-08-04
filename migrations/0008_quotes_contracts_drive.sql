-- Multi-quote versions, Drive folder, contract templates; retire test_drive stage usage

-- Migrate any test_drive leads forward (feature removed)
UPDATE leads SET stage = 'quote_sent', stage_entered_at = now()
WHERE stage = 'test_drive';

ALTER TABLE leads ADD COLUMN IF NOT EXISTS guarantor text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS drive_folder_id text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS drive_folder_url text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS accepted_quote_id text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS legal_entity_name text;

-- Enrich lease_quotes for reopen / accept / PDF instances
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS accepted_option int;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS pdf_name text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS pdf_data text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS retail_html text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS contract_html text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS invoice_html text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS drive_file_id text;
ALTER TABLE lease_quotes ADD COLUMN IF NOT EXISTS drive_file_url text;

-- Multiple quote PDF attachments on a lead (saved CRM quotes + manual uploads)
CREATE TABLE IF NOT EXISTS lead_quote_files (
  id text PRIMARY KEY,
  lead_id text NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  quote_id text REFERENCES lease_quotes(id) ON DELETE SET NULL,
  option_number int,
  file_name text NOT NULL,
  file_data text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/pdf',
  source text NOT NULL DEFAULT 'upload',
  created_by text REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_quote_files_lead_idx ON lead_quote_files (lead_id);

-- Editable lease contract templates (6 styles)
CREATE TABLE IF NOT EXISTS contract_templates (
  id text PRIMARY KEY,
  style_key text NOT NULL UNIQUE,
  label text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  jurisdiction text NOT NULL DEFAULT 'QC',
  party_type text NOT NULL DEFAULT 'individual',
  body_html text NOT NULL,
  updated_by text REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
