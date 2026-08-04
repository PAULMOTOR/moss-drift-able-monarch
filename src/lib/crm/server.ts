import { createServerFn } from "@tanstack/react-start";
import { hashPassword } from "better-auth/crypto";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { ensureCrmSeeded, syncRealInventory } from "./seed";
import { parseLeadEmail } from "./parse-email";
import { PAUL_MOTOR_INVENTORY_SOURCE } from "./real-inventory";
import { getEmailImportStatus, runEmailImport } from "./import-emails";
import { sendCrmEmail } from "./mail";
import type { ClientQuoteInfo, ContractStyleKey, LeaseOptionResult } from "./lease-quote";
import {
  buildFirstInvoiceHtml,
  buildRetailQuoteHtml,
  CONTRACT_STYLE_META,
  defaultContractBody,
  renderContractTemplate,
  taxRateForProvince,
  wrapPrintable,
} from "./lease-quote";
import {
  buildDealFolderName,
  buildQuotePdfFileName,
  ensureDealFolder,
  isDriveConfigured,
  probeDrive,
  uploadFileToFolder,
} from "./google-drive";
import {
  type AdminMetrics,
  type DataAnalysis,
  type InventoryItem,
  type Lead,
  type LeadActivity,
  type LeadAppointment,
  type LeadType,
  type ParsedEmailLead,
  type Profile,
  type Role,
  type TestDrive,
  isLeadType,
  isStageId,
  vehicleLabel,
} from "./types";

function id() {
  return crypto.randomUUID();
}

/** Lazy-load PDF lib so a packaging issue never takes down all CRM server functions. */
async function makeQuotePdfData(
  client: ClientQuoteInfo,
  options: LeaseOptionResult[],
  taxRate: number,
  opts?: { acceptedOption?: number | null },
): Promise<string> {
  const { buildRetailQuotePdf, pdfDataUrl } = await import("./quote-pdf");
  const buf = await buildRetailQuotePdf(client, options, taxRate, {
    acceptedOption: opts?.acceptedOption ?? null,
  });
  return pdfDataUrl(buf);
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

/** Normalize Date/string for Postgres timestamptz — never use Date#toString(). */
function toIsoTs(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString();
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function boot() {
  const sql = await getSql();
  await ensureCrmSeeded(sql);
  return sql;
}

export const ensureDemoReady = createServerFn({ method: "POST" }).handler(async () => {
  await boot();
  return { ok: true as const };
});

async function requireProfile(userId: string): Promise<Profile> {
  const sql = await boot();
  const rows = await sql<Profile>`
    select id, user_id, email, name, role, active, phone, title,
           created_at::text as created_at, updated_at::text as updated_at
    from profiles where user_id = ${userId} limit 1
  `;
  const p = rows[0];
  if (!p || !p.active) throw new Error("No active CRM profile for this account");
  return p;
}

async function requireAdmin(userId: string) {
  const p = await requireProfile(userId);
  if (p.role !== "admin") throw new Error("Admin access required");
  return p;
}

function mapLead(r: Record<string, unknown>): Lead {
  const lt = String(r.lead_type || "inventory");
  return {
    id: String(r.id),
    name: String(r.name),
    phone: (r.phone as string) ?? null,
    email: (r.email as string) ?? null,
    source: String(r.source),
    lead_type: isLeadType(lt) ? lt : "inventory",
    notes: (r.notes as string) ?? null,
    vehicle_interest: (r.vehicle_interest as string) ?? null,
    inventory_id: (r.inventory_id as string) ?? null,
    assigned_to: (r.assigned_to as string) ?? null,
    stage: isStageId(String(r.stage)) ? (r.stage as Lead["stage"]) : "new",
    stage_entered_at: String(r.stage_entered_at),
    quote_sent: bool(r.quote_sent),
    quote_sent_at: (r.quote_sent_at as string) ?? null,
    quote_link: (r.quote_link as string) ?? null,
    quote_notes: (r.quote_notes as string) ?? null,
    quote_pdf_name: (r.quote_pdf_name as string) ?? null,
    quote_pdf_data: (r.quote_pdf_data as string) ?? null,
    guarantor: (r.guarantor as string) ?? null,
    legal_entity_name: (r.legal_entity_name as string) ?? null,
    drive_folder_id: (r.drive_folder_id as string) ?? null,
    drive_folder_url: (r.drive_folder_url as string) ?? null,
    accepted_quote_id: (r.accepted_quote_id as string) ?? null,
    source_email_raw: (r.source_email_raw as string) ?? null,
    email_portal: (r.email_portal as string) ?? null,
    gmail_message_id: (r.gmail_message_id as string) ?? null,
    pause_until: (r.pause_until as string) ?? null,
    pause_note: (r.pause_note as string) ?? null,
    stage_before_pause: (r.stage_before_pause as string) ?? null,
    google_review_status: (r.google_review_status as Lead["google_review_status"]) || "not_requested",
    google_review_at: (r.google_review_at as string) ?? null,
    google_review_link: (r.google_review_link as string) ?? null,
    estimated_value: num(r.estimated_value),
    created_by: (r.created_by as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    assigned_name: (r.assigned_name as string) ?? null,
    inventory_label: (r.inventory_label as string) ?? null,
  };
}

const leadSelect = `
  l.id, l.name, l.phone, l.email, l.source, l.lead_type, l.notes, l.vehicle_interest,
  l.inventory_id, l.assigned_to, l.stage,
  l.stage_entered_at::text as stage_entered_at,
  l.quote_sent, l.quote_sent_at::text as quote_sent_at,
  l.quote_link, l.quote_notes, l.quote_pdf_name, l.quote_pdf_data, l.source_email_raw,
  l.guarantor, l.legal_entity_name, l.drive_folder_id, l.drive_folder_url, l.accepted_quote_id,
  l.email_portal, l.gmail_message_id,
  l.pause_until::text as pause_until, l.pause_note, l.stage_before_pause,
  l.google_review_status,
  l.google_review_at::text as google_review_at,
  l.google_review_link,
  l.estimated_value::float8 as estimated_value,
  l.created_by,
  l.created_at::text as created_at,
  l.updated_at::text as updated_at,
  p.name as assigned_name,
  case when i.id is not null
    then trim(both ' ' from concat(i.year, ' ', i.make, ' ', i.model, ' ', coalesce(i.trim, '')))
    else null end as inventory_label
`;

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => requireProfile(context.userId));

export const listProfiles = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { activeOnly?: boolean } | undefined) => data ?? {})
  .handler(async ({ context, data }): Promise<Profile[]> => {
    await requireProfile(context.userId);
    const sql = await boot();
    if (data.activeOnly === false) {
      return sql<Profile>`
        select id, user_id, email, name, role, active, phone, title,
               created_at::text as created_at, updated_at::text as updated_at
        from profiles order by
          case role when 'admin' then 0 when 'rep' then 1 else 2 end, name
      `;
    }
    return sql<Profile>`
      select id, user_id, email, name, role, active, phone, title,
             created_at::text as created_at, updated_at::text as updated_at
      from profiles where active = true
      order by case role when 'admin' then 0 when 'rep' then 1 else 2 end, name
    `;
  });

export const listInventory = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { q?: string; status?: string } | undefined) => data ?? {})
  .handler(async ({ context, data }): Promise<InventoryItem[]> => {
    await requireProfile(context.userId);
    const sql = await boot();
    const q = data.q?.trim() ? `%${data.q.trim().toLowerCase()}%` : null;
    const status = data.status && data.status !== "all" ? data.status : null;
    return sql<InventoryItem>`
      select id, year, make, model, trim, vin, stock_number,
             price::float8 as price, mileage, exterior_color, interior_color,
             body_type, transmission, fuel_type, status, source,
             external_url, image_url, notes,
             created_at::text as created_at, updated_at::text as updated_at
      from inventory
      where
        (${status}::text is null or status = ${status})
        and (
          ${q}::text is null
          or lower(make) like ${q}
          or lower(model) like ${q}
          or lower(coalesce(trim, '')) like ${q}
          or lower(coalesce(stock_number, '')) like ${q}
          or cast(year as text) like ${q}
        )
      order by price desc nulls last, make, model
    `;
  });

export type InventoryInput = {
  year: number;
  make: string;
  model: string;
  trim?: string;
  vin?: string;
  stock_number?: string;
  price?: number | null;
  mileage?: number | null;
  exterior_color?: string;
  body_type?: string;
  status?: string;
  source?: string;
  external_url?: string;
  notes?: string;
};

