-- Lead type (inventory sale vs lease quote) + PDF quote attachment storage

alter table leads add column if not exists lead_type text not null default 'inventory'
  check (lead_type in ('inventory', 'lease'));

alter table leads add column if not exists quote_pdf_name text;
alter table leads add column if not exists quote_pdf_data text;

-- Email paste / raw source body kept for audit
alter table leads add column if not exists source_email_raw text;

create index if not exists leads_lead_type_idx on leads (lead_type);
