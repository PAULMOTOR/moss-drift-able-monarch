-- Credit underwriting, new roles (GSM / Credit Manager), client name/party type

-- Expand profile roles
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'rep', 'broker', 'gsm', 'credit_manager'));

-- Lead client identity
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS party_type text DEFAULT 'individual';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS credit_status text DEFAULT 'none';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS credit_app_id text;

-- Expand stage check if present (best-effort; some DBs use loose stage)
DO $$
BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_stage_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Credit application (one active app per lead typically)
CREATE TABLE IF NOT EXISTS credit_applications (
  id text PRIMARY KEY,
  lead_id text NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'app_requested', 'app_in_progress', 'app_submitted',
      'ids_uploaded', 'credit_requested', 'in_review',
      'pending_gsm', 'approved', 'declined', 'cancelled'
    )),
  party_type text NOT NULL DEFAULT 'individual'
    CHECK (party_type IN ('individual', 'business')),
  -- Individual fields (JSON blob for flexibility + structured columns for search)
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Access / workflow
  public_token text UNIQUE,
  doc_request_token text UNIQUE,
  app_email text,
  requested_by text REFERENCES profiles (id) ON DELETE SET NULL,
  submitted_at timestamptz,
  credit_requested_at timestamptz,
  credit_requested_by text REFERENCES profiles (id) ON DELETE SET NULL,
  credit_request_notes text,
  do_not_pull_credit boolean NOT NULL DEFAULT false,
  equifax_file_name text,
  equifax_file_data text,
  equifax_notes text,
  gsm_requested_at timestamptz,
  gsm_requested_by text REFERENCES profiles (id) ON DELETE SET NULL,
  approved_by text REFERENCES profiles (id) ON DELETE SET NULL,
  approved_at timestamptz,
  approval_notes text,
  -- Checklist completion flags
  vehicle_checklist_complete boolean NOT NULL DEFAULT false,
  customer_checklist_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_apps_lead_idx ON credit_applications (lead_id);
CREATE INDEX IF NOT EXISTS credit_apps_status_idx ON credit_applications (status);
CREATE INDEX IF NOT EXISTS credit_apps_token_idx ON credit_applications (public_token);

-- Uploaded docs (IDs, NOAs, bank statements, equifax, etc.)
CREATE TABLE IF NOT EXISTS credit_documents (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES credit_applications (id) ON DELETE CASCADE,
  lead_id text NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN (
      'dl_front', 'dl_back', 'id_second', 'noa_payslip', 'bank_statement',
      'equifax', 'other'
    )),
  file_name text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  file_data text NOT NULL,
  uploaded_by text,
  uploaded_via text NOT NULL DEFAULT 'crm'
    CHECK (uploaded_via IN ('crm', 'lessee_app', 'lessee_doc_link')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_docs_app_idx ON credit_documents (application_id);
CREATE INDEX IF NOT EXISTS credit_docs_lead_idx ON credit_documents (lead_id);

-- Deal pre-approval checklist items
CREATE TABLE IF NOT EXISTS credit_checklist (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES credit_applications (id) ON DELETE CASCADE,
  section text NOT NULL CHECK (section IN ('vehicle', 'customer')),
  item_key text NOT NULL,
  label text NOT NULL,
  notes text NOT NULL DEFAULT '',
  done boolean NOT NULL DEFAULT false,
  filled_by text REFERENCES profiles (id) ON DELETE SET NULL,
  filled_at timestamptz,
  UNIQUE (application_id, item_key)
);

CREATE INDEX IF NOT EXISTS credit_checklist_app_idx ON credit_checklist (application_id);

-- Backfill party_type from name heuristics is skipped; app defaults individual
UPDATE leads SET party_type = 'individual' WHERE party_type IS NULL;
UPDATE leads SET credit_status = 'none' WHERE credit_status IS NULL;

-- Split existing name into first/last where empty
UPDATE leads SET
  first_name = COALESCE(NULLIF(first_name, ''), split_part(trim(name), ' ', 1)),
  last_name = COALESCE(
    NULLIF(last_name, ''),
    NULLIF(trim(substring(trim(name) from position(' ' in trim(name) || ' '))), ''),
    ''
  )
WHERE first_name IS NULL OR last_name IS NULL;
