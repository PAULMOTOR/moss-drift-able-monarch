/**
 * Palmetto → CRM lease Apply.
 * Palmetto POSTs JSON + Bearer secret. It never opens this database.
 */
import { timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "@/lib/db";
import { sendCrmEmail } from "./mail";
import { publicAppUrl } from "./public-url";
import { CUSTOMER_CHECKLIST, VEHICLE_CHECKLIST } from "./types";
import {
  buildRetailQuoteHtml,
  calcLeaseOption,
  emptyOption,
  taxRateForProvince,
  type ClientQuoteInfo,
  type LeaseOptionResult,
} from "./lease-quote";

export const HANDOFF_SECRET_ENV = "CRM_HANDOFF_SECRET";

function uid() {
  return crypto.randomUUID();
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return "";
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (raw[k] != null && raw[k] !== "") return raw[k];
  }
  return undefined;
}

function timingSafeMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function handoffSecret(): string {
  return (
    process.env.CRM_HANDOFF_SECRET?.trim() ||
    process.env.HANDOFF_SECRET?.trim() ||
    ""
  );
}

export function authorizeHandoff(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = handoffSecret();
  const header =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    request.headers.get("x-handoff-secret")?.trim() ||
    "";
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "CRM_HANDOFF_SECRET is not set. Add it in Vercel (CRM project), then Redeploy.",
    };
  }
  if (!header || !timingSafeMatch(header, secret)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

export type PalmettoHandoffInput = {
  referenceId: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postal: string;
  province: string;
  job: string;
  income: string;
  creditConsent: boolean;
  dealerName: string;
  dealerCity: string;
  dealerProvince: string;
  dealerEmail: string;
  vehicle: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  vin: string;
  stock: string;
  price: number | null;
  down: number | null;
  residual: number | null;
  term: number | null;
  monthly: number | null;
  rate: number | null;
};

function dollarsOrCents(
  dollar: unknown,
  cents: unknown,
): number | null {
  const d = num(dollar);
  if (d != null) return d;
  const c = num(cents);
  if (c == null) return null;
  // Palmetto stores money in cents (359000000 = $3,590,000)
  return Math.round(c) / 100;
}

function ratePercent(v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  return n > 0 && n < 1 ? Math.round(n * 10_000) / 100 : n;
}

export function parsePalmettoPayload(raw: unknown): PalmettoHandoffInput {
  const root = obj(raw);
  const car = obj(pick(root, "car", "unit"));
  const dealer = obj(pick(root, "dealer", "partner", "sellingDealer"));
  const quote = obj(pick(root, "quote", "lease", "numbers"));
  const customer = obj(pick(root, "customer", "applicant", "lessee", "client"));
  const application = obj(pick(root, "application"));
  const addressObj = obj(
    pick(root, "address", "addr") ?? pick(customer, "address") ?? pick(application, "address"),
  );
  const consent = obj(pick(root, "consent", "creditConsent"));

  const firstName = str(
    pick(customer, "firstName", "first_name") ?? pick(root, "firstName", "first_name"),
  );
  const lastName = str(
    pick(customer, "lastName", "last_name") ?? pick(root, "lastName", "last_name"),
  );
  const fullName =
    str(
      pick(customer, "name", "fullName", "full_name", "customerName") ??
        pick(root, "name", "fullName", "full_name", "customerName"),
    ) || [firstName, lastName].filter(Boolean).join(" ");

  const addrLine =
    str(pick(addressObj, "line1", "street", "address")) ||
    str(
      pick(application, "address") ??
        pick(customer, "address") ??
        pick(root, "address"),
    );

  const dealerName = str(
    pick(dealer, "name", "dealerName") ?? pick(root, "dealerName", "dealer", "partnerName"),
  );

  const year = str(pick(car, "year") ?? pick(root, "year"));
  const make = str(pick(car, "make") ?? pick(root, "make"));
  const model = str(pick(car, "model") ?? pick(root, "model"));
  const trim = str(pick(car, "trim") ?? pick(root, "trim"));
  const vehicle =
    str(
      pick(car, "label", "name", "description") ??
        pick(root, "vehicle", "vehicleLabel", "vehicleInterest"),
    ) || [year, make, model, trim].filter(Boolean).join(" ");

  const consentRaw =
    pick(root, "creditConsent", "credit_consent", "consent") ??
    pick(application, "consentCredit", "creditConsent") ??
    pick(consent, "credit", "bureau");
  const creditConsent =
    consentRaw === true || /^(true|1|yes|y|agreed|consent)$/i.test(str(consentRaw));

  return {
    referenceId: str(pick(root, "referenceId", "reference_id", "ref")),
    name: fullName,
    firstName: firstName || fullName.split(/\s+/)[0] || "",
    lastName: lastName || fullName.split(/\s+/).slice(1).join(" "),
    email: str(
      pick(customer, "email", "customerEmail") ?? pick(root, "email", "customerEmail"),
    ).toLowerCase(),
    phone: str(
      pick(customer, "phone", "mobile", "tel", "customerPhone") ??
        pick(root, "phone", "mobile", "customerPhone"),
    ),
    address: addrLine,
    city: str(
      pick(addressObj, "city") ??
        pick(application, "city") ??
        pick(customer, "city") ??
        pick(root, "city"),
    ),
    postal: str(
      pick(addressObj, "postal", "postalCode", "zip") ??
        pick(application, "postalCode", "postal") ??
        pick(customer, "postal") ??
        pick(root, "postal", "postalCode"),
    ),
    province: str(
      pick(addressObj, "province", "state") ??
        pick(application, "province") ??
        pick(customer, "province") ??
        pick(root, "province"),
    ).toUpperCase(),
    job: str(
      pick(customer, "job", "occupation", "employer", "employment") ??
        pick(application, "occupation", "employer") ??
        pick(root, "job", "occupation", "employer"),
    ),
    income: str(
      pick(customer, "income", "grossIncome", "gross_income", "annualIncome") ??
        pick(application, "annualIncome", "income") ??
        pick(root, "income", "grossIncome", "annualIncome"),
    ),
    creditConsent,
    dealerName: typeof dealer === "object" && dealerName ? dealerName : str(dealerName || pick(root, "dealer")),
    dealerCity: str(pick(dealer, "city")),
    dealerProvince: str(pick(dealer, "province", "state")).toUpperCase(),
    dealerEmail: str(pick(dealer, "email")).toLowerCase(),
    vehicle,
    year,
    make,
    model,
    trim,
    vin: str(pick(car, "vin") ?? pick(root, "vin")).toUpperCase(),
    stock: str(pick(car, "stock", "stockNumber", "stock_number") ?? pick(root, "stock")),
    price: dollarsOrCents(
      pick(quote, "price", "salePrice", "capCost") ?? pick(car, "price") ?? pick(root, "price"),
      pick(quote, "priceCents") ?? pick(root, "priceCents"),
    ),
    down: dollarsOrCents(
      pick(quote, "down", "cashDown", "downPayment") ?? pick(root, "down", "cashDown"),
      pick(quote, "downPaymentCents") ?? pick(root, "downPaymentCents"),
    ),
    residual: dollarsOrCents(
      pick(quote, "residual", "residualValue") ?? pick(root, "residual"),
      pick(quote, "residualCents") ?? pick(root, "residualCents"),
    ),
    term: num(pick(quote, "term", "termMonths", "months") ?? pick(root, "term", "termMonths")),
    monthly: dollarsOrCents(
      pick(quote, "monthly", "payment", "paymentMonthly") ?? pick(root, "monthly", "payment"),
      pick(quote, "monthlyPaymentCents") ?? pick(root, "monthlyPaymentCents"),
    ),
    rate: ratePercent(
      pick(quote, "rate", "ratePct", "apr", "baseInterestRate") ??
        pick(root, "rate", "baseInterestRate"),
    ),
  };
}

async function findOrCreateDealer(sql: Sql, input: PalmettoHandoffInput): Promise<string | null> {
  const name = input.dealerName.trim();
  if (name.length < 2) return null;
  const existing = await sql<{ id: string }>`
    select id from partners
    where lower(btrim(name)) = ${name.toLowerCase()}
    limit 1
  `;
  if (existing[0]) {
    await sql`update partners set active = true, updated_at = now() where id = ${existing[0].id}`;
    return existing[0].id;
  }
  const id = uid();
  await sql`
    insert into partners (id, name, kind, city, province, email, notes)
    values (
      ${id}, ${name}, 'dealer',
      ${input.dealerCity || null}, ${input.dealerProvince || null},
      ${input.dealerEmail || null},
      ${"Created from Palmetto Apply"}
    )
  `;
  return id;
}

async function resolveLucasId(sql: Sql): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    select id from profiles
    where active = true
      and (
        lower(email) = 'lucasl@paulmotorcompany.com'
        or lower(name) like 'lucas%'
      )
    order by case when lower(email) = 'lucasl@paulmotorcompany.com' then 0 else 1 end
    limit 1
  `;
  return rows[0]?.id ?? null;
}

async function seedChecklist(sql: Sql, appId: string) {
  for (const item of VEHICLE_CHECKLIST) {
    await sql`
      insert into credit_checklist (id, application_id, section, item_key, label, notes, done)
      values (${uid()}, ${appId}, 'vehicle', ${item.key}, ${item.label}, '', false)
      on conflict (application_id, item_key) do update set label = excluded.label
    `;
  }
  for (const item of CUSTOMER_CHECKLIST) {
    await sql`
      insert into credit_checklist (id, application_id, section, item_key, label, notes, done)
      values (${uid()}, ${appId}, 'customer', ${item.key}, ${item.label}, '', false)
      on conflict (application_id, item_key) do update set label = excluded.label
    `;
  }
}

function money(n: number | null): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(n);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function websiteQuoteLines(input: PalmettoHandoffInput): string[] {
  return [
    input.price != null ? `Price ${money(input.price)}` : "",
    input.down != null ? `Cash down ${money(input.down)}` : "",
    input.residual != null ? `Residual ${money(input.residual)}` : "",
    input.term != null ? `Term ${input.term} mo` : "",
    input.monthly != null ? `Monthly ${money(input.monthly)}` : "",
    input.rate != null ? `Rate ${input.rate}%` : "",
  ].filter(Boolean);
}

/** Persist the Palmetto website numbers as a real CRM lease quote (Lease quote button). */
async function persistWebsiteQuote(
  sql: Sql,
  leadId: string,
  input: PalmettoHandoffInput,
  name: string,
  createdBy: string | null,
): Promise<string | null> {
  if (input.price == null && input.monthly == null) return null;
  const province = (input.province || "QC").toUpperCase() || "QC";
  const start = todayIso();
  const client: ClientQuoteInfo = {
    clientName: name,
    phone: input.phone,
    email: input.email,
    guarantor: "N/A",
    address: input.address,
    city: input.city,
    province,
    postalCode: input.postal,
    salesman: "Palmetto website",
    year: input.year ? Number(input.year) || null : null,
    make: input.make,
    model: input.model,
    trim: input.trim,
    color: "",
    km: null,
    vin: input.vin,
    stock: input.stock,
    condition: "used",
    kmPerYear: 16000,
    excessKmFee: 0.9,
    quoteDate: new Date().toLocaleDateString("en-CA"),
    deliveryDate: start,
    startDate: start,
    notes: [
      "Website quote from Palmetto Apply.",
      input.referenceId ? `Reference ${input.referenceId}` : "",
      input.monthly != null ? `Monthly shown to customer: ${money(input.monthly)}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    adminFee: 0,
    trackerFee: 0,
    lienPpsa: 0,
    license: 0,
    tireTax: 0,
    daysLeftOverride: null,
    contractStyle: "qc_individual_en",
    partyType: "individual",
    tradeVin: "",
    tradeYear: null,
    tradeMake: "",
    tradeModel: "",
    tradeTrim: "",
    tradeKm: null,
    tradeKind: "financed",
  };

  const computed = calcLeaseOption(
    emptyOption({
      cost: input.price || 0,
      deposit: input.down || 0,
      residual: input.residual || 0,
      termMonths: input.term || 36,
      ratePct: input.rate || 0,
      handling: 0,
    }),
    province,
    { admin: 0, tracker: 0, lienPpsa: 0, license: 0, tireTax: 0 },
    { startDate: start },
  );

  // Keep the monthly the customer saw on Palmetto; CRM engine can differ slightly.
  const option: LeaseOptionResult =
    input.monthly != null && Number.isFinite(input.monthly)
      ? {
          ...computed,
          payment: input.monthly,
          totalPayment: Math.round((input.monthly + computed.taxOnPayment) * 100) / 100,
        }
      : computed;

  const taxRate = taxRateForProvince(province);
  const html = buildRetailQuoteHtml(client, [option], taxRate);
  const quoteId = uid();
  const title = `Palmetto · ${input.vehicle || name} · ${option.termMonths}mo`;
  const payload = {
    client,
    options: [option],
    taxRate,
    selectedOption: 1,
    source: "palmetto",
  };

  await sql`
    insert into lease_quotes (
      id, lead_id, created_by, client_name, payload, retail_html,
      selected_option, status, title
    ) values (
      ${quoteId}, ${leadId}, ${createdBy}, ${name},
      ${JSON.stringify(payload)}::jsonb, ${html},
      1, 'draft', ${title}
    )
  `;
  return quoteId;
}

