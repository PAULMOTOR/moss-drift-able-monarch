import type { Sql } from "@/lib/db";
import { sendCrmEmail } from "./mail";
import { publicAppUrl } from "./public-url";

function uid() {
  return crypto.randomUUID();
}

export function appBaseUrl() {
  return publicAppUrl();
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;");
}

/** America/Toronto clock used for weekday 9am / 2pm gates. */
export function getTorontoClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const weekday = get("weekday"); // Mon … Sun
  const hour = Number.parseInt(get("hour"), 10);
  const minute = Number.parseInt(get("minute"), 10);
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  /** Morning batch window (9:00–9:59 Toronto). */
  const isAmSlot = hour === 9;
  /** Afternoon batch window (14:00–14:59 Toronto). */
  const isPmSlot = hour === 14;
  return { weekday, hour, minute, dateKey, isWeekday, isAmSlot, isPmSlot };
}

export type UncontactedSlot = "am" | "pm";

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
    const back =
      r.stage_before_pause && r.stage_before_pause !== "paused"
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

type UncontactedLead = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  vehicle_interest: string | null;
  created_at: string;
  assigned_to: string | null;
  rep_email: string | null;
  rep_name: string | null;
  days_open: number;
  lead_type: string;
};

async function fetchUncontactedLeads(sql: Sql, minDays?: number): Promise<UncontactedLead[]> {
  const rows = await sql<{
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    vehicle_interest: string | null;
    created_at: string;
    assigned_to: string | null;
    rep_email: string | null;
    rep_name: string | null;
    days_open: number;
    lead_type: string;
  }>`
    select l.id, l.name, l.phone, l.email, l.vehicle_interest,
           l.created_at::text as created_at, l.assigned_to,
           p.email as rep_email, p.name as rep_name,
           greatest(0, floor(extract(epoch from (now() - l.created_at)) / 86400))::int as days_open,
           coalesce(l.lead_type, 'inventory') as lead_type
    from leads l
    left join profiles p on p.id = l.assigned_to and p.active = true
    where l.stage = 'new'
      and (l.pause_until is null or l.pause_until > now())
    order by l.created_at asc
  `;
  if (minDays != null) {
    return rows.filter((r) => r.days_open >= minDays);
  }
  return rows;
}

function formatLeadLine(l: UncontactedLead, base: string, withRep = false) {
  const age =
    l.days_open >= 1
      ? `${l.days_open}d uncontacted`
      : `${Math.max(1, Math.floor((Date.now() - new Date(l.created_at).getTime()) / 3600000))}h old`;
  const contact = [l.phone, l.email].filter(Boolean).join(" · ") || "no contact";
  const rep = withRep ? ` · Owner: ${l.rep_name || "Unassigned"}` : "";
  const kind =
    l.lead_type === "general"
      ? "General inquiry"
      : l.lead_type === "lease"
        ? "Lease"
        : "Inventory";
  return `• [${kind}] ${l.name} (${age}) — ${contact} — ${l.vehicle_interest || "—"}${rep}\n  ${base}/leads/${l.id}?tab=lead`;
}

/**
 * Weekdays 9am and 2pm (America/Toronto): one batch email per rep listing
 * all of their still-New (uncontacted) leads. Replaces per-lead hourly spam.
 */
