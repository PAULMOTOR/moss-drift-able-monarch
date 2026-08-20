import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { HERO_SHOT_KIND } from "@/lib/crm/types";
import { heroBytes } from "@/lib/crm/hero-shot";

/**
 * Public JPEG for emails / client pages. Token is credit app public_token or doc_request_token.
 */
export const Route = createFileRoute("/api/public/hero/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const token = String(params.token || "").trim();
        if (token.length < 8) {
          return new Response("Not found", { status: 404 });
        }
        const sql = await getSql();
        const apps = await sql<{ lead_id: string }>`
          select lead_id from credit_applications
          where public_token = ${token} or doc_request_token = ${token}
          limit 1
        `;
        if (!apps[0]) return new Response("Not found", { status: 404 });
        const docs = await sql<{ file_data: string; mime_type: string | null }>`
          select file_data, mime_type from credit_documents
          where lead_id = ${apps[0].lead_id} and kind = ${HERO_SHOT_KIND}
          order by created_at desc
          limit 1
        `;
        const raw = docs[0]?.file_data || "";
        const parsed = heroBytes(raw);
        if (!parsed) return new Response("Not found", { status: 404 });
        const mime = parsed.mime.includes("png")
          ? "image/png"
          : parsed.mime.includes("webp")
            ? "image/webp"
            : "image/jpeg";
        return new Response(Buffer.from(parsed.bytes), {
          status: 200,
          headers: {
            "content-type": mime,
            "cache-control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
