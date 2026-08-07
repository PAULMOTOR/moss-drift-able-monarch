/**
 * Personal CRM tasks — call, email, follow-up for a day.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import type { CrmTask, Profile, TaskListView } from "./types";

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

function mapTask(r: Record<string, unknown>): CrmTask {
  return {
    id: String(r.id),
    title: String(r.title),
    task_type: String(r.task_type),
    due_at: r.due_at ? String(r.due_at) : null,
    due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
    owner_id: String(r.owner_id),
    owner_name: (r.owner_name as string) || null,
    lead_id: (r.lead_id as string) || null,
    lead_name: (r.lead_name as string) || null,
    notes: (r.notes as string) || null,
    status: String(r.status),
    completed_at: r.completed_at ? String(r.completed_at) : null,
    completed_by: (r.completed_by as string) || null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

/** Toronto calendar date YYYY-MM-DD */
export function torontoDateKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export const listTasks = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { view?: TaskListView; leadId?: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const view: TaskListView = data.view || "today";
    const today = torontoDateKey();

    let rows: Record<string, unknown>[];

    if (data.leadId) {
      rows = await sql.query<Record<string, unknown>>(
        `select t.id, t.title, t.task_type, t.due_at::text as due_at, t.due_date::text as due_date,
                t.owner_id, t.lead_id, t.notes, t.status,
                t.completed_at::text as completed_at, t.completed_by,
                t.created_at::text as created_at, t.updated_at::text as updated_at,
                o.name as owner_name, l.name as lead_name
         from crm_tasks t
         join profiles o on o.id = t.owner_id
         left join leads l on l.id = t.lead_id
         where t.lead_id = $1 and t.owner_id = $2
         order by t.status asc, t.due_date nulls last, t.created_at desc
         limit 100`,
        [data.leadId, me.id],
      );
    } else if (view === "completed") {
      rows = await sql.query<Record<string, unknown>>(
        `select t.id, t.title, t.task_type, t.due_at::text as due_at, t.due_date::text as due_date,
                t.owner_id, t.lead_id, t.notes, t.status,
                t.completed_at::text as completed_at, t.completed_by,
                t.created_at::text as created_at, t.updated_at::text as updated_at,
                o.name as owner_name, l.name as lead_name
         from crm_tasks t
         join profiles o on o.id = t.owner_id
         left join leads l on l.id = t.lead_id
         where t.owner_id = $1 and t.status = 'done'
           and t.completed_at > now() - interval '30 days'
         order by t.completed_at desc
         limit 100`,
        [me.id],
      );
    } else if (view === "overdue") {
      rows = await sql.query<Record<string, unknown>>(
        `select t.id, t.title, t.task_type, t.due_at::text as due_at, t.due_date::text as due_date,
                t.owner_id, t.lead_id, t.notes, t.status,
                t.completed_at::text as completed_at, t.completed_by,
                t.created_at::text as created_at, t.updated_at::text as updated_at,
                o.name as owner_name, l.name as lead_name
         from crm_tasks t
         join profiles o on o.id = t.owner_id
         left join leads l on l.id = t.lead_id
         where t.owner_id = $1 and t.status = 'open'
           and t.due_date is not null and t.due_date < $2::date
         order by t.due_date asc, t.created_at asc
         limit 100`,
        [me.id, today],
      );
    } else if (view === "upcoming") {
      rows = await sql.query<Record<string, unknown>>(
        `select t.id, t.title, t.task_type, t.due_at::text as due_at, t.due_date::text as due_date,
                t.owner_id, t.lead_id, t.notes, t.status,
                t.completed_at::text as completed_at, t.completed_by,
                t.created_at::text as created_at, t.updated_at::text as updated_at,
                o.name as owner_name, l.name as lead_name
         from crm_tasks t
         join profiles o on o.id = t.owner_id
         left join leads l on l.id = t.lead_id
         where t.owner_id = $1 and t.status = 'open'
           and (t.due_date is null or t.due_date > $2::date)
         order by t.due_date nulls last, t.created_at asc
         limit 100`,
        [me.id, today],
      );
    } else {
      // today: due today or no date (inbox for today)
      rows = await sql.query<Record<string, unknown>>(
        `select t.id, t.title, t.task_type, t.due_at::text as due_at, t.due_date::text as due_date,
                t.owner_id, t.lead_id, t.notes, t.status,
                t.completed_at::text as completed_at, t.completed_by,
                t.created_at::text as created_at, t.updated_at::text as updated_at,
                o.name as owner_name, l.name as lead_name
         from crm_tasks t
         join profiles o on o.id = t.owner_id
         left join leads l on l.id = t.lead_id
         where t.owner_id = $1 and t.status = 'open'
           and (t.due_date is null or t.due_date = $2::date)
         order by t.due_at nulls last, t.created_at asc
         limit 100`,
        [me.id, today],
      );
    }

    return { me, view, today, tasks: rows.map(mapTask) };
  });