export async function runUncontactedRepBatches(
  sql: Sql,
  options?: { forceSlot?: UncontactedSlot; ignoreSchedule?: boolean },
) {
  await releaseExpiredPauses(sql);
  const clock = getTorontoClock();

  if (!options?.ignoreSchedule) {
    if (!clock.isWeekday) {
      return { sent: 0, skipped: 0, reason: "weekend" as const, clock };
    }
    if (!clock.isAmSlot && !clock.isPmSlot) {
      return { sent: 0, skipped: 0, reason: "outside_slots" as const, clock };
    }
  }

  const slot: UncontactedSlot =
    options?.forceSlot || (clock.isPmSlot ? "pm" : "am");
  const kind = slot === "am" ? "uncontacted_rep_am" : "uncontacted_rep_pm";
  const slotLabel = slot === "am" ? "9:00 AM" : "2:00 PM";

  // Sales rep digests: inventory/lease only. General inquiries go to GSM/Admin.
  const leads = (await fetchUncontactedLeads(sql)).filter(
    (l) =>
      l.assigned_to &&
      l.rep_email &&
      l.lead_type !== "general",
  );

  const byRep = new Map<
    string,
    { email: string; name: string; profileId: string; leads: UncontactedLead[] }
  >();
  for (const l of leads) {
    if (!l.assigned_to || !l.rep_email) continue;
    const cur = byRep.get(l.assigned_to) || {
      email: l.rep_email,
      name: l.rep_name || "there",
      profileId: l.assigned_to,
      leads: [] as UncontactedLead[],
    };
    cur.leads.push(l);
    byRep.set(l.assigned_to, cur);
  }

  let sent = 0;
  let skipped = 0;
  const base = appBaseUrl();

  for (const [, rep] of byRep) {
    const already = await sql<{ n: number }>`
      select count(*)::int as n from reminder_sends
      where kind = ${kind}
        and profile_id = ${rep.profileId}
        and meta = ${clock.dateKey}
    `;
    if ((already[0]?.n ?? 0) > 0) {
      skipped += 1;
      continue;
    }
    if (rep.leads.length === 0) {
      skipped += 1;
      continue;
    }

    const lines = rep.leads.map((l) => formatLeadLine(l, base));
    const subject = `[CRM] Uncontacted leads (${slotLabel}) — ${rep.leads.length} for ${rep.name}`;
    const text = [
      `Hi ${rep.name},`,
      ``,
      `These leads are still in New Lead and need a first contact (${slotLabel} weekday check-in):`,
      ``,
      lines.join("\n\n"),
      ``,
      `Open each lead, call or email the client, then move the stage to Contacted.`,
      `To park a callback without more reminders, set a Contact appointment (pauses until that date).`,
      ``,
      `— PAUL MOTOR CO. CRM`,
    ].join("\n");

    const htmlLines = rep.leads
      .map((l) => {
        const age =
          l.days_open >= 1
            ? `${l.days_open}d uncontacted`
            : `${Math.max(1, Math.floor((Date.now() - new Date(l.created_at).getTime()) / 3600000))}h old`;
        const contact = [l.phone, l.email].filter(Boolean).join(" · ") || "no contact";
        return (
          `<li style="margin-bottom:10px"><strong><a href="${base}/leads/${l.id}?tab=lead">` +
          `${escapeHtml(l.name)}</a></strong>` +
          `<span style="color:#666"> (${escapeHtml(age)})</span><br/>` +
          `<span style="font-size:13px;color:#444">${escapeHtml(contact)} — ${escapeHtml(l.vehicle_interest || "—")}</span></li>`
        );
      })
      .join("");

    await sendCrmEmail(sql, {
      to: rep.email,
      subject,
      text,
      html:
        `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45">` +
        `<p>Hi ${escapeHtml(rep.name)},</p>` +
        `<p>These leads are still in <strong>New Lead</strong> and need a first contact ` +
        `(${escapeHtml(slotLabel)} weekday check-in):</p>` +
        `<ul style="padding-left:18px">${htmlLines}</ul>` +
        `<p style="font-size:13px;color:#555">Move each lead to <strong>Contacted</strong> after you reach out. ` +
        `Use a Contact appointment to pause reminders for a scheduled callback.</p>` +
        `<p style="font-size:13px;color:#555">— PAUL MOTOR CO. CRM</p></div>`,
      kind,
      profileId: rep.profileId,
    });
    await sql`
      insert into reminder_sends (id, kind, profile_id, lead_id, meta)
      values (${uid()}, ${kind}, ${rep.profileId}, null, ${clock.dateKey})
    `;
    sent += 1;
  }

  return {
    sent,
    skipped,
    candidates: leads.length,
    reps: byRep.size,
    slot,
    reason: "ok" as const,
    clock,
  };
}

/**
 * Weekdays 9am and 2pm (America/Toronto): general-inquiry New leads (usually unassigned)
 * go to GSM + Admins — never to Lucas / sales rep digests.
 */
