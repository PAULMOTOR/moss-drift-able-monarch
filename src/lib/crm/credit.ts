/**
 * Credit underwriting workflow (Paays/RouteOne-inspired).
 * Public token links for lessee credit app + doc uploads.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { sendCrmEmail, clientFacingFromName, replyToForActor } from "./mail";
import {
  CUSTOMER_CHECKLIST,
  VEHICLE_CHECKLIST,
  type CreditApplication,
  type CreditChecklistItem,
  type CreditDocument,
  type CreditDocumentKind,
  type CreditPayload,
  type Profile,
} from "./types";

function uid() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function appBaseUrl() {
  return (
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.BETTER_AUTH_URL?.replace(/\/$/, "") ||
    process.env.VITE_APP_URL?.replace(/\/$/, "") ||
    "https://moss-drift-able-monarch.vercel.app"
  );
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
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

async function requireProfile(userId: string): Promise<Profile> {
  const sql = await getSql();
  const rows = await sql<Profile>`
    select id, user_id, email, name, role, active, phone, title,
           created_at::text as created_at, updated_at::text as updated_at
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
      on conflict (application_id, item_key) do nothing
    `;
  }
  for (const item of CUSTOMER_CHECKLIST) {
    await sql`
      insert into credit_checklist (id, application_id, section, item_key, label, notes, done)
      values (${uid()}, ${appId}, 'customer', ${item.key}, ${item.label}, '', false)
      on conflict (application_id, item_key) do nothing
    `;
  }
}

async function getOrCreateApp(sql: Awaited<ReturnType<typeof getSql>>, leadId: string, meId: string) {
  const existing = await sql.query<Record<string, unknown>>(
    `select * from credit_applications where lead_id = $1 order by created_at desc limit 1`,
    [leadId],
  );
  if (existing[0]) return mapApp(existing[0]);
  const id = uid();
  const pub = token();
  await sql`
    insert into credit_applications (
      id, lead_id, status, party_type, public_token, requested_by
    ) values (
      ${id}, ${leadId}, 'draft', 'individual', ${pub}, ${meId}
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
      `select id, name, email, phone, first_name, last_name, party_type, assigned_to,
              credit_status, credit_app_id, vehicle_interest, stage
       from leads where id = $1 limit 1`,
      [data.leadId],
    );
    if (!leadRows[0]) throw new Error("Lead not found");
    const lead = leadRows[0];
    if (!canSeeCredit(me, (lead.assigned_to as string) || null)) {
      throw new Error("You do not have access to credit data for this lead");
    }
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    const docs = await sql<CreditDocument>`
      select id, application_id, lead_id, kind, file_name, mime_type, file_data,
             uploaded_by, uploaded_via, created_at::text as created_at
      from credit_documents where application_id = ${app.id}
      order by created_at desc
    `;
    const checklist = await sql<CreditChecklistItem>`
      select id, application_id, section, item_key, label, notes, done,
             filled_by, filled_at::text as filled_at
      from credit_checklist where application_id = ${app.id}
      order by section, item_key
    `;
    // Omit heavy equifax blob from package list (still available as document if uploaded)
    const application: CreditApplication = {
      ...app,
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
      },
      application,
      documents: docs,
      checklist,
      appLink: app.public_token ? `${appBaseUrl()}/credit-app/${app.public_token}` : null,
      docLink: app.doc_request_token
        ? `${appBaseUrl()}/credit-docs/${app.doc_request_token}`
        : null,
    };
  });

/** Request App & IDs — email lessee the public app link */
export const requestCreditApp = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string; email?: string }) => data)
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
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    const email = (data.email || (lead.email as string) || "").trim().toLowerCase();
    if (!email || !email.includes("@")) throw new Error("A valid email is required to send the app");
    const pub = app.public_token || token();
    await sql`
      update credit_applications set
        status = 'app_requested',
        public_token = ${pub},
        app_email = ${email},
        requested_by = ${me.id},
        updated_at = now()
      where id = ${app.id}
    `;
    await sql`
      update leads set credit_status = 'app_requested', credit_app_id = ${app.id}, updated_at = now()
      where id = ${data.leadId}
    `;
    const link = `${appBaseUrl()}/credit-app/${pub}`;
    const first = (lead.first_name as string) || String(lead.name).split(" ")[0] || "there";
    const mailResult = await sendCrmEmail(sql, {
      to: email,
      subject: "Paul Motor Leasing — Credit application & ID upload",
      kind: "credit_app_request",
      leadId: data.leadId,
      profileId: me.id,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
      text: `Hi ${first},

Paul Motor Leasing has invited you to complete a short credit application and upload two pieces of identification for your vehicle lease.

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
        ${`Credit app & IDs requested → ${email} (email sent)`},
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
    await sql`
      update credit_applications set
        status = 'credit_requested',
        credit_requested_at = now(),
        credit_requested_by = ${me.id},
        credit_request_notes = ${data.notes?.trim() || null},
        do_not_pull_credit = ${Boolean(data.doNotPullCredit)},
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
        stage = case when stage in ('new','contacted','paused','quote_sent') then 'credit_review' else stage end,
        stage_entered_at = case when stage in ('new','contacted','paused','quote_sent') then now() else stage_entered_at end,
        updated_at = now()
      where id = ${data.leadId}
    `;
    const cms = await sql<{ email: string; name: string }>`
      select email, name from profiles
      where active = true and role in ('credit_manager', 'admin')
    `;
    const lead = await sql<{ name: string }>`select name from leads where id = ${data.leadId}`;
    const link = `${appBaseUrl()}/leads/${data.leadId}?tab=credit`;
    for (const cm of cms) {
      await sendCrmEmail(sql, {
        to: cm.email,
        subject: `Credit review requested — ${lead[0]?.name || "Lead"}`,
        kind: "credit_review_request",
        leadId: data.leadId,
        text: `${me.name} requested credit approval for ${lead[0]?.name}.\n\nNotes: ${data.notes || "—"}\nDo not pull credit: ${data.doNotPullCredit ? "Yes" : "No"}\n\nOpen: ${link}`,
        html: `<p><strong>${me.name}</strong> requested credit approval for <strong>${lead[0]?.name}</strong>.</p>
<p>Notes: ${data.notes || "—"}<br/>Do not pull credit: ${data.doNotPullCredit ? "Yes" : "No"}</p>
<p><a href="${link}">Open deal in CRM</a></p>`,
      });
    }
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (${uid()}, ${data.leadId}, 'credit', ${`Credit approval requested by ${me.name}`}, ${me.id}, ${me.name})
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
    const section = String((items[0] as { section: string }).section);
    if (section === "vehicle" && !["admin", "rep", "gsm", "credit_manager"].includes(me.role)) {
      throw new Error("Only sales can fill vehicle checklist");
    }
    if (section === "customer" && !["admin", "credit_manager", "gsm"].includes(me.role)) {
      throw new Error("Only Credit Manager / Admin / GSM can fill customer checklist");
    }
    await sql`
      update credit_checklist set
        notes = coalesce(${data.notes ?? null}, notes),
        done = coalesce(${data.done ?? null}, done),
        filled_by = ${me.id},
        filled_at = now()
      where application_id = ${data.applicationId} and item_key = ${data.itemKey}
    `;
    const veh = await sql<{ n: number; d: number }>`
      select count(*)::int as n, count(*) filter (where done)::int as d
      from credit_checklist where application_id = ${data.applicationId} and section = 'vehicle'
    `;
    const cust = await sql<{ n: number; d: number }>`
      select count(*)::int as n, count(*) filter (where done)::int as d
      from credit_checklist where application_id = ${data.applicationId} and section = 'customer'
    `;
    await sql`
      update credit_applications set
        vehicle_checklist_complete = ${veh[0]!.n > 0 && veh[0]!.d === veh[0]!.n},
        customer_checklist_complete = ${cust[0]!.n > 0 && cust[0]!.d === cust[0]!.n},
        status = 'in_review',
        updated_at = now()
      where id = ${data.applicationId}
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
    if (!app.vehicle_checklist_complete || !app.customer_checklist_complete) {
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
    const link = `${appBaseUrl()}/leads/${data.leadId}?tab=credit`;
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
  .validator((data: { leadId: string; notes?: string; approve: boolean }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "gsm"].includes(me.role)) {
      throw new Error("Only GSM or Admin can approve deals");
    }
    const sql = await getSql();
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    const status = data.approve ? "approved" : "declined";
    await sql`
      update credit_applications set
        status = ${status},
        approved_by = ${me.id},
        approved_at = now(),
        approval_notes = ${data.notes?.trim() || null},
        updated_at = now()
      where id = ${app.id}
    `;
    await sql`
      update leads set
        credit_status = ${status},
        stage = case when ${data.approve} then 'ready_bc' else stage end,
        updated_at = now()
      where id = ${data.leadId}
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Deal ${status} by ${me.name}${data.notes ? `: ${data.notes}` : ""}`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const, status };
  });

