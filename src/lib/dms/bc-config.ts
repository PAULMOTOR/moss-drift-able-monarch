/**
 * Business Central connection stubs for the DMS lab.
 * Wire OAuth + API v2 only on the lab project / BC sandbox company.
 *
 * Safe on client and server — client only sees public VITE_* if you add them later.
 */

export type BcEnvironment = "sandbox" | "production";

export type BcConfig = {
  enabled: boolean;
  environment: BcEnvironment;
  tenantId: string | null;
  clientId: string | null;
  companyId: string | null;
  baseUrl: string | null;
};

function env(key: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const v = process.env[key]?.trim();
  return v || undefined;
}

export function getBcConfig(): BcConfig {
  const enabled =
    (env("BC_ENABLED") || "").toLowerCase() === "true" || env("BC_ENABLED") === "1";
  const envRaw = (env("BC_ENVIRONMENT") || "sandbox").toLowerCase();
  const environment: BcEnvironment =
    envRaw === "production" ? "production" : "sandbox";
  return {
    enabled,
    environment,
    tenantId: env("BC_TENANT_ID") || null,
    clientId: env("BC_CLIENT_ID") || null,
    companyId: env("BC_COMPANY_ID") || null,
    baseUrl: env("BC_API_BASE_URL") || null,
  };
}

export function bcStatusMessage(cfg: BcConfig = getBcConfig()): string {
  if (!cfg.enabled) {
    return "Business Central integration is not enabled (set BC_ENABLED=true on the lab project when ready).";
  }
  if (!cfg.tenantId || !cfg.clientId || !cfg.companyId) {
    return "BC enabled but missing BC_TENANT_ID / BC_CLIENT_ID / BC_COMPANY_ID.";
  }
  return `BC ${cfg.environment} configured for company ${cfg.companyId}.`;
}
