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

function compactAppPayload(raw: Record<string, string>): Record<string, string> {
  const keep = [
    "first_name",
    "last_name",
    "date_of_birth",
    "dob",
    "address",
    "city",
    "province",
    "employer",
    "occupation",
    "income",
    "income_notes",
    "housing",
    "status",
    "citizenship",
    "years_at_address",
    "email",
    "phone",
  ];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = raw[k];
    if (v) out[k] = String(v).slice(0, 200);
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
      vehicle: [client.year, client.make, client.model, client.trim, client.driveType].filter(Boolean).join(" "),
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
  const models = uniqueModels([
    process.env.XAI_MODEL?.trim(),
    "grok-4-fast-non-reasoning",
    "grok-4-1-fast-non-reasoning",
    "grok-4.6",
  ]);
  const filesSent: string[] = [];
  const excerpts: string[] = [];
  for (const f of attachments.slice(0, 5)) {
    const parsed = parseDataUrl(f.dataUrl);
    if (!parsed) {
      filesSent.push(`${f.name} (skipped)`);
      continue;
    }
    const mime = (parsed.mime || "").toLowerCase();
    const name = f.name || "document";
    if (mime.includes("pdf") || /\.pdf$/i.test(name)) {
      const text = extractPdfPlain(parsed.buf);
      if (text.length > 40) {
        excerpts.push(`--- ${name} ---\n${text}`);
        filesSent.push(name);
      } else {
        filesSent.push(`${name} (scan / no text)`);
      }
      continue;
    }
    if (mime.startsWith("text/") || mime.includes("json") || mime.includes("csv")) {
      excerpts.push(`--- ${name} ---\n${parsed.buf.toString("utf8").slice(0, 2500)}`);
      filesSent.push(name);
      continue;
    }
    filesSent.push(`${name} (image — not sent)`);
  }

  const system =
    "You are a fast second-look credit underwriter for Paul Motor Leasing (Montreal). " +
    "Use the structured file, staff notes, and any document text extracts. " +
    "Conservative: large cash down to mitigate; decline shady or criminal files. " +
    "You never approve a deal yourself. Reply with JSON only. Be brief.";

  const user =
    excerpts.length > 0
      ? `${prompt}\n\nDOCUMENT TEXT EXTRACTS:\n${excerpts.join("\n\n").slice(0, 16000)}`
      : prompt;

  const ask = async (model: string) => {
    let resIn: Response;
    try {
      resIn = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.15,
          max_tokens: 800,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(/abort|timeout/i.test(msg) ? "Grok timed out. Try again." : msg);
    }
    const resBody = await resIn.text();
    if (resIn.status === 404 || (resIn.status === 400 && /model/i.test(resBody))) {
      throw new Error(`MODEL_UNAVAILABLE ${model}`);
    }
    if (!resIn.ok) {
      throw new Error(`Grok ${model} ${resIn.status}: ${resBody.slice(0, 240)}`);
    }
    try {
      const json = JSON.parse(resBody) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = String(json.choices?.[0]?.message?.content || "").trim();
      if (text) return text;
    } catch {
      /* fall through */
    }
    throw new Error(`Grok returned no readable text (${resBody.slice(0, 120)})`);
  };

  let last = "No model available";
  for (const model of models) {
    try {
      const text = await ask(model);
      return { text, model, filesSent };
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (!last.startsWith("MODEL_UNAVAILABLE")) throw new Error(last);
    }
  }
  throw new Error(last);
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

function decodePdfLiteral(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function extractPdfPlain(buf: Buffer): string {
  const src = buf.toString("latin1");
  const parts: string[] = [];
  const tj = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tj.exec(src))) {
    const t = decodePdfLiteral(m[1]).trim();
    if (t) parts.push(t);
  }
  const tjArr = /\[([\s\S]*?)\]\s*TJ/g;
  while ((m = tjArr.exec(src))) {
    const inner = /\(((?:\\.|[^\\)])*)\)/g;
    let im: RegExpExecArray | null;
    while ((im = inner.exec(m[1]))) {
      const t = decodePdfLiteral(im[1]).trim();
      if (t) parts.push(t);
    }
  }
  let text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (text.length < 80) {
    const loose: string[] = [];
    const any = /\(((?:\\.|[^\\)]){3,160})\)/g;
    while ((m = any.exec(src))) {
      const t = decodePdfLiteral(m[1]);
      if (/[A-Za-z0-9]/.test(t)) loose.push(t);
    }
    text = loose.join(" ").replace(/\s+/g, " ").trim();
  }
  return text.slice(0, 5000);
}

