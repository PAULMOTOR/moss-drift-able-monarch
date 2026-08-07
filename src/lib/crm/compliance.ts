import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  COMPLIANCE_ITEMS,
  FUNDING_BANKS,
  type ComplianceChecklistItem,
  type Profile,
} from "./types";

function uid() {
  return crypto.randomUUID();
}

async function requireProfile(userId: string): Promise<Profile> {
  const sql = await getSql();
  const rows = await sql<Profile>`
    select id, user_id, email, name, role, active, phone, title,
           created_at::text as created_at, updated_at::text as updated_at
    from profiles where user_id = ${userId} limit 1
  `;
  if (!rows[0] || !rows[0].active) throw new Error("No active CRM profile");
  return rows[0];
}

function mapItem(r: Record<string, unknown>): ComplianceChecklistItem {
  return {
    id: String(r.id),
    lead_id: String(r.lead_id),
    item_key: String(r.item_key),
    label: String(r.label),
    sort_order: Number(r.sort_order || 0),
    done: Boolean(r.done),
    notes: String(r.notes || ""),
    meta: String(r.meta || ""),
    file_name: (r.file_name as string) || null,
    mime_type: (r.mime_type as string) || null,
    has_file: Boolean(r.has_file),
    filled_by: (r.filled_by as string) || null,
    filled_at: r.filled_at ? String(r.filled_at) : null,
    updated_at: String(r.updated_at),
  };
}

/** Ensure compliance rows exist for an approved deal. */
export async function ensureComplianceChecklist(
  sql: Awaited<ReturnType<typeof getSql>>,
  leadId: string,
) {
  for (let i = 0; i < COMPLIANCE_ITEMS.length; i++) {
    const item = COMPLIANCE_ITEMS[i]!;
    await sql`
      insert into compliance_checklist (
        id, lead_id, item_key, label, sort_order, done, notes, meta
      ) values (
        ${uid()}, ${leadId}, ${item.key}, ${item.label}, ${i}, false, '', ''
      )
      on conflict (lead_id, item_key) do nothing
    `;
  }
}

export const getCompliancePackage = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await getSql();
    const lead = await sql<{
      id: string;
      name: string;
      stage: string;
      credit_status: string | null;
      accepted_quote_id: string | null;
    }>`
      select id, name, stage, credit_status, accepted_quote_id
      from leads where id = ${data.leadId} limit 1
    `;
    if (!lead[0]) throw new Error("Lead not found");

    const approved =
      (lead[0].credit_status || "").toLowerCase() === "approved" ||
      lead[0].stage === "ready_bc" ||
      lead[0].stage === "won";

    if (approved) {
      await ensureComplianceChecklist(sql, data.leadId);
    }

    const rows = await sql<Record<string, unknown>>`
      select id, lead_id, item_key, label, sort_order, done, notes, meta,
             file_name, mime_type,
             (file_data is not null and length(file_data) > 0) as has_file,
             filled_by, filled_at::text as filled_at,
             updated_at::text as updated_at
      from compliance_checklist
      where lead_id = ${data.leadId}
      order by sort_order asc, item_key asc
    `;

    const items = rows.map(mapItem);
    const doneCount = items.filter((i) => i.done).length;

    let quoteSummary: {
      title: string | null;
      accepted_option: number | null;
      client_name: string | null;
      retail_html: string | null;
      invoice_html: string | null;
    } | null = null;

    if (lead[0].accepted_quote_id) {
      const q = await sql<{
        title: string | null;
        accepted_option: number | null;
        client_name: string | null;
        retail_html: string | null;
        invoice_html: string | null;
      }>`
        select title, accepted_option, client_name, retail_html, invoice_html
        from lease_quotes where id = ${lead[0].accepted_quote_id} limit 1
      `;
      quoteSummary = q[0] || null;
    }

    return {
      lead: lead[0],
      unlocked: approved,
      items,
      progress: {
        done: doneCount,
        total: Math.max(items.length, COMPLIANCE_ITEMS.length),
      },
      fundingBanks: [...FUNDING_BANKS],
      quoteSummary,
    };
  });

export const updateComplianceItem = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      itemKey: string;
      done?: boolean;
      notes?: string;
      meta?: string;
      fileName?: string | null;
      fileData?: string | null;
      mimeType?: string | null;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    await ensureComplianceChecklist(sql, data.leadId);

    const existing = await sql<{ id: string }>`
      select id from compliance_checklist
      where lead_id = ${data.leadId} and item_key = ${data.itemKey}
      limit 1
    `;
    if (!existing[0]) throw new Error("Compliance item not found");

    const done = data.done;
    await sql`
      update compliance_checklist set
        done = coalesce(${done ?? null}, done),
        notes = coalesce(${data.notes ?? null}, notes),
        meta = coalesce(${data.meta ?? null}, meta),
        file_name = case
          when ${data.fileData != null && data.fileData.length > 0} then ${data.fileName || "file"}
          else file_name
        end,
        file_data = case
          when ${data.fileData != null && data.fileData.length > 0} then ${data.fileData}
          else file_data
        end,
        mime_type = case
          when ${data.fileData != null && data.fileData.length > 0} then ${data.mimeType || "application/octet-stream"}
          else mime_type
        end,
        filled_by = ${me.id},
        filled_at = case when ${done === true} then now() else filled_at end,
        updated_at = now()
      where id = ${existing[0].id}
    `;

    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'compliance',
        ${`Compliance: ${data.itemKey}${done === true ? " ✓" : done === false ? " reopened" : " updated"}`},
        ${me.id}, ${me.name}
      )
    `;

    // Auto-won when all compliance items done
    const remaining = await sql<{ n: number }>`
      select count(*)::int as n from compliance_checklist
      where lead_id = ${data.leadId} and done = false
    `;
    if ((remaining[0]?.n ?? 1) === 0) {
      await sql`
        update leads set stage = 'won', stage_entered_at = now(), updated_at = now()
        where id = ${data.leadId} and stage in ('ready_bc', 'compliance', 'credit_review')
      `;
    }

    return { ok: true as const };
  });

export const getComplianceFile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string; itemKey: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await getSql();
    const rows = await sql<{
      file_name: string | null;
      file_data: string | null;
      mime_type: string | null;
    }>`
      select file_name, file_data, mime_type from compliance_checklist
      where lead_id = ${data.leadId} and item_key = ${data.itemKey}
      limit 1
    `;
    if (!rows[0]?.file_data) throw new Error("No file on this item");
    return {
      file_name: rows[0].file_name || "document",
      file_data: rows[0].file_data,
      mime_type: rows[0].mime_type || "application/octet-stream",
    };
  });
