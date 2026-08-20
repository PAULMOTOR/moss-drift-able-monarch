/**
 * Credit underwriting workflow (Paays/RouteOne-inspired).
 * Public token links for lessee credit app + doc uploads.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { sendCrmEmail, clientFacingFromName, replyToForActor } from "./mail";
import { fetchPartnerForLead, referralClientCopy } from "./partners";
import {
  CUSTOMER_CHECKLIST,
  LESSEE_DOC_TYPES,
  STAFF_UPLOAD_DOC_TYPES,
  VEHICLE_CHECKLIST,
  checklistDef,
  lesseeDocLabel,
  type CreditApplication,
  type CreditChecklistItem,
  type CreditDocument,
  type CreditDocumentKind,
  type CreditPayload,
  type LesseeDocTypeKey,
  type Profile,
} from "./types";

import { publicAppUrl } from "./public-url";
import { ensureHeroShotForLead } from "./handoff";
import { loadHeroShotForLead, publicHeroUrl } from "./hero-shot";
import {
  attachInventoryListingThenKickHero,
  ensureInventoryListingAndHero,
  generatePalmettoTileImage,
  parseVehicleBits,
  pickListingPhoto,
  saveHeroShot,
} from "./palmetto-tile";

function uid() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function appBaseUrl() {
  return publicAppUrl();
}

function toCreditPayload(raw: unknown): CreditPayload {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return {};
  }
  const out: CreditPayload = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) out[k] = "";
    else if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

function mapApp(r: Record<string, unknown>): CreditApplication {
  return {
    id: String(r.id),
    lead_id: String(r.lead_id),
    status: r.status as CreditApplication["status"],
    party_type: (r.party_type as CreditApplication["party_type"]) || "individual",
    payload: toCreditPayload(r.payload),
    public_token: (r.public_token as string) ?? null,
    doc_request_token: (r.doc_request_token as string) ?? null,
    app_email: (r.app_email as string) ?? null,
    requested_by: (r.requested_by as string) ?? null,
    submitted_at: (r.submitted_at as string) ?? null,
    credit_requested_at: (r.credit_requested_at as string) ?? null,
    credit_requested_by: (r.credit_requested_by as string) ?? null,
    credit_request_notes: (r.credit_request_notes as string) ?? null,
    do_not_pull_credit: Boolean(r.do_not_pull_credit),
    equifax_file_name: (r.equifax_file_name as string) ?? null,
    equifax_file_data: (r.equifax_file_data as string) ?? null,
    equifax_notes: (r.equifax_notes as string) ?? null,
    gsm_requested_at: (r.gsm_requested_at as string) ?? null,
    gsm_requested_by: (r.gsm_requested_by as string) ?? null,
    approved_by: (r.approved_by as string) ?? null,
    approved_at: (r.approved_at as string) ?? null,
    approval_notes: (r.approval_notes as string) ?? null,
    vehicle_checklist_complete: Boolean(r.vehicle_checklist_complete),
    customer_checklist_complete: Boolean(r.customer_checklist_complete),
    applicant_role: r.applicant_role === "guarantor" ? "guarantor" : "primary",
    guarantor_slot: r.guarantor_slot != null ? Number(r.guarantor_slot) : null,
    applicant_name: (r.applicant_name as string) ?? null,
    applicant_email: (r.applicant_email as string) ?? null,
    applicant_phone: (r.applicant_phone as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

async function requireProfile(userId: string): Promise<Profile> {
  const sql = await getSql();
  const rows = await sql<Profile>`
    select id, user_id, email, name, role, active, phone, title,
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
    from profiles where user_id = ${userId} limit 1
  `;
  const p = rows[0];
  if (!p || !p.active) throw new Error("No active CRM profile");
  return p;
}

function canSeeCredit(me: Profile, assignedTo: string | null): boolean {
  if (me.role === "admin" || me.role === "gsm" || me.role === "credit_manager") return true;
  if (assignedTo && assignedTo === me.id) return true;
  return false;
}

async function seedChecklist(sql: Awaited<ReturnType<typeof getSql>>, appId: string) {
  for (const item of VEHICLE_CHECKLIST) {
    await sql`
      insert into credit_checklist (id, application_id, section, item_key, label, notes, done)
      values (${uid()}, ${appId}, 'vehicle', ${item.key}, ${item.label}, '', false)
      on conflict (application_id, item_key) do update set label = excluded.label
    `;
  }
  for (const item of CUSTOMER_CHECKLIST) {
    await sql`
      insert into credit_checklist (id, application_id, section, item_key, label, notes, done)
      values (${uid()}, ${appId}, 'customer', ${item.key}, ${item.label}, '', false)
      on conflict (application_id, item_key) do update set label = excluded.label
    `;
  }
}

/** Section complete = all non-optional items done. */
async function refreshChecklistComplete(
  sql: Awaited<ReturnType<typeof getSql>>,
  applicationId: string,
) {
  const rows = await sql<{ section: string; item_key: string; done: boolean }>`
    select section, item_key, done from credit_checklist
    where application_id = ${applicationId}
  `;
  const vehKeys = new Set(
    VEHICLE_CHECKLIST.filter((i) => !i.optionalForComplete).map((i) => i.key),
  );
  const custKeys = new Set(
    CUSTOMER_CHECKLIST.filter((i) => !i.optionalForComplete).map((i) => i.key),
  );
  const byKey = new Map(rows.map((r) => [r.item_key, r]));
  let vehOk = vehKeys.size > 0;
  for (const k of vehKeys) {
    if (!byKey.get(k)?.done) {
      vehOk = false;
      break;
    }
  }
  let custOk = custKeys.size > 0;
  for (const k of custKeys) {
    if (!byKey.get(k)?.done) {
      custOk = false;
      break;
    }
  }
  await sql`
    update credit_applications set
      vehicle_checklist_complete = ${vehOk},
      customer_checklist_complete = ${custOk},
      status = case
        when status in ('approved', 'declined', 'cancelled', 'pending_gsm') then status
        else 'in_review'
      end,
      updated_at = now()
    where id = ${applicationId}
  `;
}

async function ensureCreditPartySchema(sql: Awaited<ReturnType<typeof getSql>>) {
  await sql`alter table credit_applications add column if not exists applicant_role text default 'primary'`;
  await sql`alter table credit_applications add column if not exists guarantor_slot int`;
  await sql`alter table credit_applications add column if not exists applicant_name text`;
  await sql`alter table credit_applications add column if not exists applicant_email text`;
  await sql`alter table credit_applications add column if not exists applicant_phone text`;
}

async function syncLeadGuarantorLabel(sql: Awaited<ReturnType<typeof getSql>>, leadId: string) {
  const rows = await sql<{ applicant_name: string | null; guarantor_slot: number | null }>`
    select applicant_name, guarantor_slot from credit_applications
    where lead_id = ${leadId} and applicant_role = 'guarantor'
    order by guarantor_slot nulls last
  `;
  const label =
    rows
      .map((r) => (r.applicant_name || "").trim())
      .filter(Boolean)
      .join(" · ") || null;
  await sql`update leads set guarantor = ${label}, updated_at = now() where id = ${leadId}`;
  return label;
}

async function getOrCreateApp(sql: Awaited<ReturnType<typeof getSql>>, leadId: string, meId: string) {
  await ensureCreditPartySchema(sql);
  const existing = await sql.query<Record<string, unknown>>(
    `select * from credit_applications
     where lead_id = $1
       and coalesce(applicant_role, 'primary') = 'primary'
     order by created_at asc limit 1`,
    [leadId],
  );
  if (existing[0]) {
    const app = mapApp(existing[0]);
    await seedChecklist(sql, app.id);
    return app;
  }
  const id = uid();
  const pub = token();
  await sql`
    insert into credit_applications (
      id, lead_id, status, party_type, public_token, requested_by, applicant_role
    ) values (
      ${id}, ${leadId}, 'draft', 'individual', ${pub}, ${meId}, 'primary'
    )
  `;
  await seedChecklist(sql, id);
  await sql`update leads set credit_app_id = ${id}, updated_at = now() where id = ${leadId}`;
  const rows = await sql.query<Record<string, unknown>>(
    `select * from credit_applications where id = $1`,
    [id],
  );
  return mapApp(rows[0]!);
}

