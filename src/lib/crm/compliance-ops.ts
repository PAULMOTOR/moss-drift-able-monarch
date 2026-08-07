/**
 * Compliance ops — ownership tracking, email title to bank, vehicle liens.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { sendCrmEmail, clientFacingFromName, replyToForActor } from "./mail";
import { profileHasPermission } from "./permissions";
import type { OwnershipRecord, Profile, VehicleLien } from "./types";
import { TITLE_BANKS, vehicleLabel } from "./types";
import type { Sql } from "@/lib/db";

function uid() {
  return crypto.randomUUID();
}

async function requireProfile(userId: string): Promise<Profile> {
  const sql = await getSql();
  const rows = await sql<Profile>`
    select id, user_id, email, name, role, active, phone, title,
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
    from profiles where user_id = ${userId} limit 1
  `;
  if (!rows[0]?.active) throw new Error("No active CRM profile");
  return rows[0];
}

function mapOwnership(r: Record<string, unknown>): OwnershipRecord {
  return {
    id: String(r.id),
    lead_id: String(r.lead_id),
    vin: (r.vin as string) || null,
    vehicle_label: (r.vehicle_label as string) || null,
    signed_at: r.signed_at ? String(r.signed_at) : null,
    ownership_uploaded: Boolean(r.ownership_uploaded),
    ownership_file_name: (r.ownership_file_name as string) || null,
    title_emailed_at: r.title_emailed_at ? String(r.title_emailed_at) : null,
    title_emailed_to: (r.title_emailed_to as string) || null,
    title_bank: (r.title_bank as string) || null,
    notes: (r.notes as string) || null,
    lead_name: (r.lead_name as string) || null,
  };
}

function mapLien(r: Record<string, unknown>): VehicleLien {
  return {
    id: String(r.id),
    lead_id: (r.lead_id as string) || null,
    inventory_id: (r.inventory_id as string) || null,
    vin: (r.vin as string) || null,
    vehicle_label: (r.vehicle_label as string) || null,
    lienholder: (r.lienholder as string) || null,
    registration_province: (r.registration_province as string) || null,
    registered_at: r.registered_at ? String(r.registered_at).slice(0, 10) : null,
    registration_ref: (r.registration_ref as string) || null,
    notes: (r.notes as string) || null,
    status: String(r.status),
    signed_lease_at: r.signed_lease_at ? String(r.signed_lease_at) : null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

/** Ensure ownership + lien rows when lease is signed / compliance starts. */
export async function ensureOpsTrackingForLead(sql: Sql, leadId: string) {
  const lead = await sql<Record<string, unknown>>`
    select l.id, l.name, l.vehicle_interest, l.inventory_id, i.vin, i.year, i.make, i.model, i.trim
    from leads l
    left join inventory i on i.id = l.inventory_id
    where l.id = ${leadId}
    limit 1
  `;
  if (!lead[0]) return;
  const vin = (lead[0].vin as string) || null;
  const vlabel =
    vehicleLabel(lead[0] as never) ||
    (lead[0].vehicle_interest as string) ||
    null;
  const existing = await sql`select id from ownership_tracking where lead_id = ${leadId} limit 1`;
  if (!existing[0]) {
    await sql`
      insert into ownership_tracking (id, lead_id, vin, vehicle_label, signed_at)
      values (${uid()}, ${leadId}, ${vin}, ${vlabel}, now())
      on conflict (lead_id) do nothing
    `;
  }
  const lien = await sql`select id from vehicle_liens where lead_id = ${leadId} limit 1`;
  if (!lien[0]) {
    await sql`
      insert into vehicle_liens (
        id, lead_id, inventory_id, vin, vehicle_label, status, signed_lease_at, created_at
      ) values (
        ${uid()}, ${leadId}, ${(lead[0].inventory_id as string) || null},
        ${vin}, ${vlabel}, 'pending', now(), now()
      )
    `;
  }
}

