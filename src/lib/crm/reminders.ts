import type { Sql } from "@/lib/db";
import { sendCrmEmail } from "./mail";

function uid() {
  return crypto.randomUUID();
}

/** Unpause leads whose pause_until has passed. */
export async function releaseExpiredPauses(sql: Sql) {
  const rows = await sql<{
    id: string;
    stage_before_pause: string | null;
    name: string;
  }>`
    select id, stage_before_pause, name from leads
    where stage = 'paused'
      and pause_until is not null
      and pause_until <= now()
  `;
  for (const r of rows) {
    const back = r.stage_before_pause && r.stage_before_pause !== "paused"
      ? r.stage_before_pause
      : "new";
    await sql`
      update leads set
        stage = ${back},
        stage_entered_at = now(),
        pause_until = null,
        pause_note = null,
        stage_before_pause = null,
        updated_at = now()
      where id = ${r.id}
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by_name)
      values (
        ${uid()}, ${r.id}, 'system',
        ${`Pause ended — returned to ${back}. Contact appointment is due.`},
        'Reminders'
      )
    `;
    await sql`
      update lead_appointments set status = 'due', updated_at = now()
      where lead_id = ${r.id} and status = 'scheduled' and scheduled_at <= now()
    `;
  }
  return rows.length;
}

/**
 * Hourly: email assigned rep for each New Lead still untouched (not paused).
 * Dedupes: at most one hourly mail per lead per hour.
 */
export async function runHourlyNewLeadReminders(sql: Sql) {
  await releaseExpiredPauses(sql);

  const leads = await sql<{
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    vehicle_interest: string | null;
    created_at: string;
    assigned_to: string | null;
    rep_email: string | null;
    rep_name: string | null;
  }>`
    select l.id, l.name, l.phone, l.email, l.vehicle_interest,
           l.created_at::text as created_at, l.assigned_to,
           p.email as rep_email, p.name as rep_name
    from leads l
    left join profiles p on p.id = l.assigned_to and p.active = true
    where l.stage = 'new'
      and (l.pause_until is null or l.pause_until > now())
      and l.stage <> 'paused'
      and l.assigned_to is not null
      and p.email is not null
  `;

  let sent = 0;
  let skipped = 0;

  for (const lead of leads) {
    if (!lead.rep_email) {
      skipped += 1;
      continue;
    }
    // Already reminded in the last 55 minutes?
    const recent = await sql<{ n: number }>`
      select count(*)::int as n from reminder_sends
      where kind = 'hourly_new_lead'
        and lead_id = ${lead.id}
        and sent_at > now() - interval '55 minutes'
    `;
    if ((recent[0]?.n ?? 0) > 0) {
      skipped += 1;
      continue;
    }

    const hours = Math.max(
      1,
      Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 3600000),
    );
    const subject = `[CRM] New lead waiting ${hours}h — ${lead.name}`;
    const text = [
      `Hi ${lead.rep_name || "there"},`,
      ``,
      `This lead is still in New Lead and needs a first contact:`,
      ``,
      `  Name: ${lead.name}`,
      `  Phone: ${lead.phone || "—"}`,
      `  Email: ${lead.email || "—"}`,
      `  Interest: ${lead.vehicle_interest || "—"}`,
      `  Created: ${new Date(lead.created_at).toLocaleString("en-CA")}`,
      ``,
      `Open the CRM, contact the client, and move the stage to Contacted.`,
      `If you schedule a callback, set a Contact appointment (pauses auto-reminders).`,
      ``,
      `— PAUL MOTOR CO. CRM`,
    ].join("\n");

    await sendCrmEmail(sql, {
      to: lead.rep_email,
      subject,
      text,
      kind: "hourly_new_lead",
      leadId: lead.id,
      profileId: lead.assigned_to,
    });
    await sql`
      insert into reminder_sends (id, kind, profile_id, lead_id, meta)
      values (${uid()}, 'hourly_new_lead', ${lead.assigned_to}, ${lead.id}, ${`hours=${hours}`})
    `;
    sent += 1;
  }

  return { sent, skipped, candidates: leads.length };
}

/**
 * Daily morning batch per rep: open actionable leads (not paused, not won/lost).
 */
export async function runDailyRepBatch(sql: Sql) {
  await releaseExpiredPauses(sql);

  // Dedupe: one daily batch per rep per calendar day (America/Toronto-ish via UTC date)
  const reps = await sql<{ id: string; email: string; name: string }>`
    select id, email, name from profiles
    where active = true and role in ('rep', 'broker', 'admin')
  `;

  let batches = 0;

  for (const rep of reps) {
    const already = await sql<{ n: number }>`
      select count(*)::int as n from reminder_sends
      where kind = 'daily_batch'
        and profile_id = ${rep.id}
        and sent_at::date = (now() at time zone 'America/Toronto')::date
    `;
    if ((already[0]?.n ?? 0) > 0) continue;

    const leads = await sql<{
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      stage: string;
      vehicle_interest: string | null;
      pause_until: string | null;
    }>`
      select id, name, phone, email, stage, vehicle_interest,
             pause_until::text as pause_until
      from leads
      where assigned_to = ${rep.id}
        and stage not in ('won', 'lost', 'paused')
        and (pause_until is null or pause_until > now())
      order by
        case stage
          when 'new' then 0
          when 'contacted' then 1
          when 'test_drive' then 2
          when 'quote_sent' then 3
          when 'ready_bc' then 4
          else 5
        end,
        updated_at desc
    `;

    // Also surface appointments due today
    const appts = await sql<{
      lead_name: string;
      scheduled_at: string;
      note: string | null;
    }>`
      select l.name as lead_name, a.scheduled_at::text as scheduled_at, a.note
      from lead_appointments a
      join leads l on l.id = a.lead_id
      where a.profile_id = ${rep.id}
        and a.status in ('scheduled', 'due')
        and a.scheduled_at::date <= (now() at time zone 'America/Toronto')::date + 1
      order by a.scheduled_at asc
      limit 20
    `;

    if (leads.length === 0 && appts.length === 0) continue;

    const lines = leads.map(
      (l, i) =>
        `${i + 1}. [${l.stage}] ${l.name} — ${l.phone || l.email || "no contact"} — ${l.vehicle_interest || "—"}`,
    );
    const apptLines = appts.map(
      (a) =>
        `• ${new Date(a.scheduled_at).toLocaleString("en-CA", { timeZone: "America/Toronto" })} — ${a.lead_name}${a.note ? ` (${a.note})` : ""}`,
    );

    const subject = `[CRM] Morning pipeline — ${leads.length} lead(s) for ${rep.name}`;
    const text = [
      `Good morning ${rep.name},`,
      ``,
      `Here is your actionable pipeline for today (paused leads are excluded):`,
      ``,
      lines.length ? lines.join("\n") : "(no open leads)",
      ``,
      apptLines.length ? `Contact appointments:\n${apptLines.join("\n")}` : "",
      ``,
      `Tip: set a Contact appointment on a lead to pause auto-reminders until that date.`,
      ``,
      `— PAUL MOTOR CO. CRM`,
    ]
      .filter(Boolean)
      .join("\n");

    await sendCrmEmail(sql, {
      to: rep.email,
      subject,
      text,
      kind: "daily_batch",
      profileId: rep.id,
    });
    await sql`
      insert into reminder_sends (id, kind, profile_id, meta)
      values (${uid()}, 'daily_batch', ${rep.id}, ${`leads=${leads.length}`})
    `;
    batches += 1;
  }

  return { batches, reps: reps.length };
}
