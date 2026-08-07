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
  LESSEE_DOC_TYPES,
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

async function getOrCreateApp(sql: Awaited<ReturnType<typeof getSql>>, leadId: string, meId: string) {
  const existing = await sql.query<Record<string, unknown>>(
    `select * from credit_applications where lead_id = $1 order by created_at desc limit 1`,
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
    // Stable sort by checklist definition order
    const order = new Map<string, number>();
    VEHICLE_CHECKLIST.forEach((i, idx) => order.set(i.key, idx));
    CUSTOMER_CHECKLIST.forEach((i, idx) => order.set(i.key, 100 + idx));
    checklist.sort((a, b) => (order.get(a.item_key) ?? 999) - (order.get(b.item_key) ?? 999));

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
      vehicleDefs: VEHICLE_CHECKLIST,
      customerDefs: CUSTOMER_CHECKLIST,
      lesseeDocTypes: [...LESSEE_DOC_TYPES],
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
    if (section === "customer" && !["admin", "credit_manager", "gsm"].includes(me.role)) {
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

    const lead = await sql<{ name: string; assigned_to: string | null }>`
      select name, assigned_to from leads where id = ${data.leadId} limit 1
    `;
    const clientName = lead[0]?.name || "Deal";
    const link = `${appBaseUrl()}/leads/${data.leadId}?tab=${data.approve ? "compliance" : "credit"}`;

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

    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'credit',
        ${`Deal ${status} by ${me.name}${notes ? `: ${notes}` : ""}${data.approve ? " · moved to Compliance" : data.notify ? ` · notified ${data.notify}` : ""}`},
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
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "credit_manager", "gsm", "rep"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    const sql = await getSql();
    const app = await getOrCreateApp(sql, data.leadId, me.id);
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
    const email = (data.email || leads[0]?.email || app.app_email || "").trim().toLowerCase();
    if (!email) throw new Error("Lessee email required");

    const labels = kinds.map((k) => {
      if (k === "noa_payslip") return "NOA / payslips";
      if (k === "bank_statement") return "Bank / financial statements";
      return lesseeDocLabel(k as LesseeDocTypeKey);
    });
    const kindsParam = encodeURIComponent(kinds.join(","));
    const link = `${appBaseUrl()}/credit-docs/${docTok}?kinds=${kindsParam}`;
    const listText = labels.map((l) => `• ${l}`).join("\n");
    const listHtml = labels.map((l) => `<li>${l}</li>`).join("");

    const mailResult = await sendCrmEmail(sql, {
      to: email,
      subject: `Paul Motor Leasing — please upload documents`,
      kind: "lessee_doc_request",
      leadId: data.leadId,
      profileId: me.id,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
      text: `Hi,\n\nPlease upload the following for your lease application:\n${listText}\n\n${link}\n\nYou can reopen this link anytime to add more files until complete.\n\n— ${me.name}\nPaul Motor Leasing`,
      html: `<p>Please upload the following for your lease application:</p>
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
        ${`Requested docs from lessee (${labels.join(", ")}) → ${email}`},
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
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (${uid()}, ${app.lead_id}, 'credit', 'Lessee submitted credit application', null, 'Lessee portal')
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
    return { ok: true as const };
  });

export const getPublicDocRequest = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select a.id, a.lead_id, a.pending_doc_kinds, l.name from credit_applications a
       join leads l on l.id = a.lead_id
       where a.doc_request_token = $1 limit 1`,
      [data.token],
    );
    if (!rows[0]) throw new Error("Invalid or expired document link");
    let pending: string[] = [];
    try {
      const raw = rows[0].pending_doc_kinds;
      if (typeof raw === "string" && raw.trim()) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) pending = parsed.map(String);
      }
    } catch {
      pending = [];
    }
    return {
      leadName: String(rows[0].name),
      applicationId: String(rows[0].id),
      pendingKinds: pending,
    };
  });