export const upsertInventory = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: InventoryInput & { id?: string }) => data)
  .handler(async ({ context, data }): Promise<InventoryItem> => {
    await requireAdmin(context.userId);
    const sql = await boot();
    const itemId = data.id || id();
    if (data.id) {
      await sql`
        update inventory set
          year = ${data.year}, make = ${data.make.trim()}, model = ${data.model.trim()},
          trim = ${data.trim?.trim() || null}, vin = ${data.vin?.trim() || null},
          stock_number = ${data.stock_number?.trim() || null},
          price = ${data.price ?? null}, mileage = ${data.mileage ?? null},
          exterior_color = ${data.exterior_color?.trim() || null},
          body_type = ${data.body_type?.trim() || null},
          status = ${data.status || "available"},
          source = ${data.source || "manual"},
          external_url = ${data.external_url?.trim() || null},
          notes = ${data.notes?.trim() || null}, updated_at = now()
        where id = ${data.id}
      `;
    } else {
      await sql`
        insert into inventory (
          id, year, make, model, trim, vin, stock_number, price, mileage,
          exterior_color, body_type, status, source, external_url, notes
        ) values (
          ${itemId}, ${data.year}, ${data.make.trim()}, ${data.model.trim()},
          ${data.trim?.trim() || null}, ${data.vin?.trim() || null},
          ${data.stock_number?.trim() || null}, ${data.price ?? null},
          ${data.mileage ?? null}, ${data.exterior_color?.trim() || null},
          ${data.body_type?.trim() || null}, ${data.status || "available"},
          ${data.source || "manual"}, ${data.external_url?.trim() || null},
          ${data.notes?.trim() || null}
        )
      `;
    }
    const rows = await sql<InventoryItem>`
      select id, year, make, model, trim, vin, stock_number,
             price::float8 as price, mileage, exterior_color, interior_color,
             body_type, transmission, fuel_type, status, source,
             external_url, image_url, notes,
             created_at::text as created_at, updated_at::text as updated_at
      from inventory where id = ${itemId}
    `;
    return rows[0]!;
  });

export const refreshInventoryFeeds = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await boot();
    const refreshed = await syncRealInventory(sql);
    return {
      ok: true as const,
      refreshed,
      sources: [PAUL_MOTOR_INVENTORY_SOURCE],
      message: `Synced ${refreshed} units from paulmotorleasing.com (real stock numbers).`,

    };
  });

export const parseEmailLead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { raw: string }) => data)
  .handler(
    async ({
      context,
      data,
    }): Promise<ParsedEmailLead & { inventory_id: string | null; inventory_label: string | null }> => {
      await requireProfile(context.userId);
      const parsed = parseLeadEmail(data.raw || "");
      const sql = await boot();
      let inventory_id: string | null = null;
      let inventory_label: string | null = null;

      if (parsed.stock_number) {
        const byStock = await sql<InventoryItem>`
          select id, year, make, model, trim, vin, stock_number,
                 price::float8 as price, mileage, exterior_color, interior_color,
                 body_type, transmission, fuel_type, status, source,
                 external_url, image_url, notes,
                 created_at::text as created_at, updated_at::text as updated_at
          from inventory where lower(stock_number) = ${parsed.stock_number.toLowerCase()} limit 1
        `;
        if (byStock[0]) {
          inventory_id = byStock[0].id;
          inventory_label = vehicleLabel(byStock[0]);
          if (!parsed.vehicle_interest) parsed.vehicle_interest = inventory_label;
        }
      }
      if (!inventory_id && parsed.vehicle_interest) {
        const q = `%${parsed.vehicle_interest.toLowerCase().replace(/\s+/g, "%")}%`;
        const fuzzy = await sql<InventoryItem>`
          select id, year, make, model, trim, vin, stock_number,
                 price::float8 as price, mileage, exterior_color, interior_color,
                 body_type, transmission, fuel_type, status, source,
                 external_url, image_url, notes,
                 created_at::text as created_at, updated_at::text as updated_at
          from inventory
          where lower(concat(year, ' ', make, ' ', model, ' ', coalesce(trim, ''))) like ${q}
             or lower(concat(make, ' ', model)) like ${q}
          order by price desc nulls last limit 1
        `;
        if (fuzzy[0]) {
          inventory_id = fuzzy[0].id;
          inventory_label = vehicleLabel(fuzzy[0]);
        }
      }
      return { ...parsed, inventory_id, inventory_label };
    },
  );

export const listLeads = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    (data: { stage?: string; q?: string; assigned?: string; lead_type?: string } | undefined) =>
      data ?? {},
  )
  .handler(async ({ context, data }): Promise<Lead[]> => {
    await requireProfile(context.userId);
    const sql = await boot();
    const stage = data.stage && data.stage !== "all" ? data.stage : null;
    const assigned = data.assigned && data.assigned !== "all" ? data.assigned : null;
    const leadType = data.lead_type && data.lead_type !== "all" ? data.lead_type : null;
    const q = data.q?.trim() ? `%${data.q.trim().toLowerCase()}%` : null;
    const rows = await sql.query<Record<string, unknown>>(
      `select ${leadSelect}
       from leads l
       left join profiles p on p.id = l.assigned_to
       left join inventory i on i.id = l.inventory_id
       where ($1::text is null or l.stage = $1)
         and ($2::text is null or l.assigned_to = $2)
         and ($3::text is null or l.lead_type = $3)
         and (
           $4::text is null
           or lower(l.name) like $4
           or lower(coalesce(l.email, '')) like $4
           or lower(coalesce(l.phone, '')) like $4
           or lower(coalesce(l.vehicle_interest, '')) like $4
         )
       order by l.updated_at desc`,
      [stage, assigned, leadType, q],
    );
    return rows.map(mapLead);
  });

export const getLead = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((leadId: string) => leadId)
  .handler(
    async ({
      context,
      data: leadId,
    }): Promise<{
      lead: Lead;
      activities: LeadActivity[];
      drives: TestDrive[];
      appointments: LeadAppointment[];
    } | null> => {
      await requireProfile(context.userId);
      const sql = await boot();
      const rows = await sql.query<Record<string, unknown>>(
        `select ${leadSelect}
         from leads l
         left join profiles p on p.id = l.assigned_to
         left join inventory i on i.id = l.inventory_id
         where l.id = $1 limit 1`,
        [leadId],
      );
      if (!rows[0]) return null;
      const activities = await sql<LeadActivity>`
        select id, lead_id, kind, body, created_by, created_by_name,
               created_at::text as created_at
        from lead_activities where lead_id = ${leadId}
        order by created_at desc
      `;
      const drives = await sql<TestDrive>`
        select t.id, t.lead_id, t.inventory_id,
               t.scheduled_at::text as scheduled_at,
               t.duration_minutes, t.status, t.notes, t.created_by,
               t.created_at::text as created_at, t.updated_at::text as updated_at,
               case when i.id is not null
                 then trim(both ' ' from concat(i.year, ' ', i.make, ' ', i.model, ' ', coalesce(i.trim, '')))
                 else null end as vehicle_label
        from test_drives t
        left join inventory i on i.id = t.inventory_id
        where t.lead_id = ${leadId}
        order by t.scheduled_at desc
      `;
      let appointments: LeadAppointment[] = [];
      try {
        appointments = await sql<LeadAppointment>`
          select id, lead_id, profile_id, scheduled_at::text as scheduled_at,
                 kind, note, status, created_by, created_at::text as created_at
          from lead_appointments where lead_id = ${leadId}
          order by scheduled_at desc
        `;
      } catch {
        appointments = [];
      }
      return { lead: mapLead(rows[0]), activities, drives, appointments };
    },
  );

export type CaptureLeadInput = {
  name: string;
  phone?: string;
  email?: string;
  source: string;
  lead_type?: LeadType;
  notes?: string;
  vehicle_interest?: string;
  inventory_id?: string | null;
  assigned_to?: string | null;
  quote_sent?: boolean;
  quote_sent_at?: string | null;
  quote_link?: string | null;
  quote_notes?: string | null;
  quote_pdf_name?: string | null;
  quote_pdf_data?: string | null;
  source_email_raw?: string | null;
  estimated_value?: number | null;
};

