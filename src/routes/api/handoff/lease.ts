import { createFileRoute } from "@tanstack/react-router";
import {
  authorizeHandoff,
  ingestPalmettoLease,
  parsePalmettoPayload,
} from "@/lib/crm/handoff";

/**
 * POST /api/handoff/lease
 *
 * Palmetto (separate Vercel + Neon) posts Apply here.
 * Auth: Authorization: Bearer $CRM_HANDOFF_SECRET
 * Palmetto never opens this database.
 */
async function handle(request: Request) {
  const auth = authorizeHandoff(request);
  if (!auth.ok) {
    return new Response(JSON.stringify({ ok: false, error: auth.error }), {
      status: auth.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  try {
    const input = parsePalmettoPayload(raw);
    const result = await ingestPalmettoLease(input);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /required/i.test(message) ? 400 : 500;
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

export const Route = createFileRoute("/api/handoff/lease")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "Authorization, Content-Type",
            "access-control-max-age": "86400",
          },
        }),
    },
  },
});
