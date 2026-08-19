import { createServerFn } from "@tanstack/react-start";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { syncRealInventory } from "./seed";
import { permissionsForRole } from "./permissions";
import { parseLeadEmail } from "./parse-email";
import { PAUL_MOTOR_INVENTORY_SOURCE } from "./real-inventory";
import { getEmailImportStatus, runEmailImport } from "./import-emails";
import { isPartnerKind, mapPartner, type Partner, type PartnerKind } from "./partners";
import { attachUnmatchedLeaseApp, listUnmatchedLeaseApps } from "./lease-app-import";
import { applyAcceptedOption } from "./quote-accept";
import { sendCrmEmail, clientFacingFromName, replyToForActor } from "./mail";
import { publicAppUrl } from "./public-url";
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
/** Drive helpers + googleapis are loaded only when Push-to-Drive runs. */
async function driveApi() {
  return import("./google-drive");
}

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

function realGuarantorLabel(v: unknown): string | null {
  const s = String(v || "").trim();
  if (!s || /^n\/?a$/i.test(s) || s === "-") return null;
  return s;
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

const bootGlobal = globalThis as typeof globalThis & {
  __crmSeedOk__?: boolean;
  __crmSeedP__?: Promise<void>;
};

/**
 * Hot path: open SQL only. Seed staff at most once per process.
 * Never syncs website inventory here (that belongs on admin refresh).
 */
async function boot() {
  const sql = await getSql();
  if (bootGlobal.__crmSeedOk__) return sql;
  bootGlobal.__crmSeedP__ ??= (async () => {
    // Dynamic import keeps seed/real-inventory off the cold path when already seeded
    const { ensureCrmSeeded } = await import("./seed");
    await ensureCrmSeeded(sql, { syncInventory: false });
    bootGlobal.__crmSeedOk__ = true;
  })().catch((err) => {
    bootGlobal.__crmSeedP__ = undefined;
    throw err;
  });
  await bootGlobal.__crmSeedP__;
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
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
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

function isAdminRole(p: Profile): boolean {
  return p.role === "admin";
}

/** Staff who see all leads (not ownership-scoped). */
function isElevatedStaff(p: Profile): boolean {
  return (
    p.role === "admin" ||
    p.role === "gsm" ||
    p.role === "credit_manager" ||
    p.role === "compliance" ||
    p.role === "accounting"
  );
}


/** Default owner for *unassigned* inventory leads: Lucas Legatos. Never steals an existing owner. */
export async function resolveLucasProfileId(
  sql: Awaited<ReturnType<typeof boot>>,
): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    select id from profiles
    where active = true
      and (
        lower(email) = 'lucasl@paulmotorcompany.com'
        or lower(name) like 'lucas%'
      )
    order by case when lower(email) = 'lucasl@paulmotorcompany.com' then 0 else 1 end
    limit 1
  `;
  return rows[0]?.id ?? null;
}

/** Default owner for Facebook Marketplace leads: Alex Hudon. */
export async function resolveAlexProfileId(
  sql: Awaited<ReturnType<typeof boot>>,
): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    select id from profiles
    where active = true
      and (
        lower(email) = 'alexh@paulmotorcompany.com'
        or lower(name) like 'alex hudon%'
        or lower(name) like 'alex%'
      )
    order by case when lower(email) = 'alexh@paulmotorcompany.com' then 0 else 1 end
    limit 1
  `;
  return rows[0]?.id ?? null;
}
function canAccessLead(me: Profile, assignedTo: string | null | undefined): boolean {
  if (isElevatedStaff(me)) return true;
  if (assignedTo == null || assignedTo === "") return true;
  return assignedTo === me.id;
}


function mapLead(r: Record<string, unknown>): Lead {
  const lt = String(r.lead_type || "inventory");
  return {
    id: String(r.id),
    name: String(r.name),
    first_name: (r.first_name as string) ?? null,
    last_name: (r.last_name as string) ?? null,
    party_type: (r.party_type as Lead["party_type"]) || "individual",
    phone: (r.phone as string) ?? null,
    email: (r.email as string) ?? null,
    source: String(r.source),
    lead_type: isLeadType(lt) ? lt : "inventory",
    credit_status: (r.credit_status as string) ?? "none",
    credit_app_id: (r.credit_app_id as string) ?? null,
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
    destination: (r.destination as string) ?? null,
    partner_id: (r.partner_id as string) ?? null,
    partner_name: (r.partner_name as string) ?? null,
    partner_kind: (r.partner_kind as string) ?? null,
  };
}

const leadSelect = `
  l.id, l.name, l.first_name, l.last_name, l.party_type, l.credit_status, l.credit_app_id, l.phone, l.email, l.source, l.lead_type, l.notes, l.vehicle_interest,
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
  l.destination,
  l.partner_id,
  (select name from partners where id = l.partner_id) as partner_name,
  (select kind from partners where id = l.partner_id) as partner_kind,
  l.created_by,
  l.created_at::text as created_at,
  l.updated_at::text as updated_at,
  p.name as assigned_name,
  case when i.id is not null
    then trim(both ' ' from concat(i.year, ' ', i.make, ' ', i.model, ' ', coalesce(i.trim, '')))
    else null end as inventory_label
`;

/** List/pipeline queries — omit multi-MB PDF/email blobs. */
const leadListSelect = `
  l.id, l.name, l.first_name, l.last_name, l.party_type, l.credit_status, l.credit_app_id, l.phone, l.email, l.source, l.lead_type, l.notes, l.vehicle_interest,
  l.inventory_id, l.assigned_to, l.stage,
  l.stage_entered_at::text as stage_entered_at,
  l.quote_sent, l.quote_sent_at::text as quote_sent_at,
  l.quote_link, l.quote_notes, l.quote_pdf_name,
  null::text as quote_pdf_data, null::text as source_email_raw,
  l.guarantor, l.legal_entity_name, l.drive_folder_id, l.drive_folder_url, l.accepted_quote_id,
  l.email_portal, l.gmail_message_id,
  l.pause_until::text as pause_until, l.pause_note, l.stage_before_pause,
  l.google_review_status,
  l.google_review_at::text as google_review_at,
  l.google_review_link,
  l.estimated_value::float8 as estimated_value,
  l.destination,
  l.partner_id,
  (select name from partners where id = l.partner_id) as partner_name,
  (select kind from partners where id = l.partner_id) as partner_kind,
  l.created_by,
  l.created_at::text as created_at,
  l.updated_at::text as updated_at,
  p.name as assigned_name,
  case when i.id is not null
    then trim(both ' ' from concat(i.year, ' ', i.make, ' ', i.model, ' ', coalesce(i.trim, '')))
    else null end as inventory_label
`;


export const updateOwnAvatar = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { avatar_url: string | null }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const url = data.avatar_url?.trim() || null;
    if (url && url.length > 400_000) {
      throw new Error("Image too large — use a smaller photo");
    }
    if (url && !url.startsWith("data:image/")) {
      throw new Error("Photo must be an image");
    }
    await sql`
      update profiles set avatar_url = ${url}, updated_at = now() where id = ${me.id}
    `;
    // Never copy the data-URL onto Better Auth's user.image — it gets
    // stuffed into the session cookie and Vercel 494s (headers too large).
    const rows = await sql<Profile>`
      select id, user_id, email, name, role, active, phone, title,
             avatar_url, created_at::text as created_at, updated_at::text as updated_at
      from profiles where id = ${me.id}
    `;
    return rows[0]!;
  });

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
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
        from profiles order by
          case role when 'admin' then 0 when 'gsm' then 1 when 'credit_manager' then 2 when 'rep' then 3 else 4 end, name
      `;
    }
    return sql<Profile>`
      select id, user_id, email, name, role, active, phone, title,
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
      from profiles where active = true
      order by case role when 'admin' then 0 when 'gsm' then 1 when 'credit_manager' then 2 when 'rep' then 3 else 4 end, name
    `;
  });

export const listInventory = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { q?: string; status?: string } | undefined) => data ?? {})
  .handler(async ({ context, data }): Promise<InventoryItem[]> => {
    const me = await requireProfile(context.userId);
    const perms = await permissionsForRole(me.role);
    if (me.role !== "admin" && !perms.has("inventory.view")) {
      throw new Error("Inventory access required");
    }
    const showCosts = me.role === "admin" || perms.has("inventory.costs");
    const sql = await boot();
    const q = data.q?.trim() ? `%${data.q.trim().toLowerCase()}%` : null;
    const status = data.status && data.status !== "all" ? data.status : null;
    const rows = await sql<InventoryItem>`
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
    if (showCosts) return rows;
    return rows.map((r) => ({ ...r, price: null }));
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

