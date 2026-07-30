import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { ensureCrmSeeded } from "@/lib/crm/seed";
import {
  releaseExpiredPauses,
  runDailyRepBatch,
  runHourlyNewLeadReminders,
} from "@/lib/crm/reminders";

/**
 * GET/POST /api/cron/reminders?mode=hourly|daily|all
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

  try {
    const sql = await getSql();
    await ensureCrmSeeded(sql);
    const released = await releaseExpiredPauses(sql);

    const result: Record<string, unknown> = { ok: true, released_pauses: released };

    if (mode === "hourly" || mode === "all") {
      result.hourly = await runHourlyNewLeadReminders(sql);
    }
    if (mode === "daily" || mode === "all") {
      // Daily only meaningful in morning; still safe to call (deduped per day)
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
