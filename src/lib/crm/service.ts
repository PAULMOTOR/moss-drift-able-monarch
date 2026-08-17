/**
 * Service department — work orders, estimates, vehicle inspections by VIN.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { sendCrmEmail, clientFacingFromName, replyToForActor } from "./mail";
import { profileHasPermission } from "./permissions";
import type { Profile, ServiceInspection, ServiceWorkOrder } from "./types";
import { vehicleLabel } from "./types";
import { publicAppUrl } from "./public-url";

function uid() {
  return crypto.randomUUID();
}

function appBaseUrl() {
  return publicAppUrl();
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

async function requireServiceAccess(userId: string) {
  const me = await requireProfile(userId);
  if (!(await profileHasPermission(me, "service.access")) && me.role !== "admin") {
    throw new Error("Service access required");
  }
  return me;
}

function mapWo(r: Record<string, unknown>): ServiceWorkOrder {
  return {
    id: String(r.id),
    wo_number: String(r.wo_number),
    inventory_id: (r.inventory_id as string) || null,
    vin: (r.vin as string) || null,
    vehicle_label: (r.vehicle_label as string) || null,
    customer_name: (r.customer_name as string) || null,
    customer_email: (r.customer_email as string) || null,
    customer_phone: (r.customer_phone as string) || null,
    lead_id: (r.lead_id as string) || null,
    status: String(r.status),
    description: (r.description as string) || null,
    bay: (r.bay as string) || null,
    assigned_to: (r.assigned_to as string) || null,
    assigned_name: (r.assigned_name as string) || null,
    created_by: (r.created_by as string) || null,
    scheduled_at: r.scheduled_at ? String(r.scheduled_at) : null,
    completed_at: r.completed_at ? String(r.completed_at) : null,
    labor_hours: r.labor_hours != null ? Number(r.labor_hours) : null,
    parts_total: r.parts_total != null ? Number(r.parts_total) : null,
    labor_total: r.labor_total != null ? Number(r.labor_total) : null,
    tax_total: r.tax_total != null ? Number(r.tax_total) : null,
    grand_total: r.grand_total != null ? Number(r.grand_total) : null,
    notes: (r.notes as string) || null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export const listWorkOrders = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { status?: string; q?: string }) => data)
  .handler(async ({ context, data }) => {
    await requireServiceAccess(context.userId);
    const sql = await getSql();
    const status = data.status && data.status !== "all" ? data.status : null;
    const q = data.q?.trim() || null;
    const rows = await sql.query<Record<string, unknown>>(
      `select w.*, p.name as assigned_name,
              w.scheduled_at::text as scheduled_at,
              w.completed_at::text as completed_at,
              w.created_at::text as created_at,
              w.updated_at::text as updated_at
       from service_work_orders w
       left join profiles p on p.id = w.assigned_to
       where ($1::text is null or w.status = $1)
         and (
           $2::text is null
           or w.wo_number ilike '%' || $2 || '%'
           or coalesce(w.vin,'') ilike '%' || $2 || '%'
           or coalesce(w.vehicle_label,'') ilike '%' || $2 || '%'
           or coalesce(w.customer_name,'') ilike '%' || $2 || '%'
         )
       order by w.updated_at desc
       limit 200`,
      [status, q],
    );
    return rows.map(mapWo);
  });

export const upsertWorkOrder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      id?: string;
      inventory_id?: string | null;
      vin?: string | null;
      vehicle_label?: string | null;
      customer_name?: string | null;
      customer_email?: string | null;
      customer_phone?: string | null;
      lead_id?: string | null;
      status?: string;
      description?: string | null;
      bay?: string | null;
      assigned_to?: string | null;
      scheduled_at?: string | null;
      notes?: string | null;
      labor_hours?: number | null;
      parts_total?: number | null;
      labor_total?: number | null;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireServiceAccess(context.userId);
    if (!(await profileHasPermission(me, "service.manage")) && me.role !== "admin") {
      // technicians can update status on assigned jobs only for existing
      if (!data.id) throw new Error("Only service managers can create work orders");
    }
    const sql = await getSql();
    let vin = data.vin?.trim().toUpperCase() || null;
    let vehicle_label = data.vehicle_label?.trim() || null;
    let inventory_id = data.inventory_id || null;

    if (inventory_id) {
      const inv = await sql<Record<string, unknown>>`
        select id, year, make, model, trim, vin from inventory where id = ${inventory_id} limit 1
      `;
      if (inv[0]) {
        vin = (inv[0].vin as string) || vin;
        vehicle_label = vehicleLabel(inv[0] as never) || vehicle_label;
      }
    } else if (vin) {
      const inv = await sql<Record<string, unknown>>`
        select id, year, make, model, trim, vin from inventory
        where upper(replace(vin, ' ', '')) = ${vin.replace(/\s/g, "")}
        limit 1
      `;
      if (inv[0]) {
        inventory_id = String(inv[0].id);
        vehicle_label = vehicleLabel(inv[0] as never) || vehicle_label;
      }
    }

    const tax =
      data.parts_total != null || data.labor_total != null
        ? Math.round(((Number(data.parts_total || 0) + Number(data.labor_total || 0)) * 0.14975) * 100) /
          100
        : null;
    const grand =
      data.parts_total != null || data.labor_total != null
        ? Math.round(
            (Number(data.parts_total || 0) + Number(data.labor_total || 0) + Number(tax || 0)) * 100,
          ) / 100
        : null;

    if (data.id) {
      await sql`
        update service_work_orders set
          inventory_id = ${inventory_id},
          vin = ${vin},
          vehicle_label = ${vehicle_label},
          customer_name = ${data.customer_name?.trim() || null},
          customer_email = ${data.customer_email?.trim() || null},
          customer_phone = ${data.customer_phone?.trim() || null},
          lead_id = ${data.lead_id || null},
          status = ${data.status || "draft"},
          description = ${data.description?.trim() || null},
          bay = ${data.bay || null},
          assigned_to = ${data.assigned_to || null},
          scheduled_at = ${data.scheduled_at || null},
          notes = ${data.notes?.trim() || null},
          labor_hours = ${data.labor_hours ?? null},
          parts_total = ${data.parts_total ?? null},
          labor_total = ${data.labor_total ?? null},
          tax_total = ${tax},
          grand_total = ${grand},
          updated_at = now()
        where id = ${data.id}
      `;
      const rows = await sql.query<Record<string, unknown>>(
        `select w.*, p.name as assigned_name,
                w.scheduled_at::text as scheduled_at, w.completed_at::text as completed_at,
                w.created_at::text as created_at, w.updated_at::text as updated_at
         from service_work_orders w left join profiles p on p.id = w.assigned_to
         where w.id = $1`,
        [data.id],
      );
      return mapWo(rows[0]!);
    }

    const id = uid();
    const count = await sql<{ n: number }>`select count(*)::int as n from service_work_orders`;
    const wo_number = `WO-${new Date().getFullYear()}-${String((count[0]?.n || 0) + 1).padStart(4, "0")}`;
    await sql`
      insert into service_work_orders (
        id, wo_number, inventory_id, vin, vehicle_label, customer_name, customer_email,
        customer_phone, lead_id, status, description, bay, assigned_to, created_by,
        scheduled_at, notes, labor_hours, parts_total, labor_total, tax_total, grand_total
      ) values (
        ${id}, ${wo_number}, ${inventory_id}, ${vin}, ${vehicle_label},
        ${data.customer_name?.trim() || null}, ${data.customer_email?.trim() || null},
        ${data.customer_phone?.trim() || null}, ${data.lead_id || null},
        ${data.status || "draft"}, ${data.description?.trim() || null}, ${data.bay || null},
        ${data.assigned_to || null}, ${me.id}, ${data.scheduled_at || null},
        ${data.notes?.trim() || null}, ${data.labor_hours ?? null},
        ${data.parts_total ?? null}, ${data.labor_total ?? null}, ${tax}, ${grand}
      )
    `;
    const rows = await sql.query<Record<string, unknown>>(
      `select w.*, p.name as assigned_name,
              w.scheduled_at::text as scheduled_at, w.completed_at::text as completed_at,
              w.created_at::text as created_at, w.updated_at::text as updated_at
       from service_work_orders w left join profiles p on p.id = w.assigned_to
       where w.id = $1`,
      [id],
    );
    return mapWo(rows[0]!);
  });

export const createEstimate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      work_order_id: string;
      line_items: Array<{ desc: string; qty: number; unit: number }>;
      notes?: string;
      send_to_email?: string;
      send_internal?: boolean;
      send_customer?: boolean;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireServiceAccess(context.userId);
    if (!(await profileHasPermission(me, "service.manage")) && me.role !== "admin") {
      throw new Error("Only service managers / coordinators can create estimates");
    }
    const sql = await getSql();
    const subtotal = data.line_items.reduce((s, i) => s + i.qty * i.unit, 0);
    const tax = Math.round(subtotal * 0.14975 * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    const versions = await sql<{ n: number }>`
      select coalesce(max(version), 0)::int as n from service_estimates
      where work_order_id = ${data.work_order_id}
    `;
    const version = (versions[0]?.n || 0) + 1;
    const id = uid();
    const token = uid().replace(/-/g, "");
    let status = "draft";
    if (data.send_customer) status = "sent_customer";
    else if (data.send_internal) status = "sent_internal";

    await sql`
      insert into service_estimates (
        id, work_order_id, version, line_items_json, subtotal, tax, total, notes,
        status, customer_token, sent_to_email, created_by
      ) values (
        ${id}, ${data.work_order_id}, ${version}, ${JSON.stringify(data.line_items)},
        ${subtotal}, ${tax}, ${total}, ${data.notes || null}, ${status},
        ${token}, ${data.send_to_email || null}, ${me.id}
      )
    `;
    await sql`
      update service_work_orders set status = 'estimate', updated_at = now()
      where id = ${data.work_order_id}
    `;

    const wo = await sql<{ wo_number: string; customer_name: string | null }>`
      select wo_number, customer_name from service_work_orders where id = ${data.work_order_id}
    `;
    const link = `${appBaseUrl()}/service-estimate/${token}`;

    if (data.send_customer && data.send_to_email) {
      await sendCrmEmail(sql, {
        to: data.send_to_email,
        subject: `Service estimate ${wo[0]?.wo_number || ""} — Paul Motor`,
        kind: "service_estimate",
        text:
          `Please review and approve your service estimate:\n${link}\n\nTotal: $${total.toFixed(2)} CAD (tax included estimate).`,
        html: `<p>Please review and approve your service estimate for <strong>${wo[0]?.wo_number}</strong>.</p>
          <p><a href="${link}" style="background:#008272;color:#fff;padding:12px 18px;text-decoration:none;border-radius:4px;font-weight:600">Review estimate</a></p>
          <p>Total: <strong>$${total.toFixed(2)} CAD</strong></p>`,
        fromName: clientFacingFromName(me.name),
        replyTo: replyToForActor(me.email, me.name),
      });
    }

    if (data.send_internal) {
      const managers = await sql<{ email: string; name: string }>`
        select email, name from profiles
        where active = true and (
          role in ('admin', 'accounting')
          or lower(title) like '%service manager%'
          or lower(title) like '%service operation%'
        )
      `;
      for (const m of managers) {
        await sendCrmEmail(sql, {
          to: m.email,
          subject: `Internal estimate approval — ${wo[0]?.wo_number}`,
          kind: "service_estimate_internal",
          text: `Estimate v${version} for ${wo[0]?.wo_number}: $${total.toFixed(2)}. Open Service in CRM to approve.`,
          html: `<p>Estimate <strong>v${version}</strong> for <strong>${wo[0]?.wo_number}</strong> needs internal review.</p>
            <p>Total: <strong>$${total.toFixed(2)}</strong></p>`,
          fromName: clientFacingFromName(me.name),
          replyTo: replyToForActor(me.email, me.name),
        });
      }
    }

    return { id, version, total, token, link, status };
  });

export const setEstimateStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      id: string;
      status: "internal_approved" | "customer_approved" | "customer_declined" | "superseded";
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireServiceAccess(context.userId);
    const sql = await getSql();
    if (data.status === "internal_approved") {
      await sql`
        update service_estimates set
          status = 'internal_approved',
          internal_approved_by = ${me.id},
          internal_approved_at = now(),
          updated_at = now()
        where id = ${data.id}
      `;
    } else {
      await sql`
        update service_estimates set status = ${data.status}, updated_at = now()
        where id = ${data.id}
      `;
    }
    if (data.status === "customer_approved" || data.status === "internal_approved") {
      const est = await sql<{ work_order_id: string }>`
        select work_order_id from service_estimates where id = ${data.id}
      `;
      if (est[0]) {
        await sql`
          update service_work_orders set status = 'approved', updated_at = now()
          where id = ${est[0].work_order_id}
        `;
      }
    }
    return { ok: true as const };
  });

/** Public customer estimate approval (token). */
export const getPublicEstimate = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select e.*, w.wo_number, w.vehicle_label, w.customer_name,
              e.created_at::text as created_at, e.updated_at::text as updated_at
       from service_estimates e
       join service_work_orders w on w.id = e.work_order_id
       where e.customer_token = $1 limit 1`,
      [data.token],
    );
    if (!rows[0]) throw new Error("Estimate not found");
    return {
      id: String(rows[0].id),
      work_order_id: String(rows[0].work_order_id),
      wo_number: String(rows[0].wo_number || ""),
      vehicle_label: (rows[0].vehicle_label as string) || null,
      customer_name: (rows[0].customer_name as string) || null,
      line_items_json: String(rows[0].line_items_json || "[]"),
      subtotal: rows[0].subtotal != null ? Number(rows[0].subtotal) : 0,
      tax: rows[0].tax != null ? Number(rows[0].tax) : 0,
      total: rows[0].total != null ? Number(rows[0].total) : 0,
      status: String(rows[0].status),
      notes: (rows[0].notes as string) || null,
    };
  });

export const publicDecideEstimate = createServerFn({ method: "POST" })
  .validator(
    (data: { token: string; decision: "approve" | "decline"; note?: string }) => data,
  )
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql<{ id: string; work_order_id: string; status: string }>`
      select id, work_order_id, status from service_estimates
      where customer_token = ${data.token} limit 1
    `;
    if (!rows[0]) throw new Error("Estimate not found");
    if (data.decision === "approve") {
      await sql`
        update service_estimates set
          status = 'customer_approved',
          customer_approved_at = now(),
          customer_note = ${data.note || null},
          updated_at = now()
        where id = ${rows[0].id}
      `;
      await sql`
        update service_work_orders set status = 'approved', updated_at = now()
        where id = ${rows[0].work_order_id}
      `;
    } else {
      await sql`
        update service_estimates set
          status = 'customer_declined',
          customer_declined_at = now(),
          customer_note = ${data.note || null},
          updated_at = now()
        where id = ${rows[0].id}
      `;
    }
    return { ok: true as const };
  });

export const listInspections = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { vin?: string; inventoryId?: string }) => data)
  .handler(async ({ context, data }) => {
    await requireServiceAccess(context.userId);
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select i.*, p.name as inspector_name,
              i.started_at::text as started_at, i.completed_at::text as completed_at,
              i.created_at::text as created_at
       from service_inspections i
       left join profiles p on p.id = i.inspector_id
       where ($1::text is null or upper(i.vin) = upper($1))
         and ($2::text is null or i.inventory_id = $2)
       order by i.started_at desc
       limit 100`,
      [data.vin || null, data.inventoryId || null],
    );
    return rows.map(
      (r): ServiceInspection => ({
        id: String(r.id),
        inventory_id: (r.inventory_id as string) || null,
        vin: String(r.vin),
        vehicle_label: (r.vehicle_label as string) || null,
        work_order_id: (r.work_order_id as string) || null,
        inspector_id: (r.inspector_id as string) || null,
        inspector_name: (r.inspector_name as string) || null,
        status: String(r.status),
        odometer: r.odometer != null ? Number(r.odometer) : null,
        findings_json: String(r.findings_json || "[]"),
        notes: (r.notes as string) || null,
        vin_photo_name: (r.vin_photo_name as string) || null,
        started_at: String(r.started_at),
        completed_at: r.completed_at ? String(r.completed_at) : null,
        created_at: String(r.created_at),
      }),
    );
  });