export type ListLeadsResult = {
  leads: Lead[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export const listLeads = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    (
      data:
        | {
            stage?: string;
            q?: string;
            assigned?: string;
            lead_type?: string;
            partner?: string;
            /** page size (default 50, max 200) */
            limit?: number;
            offset?: number;
          }
        | undefined,
    ) => data ?? {},
  )
  .handler(async ({ context, data }): Promise<ListLeadsResult> => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const stage = data.stage && data.stage !== "all" ? data.stage : null;
    const leadType = data.lead_type && data.lead_type !== "all" ? data.lead_type : null;
    const partnerId = data.partner && data.partner !== "all" ? data.partner : null;
    const q = data.q?.trim() ? `%${data.q.trim().toLowerCase()}%` : null;
    const admin = isElevatedStaff(me);
    const perms = await permissionsForRole(me.role);
    const canEarly = me.role === "admin" || perms.has("leads.early");
    const canLate = me.role === "admin" || perms.has("leads.late");
    const stageAllow: string[] | null =
      canEarly && canLate
        ? null
        : canLate
          ? ["lease_accepted", "credit_review", "ready_bc", "won", "lost"]
          : canEarly
            ? ["new", "contacted", "paused", "quote_sent", "lost"]
            : [];

    let assignedFilter: string | null = null;
    let unassignedOnly = false;
    if (admin) {
      if (data.assigned === "unassigned") unassignedOnly = true;
      else if (data.assigned && data.assigned !== "all") assignedFilter = data.assigned;
    } else {
      if (data.assigned === "unassigned") unassignedOnly = true;
      else if (data.assigned && data.assigned !== "all" && data.assigned !== me.id) {
        assignedFilter = "__none__";
      } else if (data.assigned === me.id) {
        assignedFilter = me.id;
      }
    }

    if (stageAllow && stage && !stageAllow.includes(stage)) {
      return { leads: [], total: 0, limit: 50, offset: 0, hasMore: false };
    }

    const limit = Math.min(200, Math.max(1, Number(data.limit) || 50));
    const offset = Math.max(0, Number(data.offset) || 0);

    const whereSql = `
       from leads l
       left join profiles p on p.id = l.assigned_to
       left join inventory i on i.id = l.inventory_id
       left join partners pr on pr.id = l.partner_id
       where ($1::text is null or l.stage = $1)
         and (
           $5::boolean = true
           or l.assigned_to is null
           or l.assigned_to = $6
         )
         and (
           case
             when $7::boolean then l.assigned_to is null
             when $2::text is not null then l.assigned_to = $2
             else true
           end
         )
         and ($3::text is null or l.lead_type = $3)
         and (
           $4::text is null
           or lower(l.name) like $4
           or lower(coalesce(l.first_name, '')) like $4
           or lower(coalesce(l.last_name, '')) like $4
           or lower(coalesce(l.legal_entity_name, '')) like $4
           or lower(coalesce(l.email, '')) like $4
           or lower(coalesce(l.phone, '')) like $4
           or lower(coalesce(l.vehicle_interest, '')) like $4
           or lower(coalesce(l.notes, '')) like $4
           or lower(coalesce(i.stock_number, '')) like $4
           or lower(coalesce(i.vin, '')) like $4
           or lower(coalesce(i.make, '') || ' ' || coalesce(i.model, '')) like $4
           or lower(coalesce(pr.name, '')) like $4
         )
         and ($9::text is null or l.partner_id = $9)
         and (
           $8::text[] is null
           or l.stage = any($8::text[])
         )`;
    const params = [
      stage,
      assignedFilter,
      leadType,
      q,
      admin,
      me.id,
      unassignedOnly,
      stageAllow,
      partnerId,
    ];

    const countRows = await sql.query<{ n: number }>(
      `select count(*)::int as n ${whereSql}`,
      params,
    );
    const total = countRows[0]?.n ?? 0;

    const rows = await sql.query<Record<string, unknown>>(
      `select ${leadListSelect}
       ${whereSql}
       order by l.updated_at desc
       limit $10 offset $11`,
      [...params, limit, offset],
    );
    const leads = rows.map(mapLead);
    return {
      leads,
      total,
      limit,
      offset,
      hasMore: offset + leads.length < total,
    };
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
         left join partners pr on pr.id = l.partner_id
         where l.id = $1 limit 1`,
        [leadId],
      );
      if (!rows[0]) return null;
      const me = await requireProfile(context.userId);
      const assignedTo = (rows[0].assigned_to as string | null) ?? null;
      if (!canAccessLead(me, assignedTo)) {
        throw new Error("You do not have access to this lead");
      }
      const perms = await permissionsForRole(me.role);
      const stage = String(rows[0].stage || "");
      const early = ["new", "contacted", "paused", "quote_sent"].includes(stage);
      if (me.role !== "admin") {
        if (early && !perms.has("leads.early")) {
          throw new Error("Your role cannot open early-stage leads");
        }
        if (!early && !perms.has("leads.late") && stage !== "lost") {
          // lost allowed if either early or late
          if (!perms.has("leads.early") && !perms.has("leads.late")) {
            throw new Error("Your role cannot open leads");
          }
          if (!perms.has("leads.late")) {
            throw new Error("Your role cannot open late-stage leads");
          }
        }
      }
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
  first_name?: string;
  last_name?: string;
  party_type?: "individual" | "business";
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
  destination?: string | null;
  legal_entity_name?: string | null;
  partner_id?: string | null;
};


export const listPartners = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { activeOnly?: boolean } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<Partner[]> => {
    const sql = await boot();
    const rows = data.activeOnly === false
      ? await sql<Record<string, unknown>>`
          select id, name, kind, city, province, email, phone, notes, active,
                 created_at::text as created_at, updated_at::text as updated_at
          from partners order by kind, lower(name)
        `
      : await sql<Record<string, unknown>>`
          select id, name, kind, city, province, email, phone, notes, active,
                 created_at::text as created_at, updated_at::text as updated_at
          from partners where active = true order by kind, lower(name)
        `;
    return rows.map(mapPartner);
  });

export const createPartner = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { name: string; kind?: string; city?: string; province?: string; email?: string }) => data)
  .handler(async ({ data }): Promise<Partner> => {
    const sql = await boot();
    const name = data.name.trim();
    if (name.length < 2) throw new Error("Partner name is required");
    const kind: PartnerKind = isPartnerKind(data.kind || "") ? data.kind as PartnerKind : "dealer";
    const existing = await sql<Record<string, unknown>>`
      select id, name, kind, city, province, email, phone, notes, active,
             created_at::text as created_at, updated_at::text as updated_at
      from partners where lower(btrim(name)) = ${name.toLowerCase()} limit 1
    `;
    if (existing[0]) {
      if (existing[0].active === false) {
        await sql`update partners set active = true, kind = ${kind}, updated_at = now() where id = ${String(existing[0].id)}`;
        existing[0].active = true;
        existing[0].kind = kind;
      }
      return mapPartner(existing[0]);
    }
    const id = crypto.randomUUID();
    await sql`
      insert into partners (id, name, kind, city, province, email)
      values (${id}, ${name}, ${kind}, ${data.city?.trim() || null}, ${data.province?.trim() || null}, ${data.email?.trim().toLowerCase() || null})
    `;
    const rows = await sql<Record<string, unknown>>`
      select id, name, kind, city, province, email, phone, notes, active,
             created_at::text as created_at, updated_at::text as updated_at
      from partners where id = ${id}
    `;
    return mapPartner(rows[0]!);
  });

export const captureLead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: CaptureLeadInput) => data)
  .handler(async ({ context, data }): Promise<Lead> => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const name = data.name.trim();
    if (!name) throw new Error("Name is required");
    const nameParts = name.split(/\s+/).filter(Boolean);
    const firstName = (data as { first_name?: string }).first_name?.trim()
      || nameParts[0]
      || name;
    const lastName = (data as { last_name?: string }).last_name?.trim()
      || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : "");
    const partyType =
      (data as { party_type?: string }).party_type === "business"
        ? "business"
        : data.lead_type === "lease" && /business|entreprise/i.test(data.source || "")
          ? "business"
          : "individual";
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
    const lucasId = await resolveLucasProfileId(sql);
    const alexId = await resolveAlexProfileId(sql);
    const source = String(data.source || "").toLowerCase();
    let assigned = data.assigned_to || null;
    if (source === "marketplace") {
      assigned = alexId || assigned || me.id;
    } else if (!assigned) {
      // Inventory → Lucas; general / consignment → unassigned (GSM/Admin)
      if ((leadType === "inventory" || leadType === "cash" || leadType === "wholesale") && lucasId) assigned = lucasId;
      else if (leadType === "general" || leadType === "consignment") assigned = null;
      else assigned = me.id;
    }

    await sql`
      insert into leads (
        id, name, first_name, last_name, party_type, legal_entity_name, phone, email, source, lead_type, notes, vehicle_interest, inventory_id,
        assigned_to, stage, stage_entered_at, quote_sent, quote_sent_at,
        quote_link, quote_notes, quote_pdf_name, quote_pdf_data, source_email_raw,
        estimated_value, destination, partner_id, created_by
      ) values (
        ${leadId}, ${name}, ${firstName}, ${lastName}, ${partyType}, ${partyType === "business" ? data.legal_entity_name?.trim() || null : null}, ${data.phone?.trim() || null},
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
        ${data.destination?.trim() || null},
        ${data.partner_id || null},
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
        const appUrl = publicAppUrl();
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
      credit_status?: string | null;
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
    const prevAssignedCheck =
      prev.assigned_to == null || prev.assigned_to === ""
        ? null
        : String(prev.assigned_to);
    if (!canAccessLead(me, prevAssignedCheck)) {
      throw new Error("You do not have access to this lead");
    }

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

    const nextFirst =
      data.first_name !== undefined
        ? data.first_name?.trim() || null
        : (prev.first_name as string | null) ?? null;
    const nextLast =
      data.last_name !== undefined
        ? data.last_name?.trim() || null
        : (prev.last_name as string | null) ?? null;
    const nextParty =
      data.party_type === "business" || data.party_type === "individual"
        ? data.party_type
        : (prev.party_type as string) || "individual";
    const displayName =
      data.name?.trim() ||
      [nextFirst, nextLast].filter(Boolean).join(" ") ||
      String(prev.name);

    await sql`
      update leads set
        name = ${displayName},
        first_name = ${nextFirst},
        last_name = ${nextLast},
        party_type = ${nextParty},
        legal_entity_name = ${
          data.legal_entity_name !== undefined
            ? (nextParty === "business" ? data.legal_entity_name?.trim() || null : null)
            : nextParty === "business"
              ? (prev.legal_entity_name as string | null)
              : null
        },
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
        destination = ${
          data.destination !== undefined
            ? data.destination?.trim() || null
            : (prev.destination as string | null)
        },
        partner_id = ${
          data.partner_id !== undefined
            ? data.partner_id || null
            : (prev.partner_id as string | null)
        },
        assigned_to = ${nextAssigned},
        stage = ${stage},
        credit_status = ${
          data.credit_status !== undefined
            ? data.credit_status || "none"
            : (prev.credit_status as string | null) || "none"
        },
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

    const nextCredit =
      data.credit_status !== undefined
        ? data.credit_status || "none"
        : (prev.credit_status as string | null) || "none";
    if (stage === "ready_bc" || nextCredit === "approved") {
      const { ensureComplianceChecklist } = await import("./compliance");
      await ensureComplianceChecklist(sql, data.id);
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
          const appUrl = publicAppUrl();
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
    const existing = await sql<{ id: string; name: string; assigned_to: string | null }>`
      select id, name, assigned_to from leads where id = ${data.id} limit 1
    `;
    if (!existing[0]) throw new Error("Lead not found");
    if (!canAccessLead(me, existing[0].assigned_to)) {
      throw new Error("You do not have access to this lead");
    }

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
      update leads set
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
    const admin = isAdminRole(me);
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
        (select count(*)::int from lease_quotes lq
          where ${admin} or exists (
            select 1 from leads lx where lx.id = lq.lead_id
              and (lx.assigned_to is null or lx.assigned_to = ${me.id})
          ) or lq.lead_id is null
        ) as drives,
        count(*) filter (where lead_type = 'inventory')::int as inventory_leads,
        count(*) filter (where lead_type = 'lease')::int as lease_leads,
        count(*) filter (where lead_type = 'general')::int as general_leads
      from leads
      where ${admin} or assigned_to is null or assigned_to = ${me.id}
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
       where ($1::boolean = true or l.assigned_to is null or l.assigned_to = $2)
       order by l.created_at desc limit 8`,
      [admin, me.id],
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
    await requireAdmin(context.userId);
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
      where p.active = true and p.role in ('rep', 'broker', 'admin', 'gsm', 'credit_manager')
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

/** One-shot / admin: assign *unassigned* inventory leads to Lucas. Never steals an existing owner. */
export const sweepInventoryToLucas = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const me = await requireProfile(context.userId);
    // Admins always; also allow any authenticated run once from deploy/boot tools
    if (!isAdminRole(me) && me.email.toLowerCase() !== "lucasl@paulmotorcompany.com") {
      await requireAdmin(context.userId);
    }
    const sql = await boot();
    const lucasId = await resolveLucasProfileId(sql);
    if (!lucasId) throw new Error("Lucas profile not found (lucasl@paulmotorcompany.com)");
    const r = await sql<{ n: number }>`
      with u as (
        update leads set assigned_to = ${lucasId}, updated_at = now()
        where lead_type = 'inventory'
          and coalesce(source, '') is distinct from 'marketplace'
          and assigned_to is null
        returning id
      )
      select count(*)::int as n from u
    `;
    return { ok: true as const, updated: r[0]?.n ?? 0, lucasId };
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
      where p.role in ('rep', 'broker', 'admin', 'gsm', 'credit_manager') and p.active = true
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


export const listUnmatchedLeaseAppsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const me = await requireProfile(context.userId);
    if (!isElevatedStaff(me)) throw new Error("Not allowed");
    const sql = await boot();
    return listUnmatchedLeaseApps(sql);
  });

export const attachUnmatchedLeaseAppFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { importId: string; leadId: string; capacity?: "primary" | "guarantor1" | "guarantor2" }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!isElevatedStaff(me)) throw new Error("Not allowed");
    const sql = await boot();
    return attachUnmatchedLeaseApp(sql, data);
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
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
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
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
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
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
      from profiles where id = ${data.id}
    `;
    return rows[0]!;
  });


export const changeOwnPassword = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: { currentPassword: string; newPassword: string }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!me.user_id) throw new Error("Account not linked — ask an admin to reset your password");
    const current = (data.currentPassword || "").trim();
    const next = (data.newPassword || "").trim();
    if (current.length < 1) throw new Error("Current password is required");
    if (next.length < 8) throw new Error("New password must be at least 8 characters");
    if (current === next) throw new Error("New password must be different from current password");
    const sql = await boot();
    const acc = await sql<{ id: string; password: string | null }>`
      select id, password from account
      where "userId" = ${me.user_id} and "providerId" = 'credential'
      limit 1
    `;
    if (!acc[0]?.password) throw new Error("No password login on this account");
    const ok = await verifyPassword({
      hash: acc[0].password,
      password: current,
    });
    if (!ok) throw new Error("Current password is incorrect");
    const passwordHash = await hashPassword(next);
    await sql`
      update account set password = ${passwordHash}, "updatedAt" = now()
      where id = ${acc[0].id}
    `;
    return { ok: true as const };
  });

export const emailFirstInvoice = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: { quoteId: string; toEmail?: string; note?: string }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await boot();
    const rows = await sql<{
      id: string;
      lead_id: string | null;
      client_name: string;
      invoice_html: string | null;
      payload: string;
      accepted_option: number | null;
    }>`
      select id, lead_id, client_name, invoice_html, payload::text as payload, accepted_option
      from lease_quotes where id = ${data.quoteId} limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("Quote not found");
    let invoiceHtml = row.invoice_html;
    let clientEmail = "";
    let clientName = row.client_name || "Client";
    try {
      const payload = JSON.parse(row.payload) as {
        client: { email?: string; clientName?: string };
        options: unknown[];
        taxRate?: number;
      };
      clientEmail = (payload.client?.email || "").trim();
      clientName = payload.client?.clientName || clientName;
      if (!invoiceHtml && row.accepted_option && payload.options?.length) {
        const { buildFirstInvoiceHtml, taxRateForProvince } = await import("./lease-quote");
        const opt = payload.options[row.accepted_option - 1] as import("./lease-quote").LeaseOptionResult;
        if (opt) {
          const tax = payload.taxRate || taxRateForProvince((payload.client as { province?: string })?.province || "QC");
          invoiceHtml = buildFirstInvoiceHtml(payload.client as import("./lease-quote").ClientQuoteInfo, opt, tax);
        }
      }
    } catch {
      /* use row fields */
    }
    if (!invoiceHtml) {
      throw new Error("No first invoice on this quote yet — accept an option first.");
    }
    const to = (data.toEmail || clientEmail || "").trim().toLowerCase();
    if (!to || !to.includes("@")) {
      throw new Error("Client email is required to send the first invoice.");
    }
    const note = (data.note || "").trim();
    const subject = `Paul Motor Leasing — Pro forma first invoice · ${clientName}`;
    const text =
      `Hi ${clientName},\n\n` +
      `Please find your pro forma first invoice from Paul Motor Leasing below` +
      (note ? `.\n\nNote: ${note}` : ".") +
      `\n\nIf you have questions, reply to this email or call your sales rep (${me.name}).\n\n— ${me.name}\nPaul Motor Leasing`;
    // Wrap invoice HTML in a simple email shell
    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111">` +
      `<p>Hi ${clientName.replace(/</g, "")},</p>` +
      `<p>Please find your <strong>pro forma first invoice</strong> from Paul Motor Leasing below.` +
      (note ? `</p><p><em>${note.replace(/</g, "")}</em></p><p>` : " ") +
      `Questions? Contact ${me.name.replace(/</g, "")}.</p>` +
      `</div><hr style="border:none;border-top:1px solid #ddd;margin:16px 0"/>` +
      invoiceHtml;

    const result = await sendCrmEmail(sql, {
      to,
      subject,
      text,
      html,
      kind: "first_invoice",
      leadId: row.lead_id,
      profileId: me.id,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
    });
    if (row.lead_id) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${id()}, ${row.lead_id}, 'email',
          ${`First invoice emailed to ${to}${result.ok ? "" : " (queued/failed: " + (result.error || result.via) + ")"} · by ${me.name}`},
          ${me.id}, ${me.name}
        )
      `;
    }
    if (!result.ok && result.via === "outbox") {
      throw new Error(result.error || "Email queued — Resend not configured");
    }
    if (!result.ok) throw new Error(result.error || "Email failed");
    return { ok: true as const, to, via: result.via };
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
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
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
      /** Only Share quote should set Quote Sent (not silent save / back-to-lead). */
      markQuoteSent?: boolean;
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
    const pdfName = (await driveApi()).buildQuotePdfFileName({
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
      if (data.markQuoteSent) {
        await sql`
          update leads set
            quote_sent = true,
            quote_sent_at = coalesce(quote_sent_at, now()),
            quote_notes = ${`Lease quote shared · payment ${primary ? primary.totalPayment : ""}`},
            guarantor = coalesce(${realGuarantorLabel(data.client.guarantor)}, guarantor),
            stage = case when stage in ('new','contacted','paused') then 'quote_sent' else stage end,
            stage_entered_at = case when stage in ('new','contacted','paused') then now() else stage_entered_at end,
            updated_at = now()
          where id = ${data.leadId}
        `;
        await sql`
          insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
          values (
            ${id()}, ${data.leadId}, 'quote',
            ${`Quote shared with customer (PDF) · ${title}`},
            ${me.id}, ${me.name}
          )
        `;
      } else {
        await sql`
          update leads set
            guarantor = coalesce(${realGuarantorLabel(data.client.guarantor)}, guarantor),
            updated_at = now()
          where id = ${data.leadId}
        `;
      }
      // File list entry only when Share quote (not silent save / Back to lead)
      if (data.markQuoteSent) {
        await sql`
          insert into lead_quote_files (
            id, lead_id, quote_id, option_number, file_name, file_data, mime_type, source, created_by
          ) values (
            ${id()}, ${data.leadId}, ${quoteId}, ${data.selectedOption ?? 1},
            ${pdfName}, ${pdfData}, 'application/pdf', 'shared_quote', ${me.id}
          )
        `;
      }
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
    return applyAcceptedOption(sql, {
      quoteId: data.quoteId,
      optionNumber: data.optionNumber,
      contractStyle: data.contractStyle,
      actorName: me.name,
      actorId: me.id,
      byKind: "staff",
    });
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
    type QuoteRow = {
      id: string;
      payload: string;
      pdf_name: string | null;
      pdf_data: string | null;
      retail_html: string | null;
      contract_html: string | null;
      invoice_html: string | null;
      contract_pdf_name: string | null;
      contract_pdf_data: string | null;
      accepted_option: number | null;
      status: string;
    };
    let quote: QuoteRow | undefined;
    try {
      const qrows = await sql<QuoteRow>`
        select id, payload::text as payload, pdf_name, pdf_data, retail_html,
               contract_html, invoice_html,
               contract_pdf_name, contract_pdf_data,
               accepted_option, status
        from lease_quotes where id = ${quoteId} limit 1
      `;
      quote = qrows[0];
    } catch {
      const fallback = await sql<{
        id: string;
        payload: string;
        pdf_name: string | null;
        pdf_data: string | null;
        retail_html: string | null;
        contract_html: string | null;
        invoice_html: string | null;
        accepted_option: number | null;
        status: string;
      }>`
        select id, payload::text as payload, pdf_name, pdf_data, retail_html,
               contract_html, invoice_html, accepted_option, status
        from lease_quotes where id = ${quoteId} limit 1
      `;
      if (fallback[0]) {
        quote = {
          ...fallback[0],
          contract_pdf_name: null,
          contract_pdf_data: null,
        };
      }
    }
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
    const personName = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || lead.name || "";
    const companyName = (lead.legal_entity_name || "").trim();
    const folderName = (await driveApi()).buildDealFolderName({
      year: client.year,
      make: client.make,
      model: client.model,
      trim: client.trim,
      lessee: client.clientName || lead.name,
      guarantor: client.guarantor || lead.guarantor || "",
      companyName,
      contactName: personName,
      isBusiness: lead.party_type === "business" || Boolean(companyName),
    });
    const now = new Date();
    if (!(await driveApi()).isDriveConfigured()) {
      throw new Error(
        "Google Drive is not configured. Re-run OAuth with Drive scope and set GOOGLE_DRIVE_REFRESH_TOKEN (or GMAIL_REFRESH_TOKEN with Drive access).",
      );
    }
    const folder = await (await driveApi()).ensureDealFolder({
      year: now.getFullYear(),
      monthIndex: now.getMonth(),
      folderName,
    });
    const optNum = quote.accepted_option || 1;
    const taxRate = taxRateForProvince(client.province || "QC");
    const uploaded: Array<{
      name: string;
      url: string;
      kind: string;
      fileId: string;
      replaced: boolean;
    }> = [];
    const errors: string[] = [];

    function extFromMime(mime: string, nameHint = ""): string {
      const fromName = nameHint.match(/(\.[a-zA-Z0-9]{2,5})$/)?.[1];
      if (fromName) return fromName.toLowerCase();
      const m = (mime || "").toLowerCase();
      if (m.includes("pdf")) return ".pdf";
      if (m.includes("png")) return ".png";
      if (m.includes("webp")) return ".webp";
      if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
      if (m.includes("html")) return ".html";
      if (m.includes("gif")) return ".gif";
      return "";
    }

    async function pushOne(
      kind: string,
      fileName: string,
      mimeType: string,
      data: string,
    ) {
      // Never push HTML snapshots — Drive package is PDF/docs only
      const mime = (mimeType || "").toLowerCase();
      if (
        mime.includes("html") ||
        mime.includes("text/plain") ||
        /\.html?$/i.test(fileName)
      ) {
        return;
      }
      try {
        const name = (await driveApi()).safeDriveFileName(fileName);
        const res = await (await driveApi()).uploadOrReplaceFile({
          folderId: folder.folderId,
          fileName: name,
          mimeType,
          data,
        });
        uploaded.push({
          name,
          url: res.fileUrl,
          kind,
          fileId: res.fileId,
          replaced: res.replaced,
        });
      } catch (e) {
        errors.push(
          `${kind}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
        );
      }
    }

    // 1) Accepted lease quote PDF — the main file for a quote-only push
    const quoteFileName = (await driveApi()).buildQuotePdfFileName({
      quoteDate: client.quoteDate,
      clientName: client.clientName,
      option: optNum,
      stock: client.stock,
      year: client.year,
      make: client.make,
      model: client.model,
    });
    const pdfData = await makeQuotePdfData(client, payload.options, taxRate, {
      acceptedOption: optNum,
    });
    if (pdfData) {
      await sql`
        update lease_quotes set
          pdf_name = ${quoteFileName},
          pdf_data = ${pdfData},
          updated_at = now()
        where id = ${quoteId}
      `;
      await pushOne(
        "quote",
        "01-Accepted-Quote.pdf",
        "application/pdf",
        pdfData,
      );
      try {
        const fileMeta = uploaded.find((u) => u.kind === "quote");
        if (fileMeta) {
          await sql`
            update lease_quotes set
              drive_file_id = ${fileMeta.fileId},
              drive_file_url = ${fileMeta.url},
              pdf_name = ${quoteFileName},
              updated_at = now()
            where id = ${quoteId}
          `;
        }
      } catch {
        /* non-fatal */
      }
    }

    // 2) Lease contract PDF only — never the HTML draft / invoice / retail HTML
    if (quote.contract_pdf_data) {
      await pushOne(
        "contract",
        "02-Lease-Contract.pdf",
        "application/pdf",
        quote.contract_pdf_data,
      );
    }

    // 3) Extra lead quote files — PDFs only; skip accepted_option / contract duplicates
    try {
      const quoteFiles = await sql<{
        id: string;
        file_name: string;
        file_data: string;
        mime_type: string;
        source: string;
        option_number: number | null;
      }>`
        select id, file_name, file_data, mime_type, source, option_number
        from lead_quote_files
        where lead_id = ${data.leadId}
        order by created_at asc
      `;
      const latestByKey = new Map<string, (typeof quoteFiles)[0]>();
      for (const f of quoteFiles) {
        if (!f.file_data) continue;
        if (f.source === "lease_contract" || f.source === "accepted_option") continue;
        const mime = (f.mime_type || "").toLowerCase();
        if (mime.includes("html") || /\.html?$/i.test(f.file_name || "")) continue;
        const key = `extra-${f.source || "upload"}-${(f.file_name || "file").toLowerCase()}`;
        latestByKey.set(key, f);
      }
      let i = 0;
      for (const f of latestByKey.values()) {
        i += 1;
        const norm = (await driveApi()).normalizeUploadPayload(
          f.file_data,
          f.mime_type || "application/pdf",
        );
        if (!norm) continue;
        if ((norm.mimeType || "").toLowerCase().includes("html")) continue;
        const base = (f.file_name || "file").replace(/^05-Extra-\d+-/, "");
        await pushOne(
          `quote_file:${f.source}`,
          `05-Extra-${String(i).padStart(2, "0")}-${base}`,
          norm.mimeType,
          norm.dataUrl,
        );
      }
    } catch {
      /* table may be empty / missing */
    }

    // 4) Lead-level attached quote PDF only if accepted CRM quote was not pushed
    if (lead.quote_pdf_data && !uploaded.some((u) => u.kind === "quote")) {
      const norm = (await driveApi()).normalizeUploadPayload(
        lead.quote_pdf_data,
        "application/pdf",
      );
      if (norm && !(norm.mimeType || "").toLowerCase().includes("html")) {
        await pushOne(
          "lead_quote_pdf",
          `06-Lead-Attached-Quote${extFromMime(norm.mimeType, lead.quote_pdf_name || "") || ".pdf"}`,
          norm.mimeType,
          norm.dataUrl,
        );
      }
    }

    // 5) Credit documents — PDFs/images only (no HTML)
    try {
      const docs = await sql<{
        id: string;
        kind: string;
        file_name: string;
        mime_type: string;
        file_data: string;
      }>`
        select id, kind, file_name, mime_type, file_data
        from credit_documents
        where lead_id = ${data.leadId}
        order by created_at asc
      `;
      const kindLabel: Record<string, string> = {
        hero_shot: "Hero-Shot",
        dl_front: "ID-DL-Front",
        dl_back: "ID-DL-Back",
        id_second: "ID-Second",
        pay_stub: "Credit-Pay-Stub",
        employment_confirmation: "Credit-Employment",
        noa_payslip: "Credit-NOA-Payslip",
        bank_statement: "Credit-Bank-Statement",
        equifax: "Credit-Equifax",
        other: "Credit-Other",
      };
      const latestByKind = new Map<string, (typeof docs)[0]>();
      for (const d of docs) {
        if (!d.file_data) continue;
        latestByKind.set(d.kind, d);
      }
      for (const d of latestByKind.values()) {
        const norm = (await driveApi()).normalizeUploadPayload(
          d.file_data,
          d.mime_type || "application/octet-stream",
        );
        if (!norm) continue;
        if ((norm.mimeType || "").toLowerCase().includes("html")) continue;
        const label = kindLabel[d.kind] || `Credit-${d.kind}`;
        const ext = extFromMime(norm.mimeType, d.file_name || "");
        await pushOne(
          `credit_doc:${d.kind}`,
          `10-${label}${ext || ""}`,
          norm.mimeType,
          norm.dataUrl,
        );
      }
    } catch {
      /* credit tables may not exist yet */
    }

    // 6) Equifax on credit application (if not already in documents)
    try {
      const apps = await sql<{
        equifax_file_name: string | null;
        equifax_file_data: string | null;
      }>`
        select equifax_file_name, equifax_file_data
        from credit_applications
        where lead_id = ${data.leadId}
        order by created_at desc
        limit 1
      `;
      const eq = apps[0];
      if (eq?.equifax_file_data) {
        const already = uploaded.some((u) => u.kind.startsWith("credit_doc:equifax"));
        if (!already) {
          const norm = (await driveApi()).normalizeUploadPayload(
            eq.equifax_file_data,
            "application/pdf",
          );
          if (norm && !(norm.mimeType || "").toLowerCase().includes("html")) {
            await pushOne(
              "equifax_app",
              `10-Credit-Equifax${extFromMime(norm.mimeType, eq.equifax_file_name || "") || ".pdf"}`,
              norm.mimeType,
              norm.dataUrl,
            );
          }
        }
      }
    } catch {
      /* optional */
    }

    // No vehicle photos, no invoice/retail/contract HTML in the Drive package

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
    const replacedCount = uploaded.filter((u) => u.replaced).length;
    const newCount = uploaded.length - replacedCount;
    const summary = `Push to Drive · ${uploaded.length} file(s) (${replacedCount} updated, ${newCount} new) → ${folder.path}${
      errors.length ? ` · ${errors.length} skipped/error` : ""
    }`;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${id()}, ${data.leadId}, 'stage',
        ${summary + (uploaded.length ? `\n` + uploaded.map((u) => `• ${u.replaced ? "↻" : "+"} ${u.name}`).join("\n") : "")},
        ${me.id}, ${me.name}
      )
    `;
    return {
      ok: true as const,
      folderId: folder.folderId,
      folderUrl: folder.folderUrl,
      path: folder.path,
      fileUrl: uploaded.find((u) => u.kind === "quote")?.url || uploaded[0]?.url || null,
      uploadedCount: uploaded.length,
      replacedCount,
      newCount,
      alreadyHadFolder: Boolean(lead.drive_folder_id),
      uploaded: uploaded.map((u) => ({
        name: u.name,
        kind: u.kind,
        url: u.url,
        replaced: u.replaced,
      })),
      errors,
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
    return (await driveApi()).probeDrive();
  });
