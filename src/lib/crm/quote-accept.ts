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
  resolveLeaseTaxRates,
  taxRateForProvince,
  wrapPrintable,
  type ClientQuoteInfo,
  type ContractStyleKey,
  type LeaseOptionResult,
} from "./lease-quote";
import { publicAppUrl } from "./public-url";
import { loadHeroShotForLead } from "./hero-shot";

function uid() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function appBaseUrl() {
  return publicAppUrl();
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

const PROVINCE_NAMES: Record<string, string> = {
  QC: "Quebec",
  ON: "Ontario",
  BC: "British Columbia",
  AB: "Alberta",
  MB: "Manitoba",
  SK: "Saskatchewan",
  NS: "Nova Scotia",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  PE: "Prince Edward Island",
  NT: "Northwest Territories",
  NU: "Nunavut",
  YT: "Yukon",
};

export function provinceTaxCopy(client: ClientQuoteInfo, opt: LeaseOptionResult): {
  province: string;
  provinceName: string;
  taxCaption: string;
} {
  const code = (client.province || "QC").trim().toUpperCase() || "QC";
  const rates = resolveLeaseTaxRates(code, opt.salePrice || opt.cost || 0, opt.pstRate);
  const name = PROVINCE_NAMES[rates.province] || rates.province;
  let taxCaption = `${(rates.combinedRate * 100).toFixed(rates.province === "QC" ? 3 : 0)}%`;
  if (rates.province === "QC") taxCaption = "GST 5% + QST 9.975%";
  else if (rates.province === "BC") {
    taxCaption = `GST 5% + PST ${(rates.pstRate * 100).toFixed(0)}%`;
  } else if (rates.pstRate > 0) {
    taxCaption = `GST ${(rates.gstRate * 100).toFixed(0)}% + PST ${(rates.pstRate * 100).toFixed(0)}%`;
  } else if (rates.combinedRate > 0.05) {
    taxCaption = `HST ${(rates.combinedRate * 100).toFixed(0)}%`;
  } else {
    taxCaption = `GST ${(rates.gstRate * 100).toFixed(0)}%`;
  }
  return { province: rates.province, provinceName: name, taxCaption };
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
  const heroDataUrl = await loadHeroShotForLead(sql, row.lead_id);
  const retailOne = buildRetailQuoteHtml(
    payload.client,
    payload.options.map((o, i) =>
      i === opts.optionNumber - 1
        ? o
        : { ...o, cost: 0, payment: 0, deposit: 0, securityDeposit: 0, residual: 0 },
    ),
    taxRate,
    { heroDataUrl },
  );
  const pdfName = `Accepted Option ${opts.optionNumber} — ${payload.client.clientName || "Client"}.pdf`;
  const { buildRetailQuotePdf, pdfDataUrl } = await import("./quote-pdf");
  const buf = await buildRetailQuotePdf(payload.client, payload.options, taxRate, {
    acceptedOption: opts.optionNumber,
    heroDataUrl,
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
        estimated_value = ${opt.salePrice},
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
    const askLink = `${link}?ask=1`;
    const safeFirst = escapeHtml(first);
    const safeVehicle = escapeHtml(vehicle);
    const safeMe = escapeHtml(me.name);
    const mail = await sendCrmEmail(sql, {
      to: email,
      subject: `Please accept your Paul Motor lease quote — Option ${data.optionNumber}`,
      kind: "quote_accept_request",
      leadId: q[0].lead_id,
      profileId: me.id,
      fromName: clientFacingFromName(me.name),
      replyTo: replyToForActor(me.email, me.name),
      text:
        `Hi ${first},\n\n` +
        `${referral.text ? referral.text + "\n\n" : ""}` +
        `Please review and accept your lease option:\n\n${summary}\n\n` +
        `Review Option ${data.optionNumber}:\n${link}\n\n` +
        `I still have questions:\n${askLink}\n\n` +
        `The page shows these numbers. You can accept there, or send us a question.\n\n` +
        `— ${me.name}\nPaul Motor Leasing`,
      html:
        `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5">` +
        `<p>Hi ${safeFirst},</p>${referral.html}` +
        `<p>Please review and accept your lease option:</p>` +
        `<table style="border-collapse:collapse;font-size:14px">` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Option</td><td><strong>${data.optionNumber}</strong> — ${safeVehicle}</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Term</td><td>${opt.termMonths} months</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Monthly</td><td><strong>${formatMoney(opt.totalPayment)}</strong> (taxes included)</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Cash down</td><td>${formatMoney(opt.deposit)}</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Security deposit</td><td>${formatMoney(opt.securityDeposit || 0)}</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#555">Rate</td><td>${opt.ratePct.toFixed(2)}%</td></tr>` +
        `</table>` +
        `<p><a href="${link}" style="display:inline-block;background:#008272;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:600">Review Option ${data.optionNumber}</a></p>` +
        `<p style="margin:8px 0 0"><a href="${askLink}" style="color:#008272;font-size:14px;font-weight:600;text-decoration:underline">I still have questions</a></p>` +
        `<p style="font-size:13px;color:#555">Opens a secure page to review this option. You can accept there, or send us a question.</p>` +
        `<p>— ${safeMe}<br/>Paul Motor Leasing</p></div>`,
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
      lead_id: string | null;
      payload: string;
      accept_option_invited: number | null;
      accepted_option: number | null;
      status: string;
      accepted_at: string | null;
      client_name: string;
    }>`
      select id, lead_id, payload::text as payload, accept_option_invited, accepted_option, status,
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
    const tax = provinceTaxCopy(payload.client, opt);
    const heroImage = rows[0].lead_id
      ? await loadHeroShotForLead(sql, rows[0].lead_id)
      : null;
    return {
      quoteId: rows[0].id,
      optionNumber: n,
      alreadyAccepted: already,
      acceptedAt: rows[0].accepted_at,
      clientName: payload.client.clientName || rows[0].client_name,
      vehicle: vehicleLine(payload.client),
      stock: payload.client.stock || null,
      snapshot: optionSnapshot(opt, payload.client),
      province: tax.province,
      provinceName: tax.provinceName,
      taxCaption: tax.taxCaption,
      heroImage,
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

export const submitPublicQuoteQuestion = createServerFn({ method: "POST" })
  .validator((data: { token: string; question: string }) => data)
  .handler(async ({ data }) => {
    const question = data.question.replace(/\r\n/g, "\n").trim();
    if (question.length < 4) throw new Error("Please type your question first");
    if (question.length > 4000) throw new Error("Please keep the question under 4,000 characters");

    const sql = await getSql();
    const rows = await sql<{
      id: string;
      lead_id: string | null;
      payload: string;
      accept_option_invited: number | null;
      accepted_option: number | null;
      created_by: string | null;
      client_name: string;
    }>`
      select id, lead_id, payload::text as payload, accept_option_invited, accepted_option,
             created_by, client_name
      from lease_quotes where accept_token = ${data.token} limit 1
    `;
    if (!rows[0]) throw new Error("This link is invalid or expired");
    const quote = rows[0];
    if (!quote.lead_id) throw new Error("This quote is not linked to a deal");

    const recent = await sql<{ created_at: string }>`
      select created_at::text as created_at from lead_activities
      where lead_id = ${quote.lead_id}
        and kind = 'note'
        and body like 'Lessee question%'
      order by created_at desc
      limit 1
    `;
    if (recent[0]) {
      const age = Date.now() - new Date(recent[0].created_at).getTime();
      if (Number.isFinite(age) && age < 20_000) {
        throw new Error("Please wait a moment before sending another question");
      }
    }

    let payload: { client: ClientQuoteInfo; options: LeaseOptionResult[] };
    try {
      payload = JSON.parse(quote.payload) as typeof payload;
    } catch {
      payload = { client: { clientName: quote.client_name } as ClientQuoteInfo, options: [] };
    }
    const n = quote.accept_option_invited || quote.accepted_option || 1;
    const vehicle = vehicleLine(payload.client);
    const clientName = payload.client.clientName || quote.client_name || "Lessee";
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const noteBody =
      `Lessee question on Option ${n}${vehicle ? ` — ${vehicle}` : ""} (${stamp} UTC):\n\n` +
      question;

    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${quote.lead_id}, 'note',
        ${noteBody},
        null, ${clientName.slice(0, 80)}
      )
    `;
    await sql`
      update leads set
        notes = case
          when notes is null or btrim(notes) = '' then ${noteBody}
          else notes || ${"\n\n" + noteBody}
        end,
        updated_at = now()
      where id = ${quote.lead_id}
    `;

    const lead = await sql<{
      assigned_to: string | null;
      email: string | null;
      name: string;
    }>`
      select assigned_to, email, name from leads where id = ${quote.lead_id} limit 1
    `;
    const clientEmail = (
      payload.client.email ||
      lead[0]?.email ||
      ""
    )
      .trim()
      .toLowerCase();
    const assignedId = lead[0]?.assigned_to || quote.created_by || null;
    const recipients: Array<{ email: string; name: string; role: string; profileId: string | null }> = [];
    const seen = new Set<string>();

    async function addRecipient(
      email: string | null | undefined,
      name: string,
      role: string,
      profileId: string | null,
    ) {
      const addr = (email || "").trim().toLowerCase();
      if (!addr.includes("@") || seen.has(addr)) return;
      seen.add(addr);
      recipients.push({ email: addr, name, role, profileId });
    }

    if (assignedId) {
      const p = await sql<{ id: string; name: string; email: string }>`
        select id, name, email from profiles where id = ${assignedId} and active = true limit 1
      `;
      if (p[0]) await addRecipient(p[0].email, p[0].name, "rep", p[0].id);
    }
    const partner = await fetchPartnerForLead(sql, quote.lead_id);
    if (partner?.kind === "broker") {
      await addRecipient(partner.email, partner.name, "broker", null);
    }

    const crmLink = `${appBaseUrl()}/leads/${quote.lead_id}`;
    const sentTo = recipients.map((r) => `${r.name} (${r.role})`).join(", ");
    if (sentTo) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by_name)
        values (
          ${uid()}, ${quote.lead_id}, 'email',
          ${`Lessee question emailed to ${sentTo}`},
          ${"CRM"}
        )
      `;
    }

    const safeQ = escapeHtml(question).replace(/\n/g, "<br/>");
    const safeClient = escapeHtml(clientName);
    const safeVehicle = escapeHtml(vehicle || "Vehicle");
    const replyTo = clientEmail.includes("@") ? clientEmail : undefined;

    for (const rec of recipients) {
      const greeting = rec.name.split(" ")[0] || rec.name;
      const who =
        rec.role === "broker"
          ? `Your client ${clientName} sent a question on their Paul Motor lease option.`
          : `${clientName} sent a question on their lease option.`;
      await sendCrmEmail(sql, {
        to: rec.email,
        subject: `Question from ${clientName} — Option ${n} · ${vehicle || "lease quote"}`,
        kind: "quote_lessee_question",
        leadId: quote.lead_id,
        profileId: rec.profileId,
        fromName: "Paul Motor Leasing",
        replyTo,
        text:
          `Hi ${greeting},\n\n${who}\n\n` +
          `Option ${n} — ${vehicle}\n\n` +
          `${question}\n\n` +
          `Deal: ${crmLink}\n` +
          (replyTo ? `Reply to this email to reach ${clientName} at ${replyTo}.\n` : "") +
          `\n— Paul Motor Leasing CRM`,
        html:
          `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5">` +
          `<p>Hi ${escapeHtml(greeting)},</p>` +
          `<p>${escapeHtml(who)}</p>` +
          `<p style="color:#555;font-size:14px">Option ${n} — ${safeVehicle}</p>` +
          `<blockquote style="margin:12px 0;padding:12px 14px;background:#f4f1ea;border-left:3px solid #008272">${safeQ}</blockquote>` +
          `<p><a href="${crmLink}" style="color:#008272;font-weight:600">Open the deal in CRM</a></p>` +
          (replyTo
            ? `<p style="font-size:13px;color:#555">Reply to this email to reach ${safeClient} at ${escapeHtml(replyTo)}.</p>`
            : "") +
          `<p>— Paul Motor Leasing CRM</p></div>`,
      });
    }

    return { ok: true as const };
  });
