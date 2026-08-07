-- Expand credit document kinds (checklist uploads + lessee doc request types)
-- and keep checklist labels/items in sync via app seed (code).

ALTER TABLE credit_documents DROP CONSTRAINT IF EXISTS credit_documents_kind_check;

-- Track which docs were last requested from the lessee (JSON array of keys)
ALTER TABLE credit_applications
  ADD COLUMN IF NOT EXISTS pending_doc_kinds text;
