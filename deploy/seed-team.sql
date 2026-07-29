-- =============================================================================
-- OPTIONAL: create empty CRM profile slots after first admin signs up
-- Prefer creating users from Admin UI (hashes passwords correctly via Better Auth).
--
-- This file is documentation only. Do NOT insert raw password hashes by hand
-- unless you know what you're doing — use Admin → Create user instead.
-- =============================================================================

-- Example: after Jeremy signs up / is created via Admin, list team:
-- SELECT id, email, name, role, active FROM profiles ORDER BY role, name;

-- Deactivate a broker without deleting history:
-- UPDATE profiles SET active = false, updated_at = now() WHERE email = 'broker@example.com';
