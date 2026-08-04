-- Lease quotes generated from Paul Motor spreadsheet engine
CREATE TABLE IF NOT EXISTS lease_quotes (
  id text PRIMARY KEY,
  lead_id text REFERENCES leads(id) ON DELETE SET NULL,
  created_by text REFERENCES profiles(id) ON DELETE SET NULL,
  client_name text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}',
  retail_html text,
  selected_option int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lease_quotes_lead_idx ON lease_quotes (lead_id);
CREATE INDEX IF NOT EXISTS lease_quotes_created_idx ON lease_quotes (created_at DESC);
