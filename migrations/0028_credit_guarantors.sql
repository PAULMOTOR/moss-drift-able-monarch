-- Up to 2 guarantors, each with their own credit application on a deal.
ALTER TABLE credit_applications
  ADD COLUMN IF NOT EXISTS applicant_role text NOT NULL DEFAULT 'primary';
ALTER TABLE credit_applications
  ADD COLUMN IF NOT EXISTS guarantor_slot int;
ALTER TABLE credit_applications
  ADD COLUMN IF NOT EXISTS applicant_name text;
ALTER TABLE credit_applications
  ADD COLUMN IF NOT EXISTS applicant_email text;
ALTER TABLE credit_applications
  ADD COLUMN IF NOT EXISTS applicant_phone text;

UPDATE credit_applications
   SET applicant_role = 'primary'
 WHERE applicant_role IS NULL OR applicant_role = '';

DO $$
BEGIN
  ALTER TABLE credit_applications DROP CONSTRAINT IF EXISTS credit_applications_role_check;
  ALTER TABLE credit_applications
    ADD CONSTRAINT credit_applications_role_check
    CHECK (applicant_role IN ('primary', 'guarantor'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS credit_apps_one_primary
  ON credit_applications (lead_id)
  WHERE applicant_role = 'primary';

CREATE UNIQUE INDEX IF NOT EXISTS credit_apps_guarantor_slot
  ON credit_applications (lead_id, guarantor_slot)
  WHERE applicant_role = 'guarantor' AND guarantor_slot IS NOT NULL;