export async function getOrCreateGuarantorApp(
  sql: Awaited<ReturnType<typeof getSql>>,
  opts: {
    leadId: string;
    slot: 1 | 2;
    meId: string | null;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  },
): Promise<CreditApplication> {
  await ensureCreditPartySchema(sql);
  const existing = await sql.query<Record<string, unknown>>(
    `select * from credit_applications
     where lead_id = $1 and applicant_role = 'guarantor' and guarantor_slot = $2
     limit 1`,
    [opts.leadId, opts.slot],
  );
  if (existing[0]) {
    const app = mapApp(existing[0]);
    await seedChecklist(sql, app.id);
    if (opts.name || opts.email || opts.phone) {
      await sql`
        update credit_applications set
          applicant_name = coalesce(${opts.name?.trim() || null}, applicant_name),
          applicant_email = coalesce(${opts.email?.trim().toLowerCase() || null}, applicant_email),
          applicant_phone = coalesce(${opts.phone?.trim() || null}, applicant_phone),
          app_email = coalesce(${opts.email?.trim().toLowerCase() || null}, app_email),
          updated_at = now()
        where id = ${app.id}
      `;
    }
    await syncLeadGuarantorLabel(sql, opts.leadId);
    const rows = await sql.query<Record<string, unknown>>(
      `select * from credit_applications where id = $1`,
      [app.id],
    );
    return mapApp(rows[0]!);
  }
  const count = await sql<{ n: number }>`
    select count(*)::int as n from credit_applications
    where lead_id = ${opts.leadId} and applicant_role = 'guarantor'
  `;
  if ((count[0]?.n ?? 0) >= 2) throw new Error("This deal already has two guarantors");
  const id = uid();
  const pub = token();
  const name = opts.name?.trim() || `Guarantor ${opts.slot}`;
  const email = opts.email?.trim().toLowerCase() || null;
  const phone = opts.phone?.trim() || null;
  const payload = {
    full_name: name,
    email: email || "",
    phone: phone || "",
    role: "guarantor",
  };
  await sql`
    insert into credit_applications (
      id, lead_id, status, party_type, public_token, requested_by,
      applicant_role, guarantor_slot, applicant_name, applicant_email, applicant_phone,
      app_email, payload
    ) values (
      ${id}, ${opts.leadId}, 'app_submitted', 'individual', ${pub}, ${opts.meId},
      'guarantor', ${opts.slot}, ${name}, ${email}, ${phone},
      ${email}, ${JSON.stringify(payload)}::jsonb
    )
  `;
  await seedChecklist(sql, id);
  await syncLeadGuarantorLabel(sql, opts.leadId);
  const rows = await sql.query<Record<string, unknown>>(
    `select * from credit_applications where id = $1`,
    [id],
  );
  return mapApp(rows[0]!);
}

export function splitPersonName(full: string): { first_name: string; last_name: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: "", last_name: "" };
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

/** Staff: get underwriting package for a lead */
export const getCreditPackage = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const leadRows = await sql.query<Record<string, unknown>>(
      `select l.id, l.name, l.email, l.phone, l.first_name, l.last_name, l.party_type, l.assigned_to,
              l.credit_status, l.credit_app_id, l.vehicle_interest, l.stage, l.guarantor,
              l.partner_id, pr.name as partner_name, pr.kind as partner_kind, pr.email as partner_email,
              ap.email as assigned_email, ap.name as assigned_name
       from leads l
       left join partners pr on pr.id = l.partner_id
       left join profiles ap on ap.id = l.assigned_to
       where l.id = $1 limit 1`,
      [data.leadId],
    );
    if (!leadRows[0]) throw new Error("Lead not found");
    const lead = leadRows[0];
    if (!canSeeCredit(me, (lead.assigned_to as string) || null)) {
      throw new Error("You do not have access to credit data for this lead");
    }
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    if (!app.applicant_name) {
      await sql`
        update credit_applications set
          applicant_name = coalesce(applicant_name, ${String(lead.name)}),
          applicant_email = coalesce(applicant_email, ${(lead.email as string) || null}),
          applicant_phone = coalesce(applicant_phone, ${(lead.phone as string) || null})
        where id = ${app.id}
      `;
    }
    const allApps = await sql.query<Record<string, unknown>>(
      `select * from credit_applications
       where lead_id = $1
       order by case when coalesce(applicant_role,'primary') = 'primary' then 0 else 1 end,
                guarantor_slot nulls last, created_at`,
      [data.leadId],
    );
    const parties = allApps.map(mapApp);
    const guarantors = parties.filter((a) => a.applicant_role === "guarantor");
    const primary = parties.find((a) => a.applicant_role === "primary") || app;
    await ensureHeroShotForLead(sql, data.leadId).catch(() => false);
    await attachInventoryListingThenKickHero(sql, data.leadId);
    const docs = await sql<CreditDocument>`
      select id, application_id, lead_id, kind, file_name, mime_type, file_data,
             uploaded_by, uploaded_via, created_at::text as created_at
      from credit_documents where lead_id = ${data.leadId}
      order by created_at desc
    `;
    const allChecks = await sql<CreditChecklistItem>`
      select id, application_id, section, item_key, label, notes, done,
             filled_by, filled_at::text as filled_at
      from credit_checklist
      where application_id in (
        select id from credit_applications where lead_id = ${data.leadId}
      )
    `;
    const order = new Map<string, number>();
    VEHICLE_CHECKLIST.forEach((i, idx) => order.set(i.key, idx));
    CUSTOMER_CHECKLIST.forEach((i, idx) => order.set(i.key, 100 + idx));
    allChecks.sort((a, b) => (order.get(a.item_key) ?? 999) - (order.get(b.item_key) ?? 999));
    const checklist = allChecks.filter((c) => c.application_id === primary.id);
    const checklistsByApp: Record<string, CreditChecklistItem[]> = {};
    for (const c of allChecks) {
      (checklistsByApp[c.application_id] ||= []).push(c);
    }

    const application: CreditApplication = {
      ...primary,
      equifax_file_data: null,
    };
    return {
      me,
      lead: {
        id: String(lead.id),
        name: String(lead.name),
        email: (lead.email as string) || null,
        phone: (lead.phone as string) || null,
        first_name: (lead.first_name as string) || null,
        last_name: (lead.last_name as string) || null,
        party_type: (lead.party_type as string) || "individual",
        assigned_to: (lead.assigned_to as string) || null,
        credit_status: (lead.credit_status as string) || "none",
        vehicle_interest: (lead.vehicle_interest as string) || null,
        stage: String(lead.stage),
        partner_id: (lead.partner_id as string) || null,
        partner_name: (lead.partner_name as string) || null,
        partner_kind: (lead.partner_kind as string) || null,
        partner_email: (lead.partner_email as string) || null,
        assigned_email: (lead.assigned_email as string) || null,
        assigned_name: (lead.assigned_name as string) || null,
        guarantor: (lead.guarantor as string) || null,
      },
      application,
      guarantors: guarantors.map((g) => ({ ...g, equifax_file_data: null })),
      checklistsByApp,
      documents: docs,
      checklist,
      vehicleDefs: VEHICLE_CHECKLIST,
      customerDefs: CUSTOMER_CHECKLIST,
      lesseeDocTypes: [...LESSEE_DOC_TYPES],
      appLink: application.public_token ? `${appBaseUrl()}/credit-app/${application.public_token}` : null,
      docLink: application.doc_request_token
        ? `${appBaseUrl()}/credit-docs/${application.doc_request_token}`
        : null,
    };
  });

