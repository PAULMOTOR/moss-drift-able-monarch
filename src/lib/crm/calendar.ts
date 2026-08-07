/**
 * Team calendar — sales, compliance, and service appointments.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  domainForEventType,
  type CalendarDomain,
  type CalendarEvent,
  type CalendarScope,
  type Profile,
} from "./types";

function uid() {
  return crypto.randomUUID();
}

async function requireProfile(userId: string): Promise<Profile> {
  const sql = await getSql();
  const rows = await sql<Profile>`
    select id, user_id, email, name, role, active, phone, title,
           created_at::text as created_at, updated_at::text as updated_at
    from profiles where user_id = ${userId} limit 1
  `;
  if (!rows[0]?.active) throw new Error("No active CRM profile");
  return rows[0];
}

async function mapEvents(
  sql: Awaited<ReturnType<typeof getSql>>,
  rows: Record<string, unknown>[],
): Promise<CalendarEvent[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.id));
  // Fetch participants in one query
  const parts = await sql.query<{ event_id: string; profile_id: string; name: string }>(
    `select ep.event_id, ep.profile_id, p.name
     from calendar_event_participants ep
     join profiles p on p.id = ep.profile_id
     where ep.event_id = any($1::text[])`,
    [ids],
  );
  const byEvent = new Map<string, { ids: string[]; names: string[] }>();
  for (const p of parts) {
    const cur = byEvent.get(p.event_id) || { ids: [], names: [] };
    cur.ids.push(p.profile_id);
    cur.names.push(p.name);
    byEvent.set(p.event_id, cur);
  }
  return rows.map((r) => {
    const part = byEvent.get(String(r.id)) || { ids: [], names: [] };
    return {
      id: String(r.id),
      title: String(r.title),
      event_type: String(r.event_type),
      domain: String(r.domain),
      starts_at: String(r.starts_at),
      ends_at: String(r.ends_at),
      all_day: Boolean(r.all_day),
      location: (r.location as string) || null,
      notes: (r.notes as string) || null,
      lead_id: (r.lead_id as string) || null,
      inventory_id: (r.inventory_id as string) || null,
      organizer_id: String(r.organizer_id),
      organizer_name: (r.organizer_name as string) || null,
      visibility: (r.visibility as "team" | "private") || "team",
      status: String(r.status),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      participant_ids: part.ids,
      participant_names: part.names,
      lead_name: (r.lead_name as string) || null,
    };
  });
}

export const listCalendarEvents = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      from: string;
      to: string;
      scope?: CalendarScope;
      domain?: CalendarDomain | "all";
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const scope: CalendarScope = data.scope || "mine";
    const domain = data.domain || "all";
    const from = new Date(data.from);
    const to = new Date(data.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new Error("Invalid date range");
    }

    const rows = await sql.query<Record<string, unknown>>(
      `select e.id, e.title, e.event_type, e.domain,
              e.starts_at::text as starts_at, e.ends_at::text as ends_at,
              e.all_day, e.location, e.notes, e.lead_id, e.inventory_id,
              e.organizer_id, e.visibility, e.status,
              e.created_at::text as created_at, e.updated_at::text as updated_at,
              o.name as organizer_name, l.name as lead_name
       from calendar_events e
       join profiles o on o.id = e.organizer_id
       left join leads l on l.id = e.lead_id
       where e.starts_at < $2
         and e.ends_at > $1
         and e.status <> 'cancelled'
         and ($3 = 'all' or e.domain = $3)
         and (
           case $4
             when 'team' then (
               e.visibility = 'team'
               or e.organizer_id = $5
               or exists (
                 select 1 from calendar_event_participants ep
                 where ep.event_id = e.id and ep.profile_id = $5
               )
             )
             when 'organize' then e.organizer_id = $5
             when 'invited' then (
               e.organizer_id <> $5
               and exists (
                 select 1 from calendar_event_participants ep
                 where ep.event_id = e.id and ep.profile_id = $5
               )
             )
             else (
               e.organizer_id = $5
               or exists (
                 select 1 from calendar_event_participants ep
                 where ep.event_id = e.id and ep.profile_id = $5
               )
             )
           end
         )
       order by e.starts_at asc`,
      [from.toISOString(), to.toISOString(), domain, scope, me.id],
    );

    return {
      me,
      events: await mapEvents(sql, rows),
    };
  });

export const getCalendarEvent = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select e.id, e.title, e.event_type, e.domain,
              e.starts_at::text as starts_at, e.ends_at::text as ends_at,
              e.all_day, e.location, e.notes, e.lead_id, e.inventory_id,
              e.organizer_id, e.visibility, e.status,
              e.created_at::text as created_at, e.updated_at::text as updated_at,
              o.name as organizer_name, l.name as lead_name
       from calendar_events e
       join profiles o on o.id = e.organizer_id
       left join leads l on l.id = e.lead_id
       where e.id = $1 limit 1`,
      [data.id],
    );
    if (!rows[0]) throw new Error("Event not found");
    const events = await mapEvents(sql, rows);
    return events[0]!;
  });

export const upsertCalendarEvent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      id?: string;
      title: string;
      event_type: string;
      starts_at: string;
      ends_at?: string;
      all_day?: boolean;
      location?: string | null;
      notes?: string | null;
      lead_id?: string | null;
      inventory_id?: string | null;
      participant_ids?: string[];
      visibility?: "team" | "private";
      status?: string;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const title = data.title.trim();
    if (!title) throw new Error("Title is required");
    const starts = new Date(data.starts_at);
    if (Number.isNaN(starts.getTime())) throw new Error("Invalid start time");
    let ends = data.ends_at ? new Date(data.ends_at) : new Date(starts.getTime() + 60 * 60 * 1000);
    if (Number.isNaN(ends.getTime())) throw new Error("Invalid end time");
    if (ends.getTime() <= starts.getTime()) {
      ends = new Date(starts.getTime() + 60 * 60 * 1000);
    }
    const domain = domainForEventType(data.event_type);
    const visibility = data.visibility === "private" ? "private" : "team";
    const status = data.status || "scheduled";
    const participants = [...new Set(data.participant_ids || [])].filter(Boolean);
    // Always include organizer as participant for "mine" filters
    if (!participants.includes(me.id)) participants.push(me.id);

    let eventId = data.id;
    if (eventId) {
      const existing = await sql<{ organizer_id: string }>`
        select organizer_id from calendar_events where id = ${eventId} limit 1
      `;
      if (!existing[0]) throw new Error("Event not found");
      const canEdit =
        existing[0].organizer_id === me.id || me.role === "admin" || me.role === "gsm";
      if (!canEdit) throw new Error("Only the organizer, GSM, or Admin can edit this event");
      await sql`
        update calendar_events set
          title = ${title},
          event_type = ${data.event_type},
          domain = ${domain},
          starts_at = ${starts.toISOString()},
          ends_at = ${ends.toISOString()},
          all_day = ${Boolean(data.all_day)},
          location = ${data.location?.trim() || null},
          notes = ${data.notes?.trim() || null},
          lead_id = ${data.lead_id || null},
          inventory_id = ${data.inventory_id || null},
          visibility = ${visibility},
          status = ${status},
          updated_at = now()
        where id = ${eventId}
      `;
      await sql`delete from calendar_event_participants where event_id = ${eventId}`;
    } else {
      eventId = uid();
      await sql`
        insert into calendar_events (
          id, title, event_type, domain, starts_at, ends_at, all_day,
          location, notes, lead_id, inventory_id, organizer_id, visibility, status
        ) values (
          ${eventId}, ${title}, ${data.event_type}, ${domain},
          ${starts.toISOString()}, ${ends.toISOString()}, ${Boolean(data.all_day)},
          ${data.location?.trim() || null}, ${data.notes?.trim() || null},
          ${data.lead_id || null}, ${data.inventory_id || null},
          ${me.id}, ${visibility}, ${status}
        )
      `;
    }

    for (const pid of participants) {
      await sql`
        insert into calendar_event_participants (event_id, profile_id)
        values (${eventId}, ${pid})
        on conflict do nothing
      `;
    }

    if (data.lead_id) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${uid()}, ${data.lead_id}, 'calendar',
          ${`Calendar: ${title} (${data.event_type.replace(/_/g, " ")}) ${starts.toLocaleString("en-CA", { timeZone: "America/Toronto" })}`},
          ${me.id}, ${me.name}
        )
      `;
    }

    const rows = await sql.query<Record<string, unknown>>(
      `select e.id, e.title, e.event_type, e.domain,
              e.starts_at::text as starts_at, e.ends_at::text as ends_at,
              e.all_day, e.location, e.notes, e.lead_id, e.inventory_id,
              e.organizer_id, e.visibility, e.status,
              e.created_at::text as created_at, e.updated_at::text as updated_at,
              o.name as organizer_name, l.name as lead_name
       from calendar_events e
       join profiles o on o.id = e.organizer_id
       left join leads l on l.id = e.lead_id
       where e.id = $1`,
      [eventId],
    );
    const events = await mapEvents(sql, rows);
    return events[0]!;
  });

export const deleteCalendarEvent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const existing = await sql<{ organizer_id: string; title: string; lead_id: string | null }>`
      select organizer_id, title, lead_id from calendar_events where id = ${data.id} limit 1
    `;
    if (!existing[0]) throw new Error("Event not found");
    const canEdit =
      existing[0].organizer_id === me.id || me.role === "admin" || me.role === "gsm";
    if (!canEdit) throw new Error("Only the organizer, GSM, or Admin can delete this event");
    await sql`delete from calendar_events where id = ${data.id}`;
    if (existing[0].lead_id) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${uid()}, ${existing[0].lead_id}, 'calendar',
          ${`Calendar event removed: ${existing[0].title}`},
          ${me.id}, ${me.name}
        )
      `;
    }
    return { ok: true as const };
  });

export const listLeadCalendarEvents = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select e.id, e.title, e.event_type, e.domain,
              e.starts_at::text as starts_at, e.ends_at::text as ends_at,
              e.all_day, e.location, e.notes, e.lead_id, e.inventory_id,
              e.organizer_id, e.visibility, e.status,
              e.created_at::text as created_at, e.updated_at::text as updated_at,
              o.name as organizer_name, l.name as lead_name
       from calendar_events e
       join profiles o on o.id = e.organizer_id
       left join leads l on l.id = e.lead_id
       where e.lead_id = $1 and e.status <> 'cancelled'
       order by e.starts_at asc
       limit 50`,
      [data.leadId],
    );
    return mapEvents(sql, rows);
  });
