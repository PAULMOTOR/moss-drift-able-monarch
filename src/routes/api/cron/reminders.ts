import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { labCronBlockedResponse, shouldBlockLabSideEffects } from "@/lib/crm/lab-guard";
import { ensureCrmSeeded } from "@/lib/crm/seed";
import {
  releaseExpiredPauses,
  runDailyRepBatch,
  runScheduledUncontactedReminders,
  runStaleUncontactedEscalation,
  runUncontactedRepBatches,
  type UncontactedSlot,
} from "@/lib/crm/reminders";

/**
 * GET/POST /api/cron/reminders?mode=uncontacted|daily|all|escalation
 * Optional: &force=am|pm to force a rep batch slot (still deduped by day).
 * Protected by CRON_SECRET.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const url = new URL(request.url);
  const header =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    request.headers.get("x-cron-secret")?.trim() ||
    url.searchParams.get("secret")?.trim() ||
    "";

  if (secret) {
    if (header !== secret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  } else if (process.env.VERCEL === "1") {
    return new Response(JSON.stringify({ error: "CRON_SECRET not configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const mode = (url.searchParams.get("mode") || "all").toLowerCase();
  const force = url.searchParams.get("force")?.toLowerCase();
  const forceSlot: UncontactedSlot | undefined =
    force === "am" || force === "pm" ? force : undefined;

  if (shouldBlockLabSideEffects()) {
    return labCronBlockedResponse('reminders');
  }

  try {
    const sql = await getSql();
    await ensureCrmSeeded(sql);
    const released = await releaseExpiredPauses(sql);

    const result: Record<string, unknown> = { ok: true, released_pauses: released };

    if (mode === "hourly" || mode === "uncontacted" || mode === "all") {
      if (forceSlot) {
        result.repBatch = await runUncontactedRepBatches(sql, {
          forceSlot,
          ignoreSchedule: true,
        });
        if (forceSlot === "am") {
          result.escalation = await runStaleUncontactedEscalation(sql, {
            ignoreSchedule: true,
          });
        }
      } else {
        result.uncontacted = await runScheduledUncontactedReminders(sql);
      }
    }
    if (mode === "escalation") {
      result.escalation = await runStaleUncontactedEscalation(sql, {
        ignoreSchedule: url.searchParams.get("force") === "1",
      });
    }
    if (mode === "daily" || mode === "all") {
      result.daily = await runDailyRepBatch(sql);
    }

    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

export const Route = createFileRoute("/api/cron/reminders")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