export const requestLesseeDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: { leadId: string; kind: "noa_payslip" | "bank_statement"; email?: string }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const app = await getOrCreateApp(sql, data.leadId, me.id);
    const docTok = app.doc_request_token || token();
    await sql`
      update credit_applications set doc_request_token = ${docTok}, updated_at = now()
      where id = ${app.id}
    `;
    const leads = await sql<{ email: string; name: string; first_name: string | null }>`
      select email, name, first_name from leads where id = ${data.leadId}
    `;
    const email = (data.email || leads[0]?.email || app.app_email || "").trim().toLowerCase();
    if (!email) throw new Error("Lessee email required");
    const label =
      data.kind === "noa_payslip" ? "NOA / payslips" : "Bank / financial statements";
    const link = `${appBaseUrl()}/credit-docs/${docTok}?kind=${data.kind}`;
    const mailResult = await sendCrmEmail(sql, {
      to: email,
      subject: `Paul Motor Leasing — please upload ${label}`,
      kind: "lessee_doc_request",
      leadId: data.leadId,
      profileId: me.id,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
      text: `Hi,\n\nPlease upload ${label} for your lease application:\n${link}\n\nYou can reopen this link anytime to add more files until complete.\n\n— ${me.name}\nPaul Motor Leasing`,
      html: `<p>Please upload <strong>${label}</strong> for your lease application.</p>
<p><a href="${link}" style="background:#008272;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">Upload document</a></p>
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
      values (${uid()}, ${data.leadId}, 'credit', ${`Requested ${label} from lessee → ${email}`}, ${me.id}, ${me.name})
    `;
    return { ok: true as const, link, outboxId: mailResult.outboxId };
  });

