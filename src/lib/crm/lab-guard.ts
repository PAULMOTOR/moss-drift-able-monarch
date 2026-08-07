import { labSideEffectsDisabled } from "@/lib/app-track";

/** Shared JSON body when cron/import is blocked on the DMS lab. */
export function labCronBlockedResponse(job: string): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      skipped: true,
      reason: "lab_side_effects_disabled",
      job,
      message:
        "DMS lab: outbound email, Gmail import, and reminder crons are disabled. Unset LAB_DISABLE_SIDE_EFFECTS only if this environment is intentionally connected to real mailboxes.",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function shouldBlockLabSideEffects(): boolean {
  return labSideEffectsDisabled();
}