export const startInspection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      vin: string;
      inventory_id?: string | null;
      odometer?: number | null;
      notes?: string | null;
      vin_photo_name?: string | null;
      vin_photo_data?: string | null;
      findings?: Array<{ area: string; result: string; note?: string }>;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireServiceAccess(context.userId);
    const sql = await getSql();
    const vin = data.vin.trim().toUpperCase().replace(/\s+/g, "");
    if (vin.length < 11) throw new Error("VIN looks too short — check the plate photo and re-enter");

    let inventory_id = data.inventory_id || null;
    let vehicle_label: string | null = null;
    const inv = await sql<Record<string, unknown>>`
      select id, year, make, model, trim, vin from inventory
      where upper(replace(coalesce(vin,''), ' ', '')) = ${vin}
         or id = ${inventory_id}
      limit 1
    `;
    if (inv[0]) {
      inventory_id = String(inv[0].id);
      vehicle_label = vehicleLabel(inv[0] as never);
    }

    const id = uid();
    await sql`
      insert into service_inspections (
        id, inventory_id, vin, vehicle_label, inspector_id, status, odometer,
        findings_json, notes, vin_photo_name, vin_photo_data
      ) values (
        ${id}, ${inventory_id}, ${vin}, ${vehicle_label}, ${me.id}, 'in_progress',
        ${data.odometer ?? null}, ${JSON.stringify(data.findings || [])},
        ${data.notes || null}, ${data.vin_photo_name || null}, ${data.vin_photo_data || null}
      )
    `;
    return { id, vin, inventory_id, vehicle_label };
  });