function extractResponseText(body: string): string {
  try {
    const json = JSON.parse(body) as {
      output_text?: string;
      output?: Array<{
        type?: string;
        text?: string;
        content?: Array<{
          text?: string;
          type?: string;
          output_text?: string;
        }>;
      }>;
    };
    if (json.output_text?.trim()) return json.output_text.trim();
    const parts: string[] = [];
    for (const item of json.output || []) {
      if (typeof item.text === "string" && item.text.trim()) parts.push(item.text);
      for (const c of item.content || []) {
        if (typeof c.text === "string" && c.text.trim()) parts.push(c.text);
        if (typeof c.output_text === "string" && c.output_text.trim()) parts.push(c.output_text);
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

export const listUnderwriteReports = createServerFn({ method: "POST" })
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

    const pendingId = uid();
    await sql`
      insert into underwrite_reports (
        id, lead_id, application_id, ran_by, ran_by_name,
        recommendation, summary, conditions_json, red_flags_json,
        policy_json, inputs_json, model
      ) values (
        ${pendingId}, ${data.leadId}, ${null}, ${me.id}, ${me.name},
        ${"send_back"}, ${"Running a fast underwrite — about 20 seconds."},
        ${"[]"}, ${"[]"}, ${"{}"}, ${"{}"}, ${"pending"}
      )
    `;

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
    const keepIds = rankedMeta.slice(0, 4).map((d) => d.id);
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
        application: compactAppPayload(payloadOf(row)),
        checklist: checks.filter((c) => c.startsWith("[x]") || c.includes(" — ")),
      };
    });
    const primaryChecks = checklist.filter((c) => String(c.application_id) === String(app?.id || ""));
    const checkLines = [...VEHICLE_CHECKLIST, ...CUSTOMER_CHECKLIST].map((def) => {
      const row = primaryChecks.find((c) => c.item_key === def.key);
      return `${row?.done ? "[x]" : "[ ]"} ${def.label}${row?.notes ? ` — ${row.notes}` : ""}`;
    });

    const prompt = `Fast underwrite — Paul Motor lease. Use staff notes + document extracts. 4–6 sentences.

QUOTE: ${JSON.stringify(quote.metrics)}
PRIME: ${prime}%
RULES: yield floor prime+4% = ${(prime + 4).toFixed(2)}% if non-citizen OR score < 690 OR car > 8yrs. Carfax haircut = 20% of largest claim. Pad is internal only. Weak-but-real file → large cash down. Shady/criminal → decline. Weak guarantor does not auto-decline a strong primary.

LEAD: ${JSON.stringify({
      name: lead.name,
      party: lead.party_type,
      company: lead.legal_entity_name,
      vehicle: lead.vehicle_interest,
      status: lead.credit_status,
    })}

PARTIES:
${JSON.stringify(partyBlocks)}

CHECKLIST:
${checkLines.join("\n")}

EQUIFAX NOTES: ${equifaxNotes.slice(0, 500) || "(none)"}
KYC: ${kycNotes.slice(0, 400) || "(none)"}
CARFAX: ${carfaxNotes.slice(0, 300) || "(none)"}
VISA: ${visaNotes.slice(0, 200) || "(none)"}
PULL CREDIT: ${Boolean(app?.do_not_pull_credit) ? "No — DO NOT PULL" : "Yes"}

JSON only:
{"recommendation":"approve"|"approve_with_conditions"|"send_back"|"decline","summary":"4-6 sentences","conditions":["..."],"red_flags":["..."],"id_consistency":"one line","suggested_cash_down":null,"credit_score":null,"citizenship":"canadian_citizen"|"permanent_resident"|"work_permit"|"student"|"other"|"unknown","market_value":null,"carfax_claim":null}`;

    let grok: { text: string; model: string; filesSent: string[] };
    let ai: ReturnType<typeof parseAiJson>;
    try {
      grok = await callGrok(prompt, attachments.slice(0, 4));
      ai = parseAiJson(grok.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      grok = { text: "", model: "policy-fallback", filesSent: [] };
      ai = {
        recommendation: "send_back",
        summary:
          `AI underwrite did not finish (${msg.slice(0, 280)}). ` +
          `Policy gates below are from the structured file. Click Run AI underwrite again.`,
        conditions: ["Re-run AI underwrite"],
        red_flags: [msg.slice(0, 300)],
        id_consistency: "",
        suggested_cash_down: null,
        credit_score: null,
        citizenship: null,
        market_value: null,
        carfax_claim: null,
      };
    }

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

    const id = pendingId;
    await sql`
      update underwrite_reports set
        recommendation = ${recommendation},
        summary = ${ai.summary},
        conditions_json = ${JSON.stringify(conditions)},
        red_flags_json = ${JSON.stringify(ai.red_flags)},
        policy_json = ${JSON.stringify(policy)},
        inputs_json = ${JSON.stringify(inputsSnap)},
        model = ${grok.model}
      where id = ${pendingId}
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