export const captureLead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: CaptureLeadInput) => data)
  .handler(async ({ context, data }): Promise<Lead> => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const name = data.name.trim();
    if (!name) throw new Error("Name is required");
    if (!data.phone?.trim() && !data.email?.trim()) throw new Error("Phone or email required");

    const leadType: LeadType =
      data.lead_type && isLeadType(data.lead_type) ? data.lead_type : "inventory";

    let vehicleInterest = data.vehicle_interest?.trim() || null;
    let estimated = data.estimated_value ?? null;
    if (data.inventory_id) {
      const inv = await sql<InventoryItem>`
        select id, year, make, model, trim, vin, stock_number,
               price::float8 as price, mileage, exterior_color, interior_color,
               body_type, transmission, fuel_type, status, source,
               external_url, image_url, notes,
               created_at::text as created_at, updated_at::text as updated_at
        from inventory where id = ${data.inventory_id}
      `;
      if (inv[0]) {
        if (!vehicleInterest) vehicleInterest = vehicleLabel(inv[0]);
        if (estimated == null) estimated = inv[0].price;
      }
    }

    const leadId = id();
    const quoteSent = Boolean(data.quote_sent) || Boolean(data.quote_pdf_data);
    const stage = quoteSent ? "quote_sent" : "new";
    const assigned = data.assigned_to || me.id;

    await sql`
      insert into leads (
        id, name, phone, email, source, lead_type, notes, vehicle_interest, inventory_id,
        assigned_to, stage, stage_entered_at, quote_sent, quote_sent_at,
        quote_link, quote_notes, quote_pdf_name, quote_pdf_data, source_email_raw,
        estimated_value, created_by
      ) values (
        ${leadId}, ${name}, ${data.phone?.trim() || null},
        ${data.email?.trim().toLowerCase() || null},
        ${data.source || "phone"}, ${leadType}, ${data.notes?.trim() || null},
        ${vehicleInterest}, ${data.inventory_id || null},
        ${assigned}, ${stage}, now(),
        ${quoteSent},
        ${quoteSent ? toIsoTs(data.quote_sent_at) || new Date().toISOString() : null},
        ${data.quote_link?.trim() || null},
        ${data.quote_notes?.trim() || null},
        ${data.quote_pdf_name?.trim() || null},
        ${data.quote_pdf_data || null},
        ${data.source_email_raw?.trim() || null},
        ${estimated},
        ${me.id}
      )
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${id()}, ${leadId}, 'system',
        ${`Lead captured (${leadType} · ${data.source || "phone"}) by ${me.name}`},
        ${me.id}, ${me.name}
      )
    `;
    if (data.source_email_raw?.trim()) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${id()}, ${leadId}, 'email',
          ${`Parsed from email paste:\n${data.source_email_raw.trim().slice(0, 1500)}`},
          ${me.id}, ${me.name}
        )
      `;
    }
    if (data.quote_pdf_name) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${id()}, ${leadId}, 'quote',
          ${`Quote PDF attached: ${data.quote_pdf_name}`},
          ${me.id}, ${me.name}
        )
      `;
    }
    if (data.notes?.trim()) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (${id()}, ${leadId}, 'note', ${data.notes.trim()}, ${me.id}, ${me.name})
      `;
    }

    // Email assignee if capturing for someone else
    if (assigned && assigned !== me.id) {
      const assignee = await sql<{ id: string; name: string; email: string }>`
        select id, name, email from profiles where id = ${assigned} and active = true limit 1
      `;
      const a = assignee[0];
      if (a?.email) {
        const appUrl =
          process.env.BETTER_AUTH_URL?.replace(/\/$/, "") ||
          process.env.APP_URL?.replace(/\/$/, "") ||
          "https://moss-drift-able-monarch.vercel.app";
        await sendCrmEmail(sql, {
          to: a.email,
          subject: `[CRM] New lead assigned to you — ${name}`,
          text: [
            `Hi ${a.name},`,
            ``,
            `${me.name} captured a lead and assigned it to you:`,
            ``,
            `  Name: ${name}`,
            `  Phone: ${data.phone?.trim() || "—"}`,
            `  Email: ${data.email?.trim() || "—"}`,
            `  Interest: ${vehicleInterest || "—"}`,
            `  Source: ${data.source || "phone"}`,
            ``,
            `Open: ${appUrl}/leads/${leadId}`,
            ``,
            `— PAUL MOTOR CO. CRM`,
          ].join("\n"),
          kind: "lead_assigned",
          leadId,
          profileId: a.id,
        });
      }
    }

    const rows = await sql.query<Record<string, unknown>>(
      `select ${leadSelect}
       from leads l
       left join profiles p on p.id = l.assigned_to
       left join inventory i on i.id = l.inventory_id
       where l.id = $1`,
      [leadId],
    );
    return mapLead(rows[0]!);
  });

export const updateLead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: Partial<CaptureLeadInput> & {
      id: string;
      stage?: string;
      google_review_status?: string;
      google_review_at?: string | null;
      google_review_link?: string | null;
      clear_quote_pdf?: boolean;
    }) => data,
  )
  .handler(async ({ context, data }): Promise<Lead> => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const existing = await sql<Record<string, unknown>>`select * from leads where id = ${data.id}`;
    if (!existing[0]) throw new Error("Lead not found");
    const prev = existing[0];

    let stage =
      data.stage && isStageId(data.stage) ? data.stage : String(prev.stage);
    // Manual stage change off paused clears pause
    let pauseUntil = toIsoTs(prev.pause_until);
    let pauseNote = (prev.pause_note as string | null) ?? null;
    let stageBefore = (prev.stage_before_pause as string | null) ?? null;
    if (data.stage && data.stage !== "paused" && String(prev.stage) === "paused") {
      pauseUntil = null;
      pauseNote = null;
      stageBefore = null;
    }
    const stageChanged = stage !== String(prev.stage);
    const prevAssigned =
      prev.assigned_to == null || prev.assigned_to === ""
        ? null
        : String(prev.assigned_to);
    const nextAssigned =
      data.assigned_to !== undefined
        ? data.assigned_to || null
        : prevAssigned;
    const hasNewPdf = Boolean(data.quote_pdf_data);
    const quoteSent =
      data.quote_sent !== undefined
        ? Boolean(data.quote_sent)
        : hasNewPdf
          ? true
          : bool(prev.quote_sent);

    const leadType =
      data.lead_type && isLeadType(data.lead_type)
        ? data.lead_type
        : isLeadType(String(prev.lead_type || "inventory"))
          ? (String(prev.lead_type) as LeadType)
          : "inventory";

    let quotePdfName = (prev.quote_pdf_name as string | null) ?? null;
    let quotePdfData = (prev.quote_pdf_data as string | null) ?? null;
    if (data.clear_quote_pdf) {
      quotePdfName = null;
      quotePdfData = null;
    }
    if (data.quote_pdf_data) {
      quotePdfData = data.quote_pdf_data;
      quotePdfName = data.quote_pdf_name?.trim() || "quote.pdf";
    }

    await sql`
      update leads set
        name = ${data.name?.trim() ?? String(prev.name)},
        phone = ${data.phone !== undefined ? data.phone?.trim() || null : (prev.phone as string | null)},
        email = ${data.email !== undefined ? data.email?.trim().toLowerCase() || null : (prev.email as string | null)},
        source = ${data.source ?? String(prev.source)},
        lead_type = ${leadType},
        notes = ${data.notes !== undefined ? data.notes?.trim() || null : (prev.notes as string | null)},
        vehicle_interest = ${
          data.vehicle_interest !== undefined
            ? data.vehicle_interest?.trim() || null
            : (prev.vehicle_interest as string | null)
        },
        inventory_id = ${
          data.inventory_id !== undefined
            ? data.inventory_id || null
            : (prev.inventory_id as string | null)
        },
        assigned_to = ${nextAssigned},
        stage = ${stage},
        stage_entered_at = ${
          stageChanged
            ? new Date().toISOString()
            : toIsoTs(prev.stage_entered_at) ?? new Date().toISOString()
        },
        pause_until = ${pauseUntil},
        pause_note = ${pauseNote},
        stage_before_pause = ${stageBefore},
        quote_sent = ${quoteSent},
        quote_sent_at = ${
          data.quote_sent_at !== undefined
            ? toIsoTs(data.quote_sent_at)
            : quoteSent && !prev.quote_sent_at
              ? new Date().toISOString()
              : toIsoTs(prev.quote_sent_at)
        },
        quote_link = ${
          data.quote_link !== undefined
            ? data.quote_link?.trim() || null
            : (prev.quote_link as string | null)
        },
        quote_notes = ${
          data.quote_notes !== undefined
            ? data.quote_notes?.trim() || null
            : (prev.quote_notes as string | null)
        },
        quote_pdf_name = ${quotePdfName},
        quote_pdf_data = ${quotePdfData},
        google_review_status = ${
          data.google_review_status ?? String(prev.google_review_status)
        },
        google_review_at = ${
          data.google_review_at !== undefined
            ? toIsoTs(data.google_review_at)
            : toIsoTs(prev.google_review_at)
        },
        google_review_link = ${
          data.google_review_link !== undefined
            ? data.google_review_link?.trim() || null
            : (prev.google_review_link as string | null)
        },
        estimated_value = ${
          data.estimated_value !== undefined
            ? data.estimated_value
            : num(prev.estimated_value)
        },
        updated_at = now()
      where id = ${data.id}
    `;

    if (stageChanged) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${id()}, ${data.id}, 'stage',
          ${`Stage: ${prev.stage} → ${stage}`},
          ${me.id}, ${me.name}
        )
      `;
    }

    // Notify rep when assignment changes (or first assign)
    if (nextAssigned && nextAssigned !== prevAssigned) {
      const assignee = await sql<{ id: string; name: string; email: string }>`
        select id, name, email from profiles where id = ${nextAssigned} and active = true limit 1
      `;
      const a = assignee[0];
      if (a?.email) {
        const leadName = data.name?.trim() ?? String(prev.name);
        const phone =
          data.phone !== undefined
            ? data.phone?.trim() || null
            : (prev.phone as string | null);
        const email =
          data.email !== undefined
            ? data.email?.trim().toLowerCase() || null
            : (prev.email as string | null);
        const interest =
          data.vehicle_interest !== undefined
            ? data.vehicle_interest?.trim() || null
            : (prev.vehicle_interest as string | null);
        await sql`
          insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
          values (
            ${id()}, ${data.id}, 'system',
            ${`Assigned to ${a.name} by ${me.name}`},
            ${me.id}, ${me.name}
          )
        `;
        // Don't email yourself
        if (a.id !== me.id) {
          const appUrl =
            process.env.BETTER_AUTH_URL?.replace(/\/$/, "") ||
            process.env.APP_URL?.replace(/\/$/, "") ||
            "https://moss-drift-able-monarch.vercel.app";
          await sendCrmEmail(sql, {
            to: a.email,
            subject: `[CRM] Lead assigned to you — ${leadName}`,
            text: [
              `Hi ${a.name},`,
              ``,
              `${me.name} assigned you a lead:`,
              ``,
              `  Name: ${leadName}`,
              `  Phone: ${phone || "—"}`,
              `  Email: ${email || "—"}`,
              `  Interest: ${interest || "—"}`,
              `  Stage: ${stage}`,
              ``,
              `Open: ${appUrl}/leads/${data.id}`,
              ``,
              `— PAUL MOTOR CO. CRM`,
            ].join("\n"),
            kind: "lead_assigned",
            leadId: data.id,
            profileId: a.id,
          });
        }
      }
    }

    if (hasNewPdf) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${id()}, ${data.id}, 'quote',
          ${`Quote PDF uploaded: ${quotePdfName}`},
          ${me.id}, ${me.name}
        )
      `;
    }

    const rows = await sql.query<Record<string, unknown>>(
      `select ${leadSelect}
       from leads l
       left join profiles p on p.id = l.assigned_to
       left join inventory i on i.id = l.inventory_id
       where l.id = $1`,
      [data.id],
    );
    return mapLead(rows[0]!);
  });

/** Schedule a call/contact — sets stage to Paused until that date (skips auto-reminders). */
export const scheduleContactAppointment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: { leadId: string; scheduled_at: string; note?: string }) => data,
  )
  .handler(async ({ context, data }): Promise<Lead> => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const when = new Date(data.scheduled_at);
    if (Number.isNaN(when.getTime())) throw new Error("Invalid date/time");
    if (when.getTime() < Date.now() - 60000) {
      throw new Error("Appointment must be in the future");
    }

    const existing = await sql<Record<string, unknown>>`
      select id, stage, stage_before_pause from leads where id = ${data.leadId}
    `;
    if (!existing[0]) throw new Error("Lead not found");
    const prevStage = String(existing[0].stage);
    const before =
      prevStage === "paused"
        ? (existing[0].stage_before_pause as string) || "new"
        : prevStage === "won" || prevStage === "lost"
          ? "contacted"
          : prevStage;

    await sql`
      update leads set
        stage = 'paused',
        stage_entered_at = now(),
        pause_until = ${when.toISOString()},
        pause_note = ${data.note?.trim() || null},
        stage_before_pause = ${before},
        updated_at = now()
      where id = ${data.leadId}
    `;

    await sql`
      insert into lead_appointments (
        id, lead_id, profile_id, scheduled_at, kind, note, status, created_by
      ) values (
        ${id()}, ${data.leadId}, ${me.id}, ${when.toISOString()},
        'contact', ${data.note?.trim() || null}, 'scheduled', ${me.id}
      )
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${id()}, ${data.leadId}, 'system',
        ${`Contact appointment set for ${when.toLocaleString("en-CA", { timeZone: "America/Toronto" })}. Lead paused — auto-reminders off until then.${data.note?.trim() ? ` Note: ${data.note.trim()}` : ""}`},
        ${me.id}, ${me.name}
      )
    `;

    const rows = await sql.query<Record<string, unknown>>(
      `select ${leadSelect}
       from leads l
       left join profiles p on p.id = l.assigned_to
       left join inventory i on i.id = l.inventory_id
       where l.id = $1`,
      [data.leadId],
    );
    return mapLead(rows[0]!);
  });

export const clearLeadPause = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string }) => data)
  .handler(async ({ context, data }): Promise<Lead> => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const existing = await sql<Record<string, unknown>>`
      select stage, stage_before_pause from leads where id = ${data.leadId}
    `;
    if (!existing[0]) throw new Error("Lead not found");
    const back =
      (existing[0].stage_before_pause as string) &&
      String(existing[0].stage_before_pause) !== "paused"
        ? String(existing[0].stage_before_pause)
        : "contacted";

    await sql`
      update leads set
        stage = ${back},
        stage_entered_at = now(),
        pause_until = null,
        pause_note = null,
        stage_before_pause = null,
        updated_at = now()
      where id = ${data.leadId}
    `;
    await sql`
      update lead_appointments set status = 'cancelled', updated_at = now()
      where lead_id = ${data.leadId} and status = 'scheduled'
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${id()}, ${data.leadId}, 'system',
        ${`Pause cleared by ${me.name} — back to ${back}`},
        ${me.id}, ${me.name}
      )
    `;
    const rows = await sql.query<Record<string, unknown>>(
      `select ${leadSelect}
       from leads l
       left join profiles p on p.id = l.assigned_to
       left join inventory i on i.id = l.inventory_id
       where l.id = $1`,
      [data.leadId],
    );
    return mapLead(rows[0]!);
  });

/** Permanently delete a lead (false positives). Does not count as Closed Lost. */
export const deleteLead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const existing = await sql<{ id: string; name: string }>`
      select id, name from leads where id = ${data.id} limit 1
    `;
    if (!existing[0]) throw new Error("Lead not found");

    try {
      await sql`delete from lead_appointments where lead_id = ${data.id}`;
    } catch {
      /* table may not exist on old DBs */
    }
    await sql`delete from test_drives where lead_id = ${data.id}`;
    await sql`delete from lead_activities where lead_id = ${data.id}`;
    try {
      await sql`update email_imports set lead_id = null where lead_id = ${data.id}`;
    } catch {
      /* optional */
    }
    await sql`delete from leads where id = ${data.id}`;

    return {
      ok: true as const,
      deleted: existing[0].name,
      message: `Permanently deleted “${existing[0].name}” (not counted as Closed Lost). Removed by ${me.name}.`,
    };
  });

export const addActivity = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string; body: string; kind?: string }) => data)
  .handler(async ({ context, data }): Promise<LeadActivity> => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const body = data.body.trim();
    if (!body) throw new Error("Note required");
    const activityId = id();
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (${activityId}, ${data.leadId}, ${data.kind || "note"}, ${body}, ${me.id}, ${me.name})
    `;
    await sql`update leads set updated_at = now() where id = ${data.leadId}`;
    const rows = await sql<LeadActivity>`
      select id, lead_id, kind, body, created_by, created_by_name,
             created_at::text as created_at
      from lead_activities where id = ${activityId}
    `;
    return rows[0]!;
  });