/** Request App & IDs — email lessee the public app link */
export const requestCreditApp = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string; email?: string; applicationId?: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const leads = await sql.query<Record<string, unknown>>(
      `select id, name, email, first_name, assigned_to from leads where id = $1`,
      [data.leadId],
    );
    if (!leads[0]) throw new Error("Lead not found");
    const lead = leads[0];
    if (!canSeeCredit(me, (lead.assigned_to as string) || null) && me.role === "broker") {
      throw new Error("Brokers cannot start credit apps");
    }
    let app = await getOrCreateApp(sql, data.leadId, me.id);
    if (data.applicationId && data.applicationId !== app.id) {
      const picked = await sql.query<Record<string, unknown>>(
        `select * from credit_applications where id = $1 and lead_id = $2 limit 1`,
        [data.applicationId, data.leadId],
      );
      if (!picked[0]) throw new Error("Credit application not found");
      app = mapApp(picked[0]);
    }
    const isGuar = app.applicant_role === "guarantor";
    const email = (
      data.email ||
      app.applicant_email ||
      app.app_email ||
      (isGuar ? "" : (lead.email as string)) ||
      ""
    )
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) throw new Error("A valid email is required to send the app");
    const pub = app.public_token || token();
    await sql`
      update credit_applications set
        status = 'app_requested',
        public_token = ${pub},
        app_email = ${email},
        applicant_email = coalesce(applicant_email, ${email}),
        requested_by = ${me.id},
        updated_at = now()
      where id = ${app.id}
    `;
    if (!isGuar) {
      await sql`
        update leads set credit_status = 'app_requested', credit_app_id = ${app.id}, updated_at = now()
        where id = ${data.leadId}
      `;
    }
    const link = `${appBaseUrl()}/credit-app/${pub}`;
    const first =
      (isGuar ? (app.applicant_name || "").split(" ")[0] : "") ||
      (lead.first_name as string) ||
      String(lead.name).split(" ")[0] ||
      "there";
    const partner = await fetchPartnerForLead(sql, data.leadId);
    const referral = referralClientCopy(partner);
    const mailResult = await sendCrmEmail(sql, {
      to: email,
      subject: isGuar
        ? "Paul Motor Leasing — Guarantor credit application & ID upload"
        : "Paul Motor Leasing — Credit application & ID upload",
      kind: "credit_app_request",
      leadId: data.leadId,
      profileId: me.id,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
      text: `Hi ${first},

${referral.text ? referral.text + "\n\n" : ""}Paul Motor Leasing has invited you to complete a short credit application and upload two pieces of identification for your vehicle lease.

Open this secure link (no password required):
${link}

You will:
1) Complete the credit application
2) Upload the front & back of your driver's licence
3) Upload a second ID (passport, PR card, or provincial health card)

Your documents are only visible to authorized Paul Motor staff.

— ${me.name}
Paul Motor Leasing`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5">
<p>Hi ${first},</p>
${referral.html}
<p><strong>Paul Motor Leasing</strong> has invited you to complete a short credit application and upload two pieces of identification for your vehicle lease.</p>
<p><a href="${link}" style="display:inline-block;background:#008272;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:600">Start credit application</a></p>
<p style="font-size:13px;color:#555">Or copy this link:<br/>${link}</p>
<p style="font-size:13px;color:#555">No account password is required. Your documents are only visible to authorized Paul Motor staff.</p>
<p>— ${String(me.name).replace(/</g, "")}<br/>Paul Motor Leasing</p></div>`,
    });
    if (!mailResult.ok) {
      throw new Error(
        mailResult.error ||
          "Email failed to send. Check RESEND_API_KEY, CRM_FROM_EMAIL, and Resend domain status.",
      );
    }
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Credit app & IDs requested → ${email}${isGuar ? ` (guarantor ${app.applicant_name || app.guarantor_slot || ""})` : ""} (email sent)`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const, link, email, outboxId: mailResult.outboxId };
  });

/** Get Credit Approval — notify credit manager */
export const requestCreditReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      notes?: string;
      doNotPullCredit?: boolean;
      equifaxFileName?: string | null;
      equifaxFileData?: string | null;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    const doNotPull = Boolean(data.doNotPullCredit);
    await sql`
      update credit_applications set
        status = 'credit_requested',
        credit_requested_at = now(),
        credit_requested_by = ${me.id},
        credit_request_notes = ${data.notes?.trim() || null},
        do_not_pull_credit = ${doNotPull},
        equifax_file_name = ${data.equifaxFileName || null},
        equifax_file_data = ${data.equifaxFileData || null},
        updated_at = now()
      where id = ${app.id}
    `;
    if (data.equifaxFileData && data.equifaxFileName) {
      await sql`
        insert into credit_documents (
          id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_by, uploaded_via
        ) values (
          ${uid()}, ${app.id}, ${data.leadId}, 'equifax',
          ${data.equifaxFileName}, 'application/pdf', ${data.equifaxFileData},
          ${me.id}, 'crm'
        )
      `;
    }
    await sql`
      update leads set
        credit_status = 'credit_requested',
        stage = case when stage in ('new','contacted','paused','quote_sent','lease_accepted') then 'credit_review' else stage end,
        stage_entered_at = case when stage in ('new','contacted','paused','quote_sent','lease_accepted') then now() else stage_entered_at end,
        updated_at = now()
      where id = ${data.leadId}
    `;
    const cms = await sql<{ email: string; name: string }>`
      select email, name from profiles
      where active = true and role in ('credit_manager', 'admin')
    `;
    const lead = await sql<{ name: string }>`select name from leads where id = ${data.leadId}`;
    const link = `${appBaseUrl()}/leads/${data.leadId}?tab=credit`;
    const clientName = lead[0]?.name || "Lead";
    const subject = doNotPull
      ? `DO NOT PULL CREDIT — ${clientName}`
      : `Credit review requested — ${clientName}`;
    const dnpBanner = doNotPull
      ? `\n\n*** DO NOT PULL CREDIT on this file ***\nThe rep checked “Do not pull credit”. Use the attached Equifax (if any) or existing file only — do not run a new bureau pull.\n`
      : "";
    const dnpHtml = doNotPull
      ? `<div style="background:#7f1d1d;color:#fff;padding:12px 16px;border-radius:4px;margin:12px 0;font-weight:700">
DO NOT PULL CREDIT — the rep checked this box. Do not run a new bureau pull. Use existing Equifax only.
</div>`
      : "";
    for (const cm of cms) {
      await sendCrmEmail(sql, {
        to: cm.email,
        subject,
        kind: "credit_review_request",
        leadId: data.leadId,
        text: `${me.name} requested credit approval for ${clientName}.${dnpBanner}\nNotes: ${data.notes || "—"}\nDo not pull credit: ${doNotPull ? "YES — DO NOT PULL" : "No"}\n\nOpen: ${link}`,
        html: `<p><strong>${me.name}</strong> requested credit approval for <strong>${clientName}</strong>.</p>
${dnpHtml}
<p>Notes: ${data.notes || "—"}<br/>Do not pull credit: <strong>${doNotPull ? "YES — DO NOT PULL" : "No"}</strong></p>
<p><a href="${link}">Open deal in CRM</a></p>`,
      });
    }
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Credit approval requested by ${me.name}${doNotPull ? " · DO NOT PULL CREDIT" : ""}`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const };
  });

export const updateChecklistItem = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      applicationId: string;
      itemKey: string;
      notes?: string;
      done?: boolean;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const items = await sql`
      select c.*, a.lead_id from credit_checklist c
      join credit_applications a on a.id = c.application_id
      where c.application_id = ${data.applicationId} and c.item_key = ${data.itemKey}
      limit 1
    `;
    if (!items[0]) throw new Error("Checklist item not found");
    const section = String((items[0] as { section: string }).section) as "vehicle" | "customer";
    if (section === "vehicle" && !["admin", "rep", "gsm", "credit_manager"].includes(me.role)) {
      throw new Error("Only sales can fill vehicle checklist");
    }
    if (section === "customer" && !["admin", "credit_manager", "gsm"].includes(me.role)) {
      throw new Error("Only Credit Manager / Admin / GSM can fill customer checklist");
    }
    const def = checklistDef(section, data.itemKey);
    if (data.done === true && def?.uploadRequired) {
      const has = await sql<{ n: number }>`
        select count(*)::int as n from credit_documents
        where application_id = ${data.applicationId} and kind = ${data.itemKey}
      `;
      if ((has[0]?.n ?? 0) === 0) {
        throw new Error("Upload a document on this line before marking it complete");
      }
    }
    await sql`
      update credit_checklist set
        notes = coalesce(${data.notes ?? null}, notes),
        done = coalesce(${data.done ?? null}, done),
        filled_by = ${me.id},
        filled_at = now()
      where application_id = ${data.applicationId} and item_key = ${data.itemKey}
    `;
    await refreshChecklistComplete(sql, data.applicationId);
    return { ok: true as const };
  });

/** Staff upload attached to a checklist line (kind = item_key). */
export const uploadChecklistDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      applicationId: string;
      itemKey: string;
      fileName: string;
      mimeType?: string;
      fileData: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const items = await sql<{ section: string }>`
      select section from credit_checklist
      where application_id = ${data.applicationId} and item_key = ${data.itemKey}
      limit 1
    `;
    if (!items[0]) throw new Error("Checklist item not found");
    const section = items[0].section as "vehicle" | "customer";
    const def = checklistDef(section, data.itemKey);
    if (!def?.needsUpload) throw new Error("This checklist line does not accept uploads");
    if (section === "vehicle" && !["admin", "rep", "gsm", "credit_manager"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    if (section === "customer" && !["admin", "credit_manager", "gsm", "rep"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    if (data.fileData.length > 6_000_000) throw new Error("File too large (max ~4MB)");
    const id = uid();
    await sql`
      insert into credit_documents (
        id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_by, uploaded_via
      ) values (
        ${id}, ${data.applicationId}, ${data.leadId}, ${data.itemKey},
        ${data.fileName}, ${data.mimeType || "application/octet-stream"}, ${data.fileData},
        ${me.id}, 'crm'
      )
    `;
    // Auto-complete when upload is the signoff (required or optional bill of sale stays optional)
    if (def.uploadRequired) {
      await sql`
        update credit_checklist set done = true, filled_by = ${me.id}, filled_at = now()
        where application_id = ${data.applicationId} and item_key = ${data.itemKey}
      `;
      await refreshChecklistComplete(sql, data.applicationId);
    }
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Uploaded ${data.fileName} for checklist: ${def.label}`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const, id };
  });

