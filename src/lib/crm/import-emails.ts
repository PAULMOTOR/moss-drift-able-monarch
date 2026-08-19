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
import { compactEmailBody } from "./email-text";
import {
  applyWebsiteLeaseAppToLead,
  findWebsiteLeaseDeal,
  isRetryableUnmatched,
  LEASE_APP_AMBIGUOUS,
  LEASE_APP_UNMATCHED,
  listUnmatchedLeaseApps,
  notifyLeaseAppAttached,
  type LeaseAppIdentity,
} from "./lease-app-import";


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

/** AutoTrader "Customer no." and similar dealer account IDs must never be buyer phones. */
function isDealerAccountPhone(
  phone: string | null | undefined,
  body?: string | null,
): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  if (!last10) return false;
  if (body) {
    const re = new RegExp(
      `(?:Customer\\s*no\\.?|Customer\\s*number|N[o°º.]?\\s*(?:de\\s+)?client)\\s*[:#]?\\s*${last10}`,
      "i",
    );
    if (re.test(body)) return true;
    if (
      body.includes(digits) &&
      /Customer\s*no|N[o°º.]?\s*(?:de\s+)?client/i.test(body) &&
      /^1000\d{6}$/.test(last10)
    ) {
      return true;
    }
  }
  // Common AutoTrader dealer customer number shape when portal is AT
  if (/^1000\d{6}$/.test(last10) && body && /autotrader|dealerleads|trader\.ca/i.test(body)) {
    return true;
  }
  return false;
}

function isJunkLeadName(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  if (!n) return true;
  if (/^(trader|autotrader|email lead|cargurus|tadvantage|dealer|unknown|no name)$/i.test(n)) {
    return true;
  }
  if (/dealerleads|1-source|no-?reply/i.test(n)) return true;
  return false;
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
 * Open = not won/lost. Window = 90 days (180 for website lease apps).
 *
 * Website lease applications always attach to an existing lead (person match only).
 */
async function findDuplicateLead(
  sql: Sql,
  opts: {
    email: string | null;
    phone: string | null;
    stock: string | null;
    vehicle: string | null;
    lead_type: LeadType;
    /** Person-only match (any vehicle / type) — used for website lease apps. */
    personOnly?: boolean;
  },
): Promise<{ id: string; name: string } | null> {
  const email = opts.email;
  const phone = opts.phone;
  if (!email && !phone) return null;

  const windowDays = opts.personOnly ? 180 : 90;

  const candidates = await sql.query<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    vehicle_interest: string | null;
    inventory_id: string | null;
    stock_number: string | null;
    lead_type: string;
  }>(
    `select l.id, l.name, l.email, l.phone, l.vehicle_interest, l.inventory_id,
            i.stock_number, l.lead_type
     from leads l
     left join inventory i on i.id = l.inventory_id
     where l.stage not in ('won', 'lost')
       and l.created_at > now() - make_interval(days => $1)
     order by l.updated_at desc
     limit 120`,
    [windowDays],
  );

  const wantStock = opts.stock;
  const wantVeh = opts.vehicle;

  const ordered = opts.personOnly
    ? [...candidates].sort((a, b) => {
        const rank = (t: string) =>
          t === "inventory" ? 0 : t === "lease" ? 1 : t === "general" ? 3 : 2;
        return rank(a.lead_type) - rank(b.lead_type);
      })
    : candidates;

  for (const c of ordered) {
    const cPhone = normalizePhone(c.phone);
    const cEmail = normalizeEmail(c.email);
    const personMatch =
      (email && cEmail && email === cEmail) ||
      (phone &&
        cPhone &&
        (phone === cPhone || cPhone.endsWith(phone) || phone.endsWith(cPhone)));

    if (!personMatch) continue;

    if (opts.personOnly) {
      return { id: c.id, name: c.name };
    }

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

    if (opts.lead_type === "consignment" && c.lead_type === "consignment") {
      return { id: c.id, name: c.name };
    }

    if (
      opts.lead_type === "lease" &&
      (c.lead_type === "lease" || c.lead_type === "inventory")
    ) {
      return { id: c.id, name: c.name };
    }
  }

  return null;
}

