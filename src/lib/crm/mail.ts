/**
 * Outbound email for CRM reminders via Resend.
 * Until paulmotorcompany.com is verified in Resend, use onboarding@resend.dev as From.
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

function escapeHtml(s: string) {
  return s
    .split("&")
    .join("&")
    .split("<")
    .join("<")
    .split(">")
    .join(">")
    .split('"')
    .join(""");
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
  // Resend free onboarding sender works immediately without domain verify.
  // After Domains verify paulmotorcompany.com, set CRM_FROM_EMAIL to client@...
  const fromAddress =
    process.env.CRM_FROM_EMAIL?.trim() || "onboarding@resend.dev";
  const fromName = "PAUL MOTOR CO. CRM";

  if (resendKey) {
    try {
      const htmlBody =
        mail.html ||
        "<pre style=\"font-family:system-ui,sans-serif;white-space:pre-wrap\">" +
          escapeHtml(mail.text) +
          "</pre>";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + resendKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromName + " <" + fromAddress + ">",
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          html: htmlBody,
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

  await sql`
    update email_outbox set
      status = 'queued_no_provider',
      error = 'Set RESEND_API_KEY in Vercel Production env, then redeploy'
    where id = ${outboxId}
  `;
  return {
    ok: false,
    via: "outbox",
    error: "RESEND_API_KEY not set — email queued only",
    outboxId,
  };
}
