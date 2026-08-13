/**
 * Lessee quote acceptance — token link, exact option, IP + timestamp audit.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getSql, type Sql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { sendCrmEmail, clientFacingFromName, replyToForActor } from "./mail";
import { fetchPartnerForLead, referralClientCopy } from "./partners";
import {
  buildFirstInvoiceHtml,
  buildRetailQuoteHtml,
  defaultContractBody,
  formatMoney,
  renderContractTemplate,
  taxRateForProvince,
  wrapPrintable,
  type ClientQuoteInfo,
  type ContractStyleKey,
  type LeaseOptionResult,
} from "./lease-quote";

function uid() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function appBaseUrl() {
  return (
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.BETTER_AUTH_URL?.replace(/\/$/, "") ||
    process.env.VITE_APP_URL?.replace(/\/$/, "") ||
    "https://moss-drift-able-monarch.vercel.app"
  );
}

function requestMeta(): { ip: string; ua: string } {
  try {
    const req = getRequest();
    const h = req.headers;
    const xf =
      h.get("x-forwarded-for") ||
      h.get("x-real-ip") ||
      h.get("cf-connecting-ip") ||
      "";
    return {
      ip: xf.split(",")[0].trim() || "unknown",
      ua: (h.get("user-agent") || "").slice(0, 400),
    };
  } catch {
    return { ip: "unknown", ua: "" };
  }
}

function vehicleLine(c: ClientQuoteInfo): string {
  return [c.year, c.make, c.model, c.trim].filter(Boolean).join(" ") || "Vehicle";
}

export function optionSnapshot(opt: LeaseOptionResult, client: ClientQuoteInfo) {
  return {
    optionNumber: 0,
    vehicle: vehicleLine(client),
    stock: client.stock || null,
    vin: client.vin || null,
    clientName: client.clientName,
    termMonths: opt.termMonths,
    ratePct: opt.ratePct,
    payment: opt.payment,
    taxOnPayment: opt.taxOnPayment,
    totalPayment: opt.totalPayment,
    cashDown: opt.deposit,
    securityDeposit: opt.securityDeposit || 0,
    residual: opt.residual,
    dueTotal: opt.dueTotal,
    financed: opt.financed,
    quoteDate: client.quoteDate || null,
  };
}

export type ApplyAcceptResult = {
  ok: true;
  quoteId: string;
  optionNumber: number;
  contractHtml: string;
  invoiceHtml: string;
  retailHtml: string;
  pdfName: string;
  pdfData: string;
};

export async function applyAcceptedOption(
  sql: Sql,
  opts: {
    quoteId: string;
    optionNumber: number;
    contractStyle?: string;
    actorName: string;
    actorId: string | null;
    byKind: "staff" | "lessee";
    ip?: string | null;
    ua?: string | null;
  },
): Promise<ApplyAcceptResult> {
  const rows = await sql<{
    id: string;
    lead_id: string | null;
    payload: string;
    accepted_option: number | null;
    status: string;
  }>`
    select id, lead_id, payload::text as payload, accepted_option, status
    from lease_quotes where id = ${opts.quoteId} limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Quote not found");
  let payload: {
    client: ClientQuoteInfo;
    options: LeaseOptionResult[];
    taxRate: number;
  };
  try {
    payload = JSON.parse(row.payload) as typeof payload;
  } catch {
    throw new Error("Corrupt quote payload");
  }
  const opt = payload.options[opts.optionNumber - 1];
  if (!opt) throw new Error("Invalid option number");

  if (row.accepted_option && row.status === "accepted") {
    if (row.accepted_option !== opts.optionNumber) {
      throw new Error(
        `Option ${row.accepted_option} is already accepted on this quote`,
      );
    }
  }

  const taxRate = payload.taxRate || taxRateForProvince(payload.client.province || "QC");
  const style = (opts.contractStyle ||
    payload.client.contractStyle ||
    "qc_individual_en") as ContractStyleKey;
  const tplRows = await sql<{ body_html: string }>`
    select body_html from contract_templates where style_key = ${style} limit 1
  `;
  const body = tplRows[0]?.body_html || defaultContractBody(style);
  const contractInner = renderContractTemplate(body, payload.client, opt, taxRate);
  const contractHtml = wrapPrintable(
    `Lease Contract — ${payload.client.clientName}`,
    contractInner,
  );
  const invoiceHtml = buildFirstInvoiceHtml(payload.client, opt, taxRate);
  const retailOne = buildRetailQuoteHtml(
    payload.client,
    payload.options.map((o, i) =>
      i === opts.optionNumber - 1
        ? o
        : { ...o, cost: 0, payment: 0, deposit: 0, securityDeposit: 0, residual: 0 },
    ),
    taxRate,
  );
  const pdfName = `Accepted Option ${opts.optionNumber} — ${payload.client.clientName || "Client"}.pdf`;
  const { buildRetailQuotePdf, pdfDataUrl } = await import("./quote-pdf");
  const buf = await buildRetailQuotePdf(payload.client, payload.options, taxRate, {
    acceptedOption: opts.optionNumber,
  });
  const pdfData = pdfDataUrl(buf);
  const snap = {
    ...optionSnapshot(opt, payload.client),
    optionNumber: opts.optionNumber,
    acceptedBy: opts.byKind,
    actorName: opts.actorName,
  };

  await sql`
    update lease_quotes set
      accepted_option = ${opts.optionNumber},
      selected_option = ${opts.optionNumber},
      status = 'accepted',
      contract_html = ${contractHtml},
      invoice_html = ${invoiceHtml},
      retail_html = ${retailOne},
      pdf_name = ${pdfName},
      pdf_data = ${pdfData},
      accepted_at = coalesce(accepted_at, now()),
      accepted_ip = coalesce(accepted_ip, ${opts.ip || null}),
      accepted_user_agent = coalesce(accepted_user_agent, ${opts.ua || null}),
      accepted_by_kind = coalesce(accepted_by_kind, ${opts.byKind}),
      accepted_snapshot = ${JSON.stringify(snap)},
      updated_at = now()
    where id = ${opts.quoteId}
  `;

  if (row.lead_id) {
    await sql`
      update leads set
        accepted_quote_id = ${opts.quoteId},
        quote_pdf_name = ${pdfName},
        quote_pdf_data = ${pdfData},
        guarantor = ${payload.client.guarantor || null},
        estimated_value = ${opt.cost + opt.extra + opt.profit},
        stage = case
          when stage in ('new','contacted','paused','quote_sent') then 'lease_accepted'
          else stage
        end,
        stage_entered_at = case
          when stage in ('new','contacted','paused','quote_sent') then now()
          else stage_entered_at
        end,
        updated_at = now()
      where id = ${row.lead_id}
    `;
    await sql`
      insert into lead_quote_files (
        id, lead_id, quote_id, option_number, file_name, file_data, mime_type, source, created_by
      ) values (
        ${uid()}, ${row.lead_id}, ${opts.quoteId}, ${opts.optionNumber},
        ${pdfName}, ${pdfData}, 'application/pdf', 'accepted_option', ${opts.actorId}
      )
    `;
    const who =
      opts.byKind === "lessee"
        ? `Lessee accepted Option ${opts.optionNumber} via secure link`
        : `Accepted Option ${opts.optionNumber}`;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${row.lead_id}, 'quote',
        ${`${who} · ${formatMoney(opt.totalPayment)}/mo × ${opt.termMonths} mo · IP ${opts.ip || "n/a"} · contract + 1st invoice generated`},
        ${opts.actorId}, ${opts.actorName}
      )
    `;
  }

  return {
    ok: true,
    quoteId: opts.quoteId,
    optionNumber: opts.optionNumber,
    contractHtml,
    invoiceHtml,
    retailHtml: retailOne,
    pdfName,
    pdfData,
  };
}

export const sendQuoteAcceptLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { quoteId: string; optionNumber: number; email?: string }) => data)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const profiles = await sql<{ id: string; name: string; email: string }>`
      select id, name, email from profiles
      where user_id = ${context.userId} and active = true limit 1
    `;
    const me = profiles[0];
    if (!me) throw new Error("Not signed in");

    const q = await sql<{
      id: string;
      lead_id: string | null;
      payload: string;
      accept_token: string | null;
      client_name: string;
    }>`
      select id, lead_id, payload::text as payload, accept_token, client_name
      from lease_quotes where id = ${data.quoteId} limit 1
    `;
    if (!q[0]) throw new Error("Quote not found");
    let payload: { client: ClientQuoteInfo; options: LeaseOptionResult[] };
    try {
      payload = JSON.parse(q[0].payload) as typeof payload;
    } catch {
      throw new Error("Corrupt quote");
    }
    const opt = payload.options[data.optionNumber - 1];
    if (!opt) throw new Error("Invalid option");
    const tok = q[0].accept_token || token();
    await sql`
      update lease_quotes set
        accept_token = ${tok},
        accept_option_invited = ${data.optionNumber},
        updated_at = now()
      where id = ${data.quoteId}
    `;
    const email = (
      data.email ||
      payload.client.email ||
      ""
    )
      .trim()
      .toLowerCase();
    if (!email.includes("@")) throw new Error("Client email is required to send the accept link");
    const link = `${appBaseUrl()}/quote-accept/${tok}`;
    const partner = q[0].lead_id ? await fetchPartnerForLead(sql, q[0].lead_id) : null;
    const referral = referralClientCopy(partner);
    const first = payload.client.clientName.split(" ")[0] || "there";
    const vehicle = vehicleLine(payload.client);
    const summary = [
      `Option ${data.optionNumber} — ${vehicle}`,
      `Term: ${opt.termMonths} months`,
      `Payment: ${formatMoney(opt.totalPayment)} / month (taxes included)`,
      `Cash down: ${formatMoney(opt.deposit)}`,
      `Security deposit: ${formatMoney(opt.securityDeposit || 0)}`,
      `Rate: ${opt.ratePct.toFixed(2)}%`,
    ].join("\n");
    const mail = await sendCrmEmail(sql, {
      to: email,
      subject: `Please accept your Paul Motor lease quote — Option ${data.optionNumber}`,
      kind: "quote_accept_request",
      leadId: q[0].lead_id,
      profileId: me.id,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
      text: `Hi ${first},\n\n${referral.text ? referral.text + "\n\n" : ""}Please review and accept this exact lease option:\n\n${summary}\n\nAccept here (secure link, no password):\n${link}\n\nThis is not a vague agreement — the page shows these numbers. Clicking accept records the option, time, and your confirmation.\n\n— ${me.name}\nPaul Motor Leasing`,
      html:
        `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5">` +
        `<p>Hi ${first.replace(/</g, "")},</p>${referral.html}` +
        `<p>Please review and accept this <strong>exact</strong> lease option:</p>` +
        `<table style="border-collapse:collapse;font-size:14px">` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Option</td><td><strong>${data.optionNumber}</strong> — ${vehicle.replace(/</g, "")}</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Term</td><td>${opt.termMonths} months</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Monthly</td><td><strong>${formatMoney(opt.totalPayment)}</strong> (taxes included)</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Cash down</td><td>${formatMoney(opt.deposit)}</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Security deposit</td><td>${formatMoney(opt.securityDeposit || 0)}</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Rate</td><td>${opt.ratePct.toFixed(2)}%</td></tr>` +
        `</table>` +
        `<p><a href="${link}" style="display:inline-block;background:#008272;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:600">Review & accept Option ${data.optionNumber}</a></p>` +
        `<p style="font-size:13px;color:#555">This records the option you accepted, the time, and a confirmation — not a vague “I agree.”</p>` +
        `<p>— ${me.name.replace(/</g, "")}<br/>Paul Motor Leasing</p></div>`,
    });
    if (!mail.ok) throw new Error(mail.error || "Email failed to send");
    if (q[0].lead_id) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${uid()}, ${q[0].lead_id}, 'quote',
          ${`Accept link sent for Option ${data.optionNumber} → ${email}`},
          ${me.id}, ${me.name}
        )
      `;
    }
    return { ok: true as const, link, email };
  });

export const getPublicQuoteAccept = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql<{
      id: string;
      payload: string;
      accept_option_invited: number | null;
      accepted_option: number | null;
      status: string;
      accepted_at: string | null;
      client_name: string;
    }>`
      select id, payload::text as payload, accept_option_invited, accepted_option, status,
             accepted_at::text as accepted_at, client_name
      from lease_quotes where accept_token = ${data.token} limit 1
    `;
    if (!rows[0]) throw new Error("This accept link is invalid or expired");
    let payload: { client: ClientQuoteInfo; options: LeaseOptionResult[] };
    try {
      payload = JSON.parse(rows[0].payload) as typeof payload;
    } catch {
      throw new Error("Quote could not be loaded");
    }
    const n = rows[0].accept_option_invited || rows[0].accepted_option || 1;
    const opt = payload.options[n - 1];
    if (!opt) throw new Error("Option missing on this quote");
    const already = rows[0].status === "accepted" && rows[0].accepted_option === n;
    return {
      quoteId: rows[0].id,
      optionNumber: n,
      alreadyAccepted: already,
      acceptedAt: rows[0].accepted_at,
      clientName: payload.client.clientName || rows[0].client_name,
      vehicle: vehicleLine(payload.client),
      stock: payload.client.stock || null,
      snapshot: optionSnapshot(opt, payload.client),
    };
  });

export const submitPublicQuoteAccept = createServerFn({ method: "POST" })
  .validator((data: { token: string; optionNumber: number }) => data)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql<{
      id: string;
      accept_option_invited: number | null;
      accepted_option: number | null;
      status: string;
    }>`
      select id, accept_option_invited, accepted_option, status
      from lease_quotes where accept_token = ${data.token} limit 1
    `;
    if (!rows[0]) throw new Error("This accept link is invalid or expired");
    const invited = rows[0].accept_option_invited || data.optionNumber;
    if (data.optionNumber !== invited) {
      throw new Error(`This link is only for Option ${invited}`);
    }
    const meta = requestMeta();
    const result = await applyAcceptedOption(sql, {
      quoteId: rows[0].id,
      optionNumber: data.optionNumber,
      actorName: "Lessee",
      actorId: null,
      byKind: "lessee",
      ip: meta.ip,
      ua: meta.ua,
    });
    return { ok: true as const, optionNumber: result.optionNumber };
  });
