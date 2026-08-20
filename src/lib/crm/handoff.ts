/**
 * Palmetto → CRM lease Apply.
 * Palmetto POSTs JSON + Bearer secret. It never opens this database.
 */
import { timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "@/lib/db";
import { sendCrmEmail } from "./mail";
import { publicAppUrl } from "./public-url";
import { CUSTOMER_CHECKLIST, HERO_SHOT_KIND, VEHICLE_CHECKLIST } from "./types";
import { loadHeroShotForLead } from "./hero-shot";
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

function httpUrl(v: unknown): string {
  const s = str(v);
  if (!/^https?:\/\//i.test(s)) return "";
  if (/^data:/i.test(s)) return "";
  return s.slice(0, 500);
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
  /** Public HTTPS URL of the Palmetto inventory tile. */
  image: string;
  price: number | null;
  down: number | null;
  residual: number | null;
  term: number | null;
  monthly: number | null;
  rate: number | null;
  photoUrl: string;
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

  const image = extractPalmettoImageRef(raw);

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
    image,
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
    photoUrl: image,
  };
}

function firstUrlFromList(v: unknown): string {
  if (!Array.isArray(v) || !v.length) return "";
  const first = v[0];
  if (typeof first === "string") return first.trim();
  if (first && typeof first === "object") {
    return str(pick(first as Record<string, unknown>, "url", "src", "href", "photoUrl", "imageUrl"));
  }
  return "";
}

function unwrapUrl(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return str(
      pick(v as Record<string, unknown>, "url", "src", "href", "photoUrl", "imageUrl", "image", "path"),
    );
  }
  return "";
}

function palmettoOrigins(): string[] {
  const env = str(process.env.PALMETTO_PUBLIC_URL || process.env.PALMETTO_SITE_URL).replace(/\/$/, "");
  return [
    env,
    "https://www.palmettoleasing.com",
    "https://palmettoleasing.com",
    "https://palmetto.paulmotorcompany.com",
  ].filter(Boolean);
}

