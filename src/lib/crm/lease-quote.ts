/**
 * Paul Motor lease quote engine — mirrors the company Google Sheet (QUOTE tab).
 *
 * Core payment:
 *   financed = cost + extra + profit - tradeIn - deposit
 *   basePmt  = PMT(rate/12, term, -financed, residual)
 *   payment  = basePmt + handling
 *
 * Pro-rata (1st invoice / due on delivery):
 *   proRata = totalPayment * (daysLeftInMonth / daysInMonth)
 *   days left computed from lease start date (or delivery date).
 */

import { PALMETTO_DATA_URI } from "./palmetto-data-uri";

export const PROVINCE_TAX: Record<string, number> = {
  QC: 0.14975,
  ON: 0.13,
  BC: 0.12,
  AB: 0.05,
  MB: 0.13,
  SK: 0.11,
  NS: 0.15,
  NB: 0.15,
  NL: 0.15,
  PE: 0.15,
  NT: 0.05,
  NU: 0.05,
  YT: 0.05,
};

export type LeaseOptionInput = {
  cost: number;
  extra: number;
  profit: number;
  tradeIn: number;
  deposit: number;
  termMonths: number;
  ratePct: number;
  residual: number;
  handling: number;
};

export type LeaseOptionResult = LeaseOptionInput & {
  financed: number;
  depositPct: number;
  residualPct: number;
  /** Effective annual yield % (Excel RATE on payment incl. handling) — interest + handling combined. */
  yieldPct: number;
  depreciation: number;
  interest: number;
  payment: number;
  taxOnPayment: number;
  totalPayment: number;
  downpaymentTax: number;
  proRata: number;
  proRataTax: number;
  daysLeftMonth: number;
  daysInMonth: number;
  admin: number;
  adminTax: number;
  tracker: number;
  trackerTax: number;
  lienPpsa: number;
  lienTax: number;
  license: number;
  licenseTax: number;
  tireTax: number;
  tireTaxTax: number;
  dueSubtotal: number;
  dueTax: number;
  dueTotal: number;
};

export type ClientQuoteInfo = {
  clientName: string;
  phone: string;
  email: string;
  guarantor: string;
  address: string;
  city: string;
  province: string;
  postalCode: string;
  salesman: string;
  year: number | null;
  make: string;
  model: string;
  trim: string;
  color: string;
  km: number | null;
  vin: string;
  stock: string;
  condition: string;
  kmPerYear: number;
  excessKmFee: number;
  quoteDate: string;
  deliveryDate: string;
  /** Lease start date (first full period) YYYY-MM-DD */
  startDate: string;
  notes: string;
  adminFee: number;
  trackerFee: number;
  lienPpsa: number;
  license: number;
  tireTax: number;
  /** Override days left; if null/0, computed from startDate */
  daysLeftOverride: number | null;
  contractStyle: string;
  partyType: string;
};

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function pmt(rate: number, nper: number, pv: number, fv = 0): number {
  if (!Number.isFinite(rate) || !Number.isFinite(nper) || nper <= 0) return 0;
  if (Math.abs(rate) < 1e-15) return -(pv + fv) / nper;
  const pow = Math.pow(1 + rate, nper);
  return -((rate * (pv * pow + fv)) / (pow - 1));
}

/**
 * Excel RATE-style inverse of PMT — annual yield % implied by a payment that
 * already includes handling (so yield > contract rate when handling > 0).
 * Matches sheet “Yield” as interest + handling combined into an effective rate.
 */
export function yieldPctFromPayment(
  termMonths: number,
  payment: number,
  financed: number,
  residual: number,
): number {
  if (termMonths <= 0 || payment <= 0 || financed <= 0) return 0;
  // Binary search monthly rate r where pmt(r, n, -financed, residual) ≈ payment
  let lo = 0;
  let hi = 0.5; // 50% monthly cap
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const calc = pmt(mid, termMonths, -financed, residual);
    if (calc > payment) hi = mid;
    else lo = mid;
  }
  return round2(lo * 12 * 100);
}

