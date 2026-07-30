-- General Interest lead type + Gmail import tracking

-- Drop any existing lead_type check constraints (name varies by PG version)
DO $$
DECLARE r record;
BEGIN
  FOR r IN (
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'leads'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%lead_type%'
  ) LOOP
    EXECUTE format('ALTER TABLE leads DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE leads ADD CONSTRAINT leads_lead_type_check
  CHECK (lead_type IN ('inventory', 'lease', 'general'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_portal text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gmail_message_id text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gmail_thread_id text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_gmail_message_id_uidx
  ON leads (gmail_message_id) WHERE gmail_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_imports (
  id text PRIMARY KEY,
  gmail_message_id text NOT NULL UNIQUE,
  gmail_thread_id text,
  from_address text,
  subject text,
  received_at timestamptz,
  lead_id text REFERENCES leads(id) ON DELETE SET NULL,
  status text NOT NULL,
  reason text,
  lead_type text,
  portal text,
  raw_snippet text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_imports_created_idx ON email_imports (created_at DESC);
CREATE INDEX IF NOT EXISTS email_imports_status_idx ON email_imports (status);

CREATE TABLE IF NOT EXISTS crm_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
