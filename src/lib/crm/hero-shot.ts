import type { Sql } from "@/lib/db";
import { HERO_SHOT_KIND } from "./types";

export async function loadHeroShotForLead(
  sql: Sql,
  leadId: string | null | undefined,
): Promise<string | null> {
  if (!leadId) return null;
  const rows = await sql<{ file_data: string; mime_type: string | null }>`
    select file_data, mime_type from credit_documents
    where lead_id = ${leadId} and kind = ${HERO_SHOT_KIND}
    order by created_at desc
    limit 1
  `;
  const raw = rows[0]?.file_data || "";
  if (/^data:image\//i.test(raw)) return raw;
  return null;
}

export function heroBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[2].replace(/\s/g, ""), "base64");
    if (bytes.length < 80) return null;
    return { mime: m[1].toLowerCase(), bytes };
  } catch {
    return null;
  }
}

export function publicHeroUrl(base: string, token: string | null | undefined): string | null {
  if (!token) return null;
  return `${base.replace(/\/$/, "")}/api/public/hero/${encodeURIComponent(token)}`;
}
