import type { Sql } from "@/lib/db";
import { parseLeadEmail } from "./parse-email";
import {
  classifyInboundEmail,
  normalizeEmail,
  normalizePhone,
  stockKey,
  vehicleKey,
  type EmailPortal,
} from "./classify-email";
import {
  fetchRecentLeadEmails,
  gmailConfigStatus,
  isGmailConfigured,
  type GmailMessage,
} from "./gmail";
import type { LeadType } from "./types";


async function resolveLucasProfileId(sql: Sql): Promise<string | null> {
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

function uid() {
  return crypto.randomUUID();
}

export type ImportResult = {
  ok: boolean;
  configured: boolean;
  scanned: number;
  created: number;
  merged: number;
  skipped: number;
  errors: number;
  details: Array<{
    subject: string;
    from: string;
    status: string;
    reason?: string;
    lead_id?: string;
  }>;
  message: string;
};

function rawEnvelope(msg: GmailMessage): string {
  return [
    `From: ${msg.from}`,
    `Subject: ${msg.subject}`,
    msg.date ? `Date: ${msg.date}` : "",
    "",
    msg.bodyText || msg.snippet,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractFromAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m?.[1] || from).trim().toLowerCase();
}

/**
 * Find an open lead that is likely the same person + same car.
 * Open = not won/lost. Window = 90 days.
 */
async function findDuplicateLead(
  sql: Sql,
  opts: {
    email: string | null;
    phone: string | null;
    stock: string | null;
    vehicle: string | null;
    lead_type: LeadType;
  },
): Promise<{ id: string; name: string } | null> {
  const email = opts.email;
  const phone = opts.phone;
  if (!email && !phone) return null;

  const candidates = await sql<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    vehicle_interest: string | null;
    inventory_id: string | null;
    stock_number: string | null;
    lead_type: string;
  }>`
    select l.id, l.name, l.email, l.phone, l.vehicle_interest, l.inventory_id,
           i.stock_number, l.lead_type
    from leads l
    left join inventory i on i.id = l.inventory_id
    where l.stage not in ('won', 'lost')
      and l.created_at > now() - interval '90 days'
    order by l.updated_at desc
    limit 80
  `;

  const wantStock = opts.stock;
  const wantVeh = opts.vehicle;

  for (const c of candidates) {
    const cPhone = normalizePhone(c.phone);
    const cEmail = normalizeEmail(c.email);
    const personMatch =
      (email && cEmail && email === cEmail) ||
      (phone &&
        cPhone &&
        (phone === cPhone || cPhone.endsWith(phone) || phone.endsWith(cPhone)));

    if (!personMatch) continue;

    const cStock = stockKey(c.stock_number);
    if (wantStock && cStock && wantStock === cStock) {
      return { id: c.id, name: c.name };
    }

    const cVeh = vehicleKey(c.vehicle_interest);
    if (wantVeh && cVeh) {
      const a = new Set(wantVeh.split(" ").filter((t) => t.length > 2));
      const b = new Set(cVeh.split(" ").filter((t) => t.length > 2));
      let hit = 0;
      for (const t of a) if (b.has(t)) hit += 1;
      if (hit >= 2 || (a.size <= 2 && hit >= 1)) {
        return { id: c.id, name: c.name };
      }
    }

    if (!wantStock && !wantVeh && !cStock && !cVeh) {
      return { id: c.id, name: c.name };
    }

    if (opts.lead_type === "general" && c.lead_type === "general") {
      return { id: c.id, name: c.name };
    }
  }

  return null;
}