export const completeInspection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      id: string;
      findings?: Array<{ area: string; result: string; note?: string }>;
      notes?: string | null;
      odometer?: number | null;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    await requireServiceAccess(context.userId);
    const sql = await getSql();
    await sql`
      update service_inspections set
        status = 'completed',
        completed_at = now(),
        findings_json = ${JSON.stringify(data.findings || [])},
        notes = coalesce(${data.notes || null}, notes),
        odometer = coalesce(${data.odometer ?? null}, odometer),
        updated_at = now()
      where id = ${data.id}
    `;
    return { ok: true as const };
  });

/** Resolve inventory vehicle from VIN (for scanners / typed VIN). */
export const resolveVehicleByVin = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { vin: string }) => data)
  .handler(async ({ context, data }) => {
    await requireServiceAccess(context.userId);
    const sql = await getSql();
    const vin = data.vin.trim().toUpperCase().replace(/\s+/g, "");
    const rows = await sql<Record<string, unknown>>`
      select id, year, make, model, trim, vin, stock_number, status
      from inventory
      where upper(replace(coalesce(vin,''), ' ', '')) = ${vin}
         or right(upper(replace(coalesce(vin,''), ' ', '')), 6) = ${vin.slice(-6)}
      order by case when upper(replace(coalesce(vin,''), ' ', '')) = ${vin} then 0 else 1 end
      limit 5
    `;
    return rows.map((r) => ({
      id: String(r.id),
      vin: (r.vin as string) || null,
      label: vehicleLabel(r as never),
      stock_number: (r.stock_number as string) || null,
      status: String(r.status),
    }));
  });
