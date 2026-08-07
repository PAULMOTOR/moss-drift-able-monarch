-- New roles: compliance, accounting, service
-- Profile avatars, RBAC toggles, liens, service module

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'admin', 'rep', 'broker', 'gsm', 'credit_manager',
    'compliance', 'accounting', 'service'
  ));

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url text;

CREATE TABLE IF NOT EXISTS role_permissions (
  role text NOT NULL,
  permission_key text NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES profiles (id) ON DELETE SET NULL,
  PRIMARY KEY (role, permission_key)
);

CREATE TABLE IF NOT EXISTS vehicle_liens (
  id text PRIMARY KEY,
  lead_id text REFERENCES leads (id) ON DELETE SET NULL,
  inventory_id text REFERENCES inventory (id) ON DELETE SET NULL,
  vin text,
  vehicle_label text,
  lienholder text,
  registration_province text,
  registered_at date,
  registration_ref text,
  notes text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'registered', 'released', 'n_a')),
  signed_lease_at timestamptz,
  created_by text REFERENCES profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_liens_status_idx ON vehicle_liens (status, signed_lease_at);
CREATE INDEX IF NOT EXISTS vehicle_liens_lead_idx ON vehicle_liens (lead_id);
CREATE INDEX IF NOT EXISTS vehicle_liens_vin_idx ON vehicle_liens (vin);

CREATE TABLE IF NOT EXISTS ownership_tracking (
  id text PRIMARY KEY,
  lead_id text NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  vin text,
  vehicle_label text,
  signed_at timestamptz,
  ownership_uploaded boolean NOT NULL DEFAULT false,
  ownership_file_name text,
  ownership_file_data text,
  ownership_uploaded_at timestamptz,
  title_emailed_at timestamptz,
  title_emailed_to text,
  title_bank text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id)
);

CREATE INDEX IF NOT EXISTS ownership_tracking_missing_idx
  ON ownership_tracking (ownership_uploaded, signed_at);

CREATE TABLE IF NOT EXISTS service_work_orders (
  id text PRIMARY KEY,
  wo_number text NOT NULL,
  inventory_id text REFERENCES inventory (id) ON DELETE SET NULL,
  vin text,
  vehicle_label text,
  customer_name text,
  customer_email text,
  customer_phone text,
  lead_id text REFERENCES leads (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'estimate', 'pending_approval', 'approved', 'in_progress',
      'parts_ordered', 'completed', 'invoiced', 'cancelled'
    )),
  description text,
  bay text,
  assigned_to text REFERENCES profiles (id) ON DELETE SET NULL,
  created_by text REFERENCES profiles (id) ON DELETE SET NULL,
  scheduled_at timestamptz,
  completed_at timestamptz,
  labor_hours numeric,
  parts_total numeric,
  labor_total numeric,
  tax_total numeric,
  grand_total numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_wo_status_idx ON service_work_orders (status, updated_at);
CREATE INDEX IF NOT EXISTS service_wo_vin_idx ON service_work_orders (vin);
CREATE INDEX IF NOT EXISTS service_wo_inventory_idx ON service_work_orders (inventory_id);

CREATE TABLE IF NOT EXISTS service_estimates (
  id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES service_work_orders (id) ON DELETE CASCADE,
  version int NOT NULL DEFAULT 1,
  line_items_json text NOT NULL DEFAULT '[]',
  subtotal numeric,
  tax numeric,
  total numeric,
  notes text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'sent_internal', 'internal_approved', 'sent_customer',
      'customer_approved', 'customer_declined', 'superseded'
    )),
  internal_approved_by text REFERENCES profiles (id) ON DELETE SET NULL,
  internal_approved_at timestamptz,
  customer_token text,
  customer_approved_at timestamptz,
  customer_declined_at timestamptz,
  customer_note text,
  sent_to_email text,
  created_by text REFERENCES profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_estimates_wo_idx ON service_estimates (work_order_id);
CREATE INDEX IF NOT EXISTS service_estimates_token_idx ON service_estimates (customer_token);

CREATE TABLE IF NOT EXISTS service_inspections (
  id text PRIMARY KEY,
  inventory_id text REFERENCES inventory (id) ON DELETE SET NULL,
  vin text NOT NULL,
  vehicle_label text,
  work_order_id text REFERENCES service_work_orders (id) ON DELETE SET NULL,
  inspector_id text REFERENCES profiles (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  odometer int,
  findings_json text NOT NULL DEFAULT '[]',
  notes text,
  vin_photo_name text,
  vin_photo_data text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_inspections_vin_idx ON service_inspections (vin);
CREATE INDEX IF NOT EXISTS service_inspections_inventory_idx ON service_inspections (inventory_id);