export const upsertTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      id?: string;
      title: string;
      task_type?: string;
      due_date?: string | null;
      due_at?: string | null;
      lead_id?: string | null;
      notes?: string | null;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const title = data.title.trim();
    if (!title) throw new Error("Title is required");
    const taskType = data.task_type || "follow_up";
    let dueDate = data.due_date?.trim() || null;
    if (data.due_at && !dueDate) {
      dueDate = torontoDateKey(new Date(data.due_at));
    }
    if (!dueDate) dueDate = torontoDateKey();

    let id = data.id;
    if (id) {
      const existing = await sql<{ owner_id: string }>`
        select owner_id from crm_tasks where id = ${id} limit 1
      `;
      if (!existing[0]) throw new Error("Task not found");
      if (existing[0].owner_id !== me.id && me.role !== "admin") {
        throw new Error("You can only edit your own tasks");
      }
      await sql`
        update crm_tasks set
          title = ${title},
          task_type = ${taskType},
          due_date = ${dueDate}::date,
          due_at = ${data.due_at || null},
          lead_id = ${data.lead_id || null},
          notes = ${data.notes?.trim() || null},
          updated_at = now()
        where id = ${id}
      `;
    } else {
      id = uid();
      await sql`
        insert into crm_tasks (
          id, title, task_type, due_date, due_at, owner_id, lead_id, notes, status
        ) values (
          ${id}, ${title}, ${taskType}, ${dueDate}::date, ${data.due_at || null},
          ${me.id}, ${data.lead_id || null}, ${data.notes?.trim() || null}, 'open'
        )
      `;
      if (data.lead_id) {
        await sql`
          insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
          values (
            ${uid()}, ${data.lead_id}, 'task',
            ${`Task: ${title} (due ${dueDate})`},
            ${me.id}, ${me.name}
          )
        `;
      }
    }

    const rows = await sql.query<Record<string, unknown>>(
      `select t.id, t.title, t.task_type, t.due_at::text as due_at, t.due_date::text as due_date,
              t.owner_id, t.lead_id, t.notes, t.status,
              t.completed_at::text as completed_at, t.completed_by,
              t.created_at::text as created_at, t.updated_at::text as updated_at,
              o.name as owner_name, l.name as lead_name
       from crm_tasks t
       join profiles o on o.id = t.owner_id
       left join leads l on l.id = t.lead_id
       where t.id = $1`,
      [id],
    );
    return mapTask(rows[0]!);
  });

export const setTaskStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { id: string; status: "open" | "done" }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const existing = await sql<{ owner_id: string; title: string; lead_id: string | null }>`
      select owner_id, title, lead_id from crm_tasks where id = ${data.id} limit 1
    `;
    if (!existing[0]) throw new Error("Task not found");
    if (existing[0].owner_id !== me.id && me.role !== "admin") {
      throw new Error("You can only complete your own tasks");
    }
    if (data.status === "done") {
      await sql`
        update crm_tasks set
          status = 'done',
          completed_at = now(),
          completed_by = ${me.id},
          updated_at = now()
        where id = ${data.id}
      `;
      if (existing[0].lead_id) {
        await sql`
          insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
          values (
            ${uid()}, ${existing[0].lead_id}, 'task',
            ${`Task completed: ${existing[0].title}`},
            ${me.id}, ${me.name}
          )
        `;
      }
    } else {
      await sql`
        update crm_tasks set
          status = 'open',
          completed_at = null,
          completed_by = null,
          updated_at = now()
        where id = ${data.id}
      `;
    }
    return { ok: true as const };
  });

export const deleteTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    const sql = await getSql();
    const existing = await sql<{ owner_id: string }>`
      select owner_id from crm_tasks where id = ${data.id} limit 1
    `;
    if (!existing[0]) throw new Error("Task not found");
    if (existing[0].owner_id !== me.id && me.role !== "admin") {
      throw new Error("You can only delete your own tasks");
    }
    await sql`delete from crm_tasks where id = ${data.id}`;
    return { ok: true as const };
  });