async function findSamePersonVehicleLead(
  sql: Sql,
  opts: {
    name: string;
    stock: string | null;
    vehicle: string | null;
  },
): Promise<{ id: string; name: string } | null> {
  const nameKey = opts.name
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = nameKey.split(" ").filter((t) => t.length > 1);
  if (parts.length < 2) return null;
  const wantStock = opts.stock;
  const wantVeh = opts.vehicle;
  if (!wantStock && !wantVeh) return null;

  const candidates = await sql.query<{
    id: string;
    name: string;
    vehicle_interest: string | null;
    stock_number: string | null;
  }>(
    `select l.id, l.name, l.vehicle_interest, i.stock_number
     from leads l
     left join inventory i on i.id = l.inventory_id
     where l.stage not in ('won', 'lost')
       and l.created_at > now() - interval '90 days'
     order by l.updated_at desc
     limit 120`,
  );

  for (const c of candidates) {
    const cName = (c.name || "")
      .toLowerCase()
      .replace(/[^a-z0-9à-ÿ\s]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cName || cName !== nameKey) continue;
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
      if (hit >= 2) return { id: c.id, name: c.name };
    }
  }
  return null;
}

/** TAdvantage / website lease application forms — never open a new lead. */
function isWebsiteLeaseApplication(
  leadType: LeadType,
  portal: EmailPortal,
  rule: string,
  source: string,
): boolean {
  if (leadType !== "lease") return false;
  if (portal === "tadvantage") return true;
  if (source === "web") return true;
  if (/tadvantage:(financing|leasing)/i.test(rule)) return true;
  return false;
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

async function existingImport(sql: Sql, messageId: string) {
  const rows = await sql<{
    id: string;
    status: string;
    reason: string | null;
    created_at: string;
  }>`
    select id, status, reason, created_at::text as created_at
    from email_imports where gmail_message_id = ${messageId} limit 1
  `;
  return rows[0] ?? null;
}

async function upsertEmailImport(
  sql: Sql,
  row: {
    messageId: string;
    threadId: string | null;
    from: string;
    subject: string;
    receivedAt: string | null;
    leadId: string | null;
    status: string;
    reason: string;
    leadType: string;
    portal: string;
    snippet: string;
    ident?: LeaseAppIdentity | null;
    rawBody?: string | null;
  },
) {
  await sql`
    insert into email_imports (
      id, gmail_message_id, gmail_thread_id, from_address, subject, received_at,
      lead_id, status, reason, lead_type, portal, raw_snippet,
      parsed_name, parsed_email, parsed_phone, parsed_company, raw_body
    ) values (
      ${uid()}, ${row.messageId}, ${row.threadId}, ${row.from},
      ${row.subject}, ${row.receivedAt},
      ${row.leadId}, ${row.status}, ${row.reason}, ${row.leadType}, ${row.portal},
      ${row.snippet.slice(0, 500)},
      ${row.ident?.name || null}, ${row.ident?.email || null},
      ${row.ident?.phone || null}, ${row.ident?.company || null},
      ${row.rawBody || null}
    )
    on conflict (gmail_message_id) do update set
      lead_id = excluded.lead_id,
      status = excluded.status,
      reason = excluded.reason,
      parsed_name = coalesce(excluded.parsed_name, email_imports.parsed_name),
      parsed_email = coalesce(excluded.parsed_email, email_imports.parsed_email),
      parsed_phone = coalesce(excluded.parsed_phone, email_imports.parsed_phone),
      parsed_company = coalesce(excluded.parsed_company, email_imports.parsed_company),
      raw_body = coalesce(excluded.raw_body, email_imports.raw_body)
  `;
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
  const prior = await existingImport(sql, msg.id);
  if (prior && !isRetryableUnmatched(prior)) {
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
  if (
    customerEmail &&
    /tadvantage|cargurus|trader\.ca|dealerleads|noreply|1-source|autotrader/i.test(
      customerEmail,
    )
  ) {
    customerEmail = null;
  }
  // Reject AutoTrader dealer account IDs mistaken as phones (e.g. Customer no. 1000004136)
  let customerPhone = normalizePhone(parsed.phone);
  if (customerPhone && isDealerAccountPhone(customerPhone, msg.bodyText || raw)) {
    customerPhone = null;
  }
  const stock = stockKey(parsed.stock_number);
  let vehicle = parsed.vehicle_interest?.trim() || "";
  let name =
    (parsed.name?.trim() &&
    !/paul\s*motor/i.test(parsed.name) &&
    !isJunkLeadName(parsed.name)
      ? parsed.name.trim()
      : "") ||
    (customerEmail ? customerEmail.split("@")[0] : "") ||
    "Email lead";
  if (isJunkLeadName(name)) {
    name = customerEmail ? customerEmail.split("@")[0] : "Email lead";
  }

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

  const websiteLease = isWebsiteLeaseApplication(
    leadType,
    portal,
    classified.rule,
    source,
  );

  const ident: LeaseAppIdentity = {
    name,
    email: customerEmail,
    phone: customerPhone,
    company: parsed.company?.trim() || null,
    vehicle: vehicle || null,
    stock,
    isBusiness: /leasing-business|entreprise/i.test(classified.rule),
  };

  const websiteMatch = websiteLease
    ? await findWebsiteLeaseDeal(sql, ident)
    : null;

  const dup = websiteLease
    ? websiteMatch?.kind === "hit"
      ? { id: websiteMatch.id, name: websiteMatch.name }
      : null
    : (await findDuplicateLead(sql, {
        email: customerEmail,
        phone: customerPhone,
        stock,
        vehicle: vehicleKey(vehicle),
        lead_type: leadType,
        personOnly: false,
      })) ||
      (portal === "autotrader" || portal === "cargurus"
        ? await findSamePersonVehicleLead(sql, {
            name,
            stock,
            vehicle: vehicleKey(vehicle),
          })
        : null);

  const notesParts = [
    `Auto-imported from ${portal} · ${classified.rule}`,
    `Subject: ${msg.subject}`,
    parsed.notes ? compactEmailBody(parsed.notes, 800) : compactEmailBody(msg.snippet, 400),
  ].filter(Boolean);
  const notes = notesParts.join("\n");
  const mergeBlock = `\n\n---\n${notes}`;

  const receivedAt = msg.internalDate ? new Date(msg.internalDate).toISOString() : null;
  const fromAddr = extractFromAddress(msg.from);

  if (dup && websiteLease) {
    const applied = await applyWebsiteLeaseAppToLead(sql, dup.id, ident, {
      from: msg.from,
      subject: msg.subject,
      body: msg.bodyText || msg.snippet,
    });
    await notifyLeaseAppAttached(sql, {
      leadId: dup.id,
      leadName: applied.leadName,
      assignedTo: applied.assignedTo,
      subject: msg.subject,
      unpaused: applied.unpaused,
      stageMoved: applied.stageMoved,
    }).catch(() => undefined);
    await upsertEmailImport(sql, {
      messageId: msg.id,
      threadId: msg.threadId,
      from: fromAddr,
      subject: msg.subject,
      receivedAt,
      leadId: dup.id,
      status: "merged",
      reason: `lease-app:${websiteMatch && websiteMatch.kind === "hit" ? websiteMatch.reason : "match"}`,
      leadType,
      portal,
      snippet: msg.snippet,
      ident,
      rawBody: (msg.bodyText || msg.snippet).slice(0, 15000),
    });
    return {
      status: "merged",
      reason: `Financing form attached to ${applied.leadName}`,
      lead_id: dup.id,
      lead_type: leadType,
      portal,
    };
  }

  if (dup) {
    // If the existing lead still has junk AutoTrader fields, overwrite with real buyer contact
    const existing = await sql.query<{
      name: string;
      phone: string | null;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
    }>(
      `select name, phone, email, first_name, last_name from leads where id = $1`,
      [dup.id],
    );
    const ex = existing[0];
    const nextPhone =
      customerPhone &&
      (!normalizePhone(ex?.phone) ||
        isDealerAccountPhone(normalizePhone(ex?.phone), msg.bodyText || raw) ||
        isJunkLeadName(ex?.name || ""))
        ? parsed.phone || customerPhone
        : null;
    const nextEmail =
      customerEmail &&
      (!normalizeEmail(ex?.email) ||
        /trader\.ca|dealerleads|tonyroadranger|100000/i.test(ex?.email || "") ||
        isJunkLeadName(ex?.name || ""))
        ? customerEmail
        : null;
    const nextName =
      name &&
      name !== "Email lead" &&
      !isJunkLeadName(name) &&
      isJunkLeadName(ex?.name || "")
        ? name
        : null;
    const nameParts = nextName ? nextName.trim().split(/\s+/).filter(Boolean) : [];
    const nextFirst = nameParts[0] || null;
    const nextLast = nameParts.length > 1 ? nameParts.slice(1).join(" ") : null;

    await sql`
      update leads set
        notes = case
          when notes is null or notes = '' then ${notes}
          else notes || ${mergeBlock}
        end,
        vehicle_interest = coalesce(nullif(vehicle_interest, ''), ${vehicle || null}),
        inventory_id = coalesce(inventory_id, ${inv?.id ?? null}),
        phone = coalesce(${nextPhone}, nullif(phone, ''), ${customerPhone ? parsed.phone || null : null}),
        email = coalesce(${nextEmail}, nullif(email, ''), ${customerEmail}),
        name = coalesce(${nextName}, name),
        first_name = case when ${nextFirst}::text is not null then ${nextFirst} else first_name end,
        last_name = case when ${nextLast}::text is not null then ${nextLast} else last_name end,
        updated_at = now()
      where id = ${dup.id}
    `;
    const activityBody = websiteLease
      ? `Website lease application attached to existing lead (not a new lead).\nFrom: ${msg.from}\nSubject: ${msg.subject}\n\n${compactEmailBody(msg.bodyText || msg.snippet, 1200)}`
      : `Duplicate email merged (same person + vehicle).\nFrom: ${msg.from}\nSubject: ${msg.subject}\n\n${compactEmailBody(msg.bodyText || msg.snippet, 1200)}`;
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

  // Website lease apps always belong on an existing deal — never open a new lead
  if (websiteLease) {
    const reason =
      websiteMatch?.kind === "ambiguous" ? LEASE_APP_AMBIGUOUS : LEASE_APP_UNMATCHED;
    await upsertEmailImport(sql, {
      messageId: msg.id,
      threadId: msg.threadId,
      from: fromAddr,
      subject: msg.subject,
      receivedAt,
      leadId: null,
      status: "skipped",
      reason,
      leadType,
      portal,
      snippet: msg.snippet,
      ident,
      rawBody: (msg.bodyText || msg.snippet).slice(0, 15000),
    });
    return {
      status: "skipped",
      reason:
        websiteMatch?.kind === "ambiguous"
          ? websiteMatch.reason
          : "Website financing form with no matching open deal. Queued for GSM — will retry 7 days.",
      lead_type: leadType,
      portal,
    };
  }

  const leadId = uid();
  // Inventory → Lucas; general stays unassigned (GSM/Admin digests)
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
      ${customerPhone ? (parsed.phone || customerPhone) : null},
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
  const maxResults = opts?.maxResults ?? 80;

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

  // Re-try unmatched financing forms stored from earlier runs (Gmail window may have dropped them)
  try {
    const pending = await sql<{
      gmail_message_id: string;
      gmail_thread_id: string | null;
      from_address: string | null;
      subject: string | null;
      raw_body: string | null;
      raw_snippet: string | null;
      created_at: string;
      status: string;
      reason: string | null;
    }>`
      select gmail_message_id, gmail_thread_id, from_address, subject, raw_body, raw_snippet,
             created_at::text as created_at, status, reason
      from email_imports
      where status = 'skipped'
        and reason in (${LEASE_APP_UNMATCHED}, ${LEASE_APP_AMBIGUOUS})
        and created_at > now() - interval '7 days'
        and coalesce(raw_body, raw_snippet, '') <> ''
    `;
    const seen = new Set(messages.map((m) => m.id));
    for (const row of pending) {
      if (seen.has(row.gmail_message_id)) continue;
      if (!isRetryableUnmatched(row)) continue;
      const fake = {
        id: row.gmail_message_id,
        threadId: row.gmail_thread_id || "",
        from: row.from_address || "no-reply@tadvantage.ca",
        subject: row.subject || "Financing form",
        snippet: (row.raw_snippet || "").slice(0, 400),
        bodyText: row.raw_body || row.raw_snippet || "",
        date: null,
        internalDate: 0,
      } as GmailMessage;
      const r = await processMessage(sql, fake);
      if (r.status === "merged") merged += 1;
      details.push({
        subject: fake.subject,
        from: fake.from,
        status: r.status,
        reason: r.reason ? `retry:${r.reason}` : "retry",
        lead_id: r.lead_id,
      });
    }
  } catch {
    // retry pass is best-effort
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
  const unmatched = await listUnmatchedLeaseApps(sql);
  return {
    config,
    last_run: last[0]?.value ?? null,
    last_run_at: last[0]?.updated_at ?? null,
    recent,
    unmatched,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  };
}