export async function ingestPalmettoLease(
  input: PalmettoHandoffInput,
): Promise<{ ok: true; id: string; duplicate?: boolean }> {
  if (!input.name && !input.email && !input.phone) {
    throw new Error("name and email or phone are required");
  }
  if (!input.email && !input.phone) {
    throw new Error("email or phone is required");
  }
  const name = input.name || [input.firstName, input.lastName].filter(Boolean).join(" ") || "Palmetto applicant";
  const sql = await getSql();

  if (input.referenceId) {
    const prior = await sql<{ id: string }>`
      select id from leads where external_ref = ${input.referenceId} limit 1
    `;
    if (prior[0]) return { ok: true, id: prior[0].id, duplicate: true };
  }

  const partnerId = await findOrCreateDealer(sql, input);
  const assigned = await resolveLucasId(sql);
  const leadId = uid();
  const quoteLines = websiteQuoteLines(input);
  const notes = [
    "Palmetto website Apply",
    input.referenceId ? `Reference: ${input.referenceId}` : "",
    input.dealerName ? `Dealer: ${input.dealerName}` : "",
    input.vin ? `VIN: ${input.vin}` : "",
    input.stock ? `Stock: ${input.stock}` : "",
    input.creditConsent ? "Credit consent: yes" : "Credit consent: not marked",
    quoteLines.length ? `Quote:\n${quoteLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await sql`
      insert into leads (
        id, name, first_name, last_name, party_type, phone, email, source, lead_type,
        notes, vehicle_interest, assigned_to, stage, stage_entered_at,
        quote_sent, quote_sent_at, quote_notes, estimated_value, partner_id,
        credit_status, external_ref, created_by
      ) values (
        ${leadId}, ${name}, ${input.firstName || null}, ${input.lastName || null},
        'individual', ${input.phone || null}, ${input.email || null},
        'web', 'lease', ${notes}, ${input.vehicle || null},
        ${assigned}, 'new', now(),
        ${quoteLines.length > 0}, ${quoteLines.length > 0 ? new Date().toISOString() : null},
        ${quoteLines.join("\n") || null}, ${input.price}, ${partnerId},
        'app_submitted', ${input.referenceId || null}, null
      )
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (input.referenceId && /external_ref|unique/i.test(msg)) {
      const prior = await sql<{ id: string }>`
        select id from leads where external_ref = ${input.referenceId} limit 1
      `;
      if (prior[0]) return { ok: true, id: prior[0].id, duplicate: true };
    }
    throw e;
  }

  const appId = uid();
  const pub = uid().replace(/-/g, "") + uid().replace(/-/g, "").slice(0, 16);
  const payload = {
    full_name: name,
    first_name: input.firstName,
    last_name: input.lastName,
    phone: input.phone,
    email: input.email,
    address: input.address,
    city: input.city,
    postal: input.postal,
    province: input.province,
    employment: input.job,
    employer: input.job,
    gross_income: input.income,
    credit_consent: input.creditConsent ? "yes" : "",
    source: "palmetto",
    reference_id: input.referenceId,
    vehicle: input.vehicle,
    vin: input.vin,
    quote_price: input.price != null ? String(input.price) : "",
    quote_down: input.down != null ? String(input.down) : "",
    quote_residual: input.residual != null ? String(input.residual) : "",
    quote_term: input.term != null ? String(input.term) : "",
    quote_monthly: input.monthly != null ? String(input.monthly) : "",
    quote_rate: input.rate != null ? String(input.rate) : "",
  };
  await sql`
    insert into credit_applications (
      id, lead_id, status, party_type, payload, public_token, app_email, submitted_at
    ) values (
      ${appId}, ${leadId}, 'app_submitted', 'individual',
      ${JSON.stringify(payload)}::jsonb, ${pub}, ${input.email || null}, now()
    )
  `;
  await sql`update leads set credit_app_id = ${appId}, updated_at = now() where id = ${leadId}`;
  await seedChecklist(sql, appId);

  let quoteId: string | null = null;
  try {
    quoteId = await persistWebsiteQuote(sql, leadId, input, name, assigned);
  } catch (e) {
    console.error("[palmetto-handoff] lease quote persist failed", e);
  }

  const activityBody = [
    `Palmetto Apply${input.referenceId ? ` · ${input.referenceId}` : ""}${input.dealerName ? ` · ${input.dealerName}` : ""}`,
    input.vehicle || "",
    ...quoteLines,
  ]
    .filter(Boolean)
    .join("\n");

  await sql`
    insert into lead_activities (id, lead_id, kind, body, created_by_name)
    values (
      ${uid()}, ${leadId}, ${quoteId ? "quote" : "system"},
      ${activityBody},
      ${"Palmetto"}
    )
  `;

  const link = `${publicAppUrl()}/leads/${leadId}?tab=lead`;
  const staff = await sql<{ email: string; name: string }>`
    select email, name from profiles
    where active = true
      and (
        role in ('gsm', 'admin', 'credit_manager')
        or id = ${assigned}
      )
  `;
  const seen = new Set<string>();
  for (const r of staff) {
    const to = r.email.trim().toLowerCase();
    if (!to || seen.has(to)) continue;
    seen.add(to);
    await sendCrmEmail(sql, {
      to,
      subject: `[CRM] Palmetto Apply — ${name}`,
      kind: "palmetto_handoff",
      leadId,
      text: [
        `${name} applied on Palmetto.`,
        ``,
        `  Phone: ${input.phone || "—"}`,
        `  Email: ${input.email || "—"}`,
        `  Vehicle: ${input.vehicle || "—"}`,
        `  Dealer: ${input.dealerName || "—"}`,
        `  ${quoteLines.join(" · ") || "No quote numbers"}`,
        `  Consent: ${input.creditConsent ? "yes" : "not marked"}`,
        ``,
        link,
      ].join("\n"),
    }).catch(() => null);
  }

  return { ok: true, id: leadId };
}
