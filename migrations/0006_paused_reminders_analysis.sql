-- Paused stage, contact appointments, reminder outbox

DO $$
DECLARE r record;
BEGIN
  FOR r IN (
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'leads'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%stage%'
  ) LOOP
    EXECUTE format('ALTER TABLE leads DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- stage check may not exist as named constraint; columns only
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pause_until timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pause_note text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage_before_pause text;

CREATE TABLE IF NOT EXISTS lead_appointments (
  id text PRIMARY KEY,
  lead_id text NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  profile_id text REFERENCES profiles(id) ON DELETE SET NULL,
  scheduled_at timestamptz NOT NULL,
  kind text NOT NULL DEFAULT 'contact',
  note text,
  status text NOT NULL DEFAULT 'scheduled',
  created_by text REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_appointments_sched_idx
  ON lead_appointments (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS lead_appointments_lead_idx ON lead_appointments (lead_id);

CREATE TABLE IF NOT EXISTS email_outbox (
  id text PRIMARY KEY,
  to_email text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  kind text,
  related_lead_id text,
  related_profile_id text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS email_outbox_status_idx ON email_outbox (status, created_at DESC);

CREATE TABLE IF NOT EXISTS reminder_sends (
  id text PRIMARY KEY,
  kind text NOT NULL,
  profile_id text,
  lead_id text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  meta text
);

CREATE INDEX IF NOT EXISTS reminder_sends_kind_idx ON reminder_sends (kind, sent_at DESC);
CREATE INDEX IF NOT EXISTS leads_pause_until_idx ON leads (pause_until) WHERE pause_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_email_portal_idx ON leads (email_portal);
