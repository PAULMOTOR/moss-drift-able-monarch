import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { ensureCrmSeeded } from "@/lib/crm/seed";
import { runEmailImport } from "@/lib/crm/import-emails";

/**
 * GET/POST /api/cron/import-emails
 *
 * Protected by CRON_SECRET header or query (?secret=).
 * Call every 1–5 minutes via cron-job.org (Hobby Vercel crons are daily-only).
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const url = new URL(request.url);
  const header =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    request.headers.get("x-cron-secret") ||
    url.searchParams.get("secret") ||
    "";

  // Also accept Vercel Cron automatic Authorization when CRON_SECRET matches
  if (secret) {
    if (header !== secret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  } else if (process.env.VERCEL === "1") {
    // Fail closed in production if secret not set
    return new Response(
      JSON.stringify({
        error: "CRON_SECRET not configured",
        hint: "Set CRON_SECRET in Vercel env vars",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const sql = await getSql();
    await ensureCrmSeeded(sql);
    const result = await runEmailImport(sql);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.ok ? 200 : 502,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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

export const Route = createFileRoute("/api/cron/import-emails")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
