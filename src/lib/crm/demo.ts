/**
 * Demo password for OPTIONAL seeded team accounts.
 * Production: set CRM_SEED_DEMO=false and create real users in Admin.
 * Always change these passwords after first login if demo seed was used.
 */
export const DEMO_PASSWORD = "PaulMotor2026!";

/**
 * When true, ensureCrmSeeded inserts demo staff + sample leads.
 * - Preview / no DATABASE_URL: defaults ON so the sandbox is usable.
 * - Production (DATABASE_URL set): defaults OFF unless CRM_SEED_DEMO=true.
 */
export function shouldSeedDemoData(): boolean {
  const flag = process.env.CRM_SEED_DEMO?.trim().toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") return true;
  if (flag === "false" || flag === "0" || flag === "no") return false;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  // Real Postgres = production-like → do not auto-seed demo passwords
  return !databaseUrl;
}
