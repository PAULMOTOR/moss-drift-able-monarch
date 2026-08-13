import type { Sql } from "@/lib/db";

export const PARTNER_KINDS = [
  { id: "dealer", label: "Selling dealer" },
  { id: "broker", label: "Lease broker" },
  { id: "referrer", label: "Referrer" },
] as const;

export type PartnerKind = (typeof PARTNER_KINDS)[number]["id"];

export type Partner = {
  id: string;
  name: string;
  kind: PartnerKind;
  city: string | null;
  province: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export function isPartnerKind(v: string): v is PartnerKind {
  return PARTNER_KINDS.some((k) => k.id === v);
}

export function partnerKindLabel(kind: string | null | undefined): string {
  return PARTNER_KINDS.find((k) => k.id === kind)?.label ?? "Partner";
}

export function mapPartner(r: Record<string, unknown>): Partner {
  const kind = String(r.kind || "dealer");
  return {
    id: String(r.id),
    name: String(r.name),
    kind: isPartnerKind(kind) ? kind : "dealer",
    city: (r.city as string) ?? null,
    province: (r.province as string) ?? null,
    email: (r.email as string) ?? null,
    phone: (r.phone as string) ?? null,
    notes: (r.notes as string) ?? null,
    active: r.active !== false,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

/** Client-facing copy that protects the referring dealer/broker. */
export function referralClientCopy(partner: {
  name: string;
  kind?: string | null;
} | null | undefined): { text: string; html: string } {
  const name = partner?.name?.trim();
  if (!name) return { text: "", html: "" };
  const kind = partner?.kind || "dealer";
  const role =
    kind === "broker"
      ? "your lease broker"
      : kind === "referrer"
        ? "your referring partner"
        : "your dealer";
  const text =
    `We're aware you're working with ${name}. They remain ${role} on the vehicle — ` +
    `questions about the car go to them. Questions about your lease, payments, or ` +
    `credit come to Paul Motor Leasing. We're glad they partnered with us to look after you.`;
  const html =
    `<p>We're aware you're working with <strong>${escapeHtml(name)}</strong>. ` +
    `They remain ${escapeHtml(role)} on the vehicle — questions about the car go to them. ` +
    `Questions about your lease, payments, or credit come to Paul Motor Leasing. ` +
    `We're glad they partnered with us to look after you.</p>`;
  return { text, html };
}

function escapeHtml(s: string): string {
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

export async function fetchPartnerForLead(
  sql: Sql,
  leadId: string,
): Promise<Partner | null> {
  const rows = await sql<Record<string, unknown>>`
    select pr.id, pr.name, pr.kind, pr.city, pr.province, pr.email, pr.phone, pr.notes,
           pr.active, pr.created_at::text as created_at, pr.updated_at::text as updated_at
    from leads l
    join partners pr on pr.id = l.partner_id
    where l.id = ${leadId}
    limit 1
  `;
  return rows[0] ? mapPartner(rows[0]) : null;
}
