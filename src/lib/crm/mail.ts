/**
 * Outbound CRM email via Resend.
 *
 * From: always CRM_FROM_EMAIL (e.g. crm@paulmotorcompany.com) once the domain
 * is verified — stable brand identity + one mailbox to manage.
 *
 * Reply-To: optional actor address when it is on a company domain so clients
 * can reply to the salesperson without changing the From envelope.
 */
import type { Sql } from "@/lib/db";

/** Domains allowed for From/Reply-To personalization (must match Resend-verified). */
const COMPANY_EMAIL_DOMAINS = [
  "paulmotorcompany.com",
  "paulmotorleasing.com",
];

export type OutboundMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind?: string;
  leadId?: string | null;
  profileId?: string | null;
  /** Override display name (default: PAUL MOTOR CO. CRM). */
  fromName?: string;
  /**
   * Reply-To header. Prefer replyToForActor(profile.email, profile.name).
   * Resend accepts "name@domain" or "Name <name@domain>".
   */
  replyTo?: string | null;
};

function uid() {
  return crypto.randomUUID();
}

function escapeHtml(s: string) {
  const amp = String.fromCharCode(38);
  return s
    .split(amp)
    .join(amp + "amp;")
    .split("<")
    .join(amp + "lt;")
    .split(">")
    .join(amp + "gt;")
    .split('"')
    .join(amp + "quot;");
}

export function isCompanyEmail(email: string | null | undefined): boolean {
  if (!email || !email.includes("@")) return false;
  const domain = email.trim().toLowerCase().split("@")[1] || "";
  return COMPANY_EMAIL_DOMAINS.includes(domain);
}

/** Shared CRM From address (env), fallback for unverified / dev. */
export function crmFromAddress(): string {
  return process.env.CRM_FROM_EMAIL?.trim() || "onboarding@resend.dev";
}

/**
 * Reply-To for a staff actor — only if their profile email is on a company domain.
 * Returns undefined for Gmail/etc. so we never set a Reply-To that will bounce SPF confusion.
 */
export function replyToForActor(
  email: string | null | undefined,
  name?: string | null,
): string | undefined {
  const addr = (email || "").trim().toLowerCase();
  if (!isCompanyEmail(addr)) return undefined;
  const n = (name || "").trim().replace(/[<>"]/g, "");
  if (n) return `${n} <${addr}>`;
  return addr;
}

/** Client-facing From display name, e.g. "Jeremy Paul · Paul Motor Leasing". */
export function clientFacingFromName(actorName?: string | null): string {
  const n = (actorName || "").trim().replace(/[<>"]/g, "");
  if (n) return `${n} · Paul Motor Leasing`;
  return "Paul Motor Leasing";
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
  const fromAddress = crmFromAddress();
  const fromName = (mail.fromName || "PAUL MOTOR CO. CRM").trim() || "PAUL MOTOR CO. CRM";
  const replyTo = (mail.replyTo || "").trim() || undefined;

  if (resendKey) {
    try {
      const htmlBody =
        mail.html ||
        '<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">' +
          escapeHtml(mail.text) +
          "</pre>";
      const payload: Record<string, unknown> = {
        from: fromName + " <" + fromAddress + ">",
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: htmlBody,
      };
      if (replyTo) {
        payload.reply_to = replyTo;
      }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + resendKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
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
