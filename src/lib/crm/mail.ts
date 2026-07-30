/**
 * Outbound email for CRM reminders.
 * Prefer Resend (RESEND_API_KEY). Falls back to email_outbox for Admin visibility.
 */
import type { Sql } from "@/lib/db";

export type OutboundMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind?: string;
  leadId?: string | null;
  profileId?: string | null;
};

function uid() {
  return crypto.randomUUID();
}

export async function sendCrmEmail(sql: Sql, mail: OutboundMail): Promise<{
  ok: boolean;
  via: string;
  error?: string;
  outboxId: string;
}> {
  const outboxId = uid();
  await sql`
    insert into email_outbox (
      id, to_email, subject, body_text, body_html, kind,
      related_lead_id, related_profile_id, status
    ) values (
      ${outboxId}, ${mail.to}, ${mail.subject}, ${mail.text},
      ${mail.html || null}, ${mail.kind || null},
      ${mail.leadId || null}, ${mail.profileId || null}, 'pending'
    )
  `;

  const resendKey = process.env.RESEND_API_KEY?.trim();
  const from =
    process.env.CRM_FROM_EMAIL?.trim() ||
    process.env.GMAIL_USER?.trim() ||
    "client@paulmotorcompany.com";

  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `PAUL MOTOR CO. CRM <${from}>`,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          html: mail.html || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        await sql`
          update email_outbox set status = 'error', error = ${err.slice(0, 500)}
          where id = ${outboxId}
        `;
        return { ok: false, via: "resend", error: err.slice(0, 200), outboxId };
      }
      await sql`
        update email_outbox set status = 'sent', sent_at = now() where id = ${outboxId}
      `;
      return { ok: true, via: "resend", outboxId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sql`
        update email_outbox set status = 'error', error = ${msg.slice(0, 500)}
        where id = ${outboxId}
      `;
      return { ok: false, via: "resend", error: msg, outboxId };
    }
  }

  // No provider — left pending for Admin / future Resend key
  await sql`
    update email_outbox set
      status = 'queued_no_provider',
      error = 'Set RESEND_API_KEY (and optional CRM_FROM_EMAIL) in Vercel to deliver mail'
    where id = ${outboxId}
  `;
  return {
    ok: false,
    via: "outbox",
    error: "RESEND_API_KEY not set — email queued in outbox only",
    outboxId,
  };
}