/** Build the Palmetto inventory tile from Listing Photo and save it as Hero Shot. */
export const generatePalmettoHeroTile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string; applicationId: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "rep", "gsm", "credit_manager"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    const sql = await getSql();
    const leads = await sql<{
      assigned_to: string | null;
      vehicle_interest: string | null;
      inventory_id: string | null;
    }>`
      select assigned_to, vehicle_interest, inventory_id from leads where id = ${data.leadId} limit 1
    `;
    if (!leads[0]) throw new Error("Lead not found");
    if (!canSeeCredit(me, leads[0].assigned_to)) {
      throw new Error("You can only generate a tile on your deals");
    }
    if (leads[0].inventory_id) {
      await ensureInventoryListingAndHero(sql, data.leadId, { generate: false }).catch((e) =>
        console.error("[inventory-listing]", e),
      );
    }
    const pics = await sql<{
      file_name: string;
      mime_type: string;
      file_data: string;
    }>`
      select file_name, mime_type, file_data from credit_documents
      where lead_id = ${data.leadId} and kind = 'listing_pics'
      order by created_at asc
    `;
    const picked = pickListingPhoto(pics);
    let inv:
      | { year: number | null; make: string | null; model: string | null; trim: string | null; color: string | null }
      | undefined;
    if (leads[0].inventory_id) {
      const rows = await sql<{
        year: number | null;
        make: string | null;
        model: string | null;
        trim: string | null;
        exterior_color: string | null;
      }>`
        select year, make, model, trim, exterior_color from inventory where id = ${leads[0].inventory_id} limit 1
      `;
      if (rows[0]) {
        inv = {
          year: rows[0].year,
          make: rows[0].make,
          model: rows[0].model,
          trim: rows[0].trim,
          color: rows[0].exterior_color,
        };
      }
    }
    const vehicle = parseVehicleBits(leads[0].vehicle_interest || "", inv);
    const listingDataUrl =
      picked?.file_data && /^data:image\//i.test(picked.file_data) ? picked.file_data : null;
    if (!listingDataUrl) {
      throw new Error("Add a listing photo of the vehicle first.");
    }
    const result = await generatePalmettoTileImage({
      vehicle,
      listingDataUrl,
    });
    const id = await saveHeroShot(sql, {
      leadId: data.leadId,
      applicationId: data.applicationId,
      dataUrl: result.dataUrl,
      via: result.via,
    });
    return { ok: true as const, id, via: result.via };
  });

/** Sales or credit attach any deal document (not tied to a checklist line). */
export const uploadDealDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      kind: string;
      fileName: string;
      mimeType?: string;
      fileData: string;
      applicationId?: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "rep", "gsm", "credit_manager"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    const sql = await getSql();
    const leads = await sql<{ id: string; assigned_to: string | null }>`
      select id, assigned_to from leads where id = ${data.leadId} limit 1
    `;
    if (!leads[0]) throw new Error("Lead not found");
    if (!canSeeCredit(me, leads[0].assigned_to)) {
      throw new Error("You can only upload documents on your deals");
    }
    const allowed = new Set<string>([
      ...STAFF_UPLOAD_DOC_TYPES.map((d) => d.key),
      ...VEHICLE_CHECKLIST.filter((d) => d.needsUpload).map((d) => d.key),
      ...CUSTOMER_CHECKLIST.filter((d) => d.needsUpload).map((d) => d.key),
    ]);
    const kind = data.kind.trim();
    if (!allowed.has(kind)) throw new Error("Unknown document type");
    if (data.fileData.length > 6_000_000) throw new Error("File too large (max ~4MB)");
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    let applicationId = app.id;
    if (data.applicationId && data.applicationId !== app.id) {
      const picked = await sql<{ id: string }>`
        select id from credit_applications
        where id = ${data.applicationId} and lead_id = ${data.leadId}
        limit 1
      `;
      if (!picked[0]) throw new Error("Credit application not found");
      applicationId = picked[0].id;
    }
    const id = uid();
    await sql`
      insert into credit_documents (
        id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_by, uploaded_via
      ) values (
        ${id}, ${applicationId}, ${data.leadId}, ${kind},
        ${data.fileName}, ${data.mimeType || "application/octet-stream"}, ${data.fileData},
        ${me.id}, 'crm'
      )
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Uploaded ${data.fileName} (${lesseeDocLabel(kind)})`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const, id };
  });

/** GSM / Admin can remove a credit document. */
export const deleteCreditDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { documentId: string; leadId: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "gsm"].includes(me.role)) {
      throw new Error("Only GSM or Admin can delete credit documents");
    }
    const sql = await getSql();
    const rows = await sql<{ id: string; file_name: string; kind: string; application_id: string }>`
      select id, file_name, kind, application_id from credit_documents
      where id = ${data.documentId} and lead_id = ${data.leadId}
      limit 1
    `;
    if (!rows[0]) throw new Error("Document not found");
    await sql`delete from credit_documents where id = ${rows[0].id}`;
    // If required-upload line lost its last file, uncheck it
    const remaining = await sql<{ n: number }>`
      select count(*)::int as n from credit_documents
      where application_id = ${rows[0].application_id} and kind = ${rows[0].kind}
    `;
    if ((remaining[0]?.n ?? 0) === 0) {
      const defV = checklistDef("vehicle", rows[0].kind);
      const defC = checklistDef("customer", rows[0].kind);
      if (defV?.uploadRequired || defC?.uploadRequired) {
        await sql`
          update credit_checklist set done = false
          where application_id = ${rows[0].application_id} and item_key = ${rows[0].kind}
        `;
        await refreshChecklistComplete(sql, rows[0].application_id);
      }
    }
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Deleted document: ${rows[0].file_name} (${rows[0].kind}) by ${me.name}`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const };
  });

export const requestGsmApproval = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string; notes?: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "credit_manager", "gsm", "rep"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    const sql = await getSql();
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    await refreshChecklistComplete(sql, app.id);
    const fresh = await sql.query<Record<string, unknown>>(
      `select * from credit_applications where id = $1`,
      [app.id],
    );
    const current = mapApp(fresh[0]!);
    if (!current.vehicle_checklist_complete || !current.customer_checklist_complete) {
      throw new Error("Vehicle and customer checklist sections must both be complete first");
    }
    await sql`
      update credit_applications set
        status = 'pending_gsm',
        gsm_requested_at = now(),
        gsm_requested_by = ${me.id},
        approval_notes = ${data.notes?.trim() || null},
        updated_at = now()
      where id = ${app.id}
    `;
    await sql`
      update leads set credit_status = 'pending_gsm', updated_at = now() where id = ${data.leadId}
    `;
    const recipients = await sql<{ email: string; name: string }>`
      select email, name from profiles
      where active = true and role in ('gsm', 'admin')
    `;
    const lead = await sql<{ name: string }>`select name from leads where id = ${data.leadId}`;
    const link = `${appBaseUrl()}/leads/${data.leadId}?tab=approval`;
    for (const r of recipients) {
      await sendCrmEmail(sql, {
        to: r.email,
        subject: `GSM approval needed — ${lead[0]?.name || "Deal"}`,
        kind: "gsm_approval_request",
        leadId: data.leadId,
        text: `${me.name} requested GSM approval for ${lead[0]?.name}.\n\n${data.notes || ""}\n\n${link}`,
        html: `<p><strong>${me.name}</strong> requested GSM approval for <strong>${lead[0]?.name}</strong>.</p>
