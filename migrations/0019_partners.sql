-- Selling dealers, lease brokers, and other referrers (origin of the deal).
CREATE TABLE IF NOT EXISTS partners (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'dealer'
    CHECK (kind IN ('dealer', 'broker', 'referrer')),
  city text,
  province text,
  email text,
  phone text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS partners_name_lower_uidx ON partners (lower(btrim(name)));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_id text REFERENCES partners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS leads_partner_idx ON leads (partner_id);

INSERT INTO partners (id, name, kind, city, province, notes)
VALUES
  (
    'partner-ferrari-alberta',
    'Ferrari of Alberta',
    'dealer',
    'Calgary',
    'AB',
    'Referring / selling dealer'
  ),
  (
    'partner-marianetti',
    'Marianetti Motors',
    'dealer',
    NULL,
    NULL,
    'Referring / selling dealer'
  ),
  (
    'partner-lease-sniper',
    'Lease Sniper',
    'broker',
    NULL,
    NULL,
    'Lease broker'
  )
ON CONFLICT (id) DO NOTHING;
