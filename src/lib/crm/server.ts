import { createServerFn } from "@tanstack/react-start";
import { hashPassword } from "better-auth/crypto";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { ensureCrmSeeded, syncRealInventory } from "./seed";
import { parseLeadEmail } from "./parse-email";
import { PAUL_MOTOR_INVENTORY_SOURCE } from "./real-inventory";
import { getEmailImportStatus, runEmailImport } from "./import-emails";
import {
  type AdminMetrics,
  type InventoryItem,
  type Lead,
  type LeadActivity,
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

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

async function boot() {
  const sql = await getSql();
  await ensureCrmSeeded(sql);
  return sql;
}

/** Public — primes demo users / inventory before first sign-in. */
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
    source_email_raw: (r.source_email_raw as string) ?? null,
    email_portal: (r.email_portal as string) ?? null,
    gmail_message_id: (r.gmail_message_id as string) ?? null,
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
  l.email_portal, l.gmail_message_id,
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
  .handler(async ({ context }) => {
    return requireProfile(context.userId);
  });

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
          case role when 'admin' then 0 when 'rep' then 1 else 2 end,
          name
      `;
    }
    return sql<Profile>`
      select id, user_id, email, name, role, active, phone, title,
             created_at::text as created_at, updated_at::text as updated_at
      from profiles where active = true
      order by
        case role when 'admin' then 0 when 'rep' then 1 else 2 end,
        name
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
          year = ${data.year},
          make = ${data.make.trim()},
          model = ${data.model.trim()},
          trim = ${data.trim?.trim() || null},
          vin = ${data.vin?.trim() || null},
          stock_number = ${data.stock_number?.trim() || null},
          price = ${data.price ?? null},
          mileage = ${data.mileage ?? null},
          exterior_color = ${data.exterior_color?.trim() || null},
          body_type = ${data.body_type?.trim() || null},
          status = ${data.status || "available"},
          source = ${data.source || "manual"},
          external_url = ${data.external_url?.trim() || null},
          notes = ${data.notes?.trim() || null},
          updated_at = now()
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
      message: `Synced ${refreshed} live units from paulmotorleasing.com inventory snapshot.`,
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
          from inventory
          where lower(stock_number) = ${parsed.stock_number.toLowerCase()}
          limit 1
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
          order by price desc nulls last
          limit 1
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
    }): Promise<{ lead: Lead; activities: LeadActivity[]; drives: TestDrive[] } | null> => {
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
      return { lead: mapLead(rows[0]), activities, drives };
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
    if (!data.phone?.trim() && !data.email?.trim()) {
      throw new Error("Phone or email required");
    }

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
        ${quoteSent ? data.quote_sent_at || new Date().toISOString() : null},
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

    const stage =
      data.stage && isStageId(data.stage) ? data.stage : String(prev.stage);
    const stageChanged = stage !== String(prev.stage);
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
        assigned_to = ${
          data.assigned_to !== undefined
            ? data.assigned_to || null
            : (prev.assigned_to as string | null)
        },
        stage = ${stage},
        stage_entered_at = ${stageChanged ? new Date().toISOString() : String(prev.stage_entered_at)},
        quote_sent = ${quoteSent},
        quote_sent_at = ${
          data.quote_sent_at !== undefined
            ? data.quote_sent_at
            : quoteSent && !prev.quote_sent_at
              ? new Date().toISOString()
              : (prev.quote_sent_at as string | null)
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
            ? data.google_review_at
            : (prev.google_review_at as string | null)
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
      update leads set stage = case when stage = 'new' or stage = 'contacted' then 'test_drive' else stage end,
        stage_entered_at = case when stage = 'new' or stage = 'contacted' then now() else stage_entered_at end,
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
        (select count(*)::int from test_drives where status = 'scheduled' and scheduled_at >= now()) as drives,
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
        p.id as profile_id,
        p.name,
        p.role,
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

/** Admin: poll client@ Gmail and import leads now. */
export const adminRunEmailImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await boot();
    return runEmailImport(sql);
  });

/** Admin: Gmail connection + recent import log. */
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
      if ((admins[0]?.n ?? 0) < 1) {
        throw new Error("At least one active admin is required");
      }
    }

    if (nextEmail !== prev[0].email) {
      const clash = await sql`
        select id from profiles where email = ${nextEmail} and id <> ${data.id} limit 1
      `;
      if (clash[0]) throw new Error("Email already in use by another user");
      if (prev[0].user_id) {
        const uClash = await sql`
          select id from "user" where email = ${nextEmail} and id <> ${prev[0].user_id} limit 1
        `;
        if (uClash[0]) throw new Error("Email already in use");
      }
    }

    await sql`
      update profiles set
        name = ${nextName},
        email = ${nextEmail},
        role = ${nextRole},
        active = ${nextActive},
        phone = ${nextPhone},
        title = ${nextTitle},
        updated_at = now()
      where id = ${data.id}
    `;

    if (prev[0].user_id) {
      await sql`
        update "user" set
          name = ${nextName},
          email = ${nextEmail},
          "updatedAt" = now()
        where id = ${prev[0].user_id}
      `;
      await sql`
        update account set
          "accountId" = ${nextEmail},
          "updatedAt" = now()
        where "userId" = ${prev[0].user_id} and "providerId" = 'credential'
      `;

      if (data.password && data.password.length > 0) {
        if (data.password.length < 8) {
          throw new Error("Password must be at least 8 characters");
        }
        const passwordHash = await hashPassword(data.password);
        const acc = await sql<{ id: string }>`
          select id from account
          where "userId" = ${prev[0].user_id} and "providerId" = 'credential'
          limit 1
        `;
        if (acc[0]) {
          await sql`
            update account set password = ${passwordHash}, "updatedAt" = now()
            where id = ${acc[0].id}
          `;
        } else {
          await sql`
            insert into account (
              id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
            ) values (
              ${id()}, ${nextEmail}, 'credential', ${prev[0].user_id},
              ${passwordHash}, ${new Date().toISOString()}, ${new Date().toISOString()}
            )
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
      if ((admins[0]?.n ?? 0) < 1) {
        throw new Error("Cannot remove the last active admin");
      }
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

/**
 * Wipe all leads + activities + test drives (demo cleanup).
 * Keeps team users and inventory. Also clears email_imports so re-import works.
 */
export const adminClearAllLeads = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await boot();

    const before = await sql<{ n: number }>`select count(*)::int as n from leads`;
    const count = before[0]?.n ?? 0;

    await sql`delete from test_drives`;
    await sql`delete from lead_activities`;
    await sql`delete from email_imports`;
    await sql`delete from leads`;

    return {
      ok: true as const,
      deleted: count,
      message:
        count === 0
          ? "No leads to delete."
          : `Deleted ${count} lead(s), plus all notes, activities, test drives, and import log. Users and inventory kept.`,
    };
  });
