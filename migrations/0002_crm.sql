-- Paul Motor Company CRM — luxury & exotic vehicle leasing / sales (Montréal)

create table if not exists profiles (
  id text primary key,
  user_id text unique,
  email text not null unique,
  name text not null,
  role text not null check (role in ('admin', 'rep', 'broker')),
  active boolean not null default true,
  phone text,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on profiles (role);
create index if not exists profiles_user_id_idx on profiles (user_id);

create table if not exists inventory (
  id text primary key,
  year int not null,
  make text not null,
  model text not null,
  trim text,
  vin text,
  stock_number text,
  price numeric,
  mileage int,
  exterior_color text,
  interior_color text,
  body_type text,
  transmission text,
  fuel_type text,
  status text not null default 'available'
    check (status in ('available', 'reserved', 'sold', 'incoming')),
  source text not null default 'manual'
    check (source in ('manual', 'website', 'autotrader')),
  external_url text,
  image_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_make_model_idx on inventory (make, model);
create index if not exists inventory_status_idx on inventory (status);

create table if not exists leads (
  id text primary key,
  name text not null,
  phone text,
  email text,
  source text not null default 'phone'
    check (source in ('phone', 'walk_in', 'email', 'broker', 'other', 'web')),
  notes text,
  vehicle_interest text,
  inventory_id text references inventory (id) on delete set null,
  assigned_to text references profiles (id) on delete set null,
  stage text not null default 'new'
    check (stage in ('new', 'contacted', 'test_drive', 'quote_sent', 'ready_bc', 'won', 'lost')),
  stage_entered_at timestamptz not null default now(),
  quote_sent boolean not null default false,
  quote_sent_at timestamptz,
  quote_link text,
  quote_notes text,
  google_review_status text not null default 'not_requested'
    check (google_review_status in ('not_requested', 'requested', 'received')),
  google_review_at timestamptz,
  google_review_link text,
  estimated_value numeric,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_stage_idx on leads (stage);
create index if not exists leads_assigned_to_idx on leads (assigned_to);
create index if not exists leads_created_at_idx on leads (created_at desc);

create table if not exists lead_activities (
  id text primary key,
  lead_id text not null references leads (id) on delete cascade,
  kind text not null default 'note',
  body text not null,
  created_by text,
  created_by_name text,
  created_at timestamptz not null default now()
);

create index if not exists lead_activities_lead_idx on lead_activities (lead_id, created_at desc);

create table if not exists test_drives (
  id text primary key,
  lead_id text not null references leads (id) on delete cascade,
  inventory_id text references inventory (id) on delete set null,
  scheduled_at timestamptz not null,
  duration_minutes int not null default 30,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'completed', 'no_show', 'cancelled')),
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists test_drives_scheduled_idx on test_drives (scheduled_at);
create index if not exists test_drives_lead_idx on test_drives (lead_id);
