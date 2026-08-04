/**
 * Paul Motor lease quote engine — mirrors the company Google Sheet (QUOTE tab).
 *
 * Core payment formula (validated against sheet samples):
 *   financed = cost + extra + profit - tradeIn - deposit
 *   basePmt  = PMT(rate/12, term, -financed, residual)   // Excel-compatible
 *   payment  = basePmt + handling
 *   tax      = payment * provincial tax rate
 *   total    = payment + tax
 *
 * Breakdown shown to reps (sheet-style):
 *   depreciation = (financed - residual) / term
 *   interest     = payment - depreciation - handling
 */

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
  /** Vehicle price / cost */
  cost: number;
  /** Accessories / extras */
  extra: number;
  /** Desired profit add-on */
  profit: number;
  tradeIn: number;
  deposit: number;
  termMonths: number;
  /** Annual interest rate percent, e.g. 6.99 */
  ratePct: number;
  residual: number;
  /** Monthly handling $ (sheet column next to 1.50) */
  handling: number;
};

export type LeaseOptionResult = LeaseOptionInput & {
  financed: number;
  depositPct: number;
  residualPct: number;
  depreciation: number;
  interest: number;
  payment: number;
  taxOnPayment: number;
  totalPayment: number;
  /** First invoice / due on delivery components */
  downpaymentTax: number;
  proRata: number;
  proRataTax: number;
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
  notes: string;
  adminFee: number;
  trackerFee: number;
  lienPpsa: number;
  license: number;
  tireTax: number;
};

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Excel-compatible PMT. Use pv negative when amount is financed. */
export function pmt(rate: number, nper: number, pv: number, fv = 0): number {
  if (!Number.isFinite(rate) || !Number.isFinite(nper) || nper <= 0) return 0;
  if (Math.abs(rate) < 1e-15) return -(pv + fv) / nper;
  const pow = Math.pow(1 + rate, nper);
  return -((rate * (pv * pow + fv)) / (pow - 1));
}

/** Suggest handling ≈ $1.50 per $1,000 of vehicle (cost+extra+profit), sheet default. */
export function suggestHandling(cost: number, extra: number, profit: number): number {
  return round2(((cost || 0) + (extra || 0) + (profit || 0)) / 1000 * 1.5);
}

export function taxRateForProvince(province: string): number {
  const key = (province || "QC").trim().toUpperCase();
  return PROVINCE_TAX[key] ?? PROVINCE_TAX.QC;
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
  const taxOnPayment = round2(payment * taxRate);
  const totalPayment = round2(payment + taxOnPayment);

  const admin = fees.admin || 0;
  const tracker = fees.tracker || 0;
  const lienPpsa = fees.lienPpsa || 0;
  const license = fees.license || 0;
  const tireTax = fees.tireTax || 0;

  const downpaymentTax = round2(deposit * taxRate);
  const proRata = payment; // full first month in sheet samples
  const proRataTax = taxOnPayment;
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
    depreciation,
    interest,
    payment,
    taxOnPayment,
    totalPayment,
    downpaymentTax,
    proRata,
    proRataTax,
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

/** Build print-friendly HTML matching Retail Quote sheet layout. */
export function buildRetailQuoteHtml(
  client: ClientQuoteInfo,
  options: LeaseOptionResult[],
  taxRate: number,
): string {
  const optBlocks = options
    .filter((o) => o.cost > 0 || o.payment > 0)
    .map((o, i) => {
      return `
      <div class="opt">
        <h3>Option ${i + 1}</h3>
        <table>
          <tr><td>Price</td><td class="num">${formatMoney(o.cost + o.extra + o.profit)}</td></tr>
          <tr><td>Trade-In</td><td class="num">${formatMoney(o.tradeIn)}</td></tr>
          <tr><td>Cash-down</td><td class="num">${formatMoney(o.deposit)}</td></tr>
          <tr><td>Term</td><td class="num">${o.termMonths} mo</td></tr>
          <tr><td>Residual</td><td class="num">${formatMoney(o.residual)}</td></tr>
          <tr><td>Int. Rate</td><td class="num">${o.ratePct.toFixed(2)}%</td></tr>
          <tr><td>Lease Payment</td><td class="num">${formatMoney(o.payment)}</td></tr>
          <tr><td>Taxes (${(taxRate * 100).toFixed(3)}%)</td><td class="num">${formatMoney(o.taxOnPayment)}</td></tr>
          <tr class="total"><td>Total Payment</td><td class="num">${formatMoney(o.totalPayment)}</td></tr>
          <tr><td>Due on delivery</td><td class="num">${formatMoney(o.dueTotal)}</td></tr>
        </table>
      </div>`;
    })
    .join("");

  const vehicle = [
    client.year || "",
    client.make,
    client.model,
    client.trim,
  ]
    .filter(Boolean)
    .join(" ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Lease Quote — ${escapeHtml(client.clientName || "Client")}</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #323130; margin: 32px; }
  h1 { color: #008272; font-size: 22px; margin: 0 0 4px; }
  .sub { color: #605e5c; font-size: 12px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; font-size: 13px; margin-bottom: 28px; }
  .label { color: #605e5c; }
  .opts { display: flex; gap: 16px; flex-wrap: wrap; }
  .opt { border: 1px solid #edebe9; border-radius: 4px; padding: 12px 16px; min-width: 200px; flex: 1; }
  .opt h3 { margin: 0 0 8px; font-size: 14px; color: #008272; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 4px 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { font-weight: 700; border-top: 1px solid #edebe9; padding-top: 8px; }
  footer { margin-top: 32px; font-size: 11px; color: #605e5c; border-top: 1px solid #edebe9; padding-top: 12px; }
  @media print { body { margin: 16px; } }
</style>
</head>
<body>
  <h1>LEASE QUOTE</h1>
  <p class="sub">Paul Motor Co. · Valid for one week from quote date · ${escapeHtml(client.quoteDate)}</p>
  <div class="grid">
    <div><span class="label">Prepared for</span><br/><strong>${escapeHtml(client.clientName)}</strong></div>
    <div><span class="label">Vehicle</span><br/><strong>${escapeHtml(vehicle)}</strong></div>
    <div><span class="label">Phone</span><br/>${escapeHtml(client.phone || "—")}</div>
    <div><span class="label">Colour / KM</span><br/>${escapeHtml(client.color || "—")} · ${client.km != null ? client.km.toLocaleString("en-CA") : "—"} km</div>
    <div><span class="label">Email</span><br/>${escapeHtml(client.email || "—")}</div>
    <div><span class="label">VIN / Stock</span><br/>${escapeHtml(client.vin || "—")} · ${escapeHtml(client.stock || "—")}</div>
    <div><span class="label">Salesman</span><br/>${escapeHtml(client.salesman || "—")}</div>
    <div><span class="label">KM allowance</span><br/>${client.kmPerYear.toLocaleString("en-CA")} km/yr · ${formatMoney(client.excessKmFee)}/km over</div>
  </div>
  <div class="opts">${optBlocks || "<p>No options calculated.</p>"}</div>
  <footer>
    PAUL MOTOR COMPANY INC. DBA PAUL MOTOR LEASING<br/>
    4009 rue de Verdun, Montreal, QC H4G 1L1 · T: 514-767-0126 · www.paulmotor.com<br/>
    ${client.notes ? escapeHtml(client.notes) : ""}
  </footer>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  const amp = String.fromCharCode(38);
  return String(s)
    .split(amp)
    .join(amp + "amp;")
    .split("<")
    .join(amp + "lt;")
    .split(">")
    .join(amp + "gt;")
    .split('"')
    .join(amp + "quot;");
}