export const listOwnershipQueue = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const me = await requireProfile(context.userId);
    if (!(await profileHasPermission(me, "compliance.ops")) && me.role !== "admin") {
      throw new Error("Compliance access required");
    }
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select o.*, l.name as lead_name,
              o.signed_at::text as signed_at,
              o.ownership_uploaded_at::text as ownership_uploaded_at,
              o.title_emailed_at::text as title_emailed_at,
              o.created_at::text as created_at, o.updated_at::text as updated_at
       from ownership_tracking o
       join leads l on l.id = o.lead_id
       where o.ownership_uploaded = false
       order by o.signed_at asc nulls last
       limit 200`,
    );
    return rows.map(mapOwnership);
  });

export const uploadOwnershipDoc = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      file_name: string;
      file_data: string;
      notes?: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!(await profileHasPermission(me, "compliance.ops")) && me.role !== "admin") {
      throw new Error("Compliance access required");
    }
    const sql = await getSql();
    await ensureOpsTrackingForLead(sql, data.leadId);
    await sql`
      update ownership_tracking set
        ownership_uploaded = true,
        ownership_file_name = ${data.file_name},
        ownership_file_data = ${data.file_data},
        ownership_uploaded_at = now(),
        notes = coalesce(${data.notes || null}, notes),
        updated_at = now()
      where lead_id = ${data.leadId}
    `;
    // also tick compliance reg_title if present
    await sql`
      update compliance_checklist set
        done = true, done_at = now(), filled_by = ${me.id}, updated_at = now()
      where lead_id = ${data.leadId} and item_key = 'reg_title' and done = false
    `;
    return { ok: true as const };
  });

export const emailTitleToBank = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      bank: string;
      to_email: string;
      subject?: string;
      body?: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!(await profileHasPermission(me, "compliance.ops")) && me.role !== "admin") {
      throw new Error("Compliance access required");
    }
    const to = data.to_email.trim();
    if (!to.includes("@")) throw new Error("Valid bank email required");
    const sql = await getSql();
    await ensureOpsTrackingForLead(sql, data.leadId);
    const own = await sql<Record<string, unknown>>`
      select o.*, l.name as lead_name from ownership_tracking o
      join leads l on l.id = o.lead_id
      where o.lead_id = ${data.leadId} limit 1
    `;
    if (!own[0]) throw new Error("Ownership record not found");
    if (!own[0].ownership_file_data) {
      throw new Error("Upload the ownership / registration PDF before emailing the bank");
    }
    const bankMeta = TITLE_BANKS.find((b) => b.id === data.bank);
    const subject =
      data.subject?.trim() ||
      `Vehicle title / registration — ${own[0].vehicle_label || own[0].vin || data.leadId} — Paul Motor Leasing`;
    const body =
      data.body?.trim() ||
      `Hello,\n\nPlease find attached the vehicle registration / title for the unit below.\n\nClient: ${own[0].lead_name}\nVehicle: ${own[0].vehicle_label || "—"}\nVIN: ${own[0].vin || "—"}\n\nRegards,\n${me.name}\nPaul Motor Leasing`;

    // Resend attachment via data URL if mail supports it — fall back to link note
    const result = await sendCrmEmail(sql, {
      to,
      subject,
      kind: "title_to_bank",
      text: body + `\n\n[Ownership document: ${own[0].ownership_file_name || "attached in CRM"}]`,
      html: `<pre style="font-family:Segoe UI,sans-serif;white-space:pre-wrap">${body.replace(/</g, "<")}</pre>
        <p style="font-size:13px;color:#555">Document on file in CRM: <strong>${own[0].ownership_file_name || "ownership"}</strong>. Reply if you need it re-sent as an attachment.</p>`,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
    });
    if (!result.ok) throw new Error(result.error || "Email failed");

    await sql`
      update ownership_tracking set
        title_emailed_at = now(),
        title_emailed_to = ${to},
        title_bank = ${bankMeta?.label || data.bank},
        updated_at = now()
      where lead_id = ${data.leadId}
    `;
    await sql`
      update compliance_checklist set
        done = true, done_at = now(), filled_by = ${me.id},
        notes = ${`Emailed to ${to} (${bankMeta?.label || data.bank})`},
        updated_at = now()
      where lead_id = ${data.leadId} and item_key in ('reg_title_cibc', 'reg_title')
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'compliance',
        ${`Title/registration emailed to ${to} (${bankMeta?.label || data.bank})`},
        ${me.id}, ${me.name}
      )
    `;
    return { ok: true as const };
  });

export const listLiens = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { status?: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!(await profileHasPermission(me, "liens.manage")) && me.role !== "admin") {
      throw new Error("Liens access required");
    }
    const sql = await getSql();
    const status = data.status && data.status !== "all" ? data.status : null;
    const rows = await sql.query<Record<string, unknown>>(
      `select v.*,
              v.registered_at::text as registered_at,
              v.signed_lease_at::text as signed_lease_at,
              v.created_at::text as created_at, v.updated_at::text as updated_at
       from vehicle_liens v
       where ($1::text is null or v.status = $1)
       order by
         case when v.status = 'pending' then 0 else 1 end,
         v.signed_lease_at asc nulls last
       limit 300`,
      [status],
    );
    return rows.map(mapLien);
  });

export const upsertLien = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      id?: string;
      lead_id?: string | null;
      inventory_id?: string | null;
      vin?: string | null;
      vehicle_label?: string | null;
      lienholder?: string | null;
      registration_province?: string | null;
      registered_at?: string | null;
      registration_ref?: string | null;
      notes?: string | null;
      status?: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!(await profileHasPermission(me, "liens.manage")) && me.role !== "admin") {
      throw new Error("Liens access required");
    }
    const sql = await getSql();
    if (data.id) {
      await sql`
        update vehicle_liens set
          lead_id = ${data.lead_id || null},
          inventory_id = ${data.inventory_id || null},
          vin = ${data.vin || null},
          vehicle_label = ${data.vehicle_label || null},
          lienholder = ${data.lienholder || null},
          registration_province = ${data.registration_province || null},
          registered_at = ${data.registered_at || null},
          registration_ref = ${data.registration_ref || null},
          notes = ${data.notes || null},
          status = ${data.status || "pending"},
          updated_at = now()
        where id = ${data.id}
      `;
      if (data.status === "registered" && data.lead_id) {
        await sql`
          update compliance_checklist set
            done = true, done_at = now(), filled_by = ${me.id}, updated_at = now()
          where lead_id = ${data.lead_id} and item_key = 'pml_lien' and done = false
        `;
      }
      return { id: data.id };
    }
    const id = uid();
    await sql`
      insert into vehicle_liens (
        id, lead_id, inventory_id, vin, vehicle_label, lienholder, registration_province,
        registered_at, registration_ref, notes, status, created_by, signed_lease_at
      ) values (
        ${id}, ${data.lead_id || null}, ${data.inventory_id || null}, ${data.vin || null},
        ${data.vehicle_label || null}, ${data.lienholder || null},
        ${data.registration_province || null}, ${data.registered_at || null},
        ${data.registration_ref || null}, ${data.notes || null},
        ${data.status || "pending"}, ${me.id}, now()
      )
    `;
    return { id };
  });

/** Daily batch: missing ownerships 5+ days + missing liens 5+ days. */
export async function runComplianceOpsReminders(sql: Sql) {
  const base =
    process.env.APP_URL?.replace(/\/$/, "") ||
    "https://moss-drift-able-monarch.vercel.app";

  const missingOwn = await sql.query<Record<string, unknown>>(
    `select o.lead_id, o.vin, o.vehicle_label, o.signed_at::text as signed_at, l.name as lead_name
     from ownership_tracking o
     join leads l on l.id = o.lead_id
     where o.ownership_uploaded = false
       and o.signed_at is not null
       and o.signed_at < now() - interval '5 days'
     order by o.signed_at asc`,
  );

  const missingLiens = await sql.query<Record<string, unknown>>(
    `select v.id, v.lead_id, v.vin, v.vehicle_label, v.signed_lease_at::text as signed_lease_at
     from vehicle_liens v
     where v.status = 'pending'
       and v.signed_lease_at is not null
       and v.signed_lease_at < now() - interval '5 days'
     order by v.signed_lease_at asc`,
  );

  const compliancePeople = await sql<{ email: string; name: string; title: string | null }>`
    select email, name, title from profiles
    where active = true and role = 'compliance'
  `;

  const maxime = compliancePeople.filter((p) =>
    p.email.toLowerCase().includes("maxime"),
  );
  const kelly = compliancePeople.filter((p) => p.email.toLowerCase().includes("kelly"));
  const ownershipRecipients = maxime.length ? maxime : compliancePeople;
  const lienRecipients = kelly.length ? kelly : compliancePeople;

  let sent = 0;

  if (missingOwn.length && ownershipRecipients.length) {
    const lines = missingOwn.map(
      (r) =>
        `• ${r.lead_name} — ${r.vehicle_label || r.vin || "vehicle"} (signed ${String(r.signed_at).slice(0, 10)})`,
    );
    const text =
      `Missing ownership / registration uploads (5+ days since signed):\n\n` +
      lines.join("\n") +
      `\n\nOpen Compliance ops: ${base}/compliance-ops`;
    for (const to of ownershipRecipients) {
      await sendCrmEmail(sql, {
        to: to.email,
        subject: `[PML] ${missingOwn.length} missing ownership(s) — action needed`,
        kind: "ownership_reminder",
        text,
        html: `<p>These deals are missing ownership / registration in the CRM (5+ days):</p>
          <ul>${missingOwn.map((r) => `<li><strong>${r.lead_name}</strong> — ${r.vehicle_label || r.vin || "vehicle"}</li>`).join("")}</ul>
          <p><a href="${base}/compliance-ops">Open Compliance ops</a></p>`,
      });
      sent++;
    }
  }

  if (missingLiens.length && lienRecipients.length) {
    const lines = missingLiens.map(
      (r) =>
        `• ${r.vehicle_label || r.vin || r.id} (lease signed ${String(r.signed_lease_at).slice(0, 10)})`,
    );
    const text =
      `Liens not registered (5+ days since lease signed):\n\n` +
      lines.join("\n") +
      `\n\nOpen Liens: ${base}/compliance-ops?tab=liens`;
    for (const to of lienRecipients) {
      await sendCrmEmail(sql, {
        to: to.email,
        subject: `[PML] ${missingLiens.length} lien(s) still pending registration`,
        kind: "lien_reminder",
        text,
        html: `<p>These units still need lien registration (5+ days):</p>
          <ul>${missingLiens.map((r) => `<li>${r.vehicle_label || r.vin || r.id}</li>`).join("")}</ul>
          <p><a href="${base}/compliance-ops?tab=liens">Open Liens module</a></p>`,
      });
      sent++;
    }
  }

  return {
    missingOwnerships: missingOwn.length,
    missingLiens: missingLiens.length,
    emailsSent: sent,
  };
}
