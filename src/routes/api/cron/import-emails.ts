import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { ensureCrmSeeded } from "@/lib/crm/seed";
import { runEmailImport } from "@/lib/crm/import-emails";

/**
 * GET/POST /api/cron/import-emails
 *
 * Protected by CRON_SECRET (header Authorization: Bearer …, x-cron-secret, or ?secret=).
 * Vercel Cron auto-sends Authorization: Bearer $CRON_SECRET when that env is set.
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
    return new Response(
      JSON.stringify({
        error: "CRON_SECRET not configured",
        hint: "Set CRON_SECRET in Vercel env vars (Production), then redeploy",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const sql = await getSql();
    await ensureCrmSeeded(sql);
    // Ensure import schema exists even if migrate skipped a file
    try {
      await sql`select 1 from email_imports limit 1`;
    } catch {
      // soft-fail: runEmailImport will surface clearer errors
    }
    const result = await runEmailImport(sql);
    // 200 even when Gmail reports a soft failure so Vercel logs show the JSON body
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[import-emails]", message);
    return new Response(
      JSON.stringify({
        ok: false,
        error: message,
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
