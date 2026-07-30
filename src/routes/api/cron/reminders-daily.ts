import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { ensureCrmSeeded } from "@/lib/crm/seed";
import { releaseExpiredPauses, runDailyRepBatch } from "@/lib/crm/reminders";

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
  try {
    const sql = await getSql();
    await ensureCrmSeeded(sql);
    const released = await releaseExpiredPauses(sql);
    const daily = await runDailyRepBatch(sql);
    return new Response(JSON.stringify({ ok: true, released, daily }, null, 2), {
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

export const Route = createFileRoute("/api/cron/reminders-daily")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