export async function runGeneralInquiryBatches(
  sql: Sql,
  options?: { forceSlot?: UncontactedSlot; ignoreSchedule?: boolean },
) {
  await releaseExpiredPauses(sql);
  const clock = getTorontoClock();

  if (!options?.ignoreSchedule) {
    if (!clock.isWeekday) {
      return { sent: 0, skipped: 0, reason: "weekend" as const, clock, leads: 0 };
    }
    if (!clock.isAmSlot && !clock.isPmSlot) {
      return { sent: 0, skipped: 0, reason: "outside_slots" as const, clock, leads: 0 };
    }
  }

  const slot: UncontactedSlot =
    options?.forceSlot || (clock.isPmSlot ? "pm" : "am");
  const kind = slot === "am" ? "general_inquiry_am" : "general_inquiry_pm";
  const slotLabel = slot === "am" ? "9:00 AM" : "2:00 PM";

  const already = await sql<{ n: number }>`
    select count(*)::int as n from reminder_sends
    where kind = ${kind}
      and meta = ${clock.dateKey}
  `;
  if ((already[0]?.n ?? 0) > 0) {
    return { sent: 0, skipped: 1, reason: "already_sent" as const, clock, leads: 0 };
  }

  const generals = (await fetchUncontactedLeads(sql)).filter(
    (l) => l.lead_type === "general" || l.lead_type === "consignment",
  );
  if (generals.length === 0) {
    return { sent: 0, skipped: 0, reason: "none" as const, clock, leads: 0 };
  }

  const managers = await sql<{ id: string; email: string; name: string }>`
    select id, email, name from profiles
    where active = true and role in ('gsm', 'admin')
    order by case role when 'gsm' then 0 else 1 end, name
  `;
  if (managers.length === 0) {
    return { sent: 0, skipped: 0, reason: "no_managers" as const, clock, leads: generals.length };
  }

  const base = appBaseUrl();
  const lines = generals.map((l) => formatLeadLine(l, base, true));
  const subject = `[CRM] General inquiries (${slotLabel}) — ${generals.length} need follow-up`;
  const text = [
    `GSM / Admins,`,
    ``,
    `These General Contact / website / consignment inquiries are still in New Lead (${slotLabel} check-in).`,
    `They are not routed to sales reps (Lucas) — please own or reassign them:`,
    ``,
    lines.join("\n\n"),
    ``,
    `— PAUL MOTOR CO. CRM`,
  ].join("\n");

  const htmlLines = generals
    .map((l) => {
      const age =
        l.days_open >= 1
          ? `${l.days_open}d uncontacted`
          : `${Math.max(1, Math.floor((Date.now() - new Date(l.created_at).getTime()) / 3600000))}h old`;
      const contact = [l.phone, l.email].filter(Boolean).join(" · ") || "no contact";
      return (
        `<li style="margin-bottom:10px"><strong><a href="${base}/leads/${l.id}?tab=lead">` +
        `${escapeHtml(l.name)}</a></strong>` +
        `<span style="color:#666"> (${escapeHtml(age)})</span><br/>` +
        `<span style="font-size:13px;color:#444">${escapeHtml(contact)}` +
        `${l.vehicle_interest ? ` — ${escapeHtml(l.vehicle_interest)}` : ""}` +
        `${l.lead_type === "consignment" ? " — Consignment" : ""}<br/>` +
        `Owner: ${escapeHtml(l.rep_name || "Unassigned")}</span></li>`
      );
    })
    .join("");

  let sent = 0;
  for (const m of managers) {
    await sendCrmEmail(sql, {
      to: m.email,
      subject,
      text,
      html:
        `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45">` +
        `<p>GSM / Admins,</p>` +
        `<p>These <strong>General Contact</strong> / website inquiries are still in ` +
        `<strong>New Lead</strong> (${escapeHtml(slotLabel)}). They are not sent to sales reps:</p>` +
        `<ul style="padding-left:18px">${htmlLines}</ul>` +
        `<p style="font-size:13px;color:#555">Please contact, reassign, or close as appropriate.</p>` +
        `<p style="font-size:13px;color:#555">— PAUL MOTOR CO. CRM</p></div>`,
      kind,
      profileId: m.id,
    });
    sent += 1;
  }

  await sql`
    insert into reminder_sends (id, kind, profile_id, lead_id, meta)
    values (${uid()}, ${kind}, ${managers[0]!.id}, null, ${clock.dateKey})
  `;

  return {
    sent,
    skipped: 0,
    reason: "ok" as const,
    clock,
    leads: generals.length,
    managers: managers.length,
    slot,
  };
}

/**
 * Weekdays (once/day at 9am Toronto): batch email to GSM + Admins listing every lead
 * still uncontacted (stage = new) for 3+ days so management can intervene.
 */
