-- Website vehicle-consignment form is its own pipeline, not General Interest
DO $$
DECLARE r record;
BEGIN
  FOR r IN (
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'leads'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%lead_type%'
  ) LOOP
    EXECUTE format('ALTER TABLE leads DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE leads ADD CONSTRAINT leads_lead_type_check
  CHECK (lead_type IN ('inventory', 'lease', 'general', 'cash', 'wholesale', 'consignment'));