function looksLikeImageRef(s: string): boolean {
  if (!s) return false;
  if (/^data:image\//i.test(s)) return true;
  if (/^\/api\/thumb\//i.test(s)) return true;
  if (/\/api\/thumb\//i.test(s)) return true;
  if (/\.(jpe?g|png|webp|gif|avif|heic)(\?|$)/i.test(s)) return true;
  if (/^https?:\/\//i.test(s) && /image|img|thumb|photo|tile|hero|cdn|blob|storage/i.test(s)) {
    return true;
  }
  return false;
}

function forceWwwPalmetto(url: string): string {
  return url.replace(
    /^https?:\/\/palmettoleasing\.com(?=[:/?#]|$)/i,
    "https://www.palmettoleasing.com",
  );
}

function resolveImageRef(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  if (/^data:image\//i.test(s)) return [s];
  if (/^\/\//.test(s)) return [forceWwwPalmetto(`https:${s}`)];
  if (/^https?:\/\//i.test(s)) return [forceWwwPalmetto(s)];
  if (s.startsWith("/")) {
    return palmettoOrigins().map((o) => forceWwwPalmetto(`${o}${s}`));
  }
  return [];
}

export function extractTileUrlFromText(...texts: Array<string | null | undefined>): string {
  for (const text of texts) {
    const m = String(text || "").match(
      /https?:\/\/[^\s<>"']+(?:\/api\/thumb\/[^\s<>"']+|\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s<>"']*)?)/i,
    );
    if (m?.[0]) return forceWwwPalmetto(m[0].replace(/[),.;]+$/, ""));
  }
  return "";
}

/** Walk Apply JSON for any photo Palmetto may have sent. */
export function extractPalmettoImageRef(raw: unknown): string {
  const root = obj(raw);
  const car = obj(pick(root, "car", "unit", "vehicle"));
  const quote = obj(pick(root, "quote", "lease"));
  const named = [
    unwrapUrl(pick(root, "image", "imageUrl", "image_url", "photoUrl", "photo_url", "heroImageUrl", "hero_image_url", "thumbnailUrl", "tileUrl", "photo", "thumbnail")),
    unwrapUrl(pick(car, "image", "imageUrl", "photoUrl", "thumbnail", "thumbnailUrl", "photo", "src", "url")),
    unwrapUrl(pick(quote, "image", "imageUrl", "photoUrl", "thumbnailUrl")),
    firstUrlFromList(root.photos),
    firstUrlFromList(root.images),
    firstUrlFromList(car.photos),
    firstUrlFromList(car.images),
  ].map((s) => s.trim()).filter(Boolean);
  for (const s of named) {
    if (looksLikeImageRef(s) || /^https?:\/\//i.test(s) || s.startsWith("/")) return s;
  }
  const walk = (v: unknown, depth: number): string => {
    if (depth > 5 || v == null) return "";
    if (typeof v === "string") return looksLikeImageRef(v) ? v.trim() : "";
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = walk(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (!/image|photo|thumb|tile|hero|src|url/i.test(k)) continue;
        const hit = walk(o[k], depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  };
  return walk(raw, 0);
}

function pickPhotoUrl(root: Record<string, unknown>, car: Record<string, unknown>): string {
  return extractPalmettoImageRef({ ...root, car });
}

function sniffImageMime(buf: Buffer, hinted: string): string | null {
  const hint = (hinted || "").split(";")[0].trim().toLowerCase();
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF") return "image/webp";
  if (buf.slice(4, 8).toString("ascii") === "ftyp") return "image/avif";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (hint.startsWith("image/") && hint !== "image/svg+xml") return hint;
  return null;
}

async function fetchOneImage(
  url: string,
  hops = 0,
): Promise<{ dataUrl: string; mime: string; name: string } | null> {
  if (hops > 5) return null;
  const target = forceWwwPalmetto(url);
  const res = await fetch(target, {
    redirect: "manual",
    signal: AbortSignal.timeout(18_000),
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (compatible; PaulMotorCRM/1.0; +https://crm.paulmotorcompany.com)",
    },
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) return null;
    const next = loc.startsWith("http")
      ? forceWwwPalmetto(loc)
      : forceWwwPalmetto(new URL(loc, target).href);
    return fetchOneImage(next, hops + 1);
  }
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 60 || buf.length > 3_500_000) return null;
  const mime = sniffImageMime(buf, res.headers.get("content-type") || "") || "image/jpeg";
  if (!mime.startsWith("image/")) return null;
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("avif") ? "avif" : "jpg";
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  if (dataUrl.length > 5_500_000) return null;
  return { dataUrl, mime, name: `hero-shot.${ext}` };
}

async function fetchHeroImage(
  ref: string,
): Promise<{ dataUrl: string; mime: string; name: string } | null> {
  if (/^data:image\//i.test(ref)) {
    if (ref.length < 80 || ref.length > 5_500_000) return null;
    const mime = ref.slice(5, ref.indexOf(";")) || "image/jpeg";
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    return { dataUrl: ref, mime, name: `hero-shot.${ext}` };
  }
  for (const url of resolveImageRef(ref)) {
    try {
      const img = await fetchOneImage(url);
      if (img) return img;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function attachHeroShot(
  sql: Sql,
  leadId: string,
  applicationId: string,
  photoRef: string,
): Promise<boolean> {
  if (!photoRef) return false;
  const existing = await sql<{ id: string }>`
    select id from credit_documents
    where lead_id = ${leadId} and kind = ${HERO_SHOT_KIND}
    limit 1
  `;
  if (existing[0]) return true;
  const img = await fetchHeroImage(photoRef);
  if (img) {
    await sql`
      insert into credit_documents (
        id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_via
      ) values (
        ${uid()}, ${applicationId}, ${leadId}, ${HERO_SHOT_KIND},
        ${img.name}, ${img.mime}, ${img.dataUrl}, ${"crm"}
      )
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by_name)
      values (
        ${uid()}, ${leadId}, 'credit',
        ${"Hero Shot attached from Palmetto"},
        ${"Palmetto"}
      )
    `;
    return true;
  }
  const hotlink = resolveImageRef(photoRef)
    .map(forceWwwPalmetto)
    .find((u) => /^https?:\/\//i.test(u) && !/\/api\/thumb\//i.test(u));
  if (hotlink) {
    await sql`
      insert into credit_documents (
        id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_via
      ) values (
        ${uid()}, ${applicationId}, ${leadId}, ${HERO_SHOT_KIND},
        ${"hero-shot.jpg"}, ${"image/jpeg"}, ${hotlink}, ${"crm"}
      )
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by_name)
      values (
        ${uid()}, ${leadId}, 'credit',
        ${`Hero Shot linked from Palmetto (live URL)\n${hotlink}`},
        ${"Palmetto"}
      )
    `;
    return true;
  }
  await sql`
    insert into lead_activities (id, lead_id, kind, body, created_by_name)
    values (
      ${uid()}, ${leadId}, 'credit',
      ${`Hero Shot missing — Palmetto sent: ${photoRef.slice(0, 240)}`},
      ${"Palmetto"}
    )
  `;
  return false;
}

export async function ensureHeroShotForLead(
  sql: Sql,
  leadId: string,
): Promise<boolean> {
  const existing = await sql<{ id: string }>`
    select id from credit_documents
    where lead_id = ${leadId} and kind = ${HERO_SHOT_KIND}
    limit 1
  `;
  if (existing[0]) return true;
  const lead = await sql<{
    notes: string | null;
    quote_notes: string | null;
  }>`
    select notes, quote_notes from leads where id = ${leadId} limit 1
  `;
  const apps = await sql<{ id: string; payload: unknown }>`
    select id, payload from credit_applications
    where lead_id = ${leadId}
    order by case when coalesce(applicant_role,'primary') = 'primary' then 0 else 1 end
    limit 1
  `;
  if (!apps[0]) return false;
  const rawPayload = apps[0].payload;
  let payload: Record<string, unknown> = {};
  try {
    payload =
      typeof rawPayload === "string"
        ? obj(JSON.parse(rawPayload) as unknown)
        : obj(rawPayload);
  } catch {
    payload = {};
  }
  const ref =
    extractPalmettoImageRef(payload) ||
    extractTileUrlFromText(
      lead[0]?.notes,
      lead[0]?.quote_notes,
      str(payload.vehicle_image),
      str(payload.image),
      str(payload.photoUrl),
      str(payload.heroImageUrl),
    );
  if (!ref) return false;
  return attachHeroShot(sql, leadId, apps[0].id, ref);
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

export async function ensureHandoffSchema(sql: Sql): Promise<void> {
  await sql`alter table leads add column if not exists external_ref text`;
  await sql`
    create unique index if not exists leads_external_ref_uidx
    on leads (external_ref)
    where external_ref is not null and btrim(external_ref) <> ''
  `;
  await sql`
    create table if not exists handoff_attempts (
      id text primary key,
      created_at timestamptz not null default now(),
      ok boolean not null,
      status int not null,
      reference_id text,
      name text,
      error text
    )
  `;
}

export async function logHandoffAttempt(
  sql: Sql,
  row: { ok: boolean; status: number; referenceId?: string; name?: string; error?: string },
): Promise<void> {
  try {
    await ensureHandoffSchema(sql);
    await sql`
      insert into handoff_attempts (id, ok, status, reference_id, name, error)
      values (
        ${uid()}, ${row.ok}, ${row.status},
        ${row.referenceId || null}, ${row.name || null}, ${row.error?.slice(0, 400) || null}
      )
    `;
  } catch (e) {
    console.error("[handoff] log failed", e);
  }
}

export async function listHandoffAttempts(limit = 12) {
  const sql = await getSql();
  await ensureHandoffSchema(sql);
  return sql<{
    created_at: string;
    ok: boolean;
    status: number;
    reference_id: string | null;
    name: string | null;
    error: string | null;
  }>`
    select created_at::text as created_at, ok, status, reference_id, name, error
    from handoff_attempts
    order by created_at desc
    limit ${limit}
  `;
}

function websiteQuoteLines(input: PalmettoHandoffInput): string[] {
  return [
    input.price != null ? `Price ${money(input.price)}` : "",
    input.down != null ? `Cash down ${money(input.down)}` : "",
    input.residual != null ? `Residual ${money(input.residual)}` : "",
    input.term != null ? `Term ${input.term} mo` : "",
    input.monthly != null ? `Monthly ${money(input.monthly)}` : "",
    input.rate != null ? `Rate ${input.rate}%` : "",
    input.image ? `Tile ${input.image}` : "",
  ].filter(Boolean);
}

async function attachPalmettoTile(
  sql: Sql,
  leadId: string,
  appId: string,
  imageUrl: string,
): Promise<boolean> {
  if (!/^https?:\/\//i.test(imageUrl)) return false;
  try {
    const res = await fetch(imageUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 400 || buf.length > 3_500_000) return false;
    let mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0]!.trim();
    if (!mime.startsWith("image/")) mime = "image/jpeg";
    const data = `data:${mime};base64,${buf.toString("base64")}`;
    if (data.length > 5_500_000) return false;
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    await sql`
      insert into credit_documents (
        id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_via
      ) values (
        ${uid()}, ${appId}, ${leadId}, ${HERO_SHOT_KIND},
        ${`palmetto-tile.${ext}`}, ${mime}, ${data}, 'crm'
      )
    `;
    return true;
  } catch (e) {
    console.error("[palmetto-handoff] tile attach failed", e);
    return false;
  }
}

/** Persist Palmetto numbers as a real CRM lease quote (Lease quote button). */
async function savePalmettoQuote(
  sql: Sql,
  leadId: string,
  input: PalmettoHandoffInput,
  name: string,
): Promise<{ quoteId: string; monthly: number } | null> {
  if (input.price == null && input.monthly == null) return null;
  const today = new Date().toISOString().slice(0, 10);
  const province = (input.province || input.dealerProvince || "QC").slice(0, 2) || "QC";
  const yearN = Number(input.year);
  const client: ClientQuoteInfo = {
    clientName: name,
    phone: input.phone,
    email: input.email,
    guarantor: "N/A",
    address: input.address,
    city: input.city,
    province,
    postalCode: input.postal,
    salesman: "",
    year: Number.isFinite(yearN) && yearN > 1980 ? yearN : null,
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
    deliveryDate: today,
    startDate: today,
    notes: [
      "Quoted on Palmetto — review before sharing.",
      input.monthly != null ? `Palmetto showed ${money(input.monthly)}/mo.` : "",
      input.referenceId ? `Ref ${input.referenceId}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    adminFee: 999,
    trackerFee: 795,
    lienPpsa: 0,
    license: 0,
    tireTax: 0,
    daysLeftOverride: null,
    contractStyle: province === "QC" ? "qc_individual_en" : "ca_individual_en",
    partyType: "individual",
    tradeVin: "",
    tradeYear: null,
    tradeMake: "",
    tradeModel: "",
    tradeTrim: "",
    tradeKm: null,
    tradeKind: "financed",
  };
  const optIn = emptyOption({
    cost: Math.max(0, input.price || 0),
    extra: 0,
    profit: 0,
    deposit: Math.max(0, input.down || 0),
    residual: Math.max(0, input.residual || 0),
    termMonths: Math.max(1, Math.round(input.term || 36)),
    ratePct: Math.max(0, input.rate || 6.99),
    handling: 0,
  });
  const computed = calcLeaseOption(
    optIn,
    province,
    {
      admin: client.adminFee,
      tracker: client.trackerFee,
      lienPpsa: client.lienPpsa,
      license: client.license,
      tireTax: client.tireTax,
    },
    { startDate: client.startDate, daysLeftOverride: client.daysLeftOverride },
    undefined,
    { partyType: client.partyType, tradeKind: client.tradeKind },
  );
  const option: LeaseOptionResult =
    input.monthly != null && Number.isFinite(input.monthly)
      ? {
          ...computed,
          payment: input.monthly,
          totalPayment: Math.round((input.monthly + computed.taxOnPayment) * 100) / 100,
        }
      : computed;
  const blankFees = { admin: 0, tracker: 0, lienPpsa: 0, license: 0, tireTax: 0 };
  const blanks: LeaseOptionResult[] = [
    calcLeaseOption(emptyOption({ termMonths: 0, ratePct: 0 }), province, blankFees, {
      startDate: client.startDate,
    }),
    calcLeaseOption(emptyOption({ termMonths: 0, ratePct: 0 }), province, blankFees, {
      startDate: client.startDate,
    }),
  ];
  const options: LeaseOptionResult[] = [option, blanks[0], blanks[1]];
  const taxRate = taxRateForProvince(province);
  const heroDataUrl = await loadHeroShotForLead(sql, leadId);
  const html = buildRetailQuoteHtml(client, options, taxRate, { heroDataUrl });
  const quoteId = uid();
  const title = `Palmetto · ${name} · ${input.vehicle || "lease"}`.slice(0, 160);
  const payload = { client, options, taxRate, selectedOption: 1, source: "palmetto" };
  let pdfName: string | null = null;
  let pdfData: string | null = null;
  try {
    const { buildRetailQuotePdf, pdfDataUrl } = await import("./quote-pdf");
    const buf = await buildRetailQuotePdf(client, options, taxRate, {
      acceptedOption: 1,
      heroDataUrl,
    });
    pdfData = pdfDataUrl(buf);
    pdfName = `Palmetto-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.pdf`;
  } catch {
    /* quote still opens without PDF */
  }
  await sql`
    insert into lease_quotes (
      id, lead_id, created_by, client_name, payload, retail_html, selected_option, status,
      title, pdf_name, pdf_data
    ) values (
      ${quoteId}, ${leadId}, null, ${name},
      ${JSON.stringify(payload)}::jsonb, ${html}, 1, 'draft',
      ${title}, ${pdfName}, ${pdfData}
    )
  `;
  await sql`
    update leads set
      quote_notes = ${`Palmetto quote · ${money(option.totalPayment)}/mo · ${optIn.termMonths} mo`},
      estimated_value = ${input.price},
      updated_at = now()
    where id = ${leadId}
  `;
  return { quoteId, monthly: option.totalPayment };
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
  await ensureHandoffSchema(sql);

  if (input.referenceId) {
    const prior = await sql<{ id: string }>`
      select id from leads where external_ref = ${input.referenceId} limit 1
    `;
    if (prior[0]) {
      const app = await sql<{ id: string }>`
        select id from credit_applications
        where lead_id = ${prior[0].id}
        order by case when coalesce(applicant_role,'primary') = 'primary' then 0 else 1 end
        limit 1
      `;
      if (app[0] && (input.photoUrl || input.image)) {
        await attachHeroShot(sql, prior[0].id, app[0].id, input.photoUrl || input.image).catch(() => false);
      }
      return { ok: true, id: prior[0].id, duplicate: true };
    }
  }

  const partnerId = await findOrCreateDealer(sql, input);
  const leadId = uid();
  const quoteLines = websiteQuoteLines(input);
  const notes = [
    "Palmetto website Apply",
    input.referenceId ? `Reference: ${input.referenceId}` : "",
    input.dealerName ? `Dealer: ${input.dealerName}` : "",
    input.vin ? `VIN: ${input.vin}` : "",
    input.stock ? `Stock: ${input.stock}` : "",
    input.image ? `Tile: ${input.image}` : "",
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
        ${null}, 'new', now(),
        false, null,
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
    vehicle_image: input.image,
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

  const heroUrl = input.photoUrl || input.image;
  const heroOk = heroUrl
    ? await attachHeroShot(sql, leadId, appId, heroUrl).catch((e) => {
        console.error("[palmetto-handoff] hero shot failed", e);
        return false;
      })
    : false;
  if (!heroUrl) {
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by_name)
      values (
        ${uid()}, ${leadId}, 'credit',
        ${"Hero Shot missing — Palmetto Apply had no image URL"},
        ${"Palmetto"}
      )
    `;
  }

  const savedQuote = await savePalmettoQuote(sql, leadId, input, name).catch((e) => {
    console.error("[palmetto-handoff] lease quote persist failed", e);
    return null;
  });

  await sql`
    insert into lead_activities (id, lead_id, kind, body, created_by_name)
    values (
      ${uid()}, ${leadId}, ${savedQuote ? "quote" : "system"},
      ${`Palmetto Apply${input.referenceId ? ` · ${input.referenceId}` : ""}${input.dealerName ? ` · ${input.dealerName}` : ""}${savedQuote ? ` · quote saved ${money(savedQuote.monthly)}/mo` : ""}${heroOk ? " · hero shot attached" : ""} · unassigned`},
      ${"Palmetto"}
    )
  `;

  const link = `${publicAppUrl()}/leads/${leadId}?tab=lead`;
  const staff = await sql<{ email: string; name: string }>`
    select email, name from profiles
    where active = true
      and role in ('gsm', 'admin', 'credit_manager')
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
        `${name} applied on Palmetto. Unassigned — pick who works it.`,
        ``,
        `  Phone: ${input.phone || "—"}`,
        `  Email: ${input.email || "—"}`,
        `  Vehicle: ${input.vehicle || "—"}`,
        `  Dealer: ${input.dealerName || "—"}`,
        `  ${quoteLines.join(" · ") || "No quote numbers"}`,
        `  Consent: ${input.creditConsent ? "yes" : "not marked"}`,
        savedQuote ? `  Saved quote: ${money(savedQuote.monthly)}/mo` : "",
        ``,
        link,
      ].join("\n"),
    }).catch(() => null);
  }

  return { ok: true, id: leadId };
}