export async function runStaleUncontactedEscalation(
  sql: Sql,
  options?: { ignoreSchedule?: boolean },
) {
  await releaseExpiredPauses(sql);
  const clock = getTorontoClock();

  if (!options?.ignoreSchedule) {
    if (!clock.isWeekday) {
      return { sent: 0, reason: "weekend" as const, clock, leads: 0 };
    }
    if (!clock.isAmSlot) {
      return { sent: 0, reason: "outside_am_slot" as const, clock, leads: 0 };
    }
  }

  const kind = "uncontacted_stale_gsm";
  const already = await sql<{ n: number }>`
    select count(*)::int as n from reminder_sends
    where kind = ${kind}
      and meta = ${clock.dateKey}
  `;
  if ((already[0]?.n ?? 0) > 0) {
    return { sent: 0, reason: "already_sent" as const, clock, leads: 0 };
  }

  const stale = await fetchUncontactedLeads(sql, 3);
  if (stale.length === 0) {
    return { sent: 0, reason: "none" as const, clock, leads: 0 };
  }

  const managers = await sql<{ id: string; email: string; name: string }>`
    select id, email, name from profiles
    where active = true and role in ('gsm', 'admin')
  `;
  if (managers.length === 0) {
    return { sent: 0, reason: "no_managers" as const, clock, leads: stale.length };
  }

  const base = appBaseUrl();
  const lines = stale.map((l) => formatLeadLine(l, base, true));
  const subject = `[CRM] Intervention needed — ${stale.length} lead(s) uncontacted 3+ days`;
  const text = [
    `GSM / Admins,`,
    ``,
    `The following leads have been in New Lead for 3 or more days without first contact:`,
    ``,
    lines.join("\n\n"),
    ``,
    `Please intervene (reassign, call, or coach the owner).`,
    ``,
    `— PAUL MOTOR CO. CRM`,
  ].join("\n");

  const htmlLines = stale
    .map((l) => {
      const contact = [l.phone, l.email].filter(Boolean).join(" · ") || "no contact";
      return (
        `<li style="margin-bottom:10px"><strong><a href="${base}/leads/${l.id}?tab=lead">` +
        `${escapeHtml(l.name)}</a></strong>` +
        `<span style="color:#b91c1c"> · ${l.days_open}d uncontacted</span><br/>` +
        `<span style="font-size:13px;color:#444">${escapeHtml(contact)} — ${escapeHtml(l.vehicle_interest || "—")}<br/>` +
        `Owner: ${escapeHtml(l.rep_name || "Unassigned")}</span></li>`
      );
    })
    .join("");

  let sent = 0;
  for (const m of managers) {
    await sendCrmEmail(sql, {
      to: m.email,
      subject,
      text,
      html:
        `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45">` +
        `<p>GSM / Admins,</p>` +
        `<p>These leads have been in <strong>New Lead</strong> for <strong>3+ days</strong> without first contact:</p>` +
        `<ul style="padding-left:18px">${htmlLines}</ul>` +
        `<p style="font-size:13px;color:#555">Please intervene (reassign, call, or coach the owner).</p>` +
        `<p style="font-size:13px;color:#555">— PAUL MOTOR CO. CRM</p></div>`,
      kind,
      profileId: m.id,
    });
    sent += 1;
  }

  await sql`
    insert into reminder_sends (id, kind, profile_id, lead_id, meta)
    values (${uid()}, ${kind}, ${managers[0]!.id}, null, ${clock.dateKey})
  `;

  return {
    sent,
    reason: "ok" as const,
    clock,
    leads: stale.length,
    managers: managers.length,
  };
}

/**
 * Cron entry: release pauses; on weekdays at 9am/2pm Toronto run rep batches;
 * at 9am also escalate 3+ day uncontacted leads to GSM/Admin.
 */
export async function runScheduledUncontactedReminders(sql: Sql) {
  const released = await releaseExpiredPauses(sql);
  const repBatch = await runUncontactedRepBatches(sql);
  const generalBatch = await runGeneralInquiryBatches(sql);
  const escalation = await runStaleUncontactedEscalation(sql);
  let unmatchedApps: unknown = null;
  try {
    const { runUnmatchedLeaseAppDigest } = await import("./lease-app-import");
    unmatchedApps = await runUnmatchedLeaseAppDigest(sql);
  } catch {
    unmatchedApps = { sent: 0, reason: "error" };
  }
  return { released, repBatch, generalBatch, escalation, unmatchedApps };
}

/** @deprecated Name kept for old cron imports — now runs scheduled batch logic. */
export async function runHourlyNewLeadReminders(sql: Sql) {
  return runScheduledUncontactedReminders(sql);
}

/**
 * Daily morning batch per rep: open actionable leads (not paused, not won/lost).
 */
export async function runDailyRepBatch(sql: Sql) {
  await releaseExpiredPauses(sql);

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
        and coalesce(lead_type, 'inventory') <> 'general'
        and (pause_until is null or pause_until > now())
      order by
        case stage
          when 'new' then 0
          when 'contacted' then 1
          when 'quote_sent' then 3
          when 'ready_bc' then 4
          else 5
        end,
        updated_at desc
    `;

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
