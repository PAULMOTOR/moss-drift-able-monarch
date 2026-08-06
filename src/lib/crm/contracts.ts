/**
 * Post-approval lease contract generation + DocuSign send.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  buildFirstInvoiceHtml,
  buildLeaseContractDocument,
  CONTRACT_STYLE_META,
  defaultContractBody,
  taxRateForProvince,
  type ClientQuoteInfo,
  type ContractStyleKey,
  type LeaseOptionResult,
} from "./lease-quote";
import { makeContractPdfDataUrl } from "./contract-pdf";
import { docuSignStatus, sendLeaseContractEnvelope } from "./docusign";
import type { Profile } from "./types";

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
  const p = rows[0];
  if (!p || !p.active) throw new Error("No active CRM profile");
  return p;
}

function canGenerateContract(me: Profile) {
  return ["admin", "gsm", "rep", "credit_manager"].includes(me.role);
}

async function assertDealApproved(sql: Awaited<ReturnType<typeof getSql>>, leadId: string) {
  const rows = await sql<{ credit_status: string | null }>`
    select credit_status from leads where id = ${leadId} limit 1
  `;
  if (!rows[0]) throw new Error("Lead not found");
  const status = (rows[0].credit_status || "none").toLowerCase();
  if (status !== "approved") {
    throw new Error(
      "Lease contract unlocks only after GSM or Admin approves the deal (credit status: approved).",
    );
  }
}

async function loadAcceptedQuote(
  sql: Awaited<ReturnType<typeof getSql>>,
  leadId: string,
  quoteId?: string | null,
) {
  const rows = quoteId
    ? await sql<{
        id: string;
        lead_id: string | null;
        payload: string;
        accepted_option: number | null;
        client_name: string;
        contract_html: string | null;
        invoice_html: string | null;
        contract_pdf_name: string | null;
        contract_pdf_data: string | null;
        contract_style: string | null;
      }>`
        select id, lead_id, payload::text as payload, accepted_option, client_name,
               contract_html, invoice_html, contract_pdf_name, contract_pdf_data, contract_style
        from lease_quotes where id = ${quoteId} limit 1
      `
    : await sql<{
        id: string;
        lead_id: string | null;
        payload: string;
        accepted_option: number | null;
        client_name: string;
        contract_html: string | null;
        invoice_html: string | null;
        contract_pdf_name: string | null;
        contract_pdf_data: string | null;
        contract_style: string | null;
      }>`
        select id, lead_id, payload::text as payload, accepted_option, client_name,
               contract_html, invoice_html, contract_pdf_name, contract_pdf_data, contract_style
        from lease_quotes
        where lead_id = ${leadId}
        order by
          case when accepted_option is not null then 0 else 1 end,
          case when status = 'accepted' then 0 else 1 end,
          created_at desc
        limit 1
      `;
  const row = rows[0];
  if (!row) throw new Error("No lease quote found for this lead — create and accept a quote first");
  let payload: { client: ClientQuoteInfo; options: LeaseOptionResult[]; taxRate?: number };
  try {
    payload = JSON.parse(row.payload) as typeof payload;
  } catch {
    throw new Error("Corrupt quote payload");
  }
  const optionNumber = row.accepted_option || 1;
  const opt = payload.options[optionNumber - 1];
  if (!opt) throw new Error("Quote has no option to put on the contract — accept an option first");
  return { row, payload, optionNumber, opt };
}

/** Generate ENG (or selected style) lease contract after deal approval */
export const generateApprovedLeaseContract = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      quoteId?: string | null;
      optionNumber?: number | null;
      contractStyle?: string | null;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!canGenerateContract(me)) throw new Error("Not allowed to generate contracts");
    const sql = await getSql();
    await assertDealApproved(sql, data.leadId);

    const { row, payload, optionNumber: acceptedOpt, opt: acceptedOption } =
      await loadAcceptedQuote(sql, data.leadId, data.quoteId);
    const optionNumber = data.optionNumber || acceptedOpt;
    const opt = payload.options[optionNumber - 1] || acceptedOption;
    const taxRate =
      payload.taxRate || taxRateForProvince(payload.client.province || "QC");
    const style = (data.contractStyle ||
      payload.client.contractStyle ||
      "qc_individual_en") as ContractStyleKey;

    // Prefer live ENG spreadsheet-style body from code (ignore stale short DB templates)
    const tpl = await sql<{ body_html: string }>`
      select body_html from contract_templates where style_key = ${style} limit 1
    `;
    const templateBody = tpl[0]?.body_html || null;
    const contractHtml = buildLeaseContractDocument(
      payload.client,
      opt,
      taxRate,
      style,
      // Always use expanded ENG body from code for English styles unless admin customized (no placeholder note)
      style.includes("_fr") ? templateBody : null,
    );
    const invoiceHtml = buildFirstInvoiceHtml(payload.client, opt, taxRate);
    const { pdfName, pdfData } = await makeContractPdfDataUrl(payload.client, opt, taxRate);

    try {
      await sql`
        update lease_quotes set
          accepted_option = ${optionNumber},
          selected_option = ${optionNumber},
          status = 'accepted',
          contract_html = ${contractHtml},
          invoice_html = ${invoiceHtml},
          contract_pdf_name = ${pdfName},
          contract_pdf_data = ${pdfData},
          contract_style = ${style},
          contract_generated_at = now(),
          contract_generated_by = ${me.id},
          updated_at = now()
        where id = ${row.id}
      `;
    } catch {
      // Columns from 0011 not applied yet — store HTML only
      await sql`
        update lease_quotes set
          accepted_option = ${optionNumber},
          selected_option = ${optionNumber},
          status = 'accepted',
          contract_html = ${contractHtml},
          invoice_html = ${invoiceHtml},
          updated_at = now()
        where id = ${row.id}
      `;
    }
    try {
      await sql`
        update leads set
          accepted_quote_id = ${row.id},
          contract_status = 'ready',
          guarantor = ${payload.client.guarantor || null},
          updated_at = now()
        where id = ${data.leadId}
      `;
    } catch {
      await sql`
        update leads set
          accepted_quote_id = ${row.id},
          guarantor = ${payload.client.guarantor || null},
          updated_at = now()
        where id = ${data.leadId}
      `;
    }
    try {
      await sql`
        insert into lead_quote_files (
          id, lead_id, quote_id, option_number, file_name, file_data, mime_type, source, created_by
        ) values (
          ${uid()}, ${data.leadId}, ${row.id}, ${optionNumber},
          ${pdfName}, ${pdfData}, 'application/pdf', 'lease_contract', ${me.id}
        )
      `;
    } catch {
      /* non-fatal */
    }
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'contract',
        ${`Lease contract generated (${style}) · Option ${optionNumber} · by ${me.name}`},
        ${me.id}, ${me.name}
      )
    `;

    return {
      ok: true as const,
      quoteId: row.id,
      optionNumber,
      contractStyle: style,
      contractHtml,
      invoiceHtml,
      pdfName,
      pdfData,
    };
  });

export const getLeadContractPacket = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string }) => data)
  .handler(async ({ context, data }) => {
    await requireProfile(context.userId);
    const sql = await getSql();
    // Base lead fields (always present)
    const lead = await sql<{
      credit_status: string | null;
      accepted_quote_id: string | null;
      name: string;
      email: string | null;
      guarantor: string | null;
    }>`
      select credit_status, accepted_quote_id, name, email, guarantor
      from leads where id = ${data.leadId} limit 1
    `;
    if (!lead[0]) throw new Error("Lead not found");

    let contractStatus = "none";
    try {
      const cs = await sql<{ contract_status: string | null }>`
        select contract_status from leads where id = ${data.leadId} limit 1
      `;
      contractStatus = cs[0]?.contract_status || "none";
    } catch {
      contractStatus = "none";
    }

    let quote: {
      id: string;
      contract_html: string | null;
      invoice_html: string | null;
      contract_pdf_name: string | null;
      contract_pdf_data: string | null;
      contract_style: string | null;
      accepted_option: number | null;
      contract_generated_at: string | null;
    } | null = null;

    try {
      const q = lead[0].accepted_quote_id
        ? await sql<{
            id: string;
            contract_html: string | null;
            invoice_html: string | null;
            contract_pdf_name: string | null;
            contract_pdf_data: string | null;
            contract_style: string | null;
            accepted_option: number | null;
            contract_generated_at: string | null;
          }>`
            select id, contract_html, invoice_html,
                   contract_pdf_name, contract_pdf_data, contract_style, accepted_option,
                   contract_generated_at::text as contract_generated_at
            from lease_quotes where id = ${lead[0].accepted_quote_id} limit 1
          `
        : await sql<{
            id: string;
            contract_html: string | null;
            invoice_html: string | null;
            contract_pdf_name: string | null;
            contract_pdf_data: string | null;
            contract_style: string | null;
            accepted_option: number | null;
            contract_generated_at: string | null;
          }>`
            select id, contract_html, invoice_html,
                   contract_pdf_name, contract_pdf_data, contract_style, accepted_option,
                   contract_generated_at::text as contract_generated_at
            from lease_quotes where lead_id = ${data.leadId}
            order by created_at desc
            limit 1
          `;
      quote = q[0] || null;
    } catch {
      // Migration not applied yet — fall back to HTML-only columns
      try {
        const q = await sql<{
          id: string;
          contract_html: string | null;
          invoice_html: string | null;
          accepted_option: number | null;
        }>`
          select id, contract_html, invoice_html, accepted_option
          from lease_quotes
          where lead_id = ${data.leadId}
          order by created_at desc
          limit 1
        `;
        if (q[0]) {
          quote = {
            id: q[0].id,
            contract_html: q[0].contract_html,
            invoice_html: q[0].invoice_html,
            contract_pdf_name: null,
            contract_pdf_data: null,
            contract_style: null,
            accepted_option: q[0].accepted_option,
            contract_generated_at: null,
          };
        }
      } catch {
        quote = null;
      }
    }

    let envelopes: Array<{
      id: string;
      envelope_id: string | null;
      status: string;
      signer_email: string | null;
      idv_enabled: boolean;
      created_at: string;
      error: string | null;
    }> = [];
    try {
      envelopes = await sql`
        select id, envelope_id, status, signer_email, idv_enabled,
               created_at::text as created_at, error
        from contract_envelopes
        where lead_id = ${data.leadId}
        order by created_at desc
        limit 10
      `;
    } catch {
      envelopes = [];
    }

    return {
      creditStatus: lead[0].credit_status || "none",
      contractStatus,
      approved: (lead[0].credit_status || "").toLowerCase() === "approved",
      lesseeName: lead[0].name,
      lesseeEmail: lead[0].email,
      guarantor: lead[0].guarantor,
      quote,
      envelopes,
      docusign: docuSignStatus(),
      styles: CONTRACT_STYLE_META.map((s) => ({ key: s.key, label: s.label })),
    };
  });

export const sendContractDocuSign = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      leadId: string;
      signerEmail?: string;
      signerName?: string;
      guarantorEmail?: string | null;
      guarantorName?: string | null;
      requireIdv?: boolean;
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (!["admin", "gsm", "rep"].includes(me.role)) {
      throw new Error("Not allowed to send contracts for signature");
    }
    const sql = await getSql();
    await assertDealApproved(sql, data.leadId);
    const packet = await loadAcceptedQuote(sql, data.leadId, null);
    let pdfData = packet.row.contract_pdf_data;
    let pdfName = packet.row.contract_pdf_name || "Lease-Contract.pdf";
    if (!pdfData) {
      // auto-generate if missing
      const taxRate =
        packet.payload.taxRate ||
        taxRateForProvince(packet.payload.client.province || "QC");
      const style = (packet.row.contract_style ||
        packet.payload.client.contractStyle ||
        "qc_individual_en") as ContractStyleKey;
      const contractHtml = buildLeaseContractDocument(
        packet.payload.client,
        packet.opt,
        taxRate,
        style,
        null,
      );
      const made = await makeContractPdfDataUrl(
        packet.payload.client,
        packet.opt,
        taxRate,
      );
      pdfData = made.pdfData;
      pdfName = made.pdfName;
      await sql`
        update lease_quotes set
          contract_html = ${contractHtml},
          contract_pdf_name = ${pdfName},
          contract_pdf_data = ${pdfData},
          contract_style = ${style},
          contract_generated_at = now(),
          contract_generated_by = ${me.id},
          updated_at = now()
        where id = ${packet.row.id}
      `;
    }

    const signerEmail = (
      data.signerEmail ||
      packet.payload.client.email ||
      ""
    )
      .trim()
      .toLowerCase();
    const signerName = (data.signerName || packet.payload.client.clientName || "").trim();
    if (!signerEmail.includes("@")) {
      throw new Error("Lessee email is required to send for DocuSign");
    }
    if (!signerName) throw new Error("Lessee name is required");

    const vehicle = [
      packet.payload.client.year,
      packet.payload.client.make,
      packet.payload.client.model,
    ]
      .filter(Boolean)
      .join(" ");

    try {
      const result = await sendLeaseContractEnvelope({
        pdfBase64: pdfData,
        fileName: pdfName,
        emailSubject: `Paul Motor Leasing — Lease agreement ${vehicle}`.slice(0, 100),
        signerName,
        signerEmail,
        guarantorName: data.guarantorName || packet.payload.client.guarantor,
        guarantorEmail: data.guarantorEmail || null,
        requireIdv: data.requireIdv !== false,
      });
      await sql`
        insert into contract_envelopes (
          id, lead_id, quote_id, provider, envelope_id, status,
          signer_email, signer_name, guarantor_email, guarantor_name,
          idv_enabled, envelope_uri, created_by
        ) values (
          ${uid()}, ${data.leadId}, ${packet.row.id}, 'docusign', ${result.envelopeId},
          ${result.status || "sent"},
          ${signerEmail}, ${signerName},
          ${data.guarantorEmail || null}, ${data.guarantorName || null},
          ${result.idvEnabled}, ${result.uri}, ${me.id}
        )
      `;
      await sql`
        update leads set contract_status = 'sent_docusign', updated_at = now()
        where id = ${data.leadId}
      `;
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
        values (
          ${uid()}, ${data.leadId}, 'contract',
          ${`Contract sent via DocuSign to ${signerEmail}${result.idvEnabled ? " (Live ID)" : ""} · envelope ${result.envelopeId}`},
          ${me.id}, ${me.name}
        )
      `;
      return {
        ok: true as const,
        envelopeId: result.envelopeId,
        status: result.status,
        idvEnabled: result.idvEnabled,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sql`
        insert into contract_envelopes (
          id, lead_id, quote_id, provider, status, signer_email, signer_name,
          error, created_by
        ) values (
          ${uid()}, ${data.leadId}, ${packet.row.id}, 'docusign', 'error',
          ${signerEmail}, ${signerName}, ${msg.slice(0, 500)}, ${me.id}
        )
      `;
      throw e;
    }
  });

export const getDocuSignHealth = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireProfile(context.userId);
    return docuSignStatus();
  });

// keep defaultContractBody import used for typecheck of styles
void defaultContractBody;
