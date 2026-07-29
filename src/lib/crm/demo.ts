/**
 * Demo password for OPTIONAL seeded team accounts.
 * Production: set CRM_SEED_DEMO=false after first login and create real passwords.
 */
export const DEMO_PASSWORD = "PaulMotor2026!";

/**
 * When true, ensureCrmSeeded inserts demo staff + sample leads.
 *
 * Rules:
 * - CRM_SEED_DEMO=true  → always allow seed (first deploy)
 * - CRM_SEED_DEMO=false → never seed
 * - unset + no DATABASE_URL (preview) → seed
 * - unset + DATABASE_URL (Neon) → seed only when profiles table is empty
 *   (checked in ensureCrmSeeded — this helper returns "maybe")
 */
export function shouldSeedDemoData(opts?: { profilesEmpty?: boolean }): boolean {
  const flag = process.env.CRM_SEED_DEMO?.trim().toLowerCase();
  if (flag === "false" || flag === "0" || flag === "no") return false;
  if (flag === "true" || flag === "1" || flag === "yes") return true;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return true; // preview / PGLite

  // Production Neon with flag unset: seed once when DB has no profiles yet
  if (opts?.profilesEmpty === true) return true;
  if (opts?.profilesEmpty === false) return false;
  // Unknown emptiness — caller should re-check with profilesEmpty
  return true;
}