export const listTestDrives = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<TestDrive[]> => {
    await requireProfile(context.userId);
    const sql = await boot();
    return sql<TestDrive>`
      select t.id, t.lead_id, t.inventory_id,
             t.scheduled_at::text as scheduled_at,
             t.duration_minutes, t.status, t.notes, t.created_by,
             t.created_at::text as created_at, t.updated_at::text as updated_at,
             l.name as lead_name,
             case when i.id is not null
               then trim(both ' ' from concat(i.year, ' ', i.make, ' ', i.model, ' ', coalesce(i.trim, '')))
               else null end as vehicle_label
      from test_drives t
      join leads l on l.id = t.lead_id
      left join inventory i on i.id = t.inventory_id
      order by t.scheduled_at asc
    `;
  });

export const bookTestDrive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      lead_id: string;
      inventory_id?: string | null;
      scheduled_at: string;
      duration_minutes?: number;
      notes?: string;
    }) => data,
  )
  .handler(async ({ context, data }): Promise<TestDrive> => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const driveId = id();
    await sql`
      insert into test_drives (
        id, lead_id, inventory_id, scheduled_at, duration_minutes, status, notes, created_by
      ) values (
        ${driveId}, ${data.lead_id}, ${data.inventory_id || null},
        ${data.scheduled_at}, ${data.duration_minutes ?? 30}, 'scheduled',
        ${data.notes?.trim() || null}, ${me.id}
      )
    `;
    await sql`
      update leads set stage = case when stage in ('new','contacted','paused') then 'quote_sent' else stage end,
        stage_entered_at = case when stage in ('new','contacted','paused') then now() else stage_entered_at end,
        pause_until = case when stage = 'paused' then null else pause_until end,
        pause_note = case when stage = 'paused' then null else pause_note end,
        stage_before_pause = case when stage = 'paused' then null else stage_before_pause end,
        updated_at = now()
      where id = ${data.lead_id}
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${id()}, ${data.lead_id}, 'test_drive',
        ${`Test drive scheduled for ${new Date(data.scheduled_at).toLocaleString("en-CA")}`},
        ${me.id}, ${me.name}
      )
    `;
    const rows = await sql<TestDrive>`
      select t.id, t.lead_id, t.inventory_id,
             t.scheduled_at::text as scheduled_at,
             t.duration_minutes, t.status, t.notes, t.created_by,
             t.created_at::text as created_at, t.updated_at::text as updated_at
      from test_drives t where t.id = ${driveId}
    `;
    return rows[0]!;
  });