<p>${data.notes || ""}</p><p><a href="${link}">Review & approve in CRM</a></p>`,
      });
    }
    return { ok: true as const };
  });

export const approveDealGsm = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      notes?: string;
      approve: boolean;
      /** On decline: who gets the reason email */
      notify?: "sales" | "credit" | "both";
      /** On approve */
      notifyPartner?: boolean;
      notifyLessee?: boolean;
      nextStep?: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "gsm"].includes(me.role)) {
      throw new Error("Only GSM or Admin can approve deals");
    }
    const sql = await getSql();
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    const notes = data.notes?.trim() || "";
    if (!data.approve && !notes) {
      throw new Error("Please enter a decline reason");
    }
    const status = data.approve ? "approved" : "declined";
    await sql`
      update credit_applications set
        status = ${status},
        approved_by = ${me.id},
        approved_at = now(),
        approval_notes = ${notes || null},
        updated_at = now()
      where id = ${app.id}
    `;
    await sql`
      update leads set
        credit_status = ${status},
        stage = case when ${data.approve} then 'ready_bc' else stage end,
        stage_entered_at = case when ${data.approve} then now() else stage_entered_at end,
        updated_at = now()
      where id = ${data.leadId}
    `;
    if (data.approve) {
      const { ensureComplianceChecklist } = await import("./compliance");
      await ensureComplianceChecklist(sql, data.leadId);
      const { ensureOpsTrackingForLead } = await import("./compliance-ops");
      await ensureOpsTrackingForLead(sql, data.leadId);
    }

    const lead = await sql<{
      name: string;
      assigned_to: string | null;
      email: string | null;
      partner_id: string | null;
    }>`
      select name, assigned_to, email, partner_id from leads where id = ${data.leadId} limit 1
    `;
    const clientName = lead[0]?.name || "Deal";
    const link = `${appBaseUrl()}/leads/${data.leadId}?tab=${data.approve ? "compliance" : "credit"}`;
    const nextStep = data.nextStep?.trim() || "";

    if (!data.approve) {
      const notify = data.notify || "both";
      const recipients: { email: string; name: string; bucket: string }[] = [];
      if (notify === "sales" || notify === "both") {
        if (lead[0]?.assigned_to) {
          const reps = await sql<{ email: string; name: string }>`
            select email, name from profiles
            where id = ${lead[0].assigned_to} and active = true limit 1
          `;
          if (reps[0]) recipients.push({ ...reps[0], bucket: "sales (vehicle)" });
        }
      }
      if (notify === "credit" || notify === "both") {
        const cms = await sql<{ email: string; name: string }>`
          select email, name from profiles
          where active = true and role in ('credit_manager', 'admin')
        `;
        for (const c of cms) {
          if (!recipients.some((r) => r.email === c.email)) {
            recipients.push({ ...c, bucket: "credit (customer)" });
          }
        }
      }
      const notifyLabel =
        notify === "sales"
          ? "Sales (vehicle portion)"
          : notify === "credit"
            ? "Credit Manager (customer portion)"
            : "Sales + Credit Manager";
      for (const r of recipients) {
        await sendCrmEmail(sql, {
          to: r.email,
          subject: `Deal declined — ${clientName}`,
          kind: "deal_declined",
          leadId: data.leadId,
          text: `GSM/Admin ${me.name} declined ${clientName}.\n\nReason:\n${notes}\n\nNotified: ${notifyLabel}\nYour area: ${r.bucket}\n\nOpen: ${link}`,
          html: `<p><strong>${me.name}</strong> declined <strong>${clientName}</strong>.</p>
<p><strong>Reason</strong></p>
<p style="white-space:pre-wrap;border-left:3px solid #b91c1c;padding-left:12px">${notes.replace(/</g, "")}</p>
<p style="font-size:13px;color:#555">Notified: ${notifyLabel}<br/>Your area: ${r.bucket}</p>
<p><a href="${link}">Open deal in CRM</a></p>`,
        });
      }
    }

    if (data.approve) {
      const sentTo: string[] = [];
      type R = { email: string; name: string; role: string };
      const recips: R[] = [];
      if (lead[0]?.assigned_to) {
        const reps = await sql<{ email: string; name: string }>`
          select email, name from profiles
          where id = ${lead[0].assigned_to} and active = true limit 1
        `;
        if (reps[0]?.email) recips.push({ ...reps[0], role: "Sales rep" });
      }
      const cms = await sql<{ email: string; name: string }>`
        select email, name from profiles
        where active = true and role = 'credit_manager'
      `;
      for (const c of cms) {
        if (c.email && !recips.some((r) => r.email === c.email)) {
          recips.push({ ...c, role: "Credit manager" });
        }
      }
      if (data.notifyPartner !== false && lead[0]?.partner_id) {
        const pr = await sql<{ name: string; email: string | null; kind: string }>`
          select name, email, kind from partners where id = ${lead[0].partner_id} limit 1
        `;
        if (pr[0]?.email) {
          recips.push({
            email: pr[0].email,
            name: pr[0].name,
            role: pr[0].kind === "broker" ? "Referring broker" : "Referring dealer",
          });
        }
      }
      if (data.notifyLessee && lead[0]?.email) {
        recips.push({ email: lead[0].email, name: clientName, role: "Lessee" });
      }
      const nextBlock = nextStep
        ? `What's next: ${nextStep}`
        : "Next steps will come from the Paul Motor team.";
      const heroExists = Boolean(await loadHeroShotForLead(sql, data.leadId));
      let lesseeHeroUrl: string | null = null;
      if (heroExists) {
        let tok = app.public_token || app.doc_request_token;
        if (!tok) {
          tok = token();
          await sql`update credit_applications set public_token = ${tok}, updated_at = now() where id = ${app.id}`;
        }
        lesseeHeroUrl = publicHeroUrl(appBaseUrl(), tok);
      }
      for (const r of recips) {
        const isLessee = r.role === "Lessee";
        const first = r.name.split(" ")[0].replace(/</g, "") || "there";
        await sendCrmEmail(sql, {
          to: r.email,
          subject: isLessee
            ? `Congratulations — your Paul Motor lease is approved`
            : `Lease approved — ${clientName}`,
          kind: "deal_approved",
          leadId: data.leadId,
          text: isLessee
            ? `Congratulations ${first}!\n\nYour lease with Paul Motor Leasing has been approved.\n\n${nextBlock}\n\nIf you have questions about the vehicle, speak with your dealer or broker. Questions about the lease or payments come to us.\n\n— ${me.name}\nPaul Motor Leasing`
            : `${me.name} approved ${clientName}.\n\n${nextBlock}\n\nYour role: ${r.role}\nOpen: ${link}`,
          html: isLessee
            ? `<div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px">
<p style="font-size:22px;color:#008272;font-weight:700;margin:0 0 8px">Congratulations${first ? `, ${first}` : ""}!</p>
<p>Your lease with <strong>Paul Motor Leasing</strong> has been approved.</p>
${
  lesseeHeroUrl
    ? `<img src="${lesseeHeroUrl}" alt="Your vehicle" width="240" height="240" style="display:block;margin:16px 0;width:240px;height:240px;object-fit:contain;background:#fff;border:1px solid #e5e4e2;border-radius:10px"/>`
    : ""
}
<p>${nextBlock.replace(/</g, "")}</p>
<p style="font-size:13px;color:#555">Car questions: your dealer or broker. Lease / payment questions: us.</p>
<p>— ${me.name.replace(/</g, "")}<br/>Paul Motor Leasing</p>
</div>`
            : `<p><strong>${me.name.replace(/</g, "")}</strong> approved <strong>${clientName.replace(/</g, "")}</strong>.</p><p>${nextBlock.replace(/</g, "")}</p><p style="font-size:13px;color:#555">You: ${r.role}</p><p><a href="${link}">Open deal in CRM</a></p>`,
        });
        sentTo.push(`${r.role} <${r.email}>`);
      }
      if (sentTo.length) {
        await sql`
          insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
          values (
            ${uid()}, ${data.leadId}, 'credit',
            ${`Approval notices sent: ${sentTo.join(", ")}`},
            ${me.id}, ${me.name}
          )
        `;
      }
    }

    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Deal ${status} by ${me.name}${notes ? `: ${notes}` : ""}${data.approve ? " · moved to Compliance" + (nextStep ? ` · next: ${nextStep}` : "") : data.notify ? ` · notified ${data.notify}` : ""}`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const, status };
  });

export const requestLesseeDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      /** One or more keys from LESSEE_DOC_TYPES (also accepts legacy noa_payslip / bank_statement). */
      kinds: string[];
      email?: string;
      applicationId?: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "credit_manager", "gsm", "rep"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    const sql = await getSql();
    const owner = await sql<{ assigned_to: string | null }>`
      select assigned_to from leads where id = ${data.leadId} limit 1
    `;
    if (!owner[0]) throw new Error("Lead not found");
    if (!canSeeCredit(me, owner[0].assigned_to)) {
      throw new Error("You can only request documents on your deals");
    }
    let app = await getOrCreateApp(sql, data.leadId, me.id);
    if (data.applicationId && data.applicationId !== app.id) {
      const picked = await sql.query<Record<string, unknown>>(
        `select * from credit_applications where id = $1 and lead_id = $2 limit 1`,
        [data.applicationId, data.leadId],
      );
      if (!picked[0]) throw new Error("Credit application not found");
      app = mapApp(picked[0]);
    }
    const validKeys = new Set<string>([
      ...LESSEE_DOC_TYPES.map((d) => d.key),
      // legacy
      "noa_payslip",
      "bank_statement",
    ]);
    const kinds = [...new Set(data.kinds.map((k) => k.trim()).filter(Boolean))].filter((k) =>
      validKeys.has(k),
    );
    if (kinds.length === 0) throw new Error("Select at least one document type");

    const docTok = app.doc_request_token || token();
    await sql`
      update credit_applications set
        doc_request_token = ${docTok},
        pending_doc_kinds = ${JSON.stringify(kinds)},
        updated_at = now()
      where id = ${app.id}
    `;
    const leads = await sql<{ email: string; name: string; first_name: string | null }>`
      select email, name, first_name from leads where id = ${data.leadId}
    `;
    const isGuar = app.applicant_role === "guarantor";
    const email = (
      data.email ||
      app.applicant_email ||
      app.app_email ||
      (isGuar ? "" : leads[0]?.email) ||
      ""
    )
      .trim()
      .toLowerCase();
    if (!email) throw new Error(isGuar ? "Guarantor email required" : "Lessee email required");

    const labels = kinds.map((k) => {
      if (k === "noa_payslip") return "NOA / payslips";
      if (k === "bank_statement") return "Bank / financial statements";
      return lesseeDocLabel(k as LesseeDocTypeKey);
    });
    const kindsParam = encodeURIComponent(kinds.join(","));
    const link = `${appBaseUrl()}/credit-docs/${docTok}?kinds=${kindsParam}`;
    const listText = labels.map((l) => `• ${l}`).join("\n");
    const listHtml = labels.map((l) => `<li>${l}</li>`).join("");
    const partner = await fetchPartnerForLead(sql, data.leadId);
    const referral = referralClientCopy(partner);

    const mailResult = await sendCrmEmail(sql, {
      to: email,
      subject: `Paul Motor Leasing — please upload documents`,
      kind: "lessee_doc_request",
      leadId: data.leadId,
      profileId: me.id,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
      text: `Hi,\n\n${referral.text ? referral.text + "\n\n" : ""}Please upload the following for your lease application:\n${listText}\n\n${link}\n\nYou can reopen this link anytime to add more files until complete.\n\n— ${me.name}\nPaul Motor Leasing`,
      html: `${referral.html}<p>Please upload the following for your lease application:</p>
