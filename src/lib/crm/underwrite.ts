/**
 * GSM / Admin AI underwrite — policy engine + Grok (xAI).
 * Never auto-approves. Key lives in Vercel as XAI_API_KEY.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { calcLeaseOption, type ClientQuoteInfo, type LeaseOptionInput } from "./lease-quote";
import {
  runUnderwritePolicy,
  type CitizenshipStatus,
  type PolicyResult,
  type UnderwriteInputs,
} from "./underwrite-policy";
import { VEHICLE_CHECKLIST, CUSTOMER_CHECKLIST, type Profile } from "./types";

function uid() {
  return crypto.randomUUID();
}

const DEFAULT_PRIME = 4.95;
const SENSITIVE_KEYS = /^(sin|ssn|social|credit_card|password)$/i;

export type UnderwriteRecommendation =
  | "approve"
  | "approve_with_conditions"
  | "send_back"
  | "decline";

export type UnderwriteReport = {
  id: string;
  lead_id: string;
  recommendation: UnderwriteRecommendation;
  summary: string;
  conditions: string[];
  red_flags: string[];
  policy: PolicyResult;
  inputs: UnderwriteInputs & { reviewerNotes: string };
  model: string | null;
  ran_by_name: string | null;
  created_at: string;
};

export type UnderwriteOverrides = {
  creditScore?: number | null;
  citizenship?: CitizenshipStatus;
  marketValue?: number | null;
  carfaxClaim?: number | null;
  reviewerNotes?: string;
};

async function requireProfile(userId: string): Promise<Profile> {
  const sql = await getSql();
  const rows = await sql<Profile>`
    select id, user_id, email, name, role, active, phone, title,
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
    from profiles where user_id = ${userId} limit 1
  `;
  const p = rows[0];
  if (!p || !p.active) throw new Error("No active CRM profile");
  return p;
}

export async function readBocPrime(sql: Awaited<ReturnType<typeof getSql>>): Promise<number> {
  const rows = await sql<{ value: string }>`
    select value from crm_settings where key = 'boc_prime_rate' limit 1
  `;
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) && n > 0 && n < 30 ? n : DEFAULT_PRIME;
}

function redactPayload(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = v?.trim() ? "[provided — redacted]" : "";
      continue;
    }
    out[k] = String(v ?? "").slice(0, 400);
  }
  return out;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function guessCitizenship(payload: Record<string, string>, visaNotes: string): CitizenshipStatus {
  const blob = `${payload.status || ""} ${payload.citizenship || ""} ${payload.visa || ""} ${visaNotes}`.toLowerCase();
  if (/citizen|citoyen/.test(blob) && !/not a citizen|non-?citizen/.test(blob)) return "canadian_citizen";
  if (/\bpr\b|permanent resident|résident permanent/.test(blob)) return "permanent_resident";
  if (/work permit|work visa|pgwp/.test(blob)) return "work_permit";
  if (/student|study permit/.test(blob)) return "student";
  if (blob.trim()) return "other";
  return "unknown";
}

function quoteFromPayload(payload: unknown, acceptedOption: number | null): {
  metrics: {
    salePrice: number;
    pad: number;
    financed: number;
    cashDown: number;
    yieldPct: number;
    ratePct: number;
    termMonths: number;
    residual: number;
    payment: number;
    vehicleYear: number | null;
    vehicle: string;
    vin: string;
    province: string;
  } | null;
} {
  if (!payload || typeof payload !== "object") return { metrics: null };
  const p = payload as { client?: Partial<ClientQuoteInfo>; options?: LeaseOptionInput[] };
  const client = p.client || {};
  const opts = Array.isArray(p.options) ? p.options : [];
  const idx = Math.max(0, (acceptedOption || 1) - 1);
  const input = opts[idx] || opts.find((o) => (o?.cost || 0) > 0);
  if (!input) return { metrics: null };
  const fees = {
    admin: client.adminFee || 0,
    tracker: client.trackerFee || 0,
    lienPpsa: client.lienPpsa || 0,
    license: client.license || 0,
    tireTax: client.tireTax || 0,
  };
  const o = calcLeaseOption(input, client.province || "QC", fees, {
    startDate: client.startDate || new Date().toISOString().slice(0, 10),
    daysLeftOverride: client.daysLeftOverride,
  }, undefined, {
    partyType: client.partyType,
    tradeKind: client.tradeKind === "leased" ? "leased" : "financed",
  });
  return {
    metrics: {
      salePrice: o.salePrice,
      pad: o.profit,
      financed: o.financed,
      cashDown: o.deposit,
      yieldPct: o.yieldPct,
      ratePct: o.ratePct,
      termMonths: o.termMonths,
      residual: o.residual,
      payment: o.totalPayment,
      vehicleYear: client.year ?? null,
      vehicle: [client.year, client.make, client.model, client.trim].filter(Boolean).join(" "),
      vin: client.vin || "",
      province: (client.province || "QC").toUpperCase(),
    },
  };
}

function mergeRecommendation(
  policy: PolicyResult,
  ai: UnderwriteRecommendation,
): UnderwriteRecommendation {
  if (ai === "decline") return "decline";
  if (policy.blockPlainApprove && ai === "approve") return "approve_with_conditions";
  return ai;
}

async function callGrok(
  prompt: string,
  attachments: Array<{ name: string; mime: string; dataUrl: string }>,
): Promise<{ text: string; model: string; filesSent: string[] }> {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new Error("XAI_API_KEY is not set. Add it in Vercel, then Redeploy.");
  }
  const models = uniqueModels([process.env.XAI_MODEL?.trim(), "grok-4.6", "grok-4"]);
  const uploaded: string[] = [];
  const filesSent: string[] = [];
  try {
    const fileParts: Array<{ type: "input_file"; file_id: string }> = [];
    const imageParts: Array<{ type: "input_image"; image_url: string }> = [];
    const uploadOne = async (f: (typeof attachments)[number]) => {
      const parsed = parseDataUrl(f.dataUrl);
      if (!parsed) {
        filesSent.push(`${f.name} (skipped — unreadable)`);
        return;
      }
      if (parsed.buf.length > 8 * 1024 * 1024) {
        filesSent.push(`${f.name} (skipped — over 8MB)`);
        return;
      }
      const mime = (parsed.mime || "").toLowerCase();
      const isImage = /^image\/(jpeg|jpg|png|gif|webp)$/i.test(mime);
      if (isImage && parsed.buf.length < 4 * 1024 * 1024) {
        imageParts.push({
          type: "input_image",
          image_url: `data:${parsed.mime};base64,${parsed.buf.toString("base64")}`,
        });
        filesSent.push(f.name);
        return;
      }
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(parsed.buf)], { type: parsed.mime || "application/pdf" }),
        safeFileName(f.name, mime),
      );
      form.append("purpose", "assistants");
      const up = await fetch("https://api.x.ai/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
      const upText = await up.text();
      if (!up.ok) {
        filesSent.push(`${f.name} (upload failed)`);
        return;
      }
      let id = "";
      try {
        id = String((JSON.parse(upText) as { id?: string }).id || "");
      } catch {
        id = "";
      }
      if (!id) {
        filesSent.push(`${f.name} (no file id)`);
        return;
      }
      uploaded.push(id);
      fileParts.push({ type: "input_file", file_id: id });
      filesSent.push(f.name);
    };
    await Promise.all(
      attachments.slice(0, 8).map((f) =>
        uploadOne(f).catch(() => {
          filesSent.push(`${f.name} (upload error)`);
        }),
      ),
    );

    const system =
      "You are the second-look credit underwriter for Paul Motor Leasing (Montreal). " +
      "Open and read every attached document (Equifax, Carfax, IDs, bank statements, NOAs, listing photos). " +
      "If the deal has guarantors, read each party's file and cite them separately. " +
      "Extract score, claims, names, DOB, address, citizenship/visa. You never approve a deal yourself. " +
      "Conservative: large cash down to mitigate; decline anyone shady or criminal. Reply with JSON only.";

    const model = models[0] || "grok-4.6";
    const fullContent: Array<Record<string, unknown>> = [
      { type: "input_text", text: prompt },
      ...fileParts,
      ...imageParts,
    ];
    const compactContent: Array<Record<string, unknown>> = [
      { type: "input_text", text: prompt },
      ...fileParts.slice(0, 4),
      ...imageParts.slice(0, 3),
    ];

    const ask = async (content: Array<Record<string, unknown>>, ms: number) => {
      let resIn: Response;
      try {
        resIn = await fetch("https://api.x.ai/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            instructions: system,
            input: [{ role: "user", content }],
          }),
          signal: AbortSignal.timeout(ms),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          /abort|timeout/i.test(msg)
            ? "Grok timed out reading the documents. Try again."
            : msg,
        );
      }
      const resBody = await resIn.text();
      if (resIn.ok) {
        const text = extractResponseText(resBody);
        if (text) return text;
        throw new Error(`Grok returned no readable text (${summarizeResponse(resBody)})`);
      }
      throw new Error(`Grok ${model} ${resIn.status}: ${resBody.slice(0, 240)}`);
    };

    try {
      const text = await ask(fullContent, 80_000);
      return { text, model, filesSent };
    } catch (first) {
      const firstMsg = first instanceof Error ? first.message : String(first);
      if (/ 400[:\s]/.test(firstMsg) && fileParts.length + imageParts.length > 4) {
        const text = await ask(compactContent, 60_000);
        return { text, model, filesSent };
      }
      throw new Error(firstMsg);
    }
  } finally {
    await Promise.all(
      uploaded.map((id) =>
        fetch(`https://api.x.ai/v1/files/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${key}` },
        }).catch(() => null),
      ),
    );
  }
}

function parseDataUrl(s: string): { mime: string; buf: Buffer } | null {
  const m = String(s || "").match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  try {
    const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
    if (!buf.length) return null;
    return { mime, buf };
  } catch {
    return null;
  }
}

function extractResponseText(body: string): string {
  try {
    const json = JSON.parse(body) as {
      output_text?: string;
      output?: Array<{
        type?: string;
        text?: string;
        content?: Array<{ text?: string; type?: string; output_text?: string }>;
      }>;
    };
    if (json.output_text?.trim()) return json.output_text.trim();
    const parts: string[] = [];
    for (const item of json.output || []) {
      if (typeof item.text === "string" && item.text.trim()) parts.push(item.text);
      for (const c of item.content || []) {
        if (c.text) parts.push(c.text);
        if (c.output_text) parts.push(c.output_text);
      }
    }
    return parts.join("\n").trim();
  } catch {
    return "";
  }
}


function summarizeResponse(body: string): string {
  try {
    const json = JSON.parse(body) as {
      status?: string;
      output?: Array<{ type?: string }>;
    };
    const types = (json.output || []).map((o) => o.type || "?").join(",") || "none";
    return `status=${json.status || "ok"} output=${types}`;
  } catch {
    return body.slice(0, 120);
  }
}

function uniqueModels(names: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function safeFileName(name: string, mime: string): string {
  const cleaned = String(name || "document")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  const base = cleaned || "document";
  if (/\.(pdf|txt|csv|json|md|png|jpe?g|webp|gif)$/i.test(base)) return base;
  if (mime.includes("pdf")) return `${base}.pdf`;
  if (mime.startsWith("image/")) return `${base}.jpg`;
  if (mime.startsWith("text/")) return `${base}.txt`;
  return `${base}.pdf`;
}

function parseAiJson(text: string): {
  recommendation: UnderwriteRecommendation;
  summary: string;
  conditions: string[];
  red_flags: string[];
  id_consistency: string;
  suggested_cash_down: number | null;
  credit_score: number | null;
  citizenship: CitizenshipStatus | null;
  market_value: number | null;
  carfax_claim: number | null;
} {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(slice) as Record<string, unknown>;
  } catch {
    obj = { summary: text.slice(0, 1200), recommendation: "send_back" };
  }
  const recRaw = String(obj.recommendation || "send_back").toLowerCase();
  const recommendation: UnderwriteRecommendation =
    recRaw === "approve" || recRaw === "approve_with_conditions" || recRaw === "decline"
      ? recRaw
      : "send_back";
  const conditions = Array.isArray(obj.conditions)
    ? obj.conditions.map((c) => String(c).slice(0, 300)).filter(Boolean)
    : [];
  const red_flags = Array.isArray(obj.red_flags)
    ? obj.red_flags.map((c) => String(c).slice(0, 300)).filter(Boolean)
    : [];
  return {
    recommendation,
    summary: String(obj.summary || text).slice(0, 2500),
    conditions,
    red_flags,
    id_consistency: String(obj.id_consistency || "").slice(0, 500),
    suggested_cash_down: num(obj.suggested_cash_down),
    credit_score: num(obj.credit_score),
    citizenship: parseCitizenship(obj.citizenship),
    market_value: num(obj.market_value),
    carfax_claim: num(obj.carfax_claim),
  };
}

function parseCitizenship(v: unknown): CitizenshipStatus | null {
  const s = String(v || "").toLowerCase().replace(/\s+/g, "_");
  if (s === "canadian_citizen" || s === "citizen") return "canadian_citizen";
  if (s === "permanent_resident" || s === "pr") return "permanent_resident";
  if (s === "work_permit" || s === "work") return "work_permit";
  if (s === "student" || s === "study_permit") return "student";
  if (s === "other") return "other";
  if (s === "unknown") return "unknown";
  return null;
}

export const getBocPrime = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const sql = await getSql();
    const prime = await readBocPrime(sql);
    return { prime };
  });

export const setBocPrime = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { prime: number }) => data)
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (me.role !== "admin") throw new Error("Only Admin can set Bank of Canada prime");
    const prime = Number(data.prime);
    if (!Number.isFinite(prime) || prime <= 0 || prime >= 30) {
      throw new Error("Prime must be a percent between 0 and 30");
    }
    const sql = await getSql();
    const v = prime.toFixed(2);
    await sql`
      insert into crm_settings (key, value, updated_at)
      values ('boc_prime_rate', ${v}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
    return { prime };
  });

export const listUnderwriteReports = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string }) => data)
  .handler(async ({ context, data }): Promise<UnderwriteReport[]> => {
    const me = await requireProfile(context.userId);
    if (!["admin", "gsm", "credit_manager"].includes(me.role)) {
      throw new Error("Not allowed");
    }
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select id, lead_id, recommendation, summary, conditions_json, red_flags_json,
              policy_json, inputs_json, model, ran_by_name, created_at::text as created_at
       from underwrite_reports where lead_id = $1
       order by created_at desc limit 8`,
      [data.leadId],
    );
    return rows.map(mapReport);
  });

export const runAiUnderwrite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { leadId: string } & UnderwriteOverrides) => data)
  .handler(async ({ context, data }): Promise<UnderwriteReport> => {
    const me = await requireProfile(context.userId);
    if (!["admin", "gsm"].includes(me.role)) {
      throw new Error("Only GSM or Admin can run AI underwrite");
    }
    const sql = await getSql();
    const leadRows = await sql.query<Record<string, unknown>>(
      `select l.id, l.name, l.email, l.phone, l.first_name, l.last_name, l.party_type,
              l.vehicle_interest, l.legal_entity_name, l.credit_status, l.notes,
              l.accepted_quote_id
       from leads l where l.id = $1 limit 1`,
      [data.leadId],
    );
    const lead = leadRows[0];
    if (!lead) throw new Error("Lead not found");

    const apps = await sql.query<Record<string, unknown>>(
      `select id, lead_id, status, party_type, payload, applicant_role, guarantor_slot,
              applicant_name, applicant_email, applicant_phone, app_email,
              do_not_pull_credit, equifax_notes, equifax_file_name, equifax_file_data
       from credit_applications where lead_id = $1
       order by case when coalesce(applicant_role,'primary') = 'primary' then 0 else 1 end,
                guarantor_slot nulls last, created_at`,
      [data.leadId],
    );
    const app =
      apps.find((a) => String(a.applicant_role || "primary") === "primary") || apps[0];

    function payloadOf(row: Record<string, unknown> | undefined): Record<string, string> {
      if (!row?.payload) return {};
      const raw = row.payload;
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw) as Record<string, string>;
        } catch {
          return {};
        }
      }
      if (typeof raw === "object") return raw as Record<string, string>;
      return {};
    }

    const payload = payloadOf(app);

    const checklist = await sql.query<{
      application_id: string;
      section: string;
      item_key: string;
      label: string;
      notes: string;
      done: boolean;
    }>(
      `select application_id, section, item_key, label, notes, done from credit_checklist
       where application_id in (select id from credit_applications where lead_id = $1)`,
      [data.leadId],
    );
    const docMeta = await sql.query<{
      id: string;
      application_id: string | null;
      kind: string;
      file_name: string;
      mime_type: string | null;
    }>(
      `select id, application_id, kind, file_name, mime_type
       from credit_documents where lead_id = $1 and file_data is not null`,
      [data.leadId],
    );
    const rankedMeta = [...docMeta].sort((a, b) => {
      const rank = (kind: string) => {
        const k = (kind || "").toLowerCase();
        if (k.includes("equifax")) return 1;
        if (k.includes("carfax")) return 2;
        if (k.includes("id") || k === "ids_verified") return 3;
        if (k.includes("visa") || k === "status_visa") return 4;
        if (k.includes("bank") || k.includes("noa")) return 5;
        return 8;
      };
      return rank(a.kind) - rank(b.kind);
    });
    const keepIds = rankedMeta.slice(0, 8).map((d) => d.id);
    const docs = keepIds.length
      ? await sql.query<{
          id: string;
          application_id: string | null;
          kind: string;
          file_name: string;
          mime_type: string | null;
          file_data: string | null;
        }>(
          `select id, application_id, kind, file_name, mime_type, file_data
           from credit_documents where id = any($1::text[])`,
          [keepIds],
        )
      : [];

    const quotes = await sql.query<{
      payload: unknown;
      accepted_option: number | null;
      selected_option: number | null;
      status: string;
    }>(
      `select payload, accepted_option, selected_option, status
       from lease_quotes where lead_id = $1
       order by case when status = 'accepted' then 0 else 1 end, updated_at desc
       limit 1`,
      [data.leadId],
    );
    const q = quotes[0];
    const quote = quoteFromPayload(q?.payload, q?.accepted_option || q?.selected_option || 1);

    const visaNotes = checklist
      .filter((c) => c.item_key === "status_visa")
      .map((c) => c.notes)
      .filter(Boolean)
      .join(" | ");
    const equifaxNotes = [
      ...apps.map((a) => String(a.equifax_notes || "")),
      ...checklist.filter((c) => c.item_key === "equifax").map((c) => c.notes),
    ]
      .filter(Boolean)
      .join(" ");
    const kycNotes = checklist
      .filter((c) => c.item_key === "kyc")
      .map((c) => c.notes)
      .filter(Boolean)
      .join(" | ");
    const carfaxNotes = checklist
      .filter((c) => c.item_key === "carfax_lien")
      .map((c) => c.notes)
      .filter(Boolean)
      .join(" | ");

    const partyName = (row: Record<string, unknown>) => {
      const role = String(row.applicant_role || "primary");
      const slot = row.guarantor_slot != null ? ` ${row.guarantor_slot}` : "";
      return `${role}${slot}`.replace(/\s+/g, " ").trim();
    };

    const attachments: Array<{ name: string; mime: string; dataUrl: string; rank: number }> = [];
    for (const a of apps) {
      if (!a.equifax_file_data) continue;
      attachments.push({
        name: `${partyName(a)}-Equifax-${String(a.equifax_file_name || "Equifax.pdf")}`,
        mime: "application/pdf",
        dataUrl: String(a.equifax_file_data),
        rank: 0,
      });
    }
    for (const d of docs) {
      if (!d.file_data) continue;
      const kind = (d.kind || "").toLowerCase();
      const owner = apps.find((a) => String(a.id) === String(d.application_id));
      const prefix = owner ? `${partyName(owner)}-` : "";
      const rank =
        kind.includes("equifax") ? 1 :
        kind.includes("carfax") ? 2 :
        kind.includes("id") || kind === "ids_verified" ? 3 :
        kind.includes("visa") || kind === "status_visa" ? 4 :
        kind.includes("bank") || kind.includes("noa") ? 5 :
        8;
      attachments.push({
        name: `${prefix}${d.kind || "doc"}-${d.file_name}`,
        mime: d.mime_type || "application/octet-stream",
        dataUrl: d.file_data,
        rank,
      });
    }
    attachments.sort((a, b) => a.rank - b.rank);

    const prime = await readBocPrime(sql);
    const partyBlocks = apps.map((row) => {
      const role = String(row.applicant_role || "primary");
      const slot = row.guarantor_slot != null ? Number(row.guarantor_slot) : null;
      const checks = checklist
        .filter((c) => String(c.application_id) === String(row.id))
        .map((c) => `${c.done ? "[x]" : "[ ]"} ${c.label}${c.notes ? ` — ${c.notes}` : ""}`);
      return {
        role,
        slot,
        name: String(row.applicant_name || (role === "primary" ? lead.name : "Unnamed")),
        email: String(row.applicant_email || row.app_email || ""),
        phone: String(row.applicant_phone || ""),
        status: String(row.status || ""),
        do_not_pull_credit: Boolean(row.do_not_pull_credit),
        application: redactPayload(payloadOf(row)),
        checklist: checks,
      };
    });
    const primaryChecks = checklist.filter((c) => String(c.application_id) === String(app?.id || ""));
    const checkLines = [...VEHICLE_CHECKLIST, ...CUSTOMER_CHECKLIST].map((def) => {
      const row = primaryChecks.find((c) => c.item_key === def.key);
      return `${row?.done ? "[x]" : "[ ]"} ${def.label}${row?.notes ? ` — ${row.notes}` : ""}`;
    });

    const prompt = `Paul Motor lease file — open EVERY attached file (Equifax, Carfax, IDs, statements) and produce a second underwrite of the COMPLETE deal (primary + every guarantor).

QUOTE / STRUCTURE:
${JSON.stringify(quote.metrics, null, 2)}

PRIME (Bank of Canada): ${prime}%
HARD RULES you must apply after reading the docs:
- Yield floor when non-citizen OR Equifax score < 690 OR car > 8 years: prime + 4% = ${(prime + 4).toFixed(2)}%
- Carfax haircut = 20% of the largest claim on the Carfax (e.g. $25,000 claim → $5,000 off market). Compare sale price to adjusted market.
- Pad is internal cap-cost only — not part of the sale price the client sees.
- Mitigate weak-but-real files with a large cash down. Decline shady / criminal / identity-inconsistent files.
- This file may include up to 2 guarantors. Analyze every party's IDs, Equifax, and application. A weak guarantor does not automatically decline a strong primary; identity fraud, criminal flags, or inconsistent IDs on ANY party are material.

LEAD (deal / primary borrower):
${JSON.stringify(
  {
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    party: lead.party_type,
    company: lead.legal_entity_name,
    vehicle_interest: lead.vehicle_interest,
    credit_status: lead.credit_status,
  },
  null,
  2,
)}

PARTIES (${partyBlocks.length} on this deal — analyze EVERYONE, not just the primary):
${JSON.stringify(partyBlocks, null, 2)}

PRIMARY CHECKLIST:
${checkLines.join("\n")}

ATTACHED FILES (you must read these, not just the names):
${attachments.map((d) => `- ${d.name}`).join("\n") || "(none on file)"}

EQUIFAX STAFF NOTES: ${equifaxNotes.slice(0, 800) || "(none)"}
KYC STAFF NOTES: ${kycNotes.slice(0, 800) || "(none — treat as incomplete)"}
CARFAX STAFF NOTES: ${carfaxNotes.slice(0, 400) || "(none)"}
VISA / STATUS NOTES: ${visaNotes.slice(0, 400) || "(none)"}
DO NOT PULL CREDIT: ${Boolean(app?.do_not_pull_credit)}

Return JSON only:
{
  "recommendation": "approve" | "approve_with_conditions" | "send_back" | "decline",
  "summary": "8-14 sentences for the GSM, citing what you saw on Equifax and Carfax for the primary AND each guarantor",
  "conditions": ["concrete next items"],
  "red_flags": ["short bullets"],
  "id_consistency": "IDs vs credit app vs Equifax for every party — one paragraph",
  "suggested_cash_down": number or null,
  "credit_score": number or null,
  "citizenship": "canadian_citizen" | "permanent_resident" | "work_permit" | "student" | "other" | "unknown",
  "market_value": number or null,
  "carfax_claim": number or null
}`;

    const grok = await callGrok(prompt, attachments.slice(0, 8));
    const ai = parseAiJson(grok.text);

    const citizenship =
      ai.citizenship ||
      data.citizenship ||
      guessCitizenship(payload, visaNotes);
    const creditScore =
      ai.credit_score ??
      data.creditScore ??
      num(payload.credit_score) ??
      num(equifaxNotes.match(/score[:\s]+(\d{3})/i)?.[1]);
    const marketValue = ai.market_value ?? data.marketValue ?? num(payload.market_value);
    const carfaxClaim =
      ai.carfax_claim ??
      data.carfaxClaim ??
      num(carfaxNotes.match(/claim[:\s$]+([\d,]+)/i)?.[1]);

    const policyInput: UnderwriteInputs = {
      yieldPct: quote.metrics?.yieldPct ?? null,
      primeRate: prime,
      creditScore,
      citizenship,
      vehicleYear: quote.metrics?.vehicleYear ?? null,
      salePrice: quote.metrics?.salePrice ?? null,
      marketValue,
      carfaxClaim,
      cashDown: quote.metrics?.cashDown ?? null,
      financed: quote.metrics?.financed ?? null,
    };
    const policy = runUnderwritePolicy(policyInput);
    const recommendation = mergeRecommendation(policy, ai.recommendation);
    const conditions = [...ai.conditions];
    if (policy.blockPlainApprove && recommendation === "approve") {
      conditions.unshift("Policy block: cannot plain-approve until yield / price / score flags clear.");
    }
    if (policy.suggestedCashDown && !conditions.some((c) => /cash down|down payment/i.test(c))) {
      conditions.push(
        `Consider cash down around ${policy.suggestedCashDown.toLocaleString("en-CA")} CAD to mitigate.`,
      );
    }
    if (ai.id_consistency) {
      conditions.push(`ID / data consistency: ${ai.id_consistency}`);
    }
    if (grok.filesSent.length) {
      conditions.push(`Documents read: ${grok.filesSent.join(", ")}`);
    }

    const inputsSnap: UnderwriteReport["inputs"] = {
      ...policyInput,
      reviewerNotes: data.reviewerNotes || "",
    };

    const id = uid();
    await sql`
      insert into underwrite_reports (
        id, lead_id, application_id, ran_by, ran_by_name,
        recommendation, summary, conditions_json, red_flags_json,
        policy_json, inputs_json, model
      ) values (
        ${id}, ${data.leadId}, ${app?.id ? String(app.id) : null}, ${me.id}, ${me.name},
        ${recommendation}, ${ai.summary},
        ${JSON.stringify(conditions)}, ${JSON.stringify(ai.red_flags)},
        ${JSON.stringify(policy)}, ${JSON.stringify(inputsSnap)}, ${grok.model}
      )
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by, created_by_name)
      values (
        ${uid()}, ${data.leadId}, 'note',
        ${`AI underwrite (${recommendation.replace(/_/g, " ")}) by ${me.name} · ${apps.length} part${apps.length === 1 ? "y" : "ies"}. ${ai.summary.slice(0, 400)}`},
        ${me.id}, ${me.name}
      )
    `;

    return {
      id,
      lead_id: data.leadId,
      recommendation,
      summary: ai.summary,
      conditions,
      red_flags: ai.red_flags,
      policy,
      inputs: inputsSnap,
      model: grok.model,
      ran_by_name: me.name,
      created_at: new Date().toISOString(),
    };
  });

function mapReport(r: Record<string, unknown>): UnderwriteReport {
  return {
    id: String(r.id),
    lead_id: String(r.lead_id),
    recommendation: (String(r.recommendation) as UnderwriteRecommendation) || "send_back",
    summary: String(r.summary || ""),
    conditions: asStringArr(r.conditions_json),
    red_flags: asStringArr(r.red_flags_json),
    policy: (r.policy_json || {}) as PolicyResult,
    inputs: (r.inputs_json || { reviewerNotes: "" }) as UnderwriteReport["inputs"],
    model: (r.model as string) || null,
    ran_by_name: (r.ran_by_name as string) || null,
    created_at: String(r.created_at),
  };
}

function asStringArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v) as unknown;
      return Array.isArray(p) ? p.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}