async function matchInventory(
  sql: Sql,
  stock: string | null,
  vehicle: string | null,
): Promise<{ id: string; label: string; price: number | null } | null> {
  if (stock) {
    const rows = await sql<{
      id: string;
      year: number;
      make: string;
      model: string;
      trim: string | null;
      price: number | null;
    }>`
      select id, year, make, model, trim, price::float8 as price
      from inventory
      where lower(stock_number) = ${stock.toLowerCase()}
      limit 1
    `;
    if (rows[0]) {
      const r = rows[0];
      return {
        id: r.id,
        label: [r.year, r.make, r.model, r.trim].filter(Boolean).join(" "),
        price: r.price,
      };
    }
  }
  if (vehicle) {
    const q = `%${vehicle.toLowerCase().replace(/\s+/g, "%")}%`;
    const rows = await sql<{
      id: string;
      year: number;
      make: string;
      model: string;
      trim: string | null;
      price: number | null;
    }>`
      select id, year, make, model, trim, price::float8 as price
      from inventory
      where lower(concat(year, ' ', make, ' ', model, ' ', coalesce(trim, ''))) like ${q}
      order by price desc nulls last
      limit 1
    `;
    if (rows[0]) {
      const r = rows[0];
      return {
        id: r.id,
        label: [r.year, r.make, r.model, r.trim].filter(Boolean).join(" "),
        price: r.price,
      };
    }
  }
  return null;
}

async function alreadyImported(sql: Sql, messageId: string): Promise<boolean> {
  const rows = await sql`select id from email_imports where gmail_message_id = ${messageId} limit 1`;
  return Boolean(rows[0]);
}

