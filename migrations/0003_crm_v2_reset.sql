-- If an older 0002 CRM schema is already applied (pre-luxury rebuild), drop and
-- recreate is handled only for fresh DBs. This migration is a no-op safety net
-- for environments that already have the new tables from 0002.
-- Intentionally empty: new 0002 defines the full Paul Motor Company schema.
select 1;