<ul>${listHtml}</ul>
<p><a href="${link}" style="background:#008272;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">Upload documents</a></p>
<p style="font-size:13px;color:#555">You can reopen this link anytime to add more files until the package is complete.</p>
<p style="font-size:13px;color:#555">— ${me.name.replace(/</g, "")}<br/>Paul Motor Leasing</p>`,
    });
    if (!mailResult.ok) {
      throw new Error(
        mailResult.error ||
          "Email failed to send. Check RESEND_API_KEY, CRM_FROM_EMAIL, and Resend domain status.",
      );
    }
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Requested docs from ${isGuar ? `guarantor ${app.applicant_name || ""}` : "lessee"} (${labels.join(", ")}) → ${email}`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const, link, kinds, outboxId: mailResult.outboxId };
  });

// ——— Public (token) endpoints ———

export const getPublicCreditApp = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select a.*, l.name as lead_name, l.email as lead_email, l.phone as lead_phone,
              l.first_name, l.last_name, l.vehicle_interest, l.party_type as lead_party_type,
              pr.name as partner_name, pr.kind as partner_kind
       from credit_applications a
       join leads l on l.id = a.lead_id
       left join partners pr on pr.id = l.partner_id
       where a.public_token = $1 limit 1`,
      [data.token],
    );
    if (!rows[0]) throw new Error("Invalid or expired link");
    const app = mapApp(rows[0]);
    const docs = await sql<{ kind: string; file_name: string }>`
      select kind, file_name from credit_documents where application_id = ${app.id}
    `;
    return {
      application: {
        id: app.id,
        status: app.status,
        party_type: app.party_type,
        payload: app.payload,
        submitted_at: app.submitted_at,
        applicant_role: app.applicant_role,
      },
      lead: {
        name:
          app.applicant_role === "guarantor"
            ? app.applicant_name || String(rows[0].lead_name)
            : String(rows[0].lead_name),
        first_name:
          app.applicant_role === "guarantor"
            ? splitPersonName(app.applicant_name || "").first_name ||
              (rows[0].first_name as string) ||
              null
            : (rows[0].first_name as string) || null,
        last_name:
          app.applicant_role === "guarantor"
            ? splitPersonName(app.applicant_name || "").last_name || null
            : (rows[0].last_name as string) || null,
        email:
          app.applicant_email ||
          app.app_email ||
          (rows[0].lead_email as string) ||
          null,
        phone:
          app.applicant_phone ||
          (app.applicant_role === "guarantor" ? null : (rows[0].lead_phone as string)) ||
          null,
        vehicle_interest: (rows[0].vehicle_interest as string) || null,
        partner_name: (rows[0].partner_name as string) || null,
        partner_kind: (rows[0].partner_kind as string) || null,
      },
      uploadedKinds: docs.map((d) => d.kind),
      heroImage: await loadHeroShotForLead(sql, app.lead_id),
    };
  });

export const savePublicCreditApp = createServerFn({ method: "POST" })
  .validator(
    (data: {
      token: string;
      payload: CreditPayload;
      party_type?: "individual" | "business";
      alreadySubmittedOnWeb?: boolean;
      submit?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select * from credit_applications where public_token = $1 limit 1`,
      [data.token],
    );
    if (!rows[0]) throw new Error("Invalid link");
    const app = mapApp(rows[0]);
    if (["approved", "declined", "cancelled"].includes(app.status)) {
      throw new Error("This application is closed");
    }
    const party = data.party_type || app.party_type || "individual";
    const status = data.submit
      ? "app_submitted"
      : data.alreadySubmittedOnWeb
        ? "app_in_progress"
        : "app_in_progress";
    const cleanPayload = toCreditPayload(data.payload);
    const p = cleanPayload;
    const first = String(p.full_name || p.first_name || "").trim();
    const { first_name, last_name } = p.first_name
      ? {
          first_name: String(p.first_name),
          last_name: String(p.last_name || ""),
        }
      : splitPersonName(first);
    const fullName = [first_name, last_name].filter(Boolean).join(" ") || first || null;
    const isGuar = app.applicant_role === "guarantor";
    const email = p.email?.trim().toLowerCase() || null;
    const phone = p.phone?.trim() || null;
    await sql`
      update credit_applications set
        payload = ${JSON.stringify(cleanPayload)}::jsonb,
        party_type = ${party},
        status = ${status},
        applicant_name = coalesce(${fullName}, applicant_name),
        applicant_email = coalesce(${email}, applicant_email),
        applicant_phone = coalesce(${phone}, applicant_phone),
        submitted_at = case when ${Boolean(data.submit)} then now() else submitted_at end,
        updated_at = now()
      where id = ${app.id}
    `;
    if (isGuar) {
      await syncLeadGuarantorLabel(sql, app.lead_id);
      if (data.submit) {
        await sql`
          update leads set
            credit_status = case
              when credit_status in ('none', 'app_requested') then 'app_submitted'
              else credit_status
            end,
            updated_at = now()
          where id = ${app.lead_id}
        `;
      }
    } else if (first_name || last_name) {
      await sql`
        update leads set
          first_name = ${first_name || null},
          last_name = ${last_name || null},
          name = ${[first_name, last_name].filter(Boolean).join(" ") || String(app.lead_id)},
          party_type = ${party},
          email = coalesce(${p.email || null}, email),
          phone = coalesce(${p.phone || null}, phone),
          credit_status = case when ${Boolean(data.submit)} then 'app_submitted' else credit_status end,
          updated_at = now()
        where id = ${app.lead_id}
      `;
    } else if (data.submit) {
      await sql`
        update leads set
          credit_status = 'app_submitted',
          updated_at = now()
        where id = ${app.lead_id}
      `;
    }
    if (data.submit) {
      const lead = await sql.query<Record<string, unknown>>(
        `select l.name, l.assigned_to, p.email as rep_email, p.name as rep_name
         from leads l left join profiles p on p.id = l.assigned_to
         where l.id = $1`,
        [app.lead_id],
      );
      const repEmail = lead[0]?.rep_email as string | undefined;
      const who = isGuar
        ? `Guarantor ${fullName || app.applicant_name || ""} on ${lead[0]?.name}`
        : String(lead[0]?.name || "");
      if (repEmail) {
        await sendCrmEmail(sql, {
          to: repEmail,
          subject: `Credit app received — ${who}`,
          kind: "credit_app_received",
          leadId: app.lead_id,
          text: `The ${isGuar ? "guarantor " : ""}credit application for ${who} has been submitted.\n\n${appBaseUrl()}/leads/${app.lead_id}?tab=credit`,
        });
      }
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${uid()}, ${app.lead_id}, 'credit',
          ${isGuar
            ? `Guarantor ${fullName || app.applicant_name || ""} submitted credit application`
            : "Lessee submitted credit application"},
          null, 'Lessee portal'
        )
      `;
    }
    return { ok: true as const, status };
  });

function parseRequestedDocKinds(raw: unknown): string[] {
  try {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw === "string" && raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function docKindAliases(key: string): string[] {
  if (key === "bank_statement" || key === "personal_bank_statements") {
    return ["bank_statement", "personal_bank_statements", "bank_statements"];
  }
  if (key === "noa_payslip" || key === "noas") {
    return ["noa_payslip", "noas", "noa"];
  }
  return [key];
}

function requestedDocsComplete(requested: string[], uploaded: Iterable<string>): boolean {
  if (!requested.length) return false;
  const have = new Set(uploaded);
  return requested.every((k) => docKindAliases(k).some((a) => have.has(a)));
}

function labelDocKind(key: string): string {
  if (key === "noa_payslip") return "NOA / payslips";
  if (key === "bank_statement") return "Bank / financial statements";
  return lesseeDocLabel(key);
}

async function notifyCreditManagerDocsReceived(
  sql: Awaited<ReturnType<typeof getSql>>,
  opts: {
    leadId: string;
    applicationId: string;
    partyName: string;
    requested: string[];
    uploaded: string[];
    complete: boolean;
    force?: boolean;
  },
): Promise<boolean> {
  const marker = `doc-package:${opts.applicationId}`;
  const prior = await sql<{ id: string; body: string }>`
    select id, body from lead_activities
    where lead_id = ${opts.leadId}
      and body like ${"%" + marker + "%"}
      and created_at > now() - interval '14 days'
    order by created_at desc
    limit 5
  `;
  const alreadyComplete = prior.some((p) => /\(complete\)/.test(p.body || ""));
  if (opts.complete && alreadyComplete) return false;
  if (!opts.complete && prior.length && !opts.force) return false;

  let recips = await sql<{ email: string; name: string }>`
    select email, name from profiles
    where active = true and role = 'credit_manager'
  `;
  const assigned = await sql<{ email: string; name: string }>`
    select p.email, p.name
    from leads l
    join profiles p on p.id = l.assigned_to
    where l.id = ${opts.leadId}
      and p.active = true
      and p.email is not null
      and trim(p.email) <> ''
    limit 1
  `;
  if (assigned[0]) recips = [...recips, assigned[0]];
  if (!recips.length) {
    recips = await sql<{ email: string; name: string }>`
      select email, name from profiles
      where active = true and role = 'admin'
    `;
  }
  const seen = new Set<string>();
  recips = recips.filter((r) => {
    const e = r.email.trim().toLowerCase();
    if (!e || seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  if (!recips.length) return false;

  const lead = await sql<{ name: string }>`select name from leads where id = ${opts.leadId}`;
  const dealName = lead[0]?.name || opts.partyName || "Deal";
  const link = `${appBaseUrl()}/leads/${opts.leadId}?tab=credit`;
  const received = opts.uploaded.map((k) => `• ${labelDocKind(k)}`).join("\n") || "• (see deal)";
  const missing = opts.requested.filter(
    (k) => !docKindAliases(k).some((a) => opts.uploaded.includes(a)),
  );
  const missingText = missing.length
    ? `\nStill missing:\n${missing.map((k) => `• ${labelDocKind(k)}`).join("\n")}`
    : "";
  const subject = opts.complete
    ? `Documents received — ${dealName}`
    : `Documents uploaded (incomplete) — ${dealName}`;
  const text =
    `${opts.partyName || "The client"} uploaded documents for ${dealName}.\n\n` +
    `Received:\n${received}${missingText}\n\nOpen: ${link}`;
  const html =
    `<p><strong>${(opts.partyName || "The client").replace(/</g, "")}</strong> uploaded documents for <strong>${dealName.replace(/</g, "")}</strong>.</p>` +
    `<p>Received:</p><ul>${opts.uploaded.map((k) => `<li>${labelDocKind(k)}</li>`).join("")}</ul>` +
    (missing.length
      ? `<p>Still missing:</p><ul>${missing.map((k) => `<li>${labelDocKind(k)}</li>`).join("")}</ul>`
      : `<p><strong>Requested package is complete.</strong></p>`) +
    `<p><a href="${link}">Open deal in CRM</a></p>`;

  for (const r of recips) {
    await sendCrmEmail(sql, {
      to: r.email,
      subject,
      kind: "lessee_docs_received",
      leadId: opts.leadId,
      text,
      html,
    });
  }
  await sql`
    insert into lead_activities (id, lead_id, kind, body, created_by_name)
    values (
      ${uid()}, ${opts.leadId}, 'credit',
      ${`Lessee documents received (${opts.complete ? "complete" : "partial"}) · ${opts.uploaded.map(labelDocKind).join(", ")}\n${marker}`},
      'Document upload'
    )
  `;
  return true;
}

export const uploadPublicCreditDoc = createServerFn({ method: "POST" })
  .validator(
    (data: {
      token: string;
      kind: CreditDocumentKind;
      fileName: string;
      mimeType: string;
      fileData: string;
      via?: "app" | "doc";
    }) => data,
  )
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows =
      data.via === "doc"
        ? await sql.query<Record<string, unknown>>(
            `select * from credit_applications where doc_request_token = $1 limit 1`,
            [data.token],
          )
        : await sql.query<Record<string, unknown>>(
            `select * from credit_applications where public_token = $1 limit 1`,
            [data.token],
          );
    if (!rows[0]) throw new Error("Invalid link");
    const app = mapApp(rows[0]);
    if (data.fileData.length > 6_000_000) throw new Error("File too large (max ~4MB)");
    const kind = String(data.kind || "other").slice(0, 80);
    await sql`
      insert into credit_documents (
        id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_via
      ) values (
        ${uid()}, ${app.id}, ${app.lead_id}, ${kind},
        ${data.fileName}, ${data.mimeType || "application/octet-stream"}, ${data.fileData},
        ${data.via === "doc" ? "lessee_doc_link" : "lessee_app"}
      )
    `;
    const kinds = await sql<{ kind: string }>`
      select distinct kind from credit_documents where application_id = ${app.id}
    `;
    const set = new Set(kinds.map((k) => k.kind));
    if (set.has("dl_front") && set.has("dl_back") && set.has("id_second")) {
      await sql`
        update credit_applications set
          status = case when status in ('app_submitted','app_in_progress','app_requested') then 'ids_uploaded' else status end,
          updated_at = now()
        where id = ${app.id}
      `;
      await sql`
        update leads set
          credit_status = case
            when credit_status in ('app_requested','app_submitted','none','app_in_progress') then 'ids_uploaded'
            else credit_status
          end,
          updated_at = now()
        where id = ${app.lead_id}
      `;
      const lead = await sql.query<Record<string, unknown>>(
        `select l.name, p.email as rep_email from leads l
         left join profiles p on p.id = l.assigned_to where l.id = $1`,
        [app.lead_id],
      );
      if (lead[0]?.rep_email) {
        await sendCrmEmail(sql, {
          to: String(lead[0].rep_email),
          subject: `IDs received — ${lead[0].name}`,
          kind: "credit_ids_received",
          leadId: app.lead_id,
          text: `Driver licence + second ID uploaded for ${lead[0].name}.\n${appBaseUrl()}/leads/${app.lead_id}?tab=credit`,
        });
      }
    }
    let notified = false;
    if (data.via === "doc") {
      const requested = parseRequestedDocKinds(rows[0].pending_doc_kinds);
      const uploaded = [...set];
      if (requestedDocsComplete(requested, uploaded)) {
        const partyName = app.applicant_name || "";
        notified = await notifyCreditManagerDocsReceived(sql, {
          leadId: app.lead_id,
          applicationId: app.id,
          partyName: partyName || "The client",
          requested,
          uploaded,
          complete: true,
        });
      }
    }
    return { ok: true as const, uploadedKind: kind, notified };
  });

export const getPublicDocRequest = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select a.id, a.lead_id, a.pending_doc_kinds, a.applicant_role, a.applicant_name, l.name from credit_applications a
       join leads l on l.id = a.lead_id
       where a.doc_request_token = $1 limit 1`,
      [data.token],
    );
    if (!rows[0]) throw new Error("Invalid or expired document link");
    let pending: string[] = [];
    try {
      const raw = rows[0].pending_doc_kinds;
      if (Array.isArray(raw)) pending = raw.map(String);
      else if (typeof raw === "string" && raw.trim()) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) pending = parsed.map(String);
      }
    } catch {
      pending = [];
    }
    const docs = await sql<{ kind: string }>`
      select distinct kind from credit_documents where application_id = ${String(rows[0].id)}
    `;
    const isGuar = String(rows[0].applicant_role || "") === "guarantor";
    const partyName = isGuar
      ? String(rows[0].applicant_name || rows[0].name)
      : String(rows[0].name);
    return {
      leadName: partyName,
      applicationId: String(rows[0].id),
      pendingKinds: pending,
      uploadedKinds: docs.map((d) => String(d.kind)),
      heroImage: await loadHeroShotForLead(sql, String(rows[0].lead_id)),
    };
  });