// ——— Public (token) endpoints ———

export const getPublicCreditApp = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select a.*, l.name as lead_name, l.email as lead_email, l.phone as lead_phone,
              l.first_name, l.last_name, l.vehicle_interest, l.party_type as lead_party_type
       from credit_applications a
       join leads l on l.id = a.lead_id
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
      },
      lead: {
        name: String(rows[0].lead_name),
        first_name: (rows[0].first_name as string) || null,
        last_name: (rows[0].last_name as string) || null,
        email: (rows[0].lead_email as string) || app.app_email,
        phone: (rows[0].lead_phone as string) || null,
        vehicle_interest: (rows[0].vehicle_interest as string) || null,
      },
      uploadedKinds: docs.map((d) => d.kind),
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
    await sql`
      update credit_applications set
        payload = ${JSON.stringify(cleanPayload)}::jsonb,
        party_type = ${party},
        status = ${status},
        submitted_at = case when ${Boolean(data.submit)} then now() else submitted_at end,
        updated_at = now()
      where id = ${app.id}
    `;
    const p = cleanPayload;
    const first = String(p.full_name || p.first_name || "").trim();
    const { first_name, last_name } = p.first_name
      ? {
          first_name: String(p.first_name),
          last_name: String(p.last_name || ""),
        }
      : splitPersonName(first);
    if (first_name || last_name) {
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
    }
    if (data.submit) {
      const lead = await sql.query<Record<string, unknown>>(
        `select l.name, l.assigned_to, p.email as rep_email, p.name as rep_name
         from leads l left join profiles p on p.id = l.assigned_to
         where l.id = $1`,
        [app.lead_id],
      );
      const repEmail = lead[0]?.rep_email as string | undefined;
      if (repEmail) {
        await sendCrmEmail(sql, {
          to: repEmail,
          subject: `Credit app received — ${lead[0]?.name}`,
          kind: "credit_app_received",
          leadId: app.lead_id,
          text: `The credit application for ${lead[0]?.name} has been submitted.\n\n${appBaseUrl()}/leads/${app.lead_id}?tab=credit`,
        });
      }
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by_name)
        values (${uid()}, ${app.lead_id}, 'credit', 'Lessee submitted credit application', 'Lessee portal')
      `;
    }
    return { ok: true as const, status };
  });

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
    await sql`
      insert into credit_documents (
        id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_via
      ) values (
        ${uid()}, ${app.id}, ${app.lead_id}, ${data.kind},
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
        update leads set credit_status = 'app_submitted', updated_at = now() where id = ${app.lead_id}
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
    return { ok: true as const };
  });

export const getPublicDocRequest = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select a.id, a.lead_id, l.name from credit_applications a
       join leads l on l.id = a.lead_id
       where a.doc_request_token = $1 limit 1`,
      [data.token],
    );
    if (!rows[0]) throw new Error("Invalid or expired document link");
    return {
      leadName: String(rows[0].name),
      applicationId: String(rows[0].id),
    };
  });
