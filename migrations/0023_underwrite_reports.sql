-- AI / policy underwrite runs on the Approval tab
CREATE TABLE IF NOT EXISTS underwrite_reports (
  id text PRIMARY KEY,
  lead_id text NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  application_id text REFERENCES credit_applications(id) ON DELETE SET NULL,
  ran_by text REFERENCES profiles(id) ON DELETE SET NULL,
  ran_by_name text,
  recommendation text NOT NULL,
  summary text NOT NULL DEFAULT '',
  conditions_json jsonb NOT NULL DEFAULT '[]',
  red_flags_json jsonb NOT NULL DEFAULT '[]',
  policy_json jsonb NOT NULL DEFAULT '{}',
  inputs_json jsonb NOT NULL DEFAULT '{}',
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS underwrite_reports_lead_idx
  ON underwrite_reports (lead_id, created_at DESC);

INSERT INTO crm_settings (key, value, updated_at)
VALUES ('boc_prime_rate', '4.95', now())
ON CONFLICT (key) DO NOTHING;