export const finishPublicDocUpload = createServerFn({ method: "POST" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select a.id, a.lead_id, a.pending_doc_kinds, a.applicant_role, a.applicant_name, l.name
       from credit_applications a
       join leads l on l.id = a.lead_id
       where a.doc_request_token = $1 limit 1`,
      [data.token],
    );
    if (!rows[0]) throw new Error("Invalid or expired document link");
    const requested = parseRequestedDocKinds(rows[0].pending_doc_kinds);
    const docs = await sql<{ kind: string }>`
      select distinct kind from credit_documents where application_id = ${String(rows[0].id)}
    `;
    const uploaded = docs.map((d) => String(d.kind));
    if (!uploaded.length) {
      throw new Error("Upload at least one document first");
    }
    const complete = requestedDocsComplete(requested, uploaded);
    const isGuar = String(rows[0].applicant_role || "") === "guarantor";
    const partyName = isGuar
      ? String(rows[0].applicant_name || rows[0].name)
      : String(rows[0].name);
    const notified = await notifyCreditManagerDocsReceived(sql, {
      leadId: String(rows[0].lead_id),
      applicationId: String(rows[0].id),
      partyName,
      requested,
      uploaded,
      complete,
    });
    return { ok: true as const, notified, complete };
  });

export const addGuarantor = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: { leadId: string; name: string; email?: string; phone?: string; slot?: 1 | 2 }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "gsm", "credit_manager", "rep"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    const sql = await getSql();
    const lead = await sql<{ assigned_to: string | null; name: string }>`
      select assigned_to, name from leads where id = ${data.leadId} limit 1
    `;
    if (!lead[0]) throw new Error("Lead not found");
    if (!canSeeCredit(me, lead[0].assigned_to)) throw new Error("Not allowed on this deal");
    await getOrCreateApp(sql, data.leadId, me.id);
    const taken = await sql<{ guarantor_slot: number | null }>`
      select guarantor_slot from credit_applications
      where lead_id = ${data.leadId} and applicant_role = 'guarantor'
    `;
    const used = new Set(taken.map((r) => r.guarantor_slot));
    const slot: 1 | 2 =
      data.slot && !used.has(data.slot) ? data.slot : !used.has(1) ? 1 : !used.has(2) ? 2 : 0 as 1;
    if (slot !== 1 && slot !== 2) throw new Error("This deal already has two guarantors");
    const app = await getOrCreateGuarantorApp(sql, {
      leadId: data.leadId,
      slot,
      meId: me.id,
      name: data.name,
      email: data.email,
      phone: data.phone,
    });
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Guarantor ${slot} added: ${data.name.trim()}`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const, applicationId: app.id, slot };
  });