export const updateTestDrive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { id: string; status: string; notes?: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await boot();
    await sql`
      update test_drives set
        status = ${data.status},
        notes = coalesce(${data.notes?.trim() || null}, notes),
        updated_at = now()
      where id = ${data.id}
    `;
    return { ok: true as const };
  });

export const getDashboardStats = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const totals = await sql<{
      total: number;
      open: number;
      new_leads: number;
      quote_pending: number;
      drives: number;
      inventory_leads: number;
      lease_leads: number;
      general_leads: number;
    }>`
      select
        count(*)::int as total,
        count(*) filter (where stage not in ('won','lost'))::int as open,
        count(*) filter (where stage = 'new')::int as new_leads,
        count(*) filter (where quote_sent = true and stage not in ('won','lost'))::int as quote_pending,
        (select count(*)::int from lease_quotes) as drives,
        count(*) filter (where lead_type = 'inventory')::int as inventory_leads,
        count(*) filter (where lead_type = 'lease')::int as lease_leads,
        count(*) filter (where lead_type = 'general')::int as general_leads
      from leads
    `;

    const mine = await sql<{ n: number }>`
      select count(*)::int as n from leads
      where assigned_to = ${me.id} and stage not in ('won','lost')
    `;
    const recent = await sql.query<Record<string, unknown>>(
      `select ${leadSelect}
       from leads l
       left join profiles p on p.id = l.assigned_to
       left join inventory i on i.id = l.inventory_id
       order by l.created_at desc limit 8`,
    );
    return {
      me,
      totals: totals[0]!,
      mine: mine[0]?.n ?? 0,
      recent: recent.map(mapLead),
    };
  });

export const getDataAnalysis = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<DataAnalysis> => {
    await requireProfile(context.userId);
    const sql = await boot();

    const portalRows = await sql<{
      portal: string;
      total: number;
      won: number;
      lost: number;
      open: number;
    }>`
      select
        coalesce(nullif(email_portal, ''), case
          when lower(source) like '%cargurus%' then 'cargurus'
          when lower(source) like '%autotrader%' or lower(source) like '%trader%' then 'autotrader'
          else 'other'
        end) as portal,
        count(*)::int as total,
        count(*) filter (where stage = 'won')::int as won,
        count(*) filter (where stage = 'lost')::int as lost,
        count(*) filter (where stage not in ('won','lost'))::int as open
      from leads
      where lead_type = 'inventory'
      group by 1
      order by total desc
    `;

    const labelMap: Record<string, string> = {
      cargurus: "CarGurus",
      autotrader: "AutoTrader",
      other: "Other / floor",
      manual: "Manual",
      tadvantage: "TAdvantage",
    };

    const portal_inventory = portalRows.map((r) => {
      const closed = r.won + r.lost;
      return {
        portal: r.portal,
        label: labelMap[r.portal] || r.portal,
        total: r.total,
        won: r.won,
        lost: r.lost,
        open: r.open,
        close_rate: closed ? Math.round((r.won / closed) * 1000) / 10 : 0,
      };
    });

    // Force CarGurus + AutoTrader rows even if zero
    for (const key of ["cargurus", "autotrader"] as const) {
      if (!portal_inventory.some((p) => p.portal === key)) {
        portal_inventory.push({
          portal: key,
          label: labelMap[key],
          total: 0,
          won: 0,
          lost: 0,
          open: 0,
          close_rate: 0,
        });
      }
    }

    const repRows = await sql<{
      profile_id: string;
      name: string;
      role: string;
      inventory_total: number;
      inventory_won: number;
      all_total: number;
      all_won: number;
    }>`
      select
        p.id as profile_id,
        p.name,
        p.role,
        count(l.id) filter (where l.lead_type = 'inventory')::int as inventory_total,
        count(l.id) filter (where l.lead_type = 'inventory' and l.stage = 'won')::int as inventory_won,
        count(l.id)::int as all_total,
        count(l.id) filter (where l.stage = 'won')::int as all_won
      from profiles p
      left join leads l on l.assigned_to = p.id
      where p.active = true and p.role in ('rep', 'broker', 'admin')
      group by p.id, p.name, p.role
      order by inventory_won desc, inventory_total desc
    `;

    const by_rep = repRows.map((r) => {
      const invClosed = r.inventory_total; // rate of won / inventory total (or only closed?)
      // User asked closing rates — won / (won+lost) preferred; if no closed, show won/total
      return {
        profile_id: r.profile_id,
        name: r.name,
        role: r.role,
        inventory_total: r.inventory_total,
        inventory_won: r.inventory_won,
        inventory_close_rate: r.inventory_total
          ? Math.round((r.inventory_won / r.inventory_total) * 1000) / 10
          : 0,
        all_total: r.all_total,
        all_won: r.all_won,
        all_close_rate: r.all_total
          ? Math.round((r.all_won / r.all_total) * 1000) / 10
          : 0,
      };
    });

    return {
      portal_inventory: portal_inventory.sort((a, b) => b.total - a.total),
      by_rep,
      generated_at: new Date().toISOString(),
    };
  });

