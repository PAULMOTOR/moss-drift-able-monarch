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

async function callGrok(prompt: string): Promise<{ text: string; model: string }> {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new Error("XAI_API_KEY is not set. Add it in Vercel, then Redeploy.");
  }
  const models = [process.env.XAI_MODEL?.trim(), "grok-4.6", "grok-4", "grok-3"].filter(
    (m): m is string => Boolean(m),
  );
  let lastErr = "xAI request failed";
  for (const model of models) {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.15,
        messages: [
          {
            role: "system",
            content:
              "You are the second-look credit underwriter for Paul Motor Leasing (Montreal). " +
              "You re-do the salesman and credit manager's work. You never approve a deal yourself. " +
              "You are conservative: we mitigate with large cash down; we do not approve anyone who looks shady or criminal. " +
              "Reply with JSON only, no markdown.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      lastErr = `xAI ${model} ${res.status}: ${body.slice(0, 240)}`;
      continue;
    }
    try {
      const json = JSON.parse(body) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content?.trim() || "";
      if (text) return { text, model };
    } catch {
      lastErr = "xAI returned unreadable JSON";
    }
  }
  throw new Error(lastErr);
}

function parseAiJson(text: string): {
  recommendation: UnderwriteRecommendation;
  summary: string;
  conditions: string[];
  red_flags: string[];
  id_consistency: string;
  suggested_cash_down: number | null;
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
  };
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
      `select * from credit_applications where lead_id = $1 order by updated_at desc limit 1`,
      [data.leadId],
    );
    const app = apps[0];
    let payload: Record<string, string> = {};
    if (app?.payload) {
      const raw = app.payload;
      if (typeof raw === "string") {
        try {
          payload = JSON.parse(raw) as Record<string, string>;
        } catch {
          payload = {};
        }
      } else if (typeof raw === "object") {
        payload = raw as Record<string, string>;
      }
    }

    const checklist = await sql.query<{
      section: string;
      item_key: string;
      label: string;
      notes: string;
      done: boolean;
    }>(
      `select section, item_key, label, notes, done from credit_checklist
       where application_id = $1`,
      [app?.id || ""],
    );
    const docs = await sql.query<{ kind: string; file_name: string }>(
      `select kind, file_name from credit_documents where application_id = $1`,
      [app?.id || ""],
    );

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

    const visaNotes = checklist.find((c) => c.item_key === "status_visa")?.notes || "";
    const equifaxNotes =
      String(app?.equifax_notes || "") +
      " " +
      (checklist.find((c) => c.item_key === "equifax")?.notes || "");
    const kycNotes = checklist.find((c) => c.item_key === "kyc")?.notes || "";
    const carfaxNotes = checklist.find((c) => c.item_key === "carfax_lien")?.notes || "";

    const prime = await readBocPrime(sql);
    const citizenship = data.citizenship || guessCitizenship(payload, visaNotes);
    const creditScore =
      data.creditScore ??
      num(payload.credit_score) ??
      num(equifaxNotes.match(/score[:\s]+(\d{3})/i)?.[1]);
    const marketValue = data.marketValue ?? num(payload.market_value);
    const carfaxClaim =
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

    const safeApp = redactPayload(payload);
    const checkLines = [...VEHICLE_CHECKLIST, ...CUSTOMER_CHECKLIST].map((def) => {
      const row = checklist.find((c) => c.item_key === def.key);
      return `${row?.done ? "[x]" : "[ ]"} ${def.label}${row?.notes ? ` — ${row.notes}` : ""}`;
    });

    const prompt = `Paul Motor lease file — produce a second underwrite.

HARD POLICY (already computed — you must respect it):
${JSON.stringify(policy, null, 2)}

QUOTE / STRUCTURE:
${JSON.stringify(quote.metrics, null, 2)}

PRIME (Bank of Canada): ${prime}%
Yield floor when non-citizen OR score < 690 OR car > 8 years: prime + 3% = ${policy.yieldFloorPct.toFixed(2)}%
Carfax haircut = 20% of claim amount. Compare sale price to adjusted market.

LEAD:
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

CREDIT APP (SIN redacted):
${JSON.stringify(safeApp, null, 2)}

CHECKLIST:
${checkLines.join("\n")}

DOCUMENTS ON FILE (names only — do not invent contents you cannot see):
${docs.map((d) => `- ${d.kind}: ${d.file_name}`).join("\n") || "(none)"}

EQUIFAX NOTES: ${equifaxNotes.slice(0, 800) || "(none)"}
KYC NOTES (staff Google/social/CanLII): ${kycNotes.slice(0, 800) || "(none — treat as incomplete)"}
REVIEWER NOTES: ${data.reviewerNotes || "(none)"}
DO NOT PULL CREDIT: ${Boolean(app?.do_not_pull_credit)}

Rules:
- Compare names, DOB, address, phone, employer on the app vs checklist notes. Flag mismatches.
- If IDs / Equifax / Carfax / visa lines are empty, call that out.
- If KYC is thin, say what still needs to be checked (CanLII, news, LinkedIn) — do not invent criminal hits.
- If anything looks fraudulent, identity-inconsistent, or criminal, recommendation = decline.
- Prefer large cash down as the mitigator when the person is otherwise real.
- Pad is internal cap-cost only; do not treat pad as a higher sale price.
- Return JSON:
{
  "recommendation": "approve" | "approve_with_conditions" | "send_back" | "decline",
  "summary": "8-14 sentences for the GSM",
  "conditions": ["concrete next items"],
  "red_flags": ["short bullets"],
  "id_consistency": "one paragraph",
  "suggested_cash_down": number or null
}`;

    const grok = await callGrok(prompt);
    const ai = parseAiJson(grok.text);
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
        ${`AI underwrite (${recommendation.replace(/_/g, " ")}) by ${me.name}. ${ai.summary.slice(0, 400)}`},
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
