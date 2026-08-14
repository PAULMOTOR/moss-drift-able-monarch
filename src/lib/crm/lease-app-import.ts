/**
 * TAdvantage / website financing forms: never a new lead.
 * Attach to an existing open deal, wake the pipeline, retry unmatched for 7 days.
 */
import type { Sql } from "@/lib/db";
import { sendCrmEmail } from "./mail";
import { appBaseUrl, getTorontoClock } from "./reminders";
import { normalizeEmail, normalizePhone } from "./classify-email";
import { compactEmailBody } from "./email-text";

export const LEASE_APP_UNMATCHED = "lease-app-no-existing-lead";
export const LEASE_APP_AMBIGUOUS = "lease-app-ambiguous";
const RETRY_DAYS = 7;

export type LeaseAppIdentity = {
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  vehicle: string | null;
  stock: string | null;
  isBusiness: boolean;
};

export type WebsiteLeaseMatch =
  | { kind: "hit"; id: string; name: string; reason: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "none" };

function uid() {
  return crypto.randomUUID();
}

export function normalizeBusinessName(raw: string | null | undefined): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\b(inc|incorporated|llc|ltd|ltee|ltée|corp|corporation|co|company|inc\.|ltd\.)\b/g, "")
    .replace(/[^a-z0-9à-ÿ]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function phonesMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

function vehicleScore(want: string | null, have: string | null): number {
  if (!want || !have) return 0;
  const a = new Set(
    want
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
  const b = new Set(
    have
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
  let hit = 0;
  for (const t of a) if (b.has(t)) hit += 1;
  if (hit >= 2) return 25;
  if (a.size <= 2 && hit >= 1) return 15;
  return 0;
}

export async function findWebsiteLeaseDeal(
  sql: Sql,
  ident: LeaseAppIdentity,
): Promise<WebsiteLeaseMatch> {
  const email = ident.email;
  const phone = ident.phone;
  const companyKey = normalizeBusinessName(ident.company);
  if (!email && !phone && companyKey.length < 4) return { kind: "none" };

  const cands = await sql<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    vehicle_interest: string | null;
    stock_number: string | null;
    lead_type: string;
    legal_entity_name: string | null;
    updated_at: string;
  }>`
    select l.id, l.name, l.email, l.phone, l.vehicle_interest,
           i.stock_number, l.lead_type, l.legal_entity_name,
           l.updated_at::text as updated_at
    from leads l
    left join inventory i on i.id = l.inventory_id
    where l.stage not in ('won', 'lost')
      and l.created_at > now() - interval '180 days'
    order by l.updated_at desc
    limit 200
  `;

  const emailHits = email
    ? cands.filter((c) => normalizeEmail(c.email) === email)
    : [];
  const phoneHits = phone
    ? cands.filter((c) => phonesMatch(phone, normalizePhone(c.phone)))
    : [];

  if (emailHits.length && phoneHits.length) {
    const phoneIds = new Set(phoneHits.map((c) => c.id));
    const overlap = emailHits.filter((c) => phoneIds.has(c.id));
    if (overlap.length === 0) {
      return {
        kind: "ambiguous",
        reason: "Email and phone match two different open deals — GSM must attach",
      };
    }
  }

  let pool = cands;
  if (emailHits.length && phoneHits.length) {
    const phoneIds = new Set(phoneHits.map((c) => c.id));
    const overlap = emailHits.filter((c) => phoneIds.has(c.id));
    pool = overlap.length ? overlap : emailHits;
  } else if (emailHits.length) {
    pool = emailHits;
  } else if (phoneHits.length) {
    pool = phoneHits;
  } else if (companyKey.length >= 4) {
    const biz = cands.filter(
      (c) => normalizeBusinessName(c.legal_entity_name) === companyKey,
    );
    if (biz.length === 0) return { kind: "none" };
    pool = biz;
  } else {
    return { kind: "none" };
  }

  const scored = pool
    .map((c) => {
      let score = 0;
      const reasons: string[] = [];
      if (email && normalizeEmail(c.email) === email) {
        score += 100;
        reasons.push("email");
      }
      if (phone && phonesMatch(phone, normalizePhone(c.phone))) {
        score += 80;
        reasons.push("phone");
      }
      if (companyKey.length >= 4 && normalizeBusinessName(c.legal_entity_name) === companyKey) {
        score += 50;
        reasons.push("company");
      }
      if (ident.stock && c.stock_number && ident.stock.toLowerCase() === c.stock_number.toLowerCase()) {
        score += 40;
        reasons.push("stock");
      }
      const vs = vehicleScore(ident.vehicle, c.vehicle_interest);
      if (vs) {
        score += vs;
        reasons.push("vehicle");
      }
      if (c.lead_type === "inventory") score += 8;
      else if (c.lead_type === "lease") score += 6;
      else if (c.lead_type === "cash" || c.lead_type === "wholesale") score += 4;
      const ageHrs = Math.max(
        0,
        (Date.now() - new Date(c.updated_at).getTime()) / 36e5,
      );
      score += Math.max(0, 10 - ageHrs / 24);
      return { c, score, reasons };
    })
    .sort((a, b) => b.score - a.score || b.c.updated_at.localeCompare(a.c.updated_at));

  const best = scored[0];
  if (!best || best.score < 50) return { kind: "none" };
  return {
    kind: "hit",
    id: best.c.id,
    name: best.c.name,
    reason: best.reasons.join("+") || "match",
  };
}

export async function applyWebsiteLeaseAppToLead(
  sql: Sql,
  leadId: string,
  ident: LeaseAppIdentity,
  msg: {
    from: string;
    subject: string;
    body: string;
  },
): Promise<{
  leadName: string;
  assignedTo: string | null;
  unpaused: boolean;
  stageMoved: string | null;
}> {
  const rows = await sql<{
    id: string;
    name: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    stage: string;
    pause_note: string | null;
    stage_before_pause: string | null;
    credit_status: string | null;
    legal_entity_name: string | null;
    party_type: string | null;
    assigned_to: string | null;
    vehicle_interest: string | null;
    notes: string | null;
  }>`
    select id, name, first_name, last_name, phone, email, stage, pause_note,
           stage_before_pause, credit_status, legal_entity_name, party_type,
           assigned_to, vehicle_interest, notes
    from leads where id = ${leadId} limit 1
  `;
  const lead = rows[0];
  if (!lead) throw new Error("Lead not found");

  const junkName = !lead.name || /^(trader|email lead|tadvantage|unknown)/i.test(lead.name);
  const nextName =
    ident.name && ident.name !== "Email lead" && junkName ? ident.name : lead.name;
  const nameParts = nextName.trim().split(/\s+/).filter(Boolean);
  const nextFirst = junkName ? nameParts[0] || lead.first_name : lead.first_name;
  const nextLast =
    junkName && nameParts.length > 1 ? nameParts.slice(1).join(" ") : lead.last_name;

  const nextPhone = !normalizePhone(lead.phone) && ident.phone ? ident.phone : lead.phone;
  const nextEmail = !normalizeEmail(lead.email) && ident.email ? ident.email : lead.email;
  const nextCompany =
    ident.company && !lead.legal_entity_name?.trim() ? ident.company : lead.legal_entity_name;
  const nextParty =
    ident.isBusiness || lead.party_type === "business" ? "business" : lead.party_type || "individual";

  let nextStage = lead.stage;
  let unpaused = false;
  let stageMoved: string | null = null;
  if (lead.stage === "paused") {
    const restored = lead.stage_before_pause && lead.stage_before_pause !== "paused"
      ? lead.stage_before_pause
      : "quote_sent";
    nextStage = ["new", "contacted"].includes(restored) ? "quote_sent" : restored;
    unpaused = true;
    stageMoved = `${lead.stage} → ${nextStage}`;
  } else if (lead.stage === "new" || lead.stage === "contacted") {
    nextStage = "quote_sent";
    stageMoved = `${lead.stage} → quote_sent`;
  }

  const cs = lead.credit_status || "none";
  const nextCredit =
    cs === "none" || cs === "app_requested" ? "app_submitted" : cs;

  const block = [
    "TAdvantage / website financing form received (attached to this deal, not a new lead).",
    `From: ${msg.from}`,
    `Subject: ${msg.subject}`,
    ident.company ? `Company: ${ident.company}` : "",
    compactEmailBody(msg.body, 1500),
  ]
    .filter(Boolean)
    .join("\n");

  await sql`
    update leads set
      name = ${nextName},
      first_name = ${nextFirst},
      last_name = ${nextLast},
      phone = ${nextPhone},
      email = ${nextEmail},
      legal_entity_name = ${nextCompany},
      party_type = ${nextParty},
      vehicle_interest = coalesce(nullif(vehicle_interest, ''), ${ident.vehicle}),
      notes = case
        when notes is null or notes = '' then ${block}
        else notes || ${"\n\n---\n" + block}
      end,
      stage = ${nextStage},
      stage_entered_at = case when ${nextStage} <> ${lead.stage} then now() else stage_entered_at end,
      pause_until = case when ${unpaused} then null else pause_until end,
      pause_note = case when ${unpaused} then null else pause_note end,
      stage_before_pause = case when ${unpaused} then null else stage_before_pause end,
      credit_status = ${nextCredit},
      updated_at = now()
    where id = ${leadId}
  `;

  await sql`
    insert into lead_activities (id, lead_id, kind, body, created_by_name)
    values (
      ${uid()}, ${leadId}, 'email',
      ${block},
      'Email Import'
    )
  `;

  return {
    leadName: nextName,
    assignedTo: lead.assigned_to,
    unpaused,
    stageMoved,
  };
}

export async function notifyLeaseAppAttached(
  sql: Sql,
  opts: {
    leadId: string;
    leadName: string;
    assignedTo: string | null;
    subject: string;
    unpaused: boolean;
    stageMoved: string | null;
  },
) {
  const base = appBaseUrl();
  const link = `${base}/leads/${opts.leadId}?tab=credit`;
  const bits = [
    `A website financing form was attached to ${opts.leadName}.`,
    opts.unpaused ? "The deal was unpaused (they just applied)." : "",
    opts.stageMoved ? `Stage: ${opts.stageMoved}.` : "",
    `Credit is marked App received if it was still empty.`,
    ``,
    `Open: ${link}`,
  ].filter(Boolean);

  const targets = await sql<{ id: string; email: string; name: string }>`
    select id, email, name from profiles
    where active = true
      and (
        id = ${opts.assignedTo}
        or role = 'credit_manager'
      )
      and email is not null and email <> ''
  `;
  const seen = new Set<string>();
  for (const t of targets) {
    const em = t.email.trim().toLowerCase();
    if (seen.has(em)) continue;
    seen.add(em);
    await sendCrmEmail(sql, {
      to: t.email,
      subject: `[CRM] Financing form on ${opts.leadName}`,
      text: [`Hi ${t.name.split(" ")[0]},`, ``, ...bits, ``, `— PAUL MOTOR CO. CRM`].join("\n"),
      kind: "lease_app_attached",
      leadId: opts.leadId,
      profileId: t.id,
    });
  }
}

export type UnmatchedLeaseApp = {
  id: string;
  gmail_message_id: string;
  subject: string | null;
  from_address: string | null;
  reason: string | null;
  parsed_name: string | null;
  parsed_email: string | null;
  parsed_phone: string | null;
  parsed_company: string | null;
  created_at: string;
};

export async function listUnmatchedLeaseApps(sql: Sql): Promise<UnmatchedLeaseApp[]> {
  return sql<UnmatchedLeaseApp>`
    select id, gmail_message_id, subject, from_address, reason,
           parsed_name, parsed_email, parsed_phone, parsed_company,
           created_at::text as created_at
    from email_imports
    where status = 'skipped'
      and reason in (${LEASE_APP_UNMATCHED}, ${LEASE_APP_AMBIGUOUS})
      and created_at > now() - interval '30 days'
    order by created_at desc
    limit 50
  `;
}

export async function attachUnmatchedLeaseApp(
  sql: Sql,
  opts: { importId: string; leadId: string },
): Promise<{ ok: true; leadName: string }> {
  const rows = await sql<{
    id: string;
    from_address: string | null;
    subject: string | null;
    raw_body: string | null;
    raw_snippet: string | null;
    parsed_name: string | null;
    parsed_email: string | null;
    parsed_phone: string | null;
    parsed_company: string | null;
    reason: string | null;
  }>`
    select id, from_address, subject, raw_body, raw_snippet,
           parsed_name, parsed_email, parsed_phone, parsed_company, reason
    from email_imports where id = ${opts.importId} limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Import row not found");

  const ident: LeaseAppIdentity = {
    name: row.parsed_name || "Website applicant",
    email: normalizeEmail(row.parsed_email),
    phone: normalizePhone(row.parsed_phone),
    company: row.parsed_company,
    vehicle: null,
    stock: null,
    isBusiness: Boolean(row.parsed_company),
  };
  const applied = await applyWebsiteLeaseAppToLead(sql, opts.leadId, ident, {
    from: row.from_address || "no-reply@tadvantage.ca",
    subject: row.subject || "Financing form",
    body: row.raw_body || row.raw_snippet || "",
  });
  await sql`
    update email_imports set
      lead_id = ${opts.leadId},
      status = 'merged',
      reason = ${"manual-attach:" + opts.leadId}
    where id = ${opts.importId}
  `;
  await notifyLeaseAppAttached(sql, {
    leadId: opts.leadId,
    leadName: applied.leadName,
    assignedTo: applied.assignedTo,
    subject: row.subject || "Financing form",
    unpaused: applied.unpaused,
    stageMoved: applied.stageMoved,
  });
  return { ok: true, leadName: applied.leadName };
}

export function isRetryableUnmatched(row: {
  status: string;
  reason: string | null;
  created_at: string;
}): boolean {
  if (row.status !== "skipped") return false;
  if (row.reason !== LEASE_APP_UNMATCHED && row.reason !== LEASE_APP_AMBIGUOUS) return false;
  const age = Date.now() - new Date(row.created_at).getTime();
  return age < RETRY_DAYS * 864e5;
}

export async function runUnmatchedLeaseAppDigest(sql: Sql) {
  const clock = getTorontoClock();
  if (!clock.isWeekday) {
    return { sent: 0, reason: "weekend" as const, n: 0 };
  }

  const already = await sql<{ n: number }>`
    select count(*)::int as n from reminder_sends
    where kind = 'unmatched_lease_apps'
      and meta = ${clock.dateKey}
  `;
  if ((already[0]?.n ?? 0) > 0) {
    return { sent: 0, reason: "already_sent" as const, n: 0 };
  }

  const apps = await listUnmatchedLeaseApps(sql);
  const fresh = apps.filter((a) => isRetryableUnmatched({
    status: "skipped",
    reason: a.reason,
    created_at: a.created_at,
  }));
  if (fresh.length === 0) {
    return { sent: 0, reason: "none" as const, n: 0 };
  }

  const managers = await sql<{ id: string; email: string; name: string }>`
    select id, email, name from profiles
    where active = true and role in ('gsm', 'admin')
    order by case role when 'gsm' then 0 else 1 end, name
  `;
  if (!managers.length) return { sent: 0, reason: "no_managers" as const, n: fresh.length };

  const base = appBaseUrl();
  const lines = fresh.map((a) => {
    const who = [a.parsed_name, a.parsed_company, a.parsed_email, a.parsed_phone]
      .filter(Boolean)
      .join(" · ");
    return `• ${a.subject || "Financing form"} — ${who || a.from_address || "—"}\n  ${a.reason}\n  Attach in Admin: ${base}/admin`;
  });
  const subject = `[CRM] Unmatched financing forms — ${fresh.length} need a deal`;
  const text = [
    `GSM / Admins,`,
    ``,
    `These TAdvantage / website financing forms could not be attached to an open deal.`,
    `They will keep retrying for 7 days. Please attach them in Admin → Email import.`,
    ``,
    lines.join("\n\n"),
    ``,
    `— PAUL MOTOR CO. CRM`,
  ].join("\n");

  let sent = 0;
  for (const m of managers) {
    await sendCrmEmail(sql, {
      to: m.email,
      subject,
      text,
      kind: "unmatched_lease_apps",
      profileId: m.id,
    });
    sent += 1;
  }
  await sql`
    insert into reminder_sends (id, kind, profile_id, lead_id, meta)
    values (${uid()}, 'unmatched_lease_apps', ${managers[0]!.id}, null, ${clock.dateKey})
  `;
  return { sent, reason: "ok" as const, n: fresh.length };
}