export const swapCreditParties = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string; guarantorApplicationId: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "gsm", "credit_manager"].includes(me.role)) {
      throw new Error("Only Credit, GSM, or Admin can switch primary and guarantor");
    }
    const sql = await getSql();
    await ensureCreditPartySchema(sql);
    const lead = await sql<{
      name: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
    }>`
      select name, first_name, last_name, email, phone from leads where id = ${data.leadId} limit 1
    `;
    if (!lead[0]) throw new Error("Lead not found");
    const primary = await getOrCreateApp(sql, data.leadId, me.id);
    const guarRows = await sql.query<Record<string, unknown>>(
      `select * from credit_applications where id = $1 and lead_id = $2 and applicant_role = 'guarantor' limit 1`,
      [data.guarantorApplicationId, data.leadId],
    );
    if (!guarRows[0]) throw new Error("Guarantor application not found");
    const guar = mapApp(guarRows[0]);
    const slot = guar.guarantor_slot || 1;
    const parts = splitPersonName(guar.applicant_name || lead[0].name);

    await sql`
      update credit_applications set applicant_role = 'guarantor', guarantor_slot = ${100 + slot}
      where id = ${primary.id}
    `;
    await sql`
      update credit_applications set
        applicant_role = 'primary',
        guarantor_slot = null,
        applicant_name = coalesce(applicant_name, ${guar.applicant_name}),
        updated_at = now()
      where id = ${guar.id}
    `;
    await sql`
      update credit_applications set
        applicant_role = 'guarantor',
        guarantor_slot = ${slot},
        applicant_name = coalesce(applicant_name, ${lead[0].name}),
        applicant_email = coalesce(applicant_email, ${lead[0].email}),
        applicant_phone = coalesce(applicant_phone, ${lead[0].phone}),
        updated_at = now()
      where id = ${primary.id}
    `;
    await sql`
      update leads set
        name = ${guar.applicant_name || lead[0].name},
        first_name = ${parts.first_name || lead[0].first_name},
        last_name = ${parts.last_name || lead[0].last_name},
        email = coalesce(${guar.applicant_email}, email),
        phone = coalesce(${guar.applicant_phone}, phone),
        credit_app_id = ${guar.id},
        updated_at = now()
      where id = ${data.leadId}
    `;
    await syncLeadGuarantorLabel(sql, data.leadId);
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Switched primary applicant with guarantor ${slot}: now ${guar.applicant_name || "guarantor"} (was ${lead[0].name})`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const };
  });

