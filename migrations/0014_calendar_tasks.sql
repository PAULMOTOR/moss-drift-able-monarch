-- Team calendar + personal tasks

CREATE TABLE IF NOT EXISTS calendar_events (
  id text PRIMARY KEY,
  title text NOT NULL,
  event_type text NOT NULL,
  domain text NOT NULL DEFAULT 'sales',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  location text,
  notes text,
  lead_id text REFERENCES leads (id) ON DELETE SET NULL,
  inventory_id text REFERENCES inventory (id) ON DELETE SET NULL,
  organizer_id text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'team'
    CHECK (visibility IN ('team', 'private')),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_events_starts_idx ON calendar_events (starts_at);
CREATE INDEX IF NOT EXISTS calendar_events_organizer_idx ON calendar_events (organizer_id);
CREATE INDEX IF NOT EXISTS calendar_events_lead_idx ON calendar_events (lead_id);
CREATE INDEX IF NOT EXISTS calendar_events_domain_idx ON calendar_events (domain, starts_at);

CREATE TABLE IF NOT EXISTS calendar_event_participants (
  event_id text NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, profile_id)
);

CREATE INDEX IF NOT EXISTS calendar_event_participants_profile_idx
  ON calendar_event_participants (profile_id);

CREATE TABLE IF NOT EXISTS crm_tasks (
  id text PRIMARY KEY,
  title text NOT NULL,
  task_type text NOT NULL DEFAULT 'follow_up',
  due_at timestamptz,
  due_date date,
  owner_id text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  lead_id text REFERENCES leads (id) ON DELETE SET NULL,
  notes text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done')),
  completed_at timestamptz,
  completed_by text REFERENCES profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_tasks_owner_status_idx ON crm_tasks (owner_id, status, due_date);
CREATE INDEX IF NOT EXISTS crm_tasks_lead_idx ON crm_tasks (lead_id);
