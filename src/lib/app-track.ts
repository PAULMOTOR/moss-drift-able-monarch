/**
 * Dual-track deployment: CRM prod (`main`) vs DMS lab (`dms` branch).
 *
 * Lab Vercel project should set:
 *   VITE_APP_TRACK=dms
 *   APP_TRACK=dms
 *   LAB_DISABLE_SIDE_EFFECTS=true
 *
 * Prod leaves these unset (defaults to CRM).
 */

export type AppTrack = "crm" | "dms";

function readTrack(): AppTrack {
  // Vite client
  try {
    const vite = (import.meta as ImportMeta & { env?: Record<string, string> }).env
      ?.VITE_APP_TRACK;
    if (vite && String(vite).toLowerCase() === "dms") return "dms";
  } catch {
    /* SSR / non-vite */
  }
  // Server / Node
  if (typeof process !== "undefined") {
    const t = (process.env.APP_TRACK || process.env.VITE_APP_TRACK || "").toLowerCase();
    if (t === "dms") return "dms";
  }
  return "crm";
}

export function getAppTrack(): AppTrack {
  return readTrack();
}

export function isDmsLab(): boolean {
  return readTrack() === "dms";
}

/**
 * When true, cron jobs that email people or import real Gmail must no-op.
 * Set on the DMS lab Vercel project so a cloned CRM never hits real inboxes.
 */
export function labSideEffectsDisabled(): boolean {
  if (typeof process === "undefined") return isDmsLab();
  const flag = (process.env.LAB_DISABLE_SIDE_EFFECTS || "").toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") return true;
  if (flag === "false" || flag === "0" || flag === "no") return false;
  // Default: disable side effects whenever track is dms
  return isDmsLab();
}