export const getAdminMetrics = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<AdminMetrics> => {
    await requireAdmin(context.userId);
    const sql = await boot();
    const overall = await sql<{
      total: number;
      won: number;
      lost: number;
      contacted: number;
      reviews: number;
      pipeline_value: number;
    }>`
      select
        count(*)::int as total,
        count(*) filter (where stage = 'won')::int as won,
        count(*) filter (where stage = 'lost')::int as lost,
        count(*) filter (where stage not in ('new'))::int as contacted,
        count(*) filter (where google_review_status = 'received')::int as reviews,
        coalesce(sum(estimated_value) filter (where stage not in ('won','lost')), 0)::float8 as pipeline_value
      from leads
    `;
    const o = overall[0]!;
    const by_rep = await sql<{
      profile_id: string;
      name: string;
      role: string;
      total: number;
      won: number;
      contacted: number;
      reviews_received: number;
    }>`
      select
        p.id as profile_id, p.name, p.role,
        count(l.id)::int as total,
        count(l.id) filter (where l.stage = 'won')::int as won,
        count(l.id) filter (where l.stage is not null and l.stage <> 'new')::int as contacted,
        count(l.id) filter (where l.google_review_status = 'received')::int as reviews_received
      from profiles p
      left join leads l on l.assigned_to = p.id
      where p.role in ('rep', 'broker', 'admin') and p.active = true
      group by p.id, p.name, p.role
      order by won desc, total desc
    `;
    const funnel = await sql<{ stage: string; count: number }>`
      select stage, count(*)::int as count from leads group by stage
    `;
    return {
      overall: {
        total: o.total,
        won: o.won,
        lost: o.lost,
        success_rate: o.total ? Math.round((o.won / o.total) * 1000) / 10 : 0,
        contact_rate: o.total ? Math.round((o.contacted / o.total) * 1000) / 10 : 0,
        review_rate: o.total ? Math.round((o.reviews / o.total) * 1000) / 10 : 0,
        pipeline_value: Number(o.pipeline_value) || 0,
      },
      by_rep: by_rep.map((r) => ({
        profile_id: r.profile_id,
        name: r.name,
        role: r.role,
        total: r.total,
        won: r.won,
        success_rate: r.total ? Math.round((r.won / r.total) * 1000) / 10 : 0,
        contact_rate: r.total ? Math.round((r.contacted / r.total) * 1000) / 10 : 0,
        review_rate: r.total ? Math.round((r.reviews_received / r.total) * 1000) / 10 : 0,
        reviews_received: r.reviews_received,
      })),
      funnel,
    };
  });

export const adminRunEmailImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { days?: number; max?: number } | undefined) => data ?? {})
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await boot();
    const days = data.days && data.days > 0 ? Math.min(data.days, 90) : 14;
    const max = data.max && data.max > 0 ? Math.min(data.max, 300) : days >= 25 ? 200 : 40;
    return runEmailImport(sql, { newerThanDays: days, maxResults: max });
  });

export const adminEmailImportStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await boot();
    return getEmailImportStatus(sql);
  });

export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      name: string;
      email: string;
      password: string;
      role: Role;
      phone?: string;
      title?: string;
    }) => data,
  )
  .handler(async ({ context, data }): Promise<Profile> => {
    await requireAdmin(context.userId);
    const sql = await boot();
    const email = data.email.trim().toLowerCase();
    const name = data.name.trim();
    if (!name || !email || data.password.length < 8) {
      throw new Error("Name, email, and password (8+) required");
    }
    const existing = await sql`select id from profiles where email = ${email}`;
    if (existing[0]) throw new Error("Email already in use");
    const existingUser = await sql`select id from "user" where email = ${email}`;
    if (existingUser[0]) throw new Error("Email already in use");

    const userId = id();
    const profileId = id();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(data.password);

    await sql`
      insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
      values (${userId}, ${name}, ${email}, true, null, ${now}, ${now})
    `;
    await sql`
      insert into account (
        id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
      ) values (
        ${id()}, ${email}, 'credential', ${userId}, ${passwordHash}, ${now}, ${now}
      )
    `;
    await sql`
      insert into profiles (id, user_id, email, name, role, active, phone, title)
      values (
        ${profileId}, ${userId}, ${email}, ${name}, ${data.role}, true,
        ${data.phone?.trim() || null}, ${data.title?.trim() || null}
      )
    `;
    const rows = await sql<Profile>`
      select id, user_id, email, name, role, active, phone, title,
             created_at::text as created_at, updated_at::text as updated_at
      from profiles where id = ${profileId}
    `;
    return rows[0]!;
  });

export const adminUpdateUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      id: string;
      name?: string;
      email?: string;
      role?: Role;
      active?: boolean;
      phone?: string | null;
      title?: string | null;
      password?: string;
    }) => data,
  )
  .handler(async ({ context, data }): Promise<Profile> => {
    const me = await requireAdmin(context.userId);
    const sql = await boot();
    const prev = await sql<Profile>`
      select id, user_id, email, name, role, active, phone, title,
             created_at::text as created_at, updated_at::text as updated_at
      from profiles where id = ${data.id}
    `;
    if (!prev[0]) throw new Error("User not found");

    const nextName = data.name?.trim() ?? prev[0].name;
    const nextEmail = data.email?.trim().toLowerCase() ?? prev[0].email;
    const nextRole = data.role ?? prev[0].role;
    const nextActive = data.active ?? prev[0].active;
    const nextPhone =
      data.phone !== undefined ? data.phone?.trim() || null : prev[0].phone;
    const nextTitle =
      data.title !== undefined ? data.title?.trim() || null : prev[0].title;

    if (!nextName) throw new Error("Name is required");
    if (!nextEmail || !nextEmail.includes("@")) throw new Error("Valid email required");
    if (me.id === data.id && nextRole !== "admin") {
      throw new Error("You cannot remove your own admin role");
    }
    if (me.id === data.id && nextActive === false) {
      throw new Error("You cannot deactivate your own account");
    }
    if (prev[0].role === "admin" && (nextRole !== "admin" || nextActive === false)) {
      const admins = await sql<{ n: number }>`
        select count(*)::int as n from profiles
        where role = 'admin' and active = true and id <> ${data.id}
      `;
      if ((admins[0]?.n ?? 0) < 1) throw new Error("At least one active admin is required");
    }
    if (nextEmail !== prev[0].email) {
      const clash = await sql`
        select id from profiles where email = ${nextEmail} and id <> ${data.id} limit 1
      `;
      if (clash[0]) throw new Error("Email already in use by another user");
    }

    await sql`
      update profiles set
        name = ${nextName}, email = ${nextEmail}, role = ${nextRole},
        active = ${nextActive}, phone = ${nextPhone}, title = ${nextTitle},
        updated_at = now()
      where id = ${data.id}
    `;

    if (prev[0].user_id) {
      await sql`
        update "user" set name = ${nextName}, email = ${nextEmail}, "updatedAt" = now()
        where id = ${prev[0].user_id}
      `;
      await sql`
        update account set "accountId" = ${nextEmail}, "updatedAt" = now()
        where "userId" = ${prev[0].user_id} and "providerId" = 'credential'
      `;
      if (data.password && data.password.length > 0) {
        if (data.password.length < 8) throw new Error("Password must be at least 8 characters");
        const passwordHash = await hashPassword(data.password);
        const acc = await sql<{ id: string }>`
          select id from account
          where "userId" = ${prev[0].user_id} and "providerId" = 'credential' limit 1
        `;
        if (acc[0]) {
          await sql`
            update account set password = ${passwordHash}, "updatedAt" = now()
            where id = ${acc[0].id}
          `;
        }
      }
    }

    const rows = await sql<Profile>`
      select id, user_id, email, name, role, active, phone, title,
             created_at::text as created_at, updated_at::text as updated_at
      from profiles where id = ${data.id}
    `;
    return rows[0]!;
  });

export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireAdmin(context.userId);
    const profileId = data.id;
    if (me.id === profileId) throw new Error("Cannot remove your own account");
    const sql = await boot();
    const rows = await sql<Profile>`
      select id, user_id, email, name, role, active, phone, title,
             created_at::text as created_at, updated_at::text as updated_at
      from profiles where id = ${profileId}
    `;
    const p = rows[0];
    if (!p) throw new Error("User not found");
    if (p.role === "admin") {
      const admins = await sql<{ n: number }>`
        select count(*)::int as n from profiles
        where role = 'admin' and active = true and id <> ${profileId}
      `;
      if ((admins[0]?.n ?? 0) < 1) throw new Error("Cannot remove the last active admin");
    }
    await sql`update leads set assigned_to = null where assigned_to = ${profileId}`;
    await sql`update leads set created_by = null where created_by = ${profileId}`;
    await sql`update lead_activities set created_by = null where created_by = ${profileId}`;
    await sql`update test_drives set created_by = null where created_by = ${profileId}`;
    await sql`delete from profiles where id = ${profileId}`;
    if (p.user_id) {
      await sql`delete from session where "userId" = ${p.user_id}`;
      await sql`delete from account where "userId" = ${p.user_id}`;
      await sql`delete from "user" where id = ${p.user_id}`;
    }
    return { ok: true as const, removed: p.name };
  });