export function suggestHandling(cost: number, extra: number, profit: number): number {
  return round2(((cost || 0) + (extra || 0) + (profit || 0)) / 1000 * 1.5);
}

export function taxRateForProvince(province: string): number {
  const key = (province || "QC").trim().toUpperCase();
  return PROVINCE_TAX[key] ?? PROVINCE_TAX.QC;
}

export function daysInCalendarMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

/**
 * Days remaining in the calendar month of `startDate` including start day
 * if start is not the 1st — sheet uses "days left month" for pro-rata of first period.
 * If lease starts on the 1st, pro-rata days = 0 (first invoice is full first month only via payment).
 * Common dealership practice: delivery mid-month → charge (daysLeft/daysInMonth) * payment.
 */
export function computeDaysLeftInMonth(startDateIso: string): {
  daysLeft: number;
  daysInMonth: number;
} {
  const d = parseLooseDate(startDateIso) || new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const dim = daysInCalendarMonth(y, m);
  // Days remaining after delivery day through end of month (sheet: "Days left month")
  const daysLeft = Math.max(0, dim - day + 1);
  // If full month (start on day 1), some shops set days left = dim; sheet sample used 1
  return { daysLeft, daysInMonth: dim };
}

function parseLooseDate(s: string): Date | null {
  if (!s || !String(s).trim()) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t);
  // MM/DD/YYYY
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return null;
}

export function calcLeaseOption(
  input: LeaseOptionInput,
  taxRate: number,
  fees: {
    admin: number;
    tracker: number;
    lienPpsa: number;
    license: number;
    tireTax: number;
  },
  proRataCtx?: { startDate: string; daysLeftOverride?: number | null },
): LeaseOptionResult {
  const cost = Math.max(0, input.cost || 0);
  const extra = input.extra || 0;
  const profit = input.profit || 0;
  const tradeIn = input.tradeIn || 0;
  const deposit = input.deposit || 0;
  const termMonths = Math.max(1, Math.round(input.termMonths || 1));
  const ratePct = Math.max(0, input.ratePct || 0);
  const residual = Math.max(0, input.residual || 0);
  const handling = Math.max(0, input.handling || 0);

  const vehicleTotal = cost + extra + profit;
  const financed = round2(Math.max(0, vehicleTotal - tradeIn - deposit));
  const depositPct = vehicleTotal > 0 ? round2((deposit / vehicleTotal) * 100) : 0;
  const residualPct = vehicleTotal > 0 ? round2((residual / vehicleTotal) * 100) : 0;

  const monthlyRate = ratePct / 100 / 12;
  const basePmt = pmt(monthlyRate, termMonths, -financed, residual);
  const payment = round2(basePmt + handling);
  const depreciation = round2((financed - residual) / termMonths);
  const interest = round2(payment - depreciation - handling);
  // Yield = effective annual rate of the full payment (interest rate + handling)
  const yieldPct = yieldPctFromPayment(termMonths, payment, financed, residual);
  const taxOnPayment = round2(payment * taxRate);
  const totalPayment = round2(payment + taxOnPayment);

  const admin = fees.admin || 0;
  const tracker = fees.tracker || 0;
  const lienPpsa = fees.lienPpsa || 0;
  const license = fees.license || 0;
  const tireTax = fees.tireTax || 0;

  const { daysLeft: computedLeft, daysInMonth } = computeDaysLeftInMonth(
    proRataCtx?.startDate || new Date().toISOString().slice(0, 10),
  );
  const daysLeftMonth =
    proRataCtx?.daysLeftOverride != null && proRataCtx.daysLeftOverride > 0
      ? Math.round(proRataCtx.daysLeftOverride)
      : computedLeft;

  // Pro-rata of the *pre-tax* lease payment proportional to days left in month
  const proRata =
    daysInMonth > 0
      ? round2(payment * (daysLeftMonth / daysInMonth))
      : payment;
  const proRataTax = round2(proRata * taxRate);

  const downpaymentTax = round2(deposit * taxRate);
  const adminTax = round2(admin * taxRate);
  const trackerTax = round2(tracker * taxRate);
  const lienTax = round2(lienPpsa * taxRate);
  const licenseTax = round2(license * taxRate);
  const tireTaxTax = round2(tireTax * taxRate);

  const dueSubtotal = round2(
    deposit + proRata + admin + tracker + lienPpsa + license + tireTax,
  );
  const dueTax = round2(
    downpaymentTax + proRataTax + adminTax + trackerTax + lienTax + licenseTax + tireTaxTax,
  );
  const dueTotal = round2(dueSubtotal + dueTax);

  return {
    cost,
    extra,
    profit,
    tradeIn,
    deposit,
    termMonths,
    ratePct,
    residual,
    handling,
    financed,
    depositPct,
    residualPct,
    yieldPct,
    depreciation,
    interest,
    payment,
    taxOnPayment,
    totalPayment,
    downpaymentTax,
    proRata,
    proRataTax,
    daysLeftMonth,
    daysInMonth,
    admin,
    adminTax,
    tracker,
    trackerTax,
    lienPpsa,
    lienTax,
    license,
    licenseTax,
    tireTax,
    tireTaxTax,
    dueSubtotal,
    dueTax,
    dueTotal,
  };
}

