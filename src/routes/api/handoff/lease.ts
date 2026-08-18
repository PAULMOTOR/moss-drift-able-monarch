import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import {
  authorizeHandoff,
  handoffSecret,
  ingestPalmettoLease,
  listHandoffAttempts,
  logHandoffAttempt,
  parsePalmettoPayload,
} from "@/lib/crm/handoff";

/**
 * POST /api/handoff/lease
 * Palmetto posts Apply here. Auth: Authorization: Bearer $CRM_HANDOFF_SECRET
 *
 * GET /api/handoff/lease
 * Status only. With the same Bearer, also returns the last few attempts.
 */
async function handlePost(request: Request) {
  const auth = authorizeHandoff(request);
  if (!auth.ok) {
    try {
      const sql = await getSql();
      await logHandoffAttempt(sql, {
        ok: false,
        status: auth.status,
        error: auth.error,
      });
    } catch {
      /* ignore */
    }
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

  const input = parsePalmettoPayload(raw);
  try {
    const result = await ingestPalmettoLease(input);
    const sql = await getSql();
    await logHandoffAttempt(sql, {
      ok: true,
      status: 200,
      referenceId: input.referenceId,
      name: input.name,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /required/i.test(message) ? 400 : 500;
    try {
      const sql = await getSql();
      await logHandoffAttempt(sql, {
        ok: false,
        status,
        referenceId: input.referenceId,
        name: input.name,
        error: message,
      });
    } catch {
      /* ignore */
    }
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

async function handleGet(request: Request) {
  const publicBody = {
    ok: true,
    ready: Boolean(handoffSecret()),
    path: "/api/handoff/lease",
    method: "POST",
  };
  const auth = authorizeHandoff(request);
  if (!auth.ok) {
    return new Response(JSON.stringify(publicBody), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const attempts = await listHandoffAttempts(15);
  return new Response(JSON.stringify({ ...publicBody, attempts }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/handoff/lease")({
  server: {
    handlers: {
      GET: async ({ request }) => handleGet(request),
      POST: async ({ request }) => handlePost(request),
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "Authorization, Content-Type",
            "access-control-max-age": "86400",
          },
        }),
    },
  },
});