export const adminClearAllLeads = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await boot();
    const before = await sql<{ n: number }>`select count(*)::int as n from leads`;
    const count = before[0]?.n ?? 0;
    await sql`delete from test_drives`;
    await sql`delete from lead_activities`;
    try {
      await sql`delete from lead_appointments`;
    } catch {
      /* optional table */
    }
    try {
      await sql`delete from email_imports`;
    } catch {
      /* optional */
    }
    await sql`delete from leads`;
    return {
      ok: true as const,
      deleted: count,
      message:
        count === 0
          ? "No leads to delete."
          : `Deleted ${count} lead(s). Users and inventory kept.`,
    };
  });



export const saveLeaseQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId?: string | null;
      client: ClientQuoteInfo;
      options: LeaseOptionResult[];
      selectedOption?: number;
      status?: string;
      title?: string;
      existingId?: string | null;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const taxRate = taxRateForProvince(data.client.province || "QC");
    const html = buildRetailQuoteHtml(data.client, data.options, taxRate);
    const quoteId = data.existingId || id();
    const payload = {
      client: data.client,
      options: data.options,
      taxRate,
      selectedOption: data.selectedOption ?? 1,
    };
    const title =
      data.title ||
      `Quote ${data.client.clientName || "Client"} · ${data.client.quoteDate || ""}`.trim();
    const pdfName = buildQuotePdfFileName({
      quoteDate: data.client.quoteDate,
      clientName: data.client.clientName,
      option: data.selectedOption ?? 1,
      stock: data.client.stock,
      year: data.client.year,
      make: data.client.make,
      model: data.client.model,
    });
    const pdfData = await makeQuotePdfData(data.client, data.options, taxRate);

    if (data.existingId) {
      await sql`
        update lease_quotes set
          lead_id = ${data.leadId || null},
          client_name = ${data.client.clientName || ""},
          payload = ${JSON.stringify(payload)}::jsonb,
          retail_html = ${html},
          selected_option = ${data.selectedOption ?? 1},
          status = ${data.status || "draft"},
          title = ${title},
          pdf_name = ${pdfName},
          pdf_data = ${pdfData},
          updated_at = now()
        where id = ${data.existingId}
      `;
    } else {
      await sql`
        insert into lease_quotes (
          id, lead_id, created_by, client_name, payload, retail_html, selected_option, status,
          title, pdf_name, pdf_data
        ) values (
          ${quoteId},
          ${data.leadId || null},
          ${me.id},
          ${data.client.clientName || ""},
          ${JSON.stringify(payload)}::jsonb,
          ${html},
          ${data.selectedOption ?? 1},
          ${data.status || "draft"},
          ${title},
          ${pdfName},
          ${pdfData}
        )
      `;
    }

    if (data.leadId) {
      const primary = data.options[(data.selectedOption ?? 1) - 1] || data.options[0];
      await sql`
        update leads set
          quote_sent = true,
          quote_sent_at = coalesce(quote_sent_at, now()),
          quote_notes = ${`Lease quote · payment ${primary ? primary.totalPayment : ""}`},
          guarantor = ${data.client.guarantor || null},
          stage = case when stage in ('new','contacted','paused') then 'quote_sent' else stage end,
          updated_at = now()
        where id = ${data.leadId}
      `;
      // Append to multi-quote file list
      await sql`
        insert into lead_quote_files (
          id, lead_id, quote_id, option_number, file_name, file_data, mime_type, source, created_by
        ) values (
          ${id()}, ${data.leadId}, ${quoteId}, ${data.selectedOption ?? 1},
          ${pdfName}, ${pdfData}, 'application/pdf', 'crm_quote', ${me.id}
        )
      `;
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${id()}, ${data.leadId}, 'quote',
          ${`Saved lease quote instance (${data.options.filter((o) => o.cost > 0 || o.payment > 0).length} option(s)). Open from Saved quotes.`},
          ${me.id}, ${me.name}
        )
      `;
    }
    return { ok: true as const, id: quoteId, html, pdfName, pdfData };
  });

export const listLeaseQuotes = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { leadId?: string } | undefined) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await boot();
    if (data?.leadId) {
      return sql<{
        id: string;
        lead_id: string | null;
        client_name: string;
        title: string | null;
        selected_option: number;
        accepted_option: number | null;
        status: string;
        pdf_name: string | null;
        created_at: string;
      }>`
        select id, lead_id, client_name, title, selected_option, accepted_option, status, pdf_name,
               created_at::text as created_at
        from lease_quotes
        where lead_id = ${data.leadId}
        order by created_at desc
        limit 50
      `;
    }
    return sql<{
      id: string;
      lead_id: string | null;
      client_name: string;
      title: string | null;
      selected_option: number;
      accepted_option: number | null;
      status: string;
      pdf_name: string | null;
      created_at: string;
    }>`
      select id, lead_id, client_name, title, selected_option, accepted_option, status, pdf_name,
             created_at::text as created_at
      from lease_quotes
      order by created_at desc
      limit 50
    `;
  });


export const deleteLeaseQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const rows = await sql<{ id: string; lead_id: string | null; title: string | null }>`
      select id, lead_id, title from lease_quotes where id = ${data.id} limit 1
    `;
    if (!rows[0]) throw new Error("Quote not found");
    const q = rows[0];
    await sql`delete from lead_quote_files where quote_id = ${data.id}`;
    await sql`
      update leads set accepted_quote_id = null
      where accepted_quote_id = ${data.id}
    `;
    await sql`delete from lease_quotes where id = ${data.id}`;
    if (q.lead_id) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${id()}, ${q.lead_id}, 'note',
          ${`Deleted quote: ${q.title || data.id.slice(0, 8)}`},
          ${me.id}, ${me.name}
        )
      `;
    }
    return { ok: true as const };
  });

export const getLeaseQuote = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await boot();
    const rows = await sql<{
      id: string;
      lead_id: string | null;
      client_name: string;
      payload: string;
      retail_html: string | null;
      contract_html: string | null;
      invoice_html: string | null;
      selected_option: number;
      accepted_option: number | null;
      status: string;
      title: string | null;
      pdf_name: string | null;
      pdf_data: string | null;
      created_at: string;
    }>`
      select id, lead_id, client_name, payload::text as payload, retail_html, contract_html, invoice_html,
             selected_option, accepted_option, status, title, pdf_name, pdf_data,
             created_at::text as created_at
      from lease_quotes where id = ${data.id} limit 1
    `;
    if (!rows[0]) throw new Error("Quote not found");
    return rows[0];
  });

export const acceptLeaseQuoteOption = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      quoteId: string;
      optionNumber: number;
      contractStyle?: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const rows = await sql<{
      id: string;
      lead_id: string | null;
      payload: string;
      retail_html: string | null;
    }>`
      select id, lead_id, payload::text as payload, retail_html
      from lease_quotes where id = ${data.quoteId} limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("Quote not found");
    let payload: {
      client: ClientQuoteInfo;
      options: LeaseOptionResult[];
      taxRate: number;
    };
    try {
      payload = JSON.parse(row.payload) as typeof payload;
    } catch {
      throw new Error("Corrupt quote payload");
    }
    const opt = payload.options[data.optionNumber - 1];
    if (!opt) throw new Error("Invalid option number");
    const taxRate = payload.taxRate || taxRateForProvince(payload.client.province || "QC");
    const style = (data.contractStyle || payload.client.contractStyle || "qc_individual_en") as ContractStyleKey;
    await ensureContractTemplates(sql);
    const tplRows = await sql<{ body_html: string }>`
      select body_html from contract_templates where style_key = ${style} limit 1
    `;
    const body =
      tplRows[0]?.body_html || defaultContractBody(style);
    const contractInner = renderContractTemplate(body, payload.client, opt, taxRate);
    const contractHtml = wrapPrintable(`Lease Contract — ${payload.client.clientName}`, contractInner);
    const invoiceHtml = buildFirstInvoiceHtml(payload.client, opt, taxRate);
    // Single-option retail snapshot for contract packet
    const retailOne = buildRetailQuoteHtml(
      payload.client,
      payload.options.map((o, i) =>
        i === data.optionNumber - 1
          ? o
          : { ...o, cost: 0, payment: 0, deposit: 0, residual: 0 },
      ),
      taxRate,
    );
    const pdfName = buildQuotePdfFileName({
      quoteDate: payload.client.quoteDate,
      clientName: payload.client.clientName,
      option: data.optionNumber,
      stock: payload.client.stock,
      year: payload.client.year,
      make: payload.client.make,
      model: payload.client.model,
    });
    const pdfData = await makeQuotePdfData(payload.client, payload.options, taxRate, {
      acceptedOption: data.optionNumber,
    });

    await sql`
      update lease_quotes set
        accepted_option = ${data.optionNumber},
        selected_option = ${data.optionNumber},
        status = 'accepted',
        contract_html = ${contractHtml},
        invoice_html = ${invoiceHtml},
        retail_html = ${retailOne},
        pdf_name = ${pdfName},
        pdf_data = ${pdfData},
        updated_at = now()
      where id = ${data.quoteId}
    `;

    if (row.lead_id) {
      await sql`
        update leads set
          accepted_quote_id = ${data.quoteId},
          quote_sent = true,
          quote_pdf_name = ${pdfName},
          quote_pdf_data = ${pdfData},
          guarantor = ${payload.client.guarantor || null},
          estimated_value = ${opt.cost + opt.extra + opt.profit},
          stage = case when stage in ('new','contacted','paused','quote_sent') then 'quote_sent' else stage end,
          updated_at = now()
        where id = ${row.lead_id}
      `;
      await sql`
        insert into lead_quote_files (
          id, lead_id, quote_id, option_number, file_name, file_data, mime_type, source, created_by
        ) values (
          ${id()}, ${row.lead_id}, ${data.quoteId}, ${data.optionNumber},
          ${pdfName}, ${pdfData}, 'application/pdf', 'accepted_option', ${me.id}
        )
      `;
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${id()}, ${row.lead_id}, 'quote',
          ${`Accepted Option ${data.optionNumber} · total payment ${opt.totalPayment} · contract + 1st invoice generated`},
          ${me.id}, ${me.name}
        )
      `;
    }
    return {
      ok: true as const,
      quoteId: data.quoteId,
      optionNumber: data.optionNumber,
      contractHtml,
      invoiceHtml,
      retailHtml: retailOne,
      pdfName,
      pdfData,
    };
  });

