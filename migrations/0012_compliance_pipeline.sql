-- Compliance pipeline checklist (post GSM/Admin approval)

CREATE TABLE IF NOT EXISTS compliance_checklist (
  id text PRIMARY KEY,
  lead_id text NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  item_key text NOT NULL,
  label text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  meta text NOT NULL DEFAULT '',
  file_name text,
  file_data text,
  mime_type text,
  filled_by text REFERENCES profiles (id) ON DELETE SET NULL,
  filled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, item_key)
);

CREATE INDEX IF NOT EXISTS compliance_checklist_lead_idx ON compliance_checklist (lead_id);
CREATE INDEX IF NOT EXISTS compliance_checklist_done_idx ON compliance_checklist (lead_id, done);

-- Allow lease_accepted stage (and keep existing stage values free-form if check existed)
DO $$
BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_stage_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
