-- Marketplace as a lead source (Kijiji, Facebook Marketplace, etc.)
DO $$
DECLARE r record;
BEGIN
  FOR r IN (
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'leads'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%source%'
      AND pg_get_constraintdef(c.oid) NOT ILIKE '%source_email%'
  ) LOOP
    EXECUTE format('ALTER TABLE leads DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE leads ADD CONSTRAINT leads_source_check
  CHECK (source IN ('phone', 'walk_in', 'email', 'broker', 'marketplace', 'other', 'web'));