export function emptyOption(partial?: Partial<LeaseOptionInput>): LeaseOptionInput {
  return {
    cost: 0,
    extra: 0,
    profit: 0,
    tradeIn: 0,
    deposit: 0,
    termMonths: 36,
    ratePct: 6.99,
    residual: 0,
    handling: 0,
    ...partial,
  };
}

export function formatMoney(n: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 2,
  }).format(n || 0);
}

function escapeHtml(s: string): string {
  const amp = String.fromCharCode(38);
  return String(s ?? "")
    .split(amp)
    .join(amp + "amp;")
    .split("<")
    .join(amp + "lt;")
    .split(">")
    .join(amp + "gt;")
    .split('"')
    .join(amp + "quot;");
}

/** Retail quote HTML: logo top-left; 2-col grid so Option 3 sits under Option 1. */
export function buildRetailQuoteHtml(
  client: ClientQuoteInfo,
  options: LeaseOptionResult[],
  taxRate: number,
): string {
  const active = options
    .map((o, i) => ({ o, i: i + 1 }))
    .filter(({ o }) => o.cost > 0 || o.payment > 0);

  const optBlocks = [1, 2, 3]
    .map((num) => {
      const found = active.find((a) => a.i === num);
      if (!found) {
        return `<div class="opt empty"></div>`;
      }
      const o = found.o;
      const rateNote =
        num === 3
          ? `<p class="smallprint">Rate and residual subject to credit approval and inventory. Quote valid one week. Excess km: ${formatMoney(client.excessKmFee)}/km over ${client.kmPerYear.toLocaleString("en-CA")} km/yr.</p>`
          : "";
      return `
      <div class="opt">
        <h3>Option ${num}</h3>
        <table>
          <tr><td>Price</td><td class="num">${formatMoney(o.cost + o.extra + o.profit)}</td></tr>
          <tr><td>Trade-In</td><td class="num">${formatMoney(o.tradeIn)}</td></tr>
          <tr><td>Cash-down</td><td class="num">${formatMoney(o.deposit)} <span class="pct">(${o.depositPct.toFixed(1)}%)</span></td></tr>
          <tr><td>Term</td><td class="num">${o.termMonths} mo</td></tr>
          <tr><td>Residual</td><td class="num">${formatMoney(o.residual)} <span class="pct">(${o.residualPct.toFixed(1)}%)</span></td></tr>
          <tr><td>Int. Rate</td><td class="num">${o.ratePct.toFixed(2)}%</td></tr>
          <tr><td>Yield</td><td class="num">${o.yieldPct.toFixed(2)}%</td></tr>
          <tr><td>Lease Payment</td><td class="num">${formatMoney(o.payment)}</td></tr>
          <tr><td>Taxes</td><td class="num">${formatMoney(o.taxOnPayment)}</td></tr>
          <tr class="total"><td>Total Payment</td><td class="num">${formatMoney(o.totalPayment)}</td></tr>
          <tr><td>Due on delivery</td><td class="num">${formatMoney(o.dueTotal)}</td></tr>
          <tr><td>Pro-rata (${o.daysLeftMonth}/${o.daysInMonth} d)</td><td class="num">${formatMoney(o.proRata)}</td></tr>
        </table>
        ${rateNote}
      </div>`;
    })
    .join("");

  const vehicle = [client.year || "", client.make, client.model, client.trim]
    .filter(Boolean)
    .join(" ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Lease Quote — ${escapeHtml(client.clientName || "Client")}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 28px; }
  .header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 20px; border-bottom: 2px solid #008272; padding-bottom: 12px; }
  .header img { width: 64px; height: 64px; object-fit: contain; background: #008272; border-radius: 4px; padding: 6px; }
  .header h1 { color: #008272; font-size: 22px; margin: 0 0 4px; font-weight: 700; letter-spacing: 0.02em; }
  .sub { color: #605e5c; font-size: 12px; margin: 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; font-size: 13px; margin-bottom: 22px; }
  .label { color: #605e5c; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  /* 2-column grid: opt3 sits under opt1 (left column) */
  .opts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    align-items: start;
  }
  .opt {
    border: 1px solid #c8c6c4;
    border-radius: 2px;
    padding: 12px 14px;
    width: 100%;
    max-width: 100%;
  }
  .opt.empty { border: none; padding: 0; min-height: 0; }
  .opt h3 { margin: 0 0 8px; font-size: 14px; color: #008272; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  td { padding: 3px 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { font-weight: 700; border-top: 1px solid #edebe9; padding-top: 8px; }
  .pct { color: #605e5c; font-size: 11px; font-weight: 400; }
  .smallprint { font-size: 10px; color: #605e5c; margin: 8px 0 0; line-height: 1.35; }
  footer { margin-top: 28px; font-size: 11px; color: #605e5c; border-top: 1px solid #edebe9; padding-top: 12px; }
  @media print {
    body { margin: 12px; }
    .opt { break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="header">
    <img src="${PALMETTO_DATA_URI}" alt="Paul Motor Co." width="64" height="64"/>
    <div>
      <h1>LEASE QUOTE</h1>
      <p class="sub">PAUL MOTOR CO. · Valid for one week · ${escapeHtml(client.quoteDate)}</p>
    </div>
  </div>
  <div class="grid">
    <div><span class="label">Prepared for</span><br/><strong>${escapeHtml(client.clientName)}</strong></div>
    <div><span class="label">Vehicle</span><br/><strong>${escapeHtml(vehicle)}</strong></div>
    <div><span class="label">Phone</span><br/>${escapeHtml(client.phone || "—")}</div>
    <div><span class="label">Colour / KM</span><br/>${escapeHtml(client.color || "—")} · ${client.km != null ? client.km.toLocaleString("en-CA") : "—"} km</div>
    <div><span class="label">Email</span><br/>${escapeHtml(client.email || "—")}</div>
    <div><span class="label">VIN / Stock</span><br/>${escapeHtml(client.vin || "—")} · ${escapeHtml(client.stock || "—")}</div>
    <div><span class="label">Salesman</span><br/>${escapeHtml(client.salesman || "—")}</div>
    <div><span class="label">Guarantor</span><br/>${escapeHtml(client.guarantor || "N/A")}</div>
    <div><span class="label">Lease start</span><br/>${escapeHtml(client.startDate || "—")}</div>
    <div><span class="label">KM allowance</span><br/>${client.kmPerYear.toLocaleString("en-CA")} km/yr · ${formatMoney(client.excessKmFee)}/km over</div>
  </div>
  <div class="opts">${optBlocks}</div>
  <footer>
    <strong>PAUL MOTOR COMPANY INC. DBA PAUL MOTOR LEASING</strong><br/>
    4009 rue de Verdun, Montreal, QC H4G 1L1 · T: 514-767-0126 · www.paulmotor.com<br/>
    ${client.notes ? escapeHtml(client.notes) : ""}
  </footer>
</body>
</html>`;
}

/** First invoice HTML with true pro-rata. */
export function buildFirstInvoiceHtml(
  client: ClientQuoteInfo,
  option: LeaseOptionResult,
  taxRate: number,
): string {
  const vehicle = [client.year, client.make, client.model, client.trim]
    .filter(Boolean)
    .join(" ");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>First Invoice — ${escapeHtml(client.clientName)}</title>
<style>
  body{font-family:Helvetica,Arial,sans-serif;margin:32px;color:#1a1a1a}
  .header{display:flex;gap:14px;align-items:center;border-bottom:2px solid #008272;padding-bottom:12px;margin-bottom:20px}
  .header img{width:56px;height:56px;background:#008272;padding:6px;border-radius:4px}
  h1{color:#008272;margin:0;font-size:20px}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}
  th,td{padding:8px;border-bottom:1px solid #edebe9;text-align:left}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .total td{font-weight:700;border-top:2px solid #008272}
  .meta{font-size:12px;color:#605e5c}
</style></head><body>
<div class="header">
  <img src="${PALMETTO_DATA_URI}" alt="PMC"/>
  <div>
    <h1>PRO-FORMA FIRST INVOICE</h1>
    <p class="meta">${escapeHtml(client.quoteDate)} · GST 8630820380001 · QST 12081377070001</p>
  </div>
</div>
<p><strong>${escapeHtml(client.clientName)}</strong><br/>
${escapeHtml([client.address, client.city, client.province, client.postalCode].filter(Boolean).join(", "))}<br/>
${escapeHtml(client.phone || "")}</p>
<p class="meta">Vehicle: <strong>${escapeHtml(vehicle)}</strong><br/>VIN: ${escapeHtml(client.vin || "—")} · Stock: ${escapeHtml(client.stock || "—")}</p>
<table>
  <thead><tr><th>Item</th><th class="num">Amount</th></tr></thead>
  <tbody>
    <tr><td>Downpayment (cash)</td><td class="num">${formatMoney(option.deposit)}</td></tr>
    <tr><td>Pro-rata lease (${option.daysLeftMonth} of ${option.daysInMonth} days)</td><td class="num">${formatMoney(option.proRata)}</td></tr>
    <tr><td>Document / admin fees</td><td class="num">${formatMoney(option.admin)}</td></tr>
    <tr><td>Anti-theft / tracker</td><td class="num">${formatMoney(option.tracker)}</td></tr>
    <tr><td>Lien / PPSA</td><td class="num">${formatMoney(option.lienPpsa)}</td></tr>
    <tr><td>License</td><td class="num">${formatMoney(option.license)}</td></tr>
    <tr><td>Tire tax</td><td class="num">${formatMoney(option.tireTax)}</td></tr>
    <tr><td>Subtotal</td><td class="num">${formatMoney(option.dueSubtotal)}</td></tr>
    <tr><td>GST/PST/HST (${(taxRate * 100).toFixed(3)}%)</td><td class="num">${formatMoney(option.dueTax)}</td></tr>
    <tr class="total"><td>TOTAL DUE ON DELIVERY</td><td class="num">${formatMoney(option.dueTotal)}</td></tr>
  </tbody>
</table>
<p class="meta" style="margin-top:24px">PAUL MOTOR COMPANY INC. · 4009 rue de Verdun, Montreal, QC H4G 1L1 · 514-767-0126</p>
</body></html>`;
}

export type ContractStyleKey =
  | "qc_individual_en"
  | "qc_individual_fr"
  | "qc_business_en"
  | "qc_business_fr"
  | "ca_business_en"
  | "ca_individual_en";

export const CONTRACT_STYLE_META: Array<{
  key: ContractStyleKey;
  label: string;
  language: string;
  jurisdiction: string;
  party_type: string;
}> = [
  { key: "qc_individual_en", label: "Quebec Individual English", language: "en", jurisdiction: "QC", party_type: "individual" },
  { key: "qc_individual_fr", label: "Quebec Individual French", language: "fr", jurisdiction: "QC", party_type: "individual" },
  { key: "qc_business_en", label: "Quebec Business English", language: "en", jurisdiction: "QC", party_type: "business" },
  { key: "qc_business_fr", label: "Quebec Business French", language: "fr", jurisdiction: "QC", party_type: "business" },
  { key: "ca_business_en", label: "Canada Business lease", language: "en", jurisdiction: "CA", party_type: "business" },
  { key: "ca_individual_en", label: "Canada Individual lease", language: "en", jurisdiction: "CA", party_type: "individual" },
];

/** Fill {{tokens}} in contract template HTML. */
export function renderContractTemplate(
  templateHtml: string,
  client: ClientQuoteInfo,
  option: LeaseOptionResult,
  taxRate: number,
): string {
  const vehicle = [client.year, client.make, client.model, client.trim]
    .filter(Boolean)
    .join(" ");
  const endDate = (() => {
    const s = parseLooseDate(client.startDate) || new Date();
    const e = new Date(s);
    e.setMonth(e.getMonth() + option.termMonths);
    return e.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  })();
  const map: Record<string, string> = {
    client_name: client.clientName,
    guarantor: client.guarantor || "N/A",
    address: [client.address, client.city, client.province, client.postalCode]
      .filter(Boolean)
      .join(", "),
    phone: client.phone || "",
    email: client.email || "",
    vehicle,
    year: String(client.year || ""),
    make: client.make,
    model: client.model,
    trim: client.trim,
    vin: client.vin,
    color: client.color,
    km: client.km != null ? String(client.km) : "",
    price: formatMoney(option.cost + option.extra + option.profit),
    deposit: formatMoney(option.deposit),
    trade_in: formatMoney(option.tradeIn),
    financed: formatMoney(option.financed),
    residual: formatMoney(option.residual),
    rate: `${option.ratePct.toFixed(2)}%`,
    term: String(option.termMonths),
    payment: formatMoney(option.payment),
    tax: formatMoney(option.taxOnPayment),
    total_payment: formatMoney(option.totalPayment),
    due_total: formatMoney(option.dueTotal),
    pro_rata: formatMoney(option.proRata),
    start_date: client.startDate,
    end_date: endDate,
    quote_date: client.quoteDate,
    salesman: client.salesman,
    km_year: String(client.kmPerYear),
    excess_km: formatMoney(client.excessKmFee),
    tax_rate: `${(taxRate * 100).toFixed(3)}%`,
  };
  return templateHtml.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k: string) => {
    return escapeHtml(map[k.toLowerCase()] ?? "");
  });
}

export function defaultContractBody(style: ContractStyleKey): string {
  const isFr = style.includes("_fr");
  const note = isFr
    ? `Modèle ${style} — texte modifiable dans Admin → Contrats.`
    : `Template style: ${style} — edit under Admin → Lease contracts.`;
  if (isFr) {
    return `<div class="contract">
<h1>CONTRAT DE LOCATION — PAUL MOTOR LEASING</h1>
<p><strong>Bailleur :</strong> Paul Motor Leasing Inc., 4009 rue de Verdun, Montréal (Québec) H4G 1L1</p>
<p><strong>Locataire :</strong> {{client_name}} — {{address}}</p>
<p><strong>Caution :</strong> {{guarantor}}</p>
<p><strong>Véhicule :</strong> {{vehicle}} · VIN {{vin}} · Couleur {{color}} · {{km}} km</p>
<ol>
<li><strong>Location.</strong> Terme de {{term}} mois, du {{start_date}} au {{end_date}}.</li>
<li><strong>Montant servant à déterminer le loyer.</strong> Prix {{price}} ; acompte {{deposit}} ; échange {{trade_in}} ; net {{financed}}.</li>
<li><strong>Taux d'intérêt.</strong> {{rate}} l'an.</li>
<li><strong>Loyer mensuel.</strong> Base {{payment}} + taxes {{tax}} = {{total_payment}}.</li>
<li><strong>Valeur résiduelle.</strong> {{residual}} (plus taxes et frais de transfert de 200 $).</li>
<li><strong>Sommes à la livraison.</strong> {{due_total}} (pro rata {{pro_rata}}).</li>
<li><strong>Kilométrage.</strong> {{km_year}} km/an ; excédent {{excess_km}} /km.</li>
</ol>
<p style="margin-top:24px">Fait à Montréal, le {{quote_date}}. Vendeur : {{salesman}}</p>
<p>_________________________ Locataire &nbsp;&nbsp; _________________________ Bailleur</p>
<p class="note">${note}</p>
</div>`;
  }
  return `<div class="contract">
<h1>LESSEE LEASE AGREEMENT — PAUL MOTOR LEASING</h1>
<p><strong>Lessor:</strong> Paul Motor Leasing Inc., 4009 rue de Verdun, Montreal, QC H4G 1L1 · GST 8630820380001 · QST 12081377070001</p>
<p><strong>Lessee:</strong> {{client_name}} — {{address}}</p>
<p><strong>Guarantor:</strong> {{guarantor}}</p>
<p><strong>Vehicle:</strong> {{vehicle}} · VIN {{vin}} · Colour {{color}} · {{km}} km</p>
<ol>
<li><strong>LEASE.</strong> Term of {{term}} months, from {{start_date}} to {{end_date}}.</li>
<li><strong>AMOUNT USED IN DETERMINING RENT.</strong> Price {{price}}; cash {{deposit}}; trade-in {{trade_in}}; amount for rent {{financed}}.</li>
<li><strong>INTEREST RATE.</strong> {{rate}} per annum.</li>
<li><strong>MONTHLY PAYMENTS.</strong> Basic rent {{payment}}; taxes {{tax}}; monthly rent {{total_payment}}.</li>
<li><strong>AMOUNTS PAYABLE UPON DELIVERY.</strong> Total {{due_total}} including pro-rata {{pro_rata}} for remaining days in the delivery month.</li>
<li><strong>RESIDUAL / PURCHASE OPTION.</strong> Residual {{residual}} plus taxes and a $200 transfer fee.</li>
<li><strong>EXCESS KILOMETER.</strong> {{km_year}} km/year; excess {{excess_km}} per km plus taxes.</li>
<li><strong>APPLICABLE LEGISLATION.</strong> Laws of the jurisdiction for this template style apply.</li>
</ol>
<p style="margin-top:24px">Executed at Montreal on {{quote_date}}. Salesperson: {{salesman}}</p>
<p>_________________________ Lessee &nbsp;&nbsp; _________________________ Lessor &nbsp;&nbsp; _________________________ Guarantor</p>
<p class="note">${note}</p>
</div>`;
}

export function wrapPrintable(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
body{font-family:Helvetica,Arial,sans-serif;margin:28px;color:#1a1a1a;font-size:12.5px;line-height:1.45}
h1{color:#008272;font-size:18px}
ol{padding-left:1.2rem} li{margin-bottom:8px}
.note{font-size:10px;color:#605e5c;margin-top:16px}
@media print{body{margin:12px}}
</style></head><body>${bodyHtml}</body></html>`;
}