async function processMessage(
  sql: Sql,
  msg: GmailMessage,
): Promise<{
  status: "created" | "merged" | "skipped" | "error";
  reason?: string;
  lead_id?: string;
  lead_type?: LeadType;
  portal?: EmailPortal;
}> {
  if (await alreadyImported(sql, msg.id)) {
    return { status: "skipped", reason: "already-imported" };
  }

  const classified = classifyInboundEmail({
    from: msg.from,
    subject: msg.subject,
    body: msg.bodyText,
  });

  const raw = rawEnvelope(msg);
  const parsed = parseLeadEmail(raw);

  const leadType = classified.lead_type;
  const portal = classified.portal;
  const source = classified.source;

  let customerEmail = normalizeEmail(parsed.email);
  if (customerEmail && /tadvantage|cargurus|trader\.ca|dealerleads|noreply/i.test(customerEmail)) {
    customerEmail = null;
  }
  const customerPhone = normalizePhone(parsed.phone);
  const stock = stockKey(parsed.stock_number);
  let vehicle = parsed.vehicle_interest?.trim() || "";
  const name =
    (parsed.name?.trim() && !/paul\s*motor/i.test(parsed.name)
      ? parsed.name.trim()
      : "") ||
    (customerEmail ? customerEmail.split("@")[0] : "") ||
    "Email lead";

  if (!customerEmail && !customerPhone && !vehicle && !stock && name === "Email lead") {
    if (portal === "other") {
      await sql`
        insert into email_imports (
          id, gmail_message_id, gmail_thread_id, from_address, subject, received_at,
          lead_id, status, reason, lead_type, portal, raw_snippet
        ) values (
          ${uid()}, ${msg.id}, ${msg.threadId}, ${extractFromAddress(msg.from)},
          ${msg.subject}, ${msg.internalDate ? new Date(msg.internalDate).toISOString() : null},
          null, 'skipped', 'no-customer-signal', ${leadType}, ${portal}, ${msg.snippet.slice(0, 500)}
        )
        on conflict (gmail_message_id) do nothing
      `;
      return { status: "skipped", reason: "no-customer-signal", lead_type: leadType, portal };
    }
  }

  const inv = await matchInventory(sql, stock, vehicle || null);
  if (inv && !vehicle) vehicle = inv.label;

  const dup = await findDuplicateLead(sql, {
    email: customerEmail,
    phone: customerPhone,
    stock,
    vehicle: vehicleKey(vehicle),
    lead_type: leadType,
  });

  const notesParts = [
    `Auto-imported from ${portal} · ${classified.rule}`,
    `Subject: ${msg.subject}`,
    parsed.notes ? parsed.notes : msg.snippet.slice(0, 400),
  ].filter(Boolean);
  const notes = notesParts.join("\n");
  const mergeBlock = `\n\n---\n${notes}`;

  if (dup) {
    await sql`
      update leads set
        notes = case
          when notes is null or notes = '' then ${notes}
          else notes || ${mergeBlock}
        end,
        vehicle_interest = coalesce(nullif(vehicle_interest, ''), ${vehicle || null}),
        inventory_id = coalesce(inventory_id, ${inv?.id ?? null}),
        phone = coalesce(nullif(phone, ''), ${customerPhone ? parsed.phone || null : null}),
        email = coalesce(nullif(email, ''), ${customerEmail}),
        updated_at = now()
      where id = ${dup.id}
    `;
    const activityBody = `Duplicate email merged (same person + vehicle).\nFrom: ${msg.from}\nSubject: ${msg.subject}\n\n${(msg.bodyText || msg.snippet).slice(0, 1200)}`;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by_name)
      values (
        ${uid()}, ${dup.id}, 'email',
        ${activityBody},
        'Email Import'
      )
    `;
    await sql`
      insert into email_imports (
        id, gmail_message_id, gmail_thread_id, from_address, subject, received_at,
        lead_id, status, reason, lead_type, portal, raw_snippet
      ) values (
        ${uid()}, ${msg.id}, ${msg.threadId}, ${extractFromAddress(msg.from)},
        ${msg.subject}, ${msg.internalDate ? new Date(msg.internalDate).toISOString() : null},
        ${dup.id}, 'merged', ${`merged-into:${dup.id}`}, ${leadType}, ${portal},
        ${msg.snippet.slice(0, 500)}
      )
      on conflict (gmail_message_id) do nothing
    `;
    return {
      status: "merged",
      reason: `Merged into existing lead for ${dup.name}`,
      lead_id: dup.id,
      lead_type: leadType,
      portal,
    };
  }

  const leadId = uid();
  const lucasId = leadType === "inventory" ? await resolveLucasProfileId(sql) : null;
  const nameParts = name.trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || name;
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";
  const partyType =
    leadType === "lease" && /business|entreprise/i.test(String(classified.rule || source || ""))
      ? "business"
      : "individual";
  await sql`
    insert into leads (
      id, name, first_name, last_name, party_type, phone, email, source, lead_type, notes, vehicle_interest, inventory_id,
      assigned_to, stage, stage_entered_at, quote_sent, estimated_value,
      source_email_raw, email_portal, gmail_message_id, gmail_thread_id, created_by
    ) values (
      ${leadId},
      ${name},
      ${firstName},
      ${lastName},
      ${partyType},
      ${parsed.phone || null},
      ${customerEmail},
      ${source},
      ${leadType},
      ${notes},
      ${vehicle || null},
      ${inv?.id ?? null},
      ${lucasId},
      'new',
      now(),
      false,
      ${inv?.price ?? null},
      ${raw.slice(0, 15000)},
      ${portal},
      ${msg.id},
      ${msg.threadId || null},
      null
    )
  `;
  const createBody = `Lead auto-created from email (${portal}).\nFrom: ${msg.from}\nSubject: ${msg.subject}\nRule: ${classified.rule}`;
  await sql`
    insert into lead_activities (id, lead_id, kind, body, created_by_name)
    values (
      ${uid()}, ${leadId}, 'email',
      ${createBody},
      'Email Import'
    )
  `;
  await sql`
    insert into email_imports (
      id, gmail_message_id, gmail_thread_id, from_address, subject, received_at,
      lead_id, status, reason, lead_type, portal, raw_snippet
    ) values (
      ${uid()}, ${msg.id}, ${msg.threadId}, ${extractFromAddress(msg.from)},
      ${msg.subject}, ${msg.internalDate ? new Date(msg.internalDate).toISOString() : null},
      ${leadId}, 'created', ${classified.rule}, ${leadType}, ${portal},
      ${msg.snippet.slice(0, 500)}
    )
    on conflict (gmail_message_id) do nothing
  `;

  return {
    status: "created",
    lead_id: leadId,
    lead_type: leadType,
    portal,
  };
}

/** Poll Gmail and create/merge leads. Safe to call often (idempotent). */
export async function runEmailImport(
  sql: Sql,
  opts?: { newerThanDays?: number; maxResults?: number },
): Promise<ImportResult> {
  const status = gmailConfigStatus();
  if (!isGmailConfigured()) {
    return {
      ok: false,
      configured: false,
      scanned: 0,
      created: 0,
      merged: 0,
      skipped: 0,
      errors: 0,
      details: [],
      message:
        "Gmail not connected. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER=client@paulmotorcompany.com in Vercel, then redeploy.",
    };
  }

  const newerThanDays = opts?.newerThanDays ?? 14;
  const maxResults = opts?.maxResults ?? 40;

  let messages: GmailMessage[] = [];
  try {
    messages = await fetchRecentLeadEmails({ maxResults, newerThanDays });
  } catch (e) {
    return {
      ok: false,
      configured: true,
      scanned: 0,
      created: 0,
      merged: 0,
      skipped: 0,
      errors: 1,
      details: [],
      message: e instanceof Error ? e.message : String(e),
    };
  }

  let created = 0;
  let merged = 0;
  let skipped = 0;
  let errors = 0;
  const details: ImportResult["details"] = [];

  for (const msg of messages) {
    try {
      const r = await processMessage(sql, msg);
      if (r.status === "created") created += 1;
      else if (r.status === "merged") merged += 1;
      else if (r.status === "skipped") skipped += 1;
      else errors += 1;
      details.push({
        subject: msg.subject,
        from: msg.from,
        status: r.status,
        reason: r.reason,
        lead_id: r.lead_id,
      });
    } catch (e) {
      errors += 1;
      const reason = e instanceof Error ? e.message : String(e);
      details.push({
        subject: msg.subject,
        from: msg.from,
        status: "error",
        reason,
      });
      try {
        await sql`
          insert into email_imports (
            id, gmail_message_id, gmail_thread_id, from_address, subject, received_at,
            lead_id, status, reason, raw_snippet
          ) values (
            ${uid()}, ${msg.id}, ${msg.threadId}, ${extractFromAddress(msg.from)},
            ${msg.subject}, ${msg.internalDate ? new Date(msg.internalDate).toISOString() : null},
            null, 'error', ${reason.slice(0, 500)}, ${msg.snippet.slice(0, 500)}
          )
          on conflict (gmail_message_id) do nothing
        `;
      } catch {
        // ignore
      }
    }
  }

  await sql`
    insert into crm_settings (key, value, updated_at)
    values ('email_import_last_run', ${new Date().toISOString()}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;

  return {
    ok: true,
    configured: true,
    scanned: messages.length,
    created,
    merged,
    skipped,
    errors,
    details: details.slice(-80),
    message: `Scanned ${messages.length} (last ${newerThanDays}d): ${created} new, ${merged} merged (duplicates), ${skipped} skipped, ${errors} errors. Inbox: ${status.user || "client@…"}`,
  };
}

export async function getEmailImportStatus(sql: Sql) {
  const config = gmailConfigStatus();
  const last = await sql<{ value: string; updated_at: string }>`
    select value, updated_at::text as updated_at from crm_settings where key = 'email_import_last_run'
  `;
  const recent = await sql<{
    id: string;
    subject: string | null;
    from_address: string | null;
    status: string;
    reason: string | null;
    lead_type: string | null;
    portal: string | null;
    created_at: string;
  }>`
    select id, subject, from_address, status, reason, lead_type, portal,
           created_at::text as created_at
    from email_imports
    order by created_at desc
    limit 20
  `;
  const counts = await sql<{ status: string; n: number }>`
    select status, count(*)::int as n from email_imports group by status
  `;
  return {
    config,
    last_run: last[0]?.value ?? null,
    last_run_at: last[0]?.updated_at ?? null,
    recent,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  };
}