export const listLeadQuoteFiles = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await boot();
    return sql<{
      id: string;
      quote_id: string | null;
      option_number: number | null;
      file_name: string;
      mime_type: string;
      source: string;
      created_at: string;
      has_data: boolean;
    }>`
      select id, quote_id, option_number, file_name, mime_type, source,
             created_at::text as created_at,
             (file_data is not null and length(file_data) > 0) as has_data
      from lead_quote_files
      where lead_id = ${data.leadId}
      order by created_at desc
      limit 100
    `;
  });

export const getLeadQuoteFile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await boot();
    const rows = await sql<{
      id: string;
      file_name: string;
      file_data: string;
      mime_type: string;
    }>`
      select id, file_name, file_data, mime_type from lead_quote_files where id = ${data.id} limit 1
    `;
    if (!rows[0]) throw new Error("File not found");
    return rows[0];
  });

export const readyForBusinessCentral = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string; quoteId?: string | null }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const leadRows = await sql.query<Record<string, unknown>>(
      `select ${leadSelect}
       from leads l
       left join profiles p on p.id = l.assigned_to
       left join inventory i on i.id = l.inventory_id
       where l.id = $1 limit 1`,
      [data.leadId],
    );

    if (!leadRows[0]) throw new Error("Lead not found");
    const lead = mapLead(leadRows[0]);

    let quoteId = data.quoteId || lead.accepted_quote_id;
    if (!quoteId) {
      const q = await sql<{ id: string }>`
        select id from lease_quotes
        where lead_id = ${data.leadId}
        order by case when status = 'accepted' then 0 else 1 end, created_at desc
        limit 1
      `;
      quoteId = q[0]?.id || null;
    }
    if (!quoteId) {
      throw new Error("Save and accept a lease quote before Push to Drive.");
    }
    const qrows = await sql<{
      id: string;
      payload: string;
      pdf_name: string | null;
      pdf_data: string | null;
      retail_html: string | null;
      accepted_option: number | null;
      status: string;
    }>`
      select id, payload::text as payload, pdf_name, pdf_data, retail_html, accepted_option, status
      from lease_quotes where id = ${quoteId} limit 1
    `;
    const quote = qrows[0];
    if (!quote) throw new Error("Quote not found");
    if (!quote.accepted_option) {
      throw new Error("Accept one of the 3 quote options before creating the Drive folder.");
    }
    let payload: { client: ClientQuoteInfo; options: LeaseOptionResult[] };
    try {
      payload = JSON.parse(quote.payload) as typeof payload;
    } catch {
      throw new Error("Corrupt quote");
    }
    const client = payload.client;
    const folderName = buildDealFolderName({
      year: client.year,
      make: client.make,
      model: client.model,
      trim: client.trim,
      lessee: client.clientName || lead.name,
      guarantor: client.guarantor || lead.guarantor || "",
    });
    const now = new Date();
    if (!isDriveConfigured()) {
      throw new Error(
        "Google Drive is not configured. Re-run OAuth with Drive scope and set GOOGLE_DRIVE_REFRESH_TOKEN (or GMAIL_REFRESH_TOKEN with Drive access).",
      );
    }
    const folder = await ensureDealFolder({
      year: now.getFullYear(),
      monthIndex: now.getMonth(),
      folderName,
    });
    const optNum = quote.accepted_option || 1;
    const fileName = buildQuotePdfFileName({
      quoteDate: client.quoteDate,
      clientName: client.clientName,
      option: optNum,
      stock: client.stock,
      year: client.year,
      make: client.make,
      model: client.model,
    });
    // Always rebuild Drive PDF with ONLY the accepted option (never all 3).
    const taxRate = taxRateForProvince(client.province || "QC");
    const pdfData = await makeQuotePdfData(client, payload.options, taxRate, {
      acceptedOption: optNum,
    });
    const mimeType = "application/pdf";
    await sql`
      update lease_quotes set
        pdf_name = ${fileName},
        pdf_data = ${pdfData},
        updated_at = now()
      where id = ${quoteId}
    `;
    let fileMeta: { fileId: string; fileUrl: string } | null = null;
    if (pdfData) {
      fileMeta = await uploadFileToFolder({
        folderId: folder.folderId,
        fileName,
        mimeType,
        data: pdfData,
      });
      await sql`
        update lease_quotes set
          drive_file_id = ${fileMeta.fileId},
          drive_file_url = ${fileMeta.fileUrl},
          pdf_name = ${fileName},
          updated_at = now()
        where id = ${quoteId}
      `;
    }
    await sql`
      update leads set
        stage = 'ready_bc',
        stage_entered_at = now(),
        drive_folder_id = ${folder.folderId},
        drive_folder_url = ${folder.folderUrl},
        accepted_quote_id = ${quoteId},
        updated_at = now()
      where id = ${data.leadId}
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${id()}, ${data.leadId}, 'stage',
        ${`Push to Drive · Drive folder: ${folder.path}`},
        ${me.id}, ${me.name}
      )
    `;
    return {
      ok: true as const,
      folderId: folder.folderId,
      folderUrl: folder.folderUrl,
      path: folder.path,
      fileUrl: fileMeta?.fileUrl || null,
    };
  });

async function ensureContractTemplates(sql: Awaited<ReturnType<typeof boot>>) {
  for (const m of CONTRACT_STYLE_META) {
    const existing = await sql<{ id: string }>`
      select id from contract_templates where style_key = ${m.key} limit 1
    `;
    if (existing[0]) continue;
    await sql`
      insert into contract_templates (id, style_key, label, language, jurisdiction, party_type, body_html)
      values (
        ${id()}, ${m.key}, ${m.label}, ${m.language}, ${m.jurisdiction}, ${m.party_type},
        ${defaultContractBody(m.key)}
      )
    `;
  }
}

export const listContractTemplates = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await boot();
    await ensureContractTemplates(sql);
    return sql<{
      id: string;
      style_key: string;
      label: string;
      language: string;
      jurisdiction: string;
      party_type: string;
      body_html: string;
      updated_at: string;
    }>`
      select id, style_key, label, language, jurisdiction, party_type, body_html,
             updated_at::text as updated_at
      from contract_templates
      order by label
    `;
  });

export const updateContractTemplate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { styleKey: string; bodyHtml: string; label?: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireAdmin(context.userId);
    const sql = await boot();
    await ensureContractTemplates(sql);
    await sql`
      update contract_templates set
        body_html = ${data.bodyHtml},
        label = coalesce(${data.label || null}, label),
        updated_by = ${me.id},
        updated_at = now()
      where style_key = ${data.styleKey}
    `;
    return { ok: true as const };
  });

export const driveHealth = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireProfile(context.userId);
    return probeDrive();
  });
