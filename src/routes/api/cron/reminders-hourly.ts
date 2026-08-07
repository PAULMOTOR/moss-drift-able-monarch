import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { labCronBlockedResponse, shouldBlockLabSideEffects } from "@/lib/crm/lab-guard";
import { ensureCrmSeeded } from "@/lib/crm/seed";
import { runScheduledUncontactedReminders } from "@/lib/crm/reminders";

/**
 * Hourly cron: release expired pauses; on weekdays at 9am & 2pm America/Toronto
 * send each rep one batch of uncontacted (New) leads; at 9am also escalate
 * 3+ day uncontacted leads to GSM + Admins.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const url = new URL(request.url);
  const header =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    request.headers.get("x-cron-secret")?.trim() ||
    url.searchParams.get("secret")?.trim() ||
    "";
  if (secret && header !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  if (!secret && process.env.VERCEL === "1") {
    return new Response(JSON.stringify({ error: "CRON_SECRET not configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (shouldBlockLabSideEffects()) {
    return labCronBlockedResponse('reminders-hourly');
  }

  try {
    const sql = await getSql();
    await ensureCrmSeeded(sql);
    const result = await runScheduledUncontactedReminders(sql);
    return new Response(JSON.stringify({ ok: true, ...result }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

export const Route = createFileRoute("/api/cron/reminders-hourly")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
