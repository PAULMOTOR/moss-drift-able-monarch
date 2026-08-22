/**
 * Paul Motor lease quote engine — mirrors the company Google Sheet (QUOTE tab).
 *
 * Core payment:
 *   financed (payment cap) = cost + extra + pad - tradeIn + payout - cashDown
 *   tax cap (individual + trade) = cost + extra - tradeIn - cashDown
 *     (pad is cap-cost only — never in sale price or tax cap)
 *     → monthly tax = statutory tax on PMT(tax cap), applied onto PMT(payment cap)
 *   Business / no trade: no tax credit (tax the real payment).
 *   Financed trade payout includes tax (use as-is). Lease buyout is pre-tax
 *     → individual payout funded = lien × (1 + combined tax).
 *   basePmt  = PMT(rate/12, term, -financed, residual)
 *   payment  = basePmt + handling
 *
 * Cash down (`deposit`): taxed; reduces cap cost / loan balance.
 * Security deposit (`securityDeposit`): NOT taxed; does NOT reduce financed;
 * appears on 1st invoice + lease contract only.
 *
 * Pro-rata (1st invoice / due on delivery):
 *   proRata = payment * (daysLeftInMonth / daysInMonth)   // 0 days → $0
 *   proRataTax = full provincial/HST on proRata (never the reduced NAV monthly code)
 */

import { PALMETTO_DATA_URI } from "./palmetto-data-uri";

/**
 * Flat combined rates for non-BC provinces.
 * BC uses TRV-based ICE vehicle PST (see bcIcePstFromTrv) + 5% GST — not this table.
 */
export const PROVINCE_TAX: Record<string, number> = {
  QC: 0.14975, // GST 5 + QST 9.975
  ON: 0.13, // HST
  BC: 0.12, // fallback only; real BC quotes use TRV chart
  AB: 0.05, // GST
  MB: 0.12, // GST 5 + RST 7
  SK: 0.11, // GST 5 + PST 6
  NS: 0.15, // HST
  NB: 0.15,
  NL: 0.15,
  PE: 0.15,
  NT: 0.05,
  NU: 0.05,
  YT: 0.05,
};

export type LeaseOptionInput = {
  cost: number;
  /** Deprecated — kept 0 for backward compatibility; not shown in UI. */
  extra: number;
  profit: number;
  tradeIn: number;
  /** Outstanding lien / loan on trade-in. Net equity = tradeIn - tradeInLien (can be negative). */
  tradeInLien: number;
  /**
   * Cash down (down payment) — NOT a refundable deposit.
   * Taxed at delivery; reduces capitalized cost / loan balance.
   * Field name `deposit` kept for saved-quote compatibility.
   */
  deposit: number;
  /**
   * Refundable security deposit — not taxed; does not reduce loan balance.
   * Optional on older saved quotes (defaults to 0).
   */
  securityDeposit?: number;
  termMonths: number;
  ratePct: number;
  residual: number;
  handling: number;
};

export type LeaseOptionResult = LeaseOptionInput & {
  /** Sticker / sale price (cost + extra). Pad is NOT included. */
  salePrice: number;
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
  /** Cap cost used for the customer payment (includes payout). */
  paymentCapCost: number;
  /** Cap cost used for tax / tax-credit (trade allowance only; no lien). */
  taxCapCost: number;
  /** Cheque we write for the trade payout (lien, or lien+tax if leased individual). */
  payoutFunded: number;
  taxCreditApplied: boolean;
  paymentTaxBase: number;
  /** NAV special-code rates: tax$ / real payment (can be negative). */
  effectiveGstRate: number;
  effectivePstRate: number;
  /** Tax meta (BC TRV / locked PST, etc.) */
  taxProvince: string;
  gstRate: number;
  /** Locked ICE vehicle PST for BC; 0 when province uses combined rate only. */
  pstRate: number;
  /** Combined rate applied to payments/fees (GST+PST or provincial combined). */
  taxCombinedRate: number;
  /** Gross capitalized cost used as BC Tax Rate Value (TRV). */
  trv: number;
  trvBand: string;
  gstOnPayment: number;
  pstOnPayment: number;
  /** Residual/buyout tax if purchased at lease end (locked PST + GST for BC). */
  residualTax: number;
  residualGst: number;
  residualPst: number;
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
  /** RWD / FWD / AWD / 4×4 from VIN explode. */
  driveType?: string;
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
  /** Customer trade-in vehicle (for Chris / contracts — not the leased unit). */
  tradeVin?: string;
  tradeYear?: number | null;
  tradeMake?: string;
  tradeModel?: string;
  tradeTrim?: string;
  tradeDriveType?: string;
  tradeColor?: string;
  tradeKm?: number | null;
  /**
   * How the trade is paid out.
   * financed = bank loan balance already includes tax (cheque = lien).
   * leased  = lessor buyout is pre-tax; we fund lien + tax (individuals).
   */
  tradeKind?: "financed" | "leased";
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
 * Excel RATE-style inverse of the lease payment — annual yield % (nominal).
 *
 * Uses beginning-of-period convention (Excel RATE type=1 / annuity due), which
 * matches Dynamics 365 Business Central “Yield” on lease quotes. With that
 * convention, yield is slightly higher than the contractual interest rate even
 * when handling is $0 (e.g. 7.49% rate → ~7.54% yield). Handling added into
 * the payment increases yield further (interest + handling combined).
 *
 * Solves monthly r where:
 *   -financed*(1+r)^n + payment*(1+r)*((1+r)^n-1)/r + residual = 0
 */
export function yieldPctFromPayment(
  termMonths: number,
  payment: number,
  financed: number,
  residual: number,
): number {
  if (termMonths <= 0 || payment <= 0 || financed <= 0) return 0;
  let lo = 0;
  let hi = 0.5; // 50% monthly cap
  for (let i = 0; i < 100; i++) {
    const r = (lo + hi) / 2;
    let npv: number;
    if (Math.abs(r) < 1e-15) {
      npv = -financed + payment * termMonths + residual;
    } else {
      const pow = Math.pow(1 + r, termMonths);
      // type = 1 (beginning of period) — Dynamics BC Yield
      npv = -financed * pow + (payment * (1 + r) * (pow - 1)) / r + residual;
    }
    // npv > 0 ⇒ discount rate too low
    if (npv > 0) lo = r;
    else hi = r;
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

/**
 * BC ICE vehicle PST brackets (luxury vehicle tax) — locked from TRV at lease inception.
 * Combined rate = PST + 5% federal GST.
 */
export function bcIcePstFromTrv(trv: number): { pstRate: number; band: string } {
  const v = Math.max(0, trv || 0);
  if (v < 55_000) return { pstRate: 0.07, band: "Under $55,000 → PST 7%" };
  if (v < 56_000) return { pstRate: 0.08, band: "$55,000–$55,999.99 → PST 8%" };
  if (v < 57_000) return { pstRate: 0.09, band: "$56,000–$56,999.99 → PST 9%" };
  if (v < 125_000) return { pstRate: 0.1, band: "$57,000–$124,999.99 → PST 10%" };
  if (v < 150_000) return { pstRate: 0.15, band: "$125,000–$149,999.99 → PST 15%" };
  return { pstRate: 0.2, band: "$150,000 and over → PST 20%" };
}

/** Gross Capitalized Cost used as BC Tax Rate Value (TRV) at inception. */
export function grossCapitalizedCost(input: Pick<LeaseOptionInput, "cost" | "extra" | "profit">): number {
  return round2(Math.max(0, (input.cost || 0) + (input.extra || 0) + (input.profit || 0)));
}

export type LeaseTaxRates = {
  province: string;
  gstRate: number;
  pstRate: number;
  combinedRate: number;
  trv: number;
  trvBand: string;
  isBc: boolean;
};

/**
 * Resolve GST/PST (or combined) for a quote.
 * BC: TRV = gross cap cost → lock PST from chart; GST always 5%.
 * lockedPstRate: if set (reopened quote), keep inception PST even if price edited.
 */
export function resolveLeaseTaxRates(
  province: string,
  trv: number,
  lockedPstRate?: number | null,
): LeaseTaxRates {
  const p = (province || "QC").trim().toUpperCase() || "QC";
  if (p === "BC") {
    const { pstRate, band } =
      lockedPstRate != null && Number.isFinite(lockedPstRate)
        ? { pstRate: lockedPstRate, band: `Locked PST ${(lockedPstRate * 100).toFixed(0)}% (inception TRV)` }
        : bcIcePstFromTrv(trv);
    const gstRate = 0.05;
    return {
      province: "BC",
      gstRate,
      pstRate,
      combinedRate: round2((gstRate + pstRate) * 1e6) / 1e6,
      trv: round2(trv),
      trvBand: band,
      isBc: true,
    };
  }
  // Explicit GST + provincial sales tax (tax credit uses these statutory rates on the tax-cap PMT)
  const split: Record<string, { gst: number; pst: number; label?: string }> = {
    QC: { gst: 0.05, pst: 0.09975 },
    MB: { gst: 0.05, pst: 0.07 },
    SK: { gst: 0.05, pst: 0.06 },
  };
  if (split[p]) {
    const { gst, pst } = split[p];
    return {
      province: p,
      gstRate: gst,
      pstRate: pst,
      combinedRate: gst + pst,
      trv: round2(trv),
      trvBand: "",
      isBc: false,
    };
  }
  // HST / GST-only provinces — one statutory rate on the tax-cap PMT
  const combined = taxRateForProvince(p);
  return {
    province: p,
    gstRate: combined,
    pstRate: 0,
    combinedRate: combined,
    trv: round2(trv),
    trvBand: "",
    isBc: false,
  };
}

/** GST + PST on an amount (BC rounds each tax separately). */
export function taxSplitOnAmount(
  amount: number,
  rates: LeaseTaxRates,
  allowNegative = false,
): { gst: number; pst: number; total: number } {
  const a = allowNegative ? Number(amount) || 0 : Math.max(0, amount || 0);
  const gst = round2(a * rates.gstRate);
  const pst = round2(a * rates.pstRate);
  return { gst, pst, total: round2(gst + pst) };
}

export type TradeTaxCtx = {
  partyType?: string;
  tradeKind?: "financed" | "leased";
};

/** Cheque to pay off the trade. Lease buyouts are pre-tax; bank loans already include tax. */
export function tradePayoutFunded(
  lien: number,
  kind: "financed" | "leased" | undefined,
  partyType: string | undefined,
  combinedRate: number,
): number {
  const L = Math.max(0, lien || 0);
  if (L <= 0) return 0;
  const isBiz = (partyType || "individual").toLowerCase() === "business";
  if (kind === "leased" && !isBiz) return round2(L * (1 + (combinedRate || 0)));
  return round2(L);
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
  /**
   * Province code (preferred, e.g. "BC") or legacy combined tax rate number.
   * When a number is passed, BC TRV logic is skipped.
   */
  provinceOrTaxRate: string | number,
  fees: {
    admin: number;
    tracker: number;
    lienPpsa: number;
    license: number;
    tireTax: number;
  },
  proRataCtx?: { startDate: string; daysLeftOverride?: number | null },
  /** Keep inception PST when reopening a saved BC quote. */
  locked?: { pstRate?: number | null },
  tradeCtx?: TradeTaxCtx,
): LeaseOptionResult {
  const cost = Math.max(0, input.cost || 0);
  const extra = input.extra || 0; // always 0 in new UI
  const profit = input.profit || 0;
  const tradeIn = input.tradeIn || 0;
  const tradeInLien = Math.max(0, input.tradeInLien || 0);
  const deposit = input.deposit || 0; // cash down
  const securityDeposit = Math.max(0, input.securityDeposit || 0);
  const termMonths = Math.max(1, Math.round(input.termMonths || 1));
  const ratePct = Math.max(0, input.ratePct || 0);
  const residual = Math.max(0, input.residual || 0);
  const handling = Math.max(0, input.handling || 0);

  const salePrice = round2(cost + extra);
  // Pad rides only in the amount financed — never in the client-facing price.
  const vehicleTotal = salePrice + profit;

  // --- Tax (BC: lock PST from TRV = gross cap cost; GST 5% always) ---
  const trv = grossCapitalizedCost({ cost, extra, profit });
  let rates: LeaseTaxRates;
  if (typeof provinceOrTaxRate === "number") {
    const r = provinceOrTaxRate;
    rates = {
      province: "—",
      gstRate: r,
      pstRate: 0,
      combinedRate: r,
      trv,
      trvBand: "",
      isBc: false,
    };
  } else {
    rates = resolveLeaseTaxRates(
      provinceOrTaxRate,
      trv,
      locked?.pstRate ?? null,
    );
  }

  const partyType = (tradeCtx?.partyType || "individual").toLowerCase();
  const isBusiness = partyType === "business";
  const tradeKind = tradeCtx?.tradeKind === "leased" ? "leased" : "financed";
  const payoutFunded = tradePayoutFunded(
    tradeInLien,
    tradeKind,
    partyType,
    rates.combinedRate,
  );
  // Payment cap: sale + pad − trade + payout − cash down
  const paymentCapCost = round2(vehicleTotal - tradeIn + payoutFunded - deposit);
  const financed = round2(Math.max(0, paymentCapCost));
  // Tax cap: sale price − trade − cash down. Pad is not part of the tax base.
  const taxCapCost = round2(salePrice - tradeIn - deposit);
  const taxCreditApplied = !isBusiness && tradeIn > 0;

  const monthlyRate = ratePct / 100 / 12;
  const basePmt = pmt(monthlyRate, termMonths, -financed, residual);
  const payment = round2(basePmt + handling);
  const taxBasePmt = taxCreditApplied
    ? round2(pmt(monthlyRate, termMonths, -taxCapCost, residual) + handling)
    : payment;

  const payTax = taxSplitOnAmount(taxBasePmt, rates, taxCreditApplied);
  const taxOnPayment = payTax.total;
  const totalPayment = round2(payment + taxOnPayment);
  const effectiveGstRate = payment !== 0 ? payTax.gst / payment : 0;
  const effectivePstRate = payment !== 0 ? payTax.pst / payment : 0;

  const depositPct = salePrice > 0 ? round2((deposit / salePrice) * 100) : 0;
  const residualPct = salePrice > 0 ? round2((residual / salePrice) * 100) : 0;
  const depreciation = round2((financed - residual) / termMonths);
  const interest = round2(payment - depreciation - handling);
  const yieldPct = yieldPctFromPayment(termMonths, payment, financed, residual);

  const admin = fees.admin || 0;
  const tracker = fees.tracker || 0;
  const lienPpsa = fees.lienPpsa || 0;
  const license = fees.license || 0;
  const tireTax = fees.tireTax || 0;

  const { daysLeft: computedLeft, daysInMonth } = computeDaysLeftInMonth(
    proRataCtx?.startDate || new Date().toISOString().slice(0, 10),
  );
  // null/undefined = auto. 0 = charge no pro-rata. >0 = that many days.
  const daysLeftMonth =
    proRataCtx?.daysLeftOverride != null && Number.isFinite(proRataCtx.daysLeftOverride)
      ? Math.max(0, Math.round(proRataCtx.daysLeftOverride))
      : computedLeft;

  // Pro-rata of the *pre-tax* lease payment. Tax on that rent is always the
  // full provincial/HST rate — never the reduced NAV monthly tax code (that's
  // for the ongoing payment posted to BC only).
  const proRata =
    daysLeftMonth <= 0 || daysInMonth <= 0
      ? 0
      : round2(payment * (daysLeftMonth / daysInMonth));
  const proRataTax = taxSplitOnAmount(proRata, rates).total;

  // Cash down: full GST + locked PST due at delivery (security deposit is untaxed)
  const downpaymentTax = taxSplitOnAmount(deposit, rates).total;
  // Doc / prep / freight-style fees: both GST and locked PST (BC)
  const adminTax = taxSplitOnAmount(admin, rates).total;
  const trackerTax = taxSplitOnAmount(tracker, rates).total;
  const lienTax = taxSplitOnAmount(lienPpsa, rates).total;
  const licenseTax = taxSplitOnAmount(license, rates).total;
  const tireTaxTax = taxSplitOnAmount(tireTax, rates).total;

  // Security deposit is included pre-tax with $0 tax
  const dueSubtotal = round2(
    deposit +
      securityDeposit +
      proRata +
      admin +
      tracker +
      lienPpsa +
      license +
      tireTax,
  );
  const dueTax = round2(
    downpaymentTax + proRataTax + adminTax + trackerTax + lienTax + licenseTax + tireTaxTax,
  );
  const dueTotal = round2(dueSubtotal + dueTax);

  // Lease-end buyout: original locked PST (+ GST), not residual-based bracket
  const residualSplit = taxSplitOnAmount(residual, rates);

  return {
    cost,
    extra,
    profit,
    salePrice,
    tradeIn,
    tradeInLien,
    deposit,
    securityDeposit,
    termMonths,
    ratePct,
    residual,
    handling,
    financed,
    paymentCapCost,
    taxCapCost,
    payoutFunded,
    taxCreditApplied,
    paymentTaxBase: taxBasePmt,
    effectiveGstRate,
    effectivePstRate,
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
    taxProvince: rates.province,
    gstRate: rates.gstRate,
    pstRate: rates.pstRate,
    taxCombinedRate: rates.combinedRate,
    trv: rates.trv,
    trvBand: rates.trvBand,
    gstOnPayment: payTax.gst,
    pstOnPayment: payTax.pst,
    residualTax: residualSplit.total,
    residualGst: residualSplit.gst,
    residualPst: residualSplit.pst,
  };
}

export function emptyOption(partial?: Partial<LeaseOptionInput>): LeaseOptionInput {
  return {
    cost: 0,
    extra: 0,
    profit: 0,
    tradeIn: 0,
    tradeInLien: 0,
    deposit: 0,
    securityDeposit: 0,
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

function tradeVehicleLine(client: ClientQuoteInfo): string {
  const label = [client.tradeYear, client.tradeMake, client.tradeModel, client.tradeTrim, client.tradeDriveType]
    .filter(Boolean)
    .join(" ");
  if (!label && !client.tradeVin && client.tradeKm == null) return "";
  const bits = [
    label || null,
    client.tradeColor ? client.tradeColor : null,
    client.tradeVin ? `VIN ${client.tradeVin}` : null,
    client.tradeKm != null ? `${client.tradeKm.toLocaleString("en-CA")} km` : null,
  ].filter(Boolean);
  return `<tr><td>Trade vehicle</td><td class="num">${escapeHtml(bits.join(" · "))}</td></tr>`;
}

function tradeVehicleLabel(client: ClientQuoteInfo): string {
  return [client.tradeYear, client.tradeMake, client.tradeModel, client.tradeTrim, client.tradeDriveType]
    .filter(Boolean)
    .join(" ");
}

/** Year / make / model / trim / drivetrain for quotes, PDFs, and contracts. */
export function vehicleDisplayLine(
  client: Pick<ClientQuoteInfo, "year" | "make" | "model" | "trim" | "driveType">,
): string {
  return [client.year || "", client.make, client.model, client.trim, client.driveType]
    .filter(Boolean)
    .join(" ");
}

/** Retail quote HTML: logo top-left; always 3 option frames (blank → Option N — N/A). */
export function buildRetailQuoteHtml(
  client: ClientQuoteInfo,
  options: LeaseOptionResult[],
  taxRate: number,
  extras?: { heroDataUrl?: string | null },
): string {
  const optBlocks = [0, 1, 2]
    .map((idx) => {
      const num = idx + 1;
      const o = options[idx];
      const isEmpty = !o || !(o.cost > 0 || o.payment > 0);
      const rateNote =
        num === 3
          ? `<p class="smallprint">Rate and residual subject to credit approval and inventory. Quote valid one week. Excess km: ${formatMoney(client.excessKmFee)}/km over ${client.kmPerYear.toLocaleString("en-CA")} km/yr.</p>`
          : "";
      if (isEmpty) {
        return `
      <div class="opt na">
        <h3>Option ${num} — (N/A)</h3>
        <p class="na-msg">No terms entered for this option.</p>
        ${rateNote}
      </div>`;
      }
      return `
      <div class="opt">
        <h3>Option ${num}</h3>
        <table>
          <tr class="emph"><td>Price</td><td class="num">${formatMoney(o.salePrice)}</td></tr>
          <tr><td>Trade-In</td><td class="num">${formatMoney(o.tradeIn)}</td></tr>
          <tr><td>Trade-In Lien</td><td class="num">${formatMoney(o.tradeInLien || 0)}</td></tr>
          ${tradeVehicleLine(client)}
          <tr class="emph"><td>Cash down</td><td class="num">${formatMoney(o.deposit)} <span class="pct">(${o.depositPct.toFixed(1)}%)</span></td></tr>
          <tr><td>Security deposit</td><td class="num">${formatMoney(o.securityDeposit || 0)}</td></tr>
          <tr><td>Term</td><td class="num">${o.termMonths} mo</td></tr>
          <tr><td>Residual</td><td class="num">${formatMoney(o.residual)} <span class="pct">(${o.residualPct.toFixed(1)}%)</span></td></tr>
          <tr><td>Int. Rate</td><td class="num">${o.ratePct.toFixed(2)}%</td></tr>
          <tr class="emph"><td>Lease Payment</td><td class="num">${formatMoney(o.payment)}</td></tr>
          <tr class="emph"><td>Taxes (${escapeHtml((client.province || "QC").toUpperCase())}${o.taxCreditApplied ? " tax credit" : ""}${o.taxProvince === "BC" ? ` GST ${((o.gstRate || 0) * 100).toFixed(0)}% + PST ${((o.pstRate || 0) * 100).toFixed(0)}%` : ""})</td><td class="num">${formatMoney(o.taxOnPayment)}</td></tr>
          <tr class="total"><td>Total Payment</td><td class="num">${formatMoney(o.totalPayment)}</td></tr>
          <tr><td>Pro-rata (${o.daysLeftMonth}/${o.daysInMonth} d)</td><td class="num">${formatMoney(o.proRata)}</td></tr>
          <tr><td>Pro-rata tax (full ${escapeHtml((client.province || "QC").toUpperCase())} rate)</td><td class="num">${formatMoney(o.proRataTax)}</td></tr>
          <tr><td>Admin / document</td><td class="num">${formatMoney(o.admin)}</td></tr>
          <tr><td>Anti-theft / tracker</td><td class="num">${formatMoney(o.tracker)}</td></tr>
          <tr class="total"><td>Due on delivery</td><td class="num">${formatMoney(o.dueTotal)}</td></tr>
        </table>
        ${rateNote}
      </div>`;
    })
    .join("");

  const vehicle = vehicleDisplayLine(client);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Lease Quote — ${escapeHtml(client.clientName || "Client")}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 28px; }
  .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; border-bottom: 2px solid #008272; padding-bottom: 12px; }
  .brand { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
  .header img.logo { width: 64px; height: 64px; object-fit: contain; background: transparent; }
  .hero-tile { width: 200px; height: 200px; object-fit: contain; background: #fff; border: 1px solid #d2d0ce; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.1); flex-shrink: 0; }
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
  .opt.na { background: #faf9f8; border-style: dashed; }
  .opt.na h3 { color: #605e5c; }
  .na-msg { margin: 0; font-size: 12px; color: #605e5c; }
  .opt h3 { margin: 0 0 8px; font-size: 14px; color: #008272; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  td { padding: 3px 0; }
  td.num { text-align: left; font-variant-numeric: tabular-nums; }
  tr.emph td { font-weight: 700; }
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
    <div class="brand">
      <img class="logo" src="${PALMETTO_DATA_URI}" alt="Paul Motor Co." width="64" height="64"/>
      <div>
        <h1>LEASE QUOTE</h1>
        <p class="sub">PAUL MOTOR LEASING · Valid for one week · ${escapeHtml(client.quoteDate)}</p>
      </div>
    </div>
    ${
      extras?.heroDataUrl && /^data:image\//i.test(extras.heroDataUrl)
        ? `<img class="hero-tile" src="${extras.heroDataUrl}" alt="${escapeHtml(vehicle || "Vehicle")}"/>`
        : ""
    }
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
  const vehicle = vehicleDisplayLine(client);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>First Invoice — ${escapeHtml(client.clientName)}</title>
<style>
  body{font-family:Helvetica,Arial,sans-serif;margin:32px;color:#1a1a1a}
  .header{display:flex;gap:14px;align-items:center;border-bottom:2px solid #008272;padding-bottom:12px;margin-bottom:20px}
  .header img{width:56px;height:56px;object-fit:contain;background:transparent}
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
    <tr><td>Cash down (down payment)</td><td class="num">${formatMoney(option.deposit)}</td></tr>
    <tr><td>Security deposit (refundable, not taxed)</td><td class="num">${formatMoney(option.securityDeposit || 0)}</td></tr>
    <tr><td>Pro-rata lease (${option.daysLeftMonth} of ${option.daysInMonth} days)</td><td class="num">${formatMoney(option.proRata)}</td></tr>
    <tr><td>Pro-rata tax (full rate, not NAV code)</td><td class="num">${formatMoney(option.proRataTax)}</td></tr>
    <tr><td>Document / admin fees</td><td class="num">${formatMoney(option.admin)}</td></tr>
    <tr><td>Anti-theft / tracker</td><td class="num">${formatMoney(option.tracker)}</td></tr>
    <tr><td>Lien / PPSA</td><td class="num">${formatMoney(option.lienPpsa)}</td></tr>
    <tr><td>License</td><td class="num">${formatMoney(option.license)}</td></tr>
    <tr><td>Tire tax</td><td class="num">${formatMoney(option.tireTax)}</td></tr>
    <tr><td>Subtotal</td><td class="num">${formatMoney(option.dueSubtotal)}</td></tr>
    <tr><td>GST/PST/HST on cash down & fees (${(taxRate * 100).toFixed(3)}%)</td><td class="num">${formatMoney(round2(option.dueTax - option.proRataTax))}</td></tr>
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
  const vehicle = vehicleDisplayLine(client);
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
    stock: client.stock || "",
    price: formatMoney(option.salePrice),

    deposit: formatMoney(option.deposit),
    cash_down: formatMoney(option.deposit),
    security_deposit: formatMoney(option.securityDeposit || 0),
    trade_in: formatMoney(option.tradeIn),
    trade_vehicle: tradeVehicleLabel(client) || "—",
    trade_vin: client.tradeVin || "—",
    trade_km: client.tradeKm != null ? String(client.tradeKm) : "—",
    trade_color: client.tradeColor || "—",
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
  const isBiz = style.includes("business");
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
<p><strong>Échange :</strong> {{trade_vehicle}} · VIN {{trade_vin}} · {{trade_km}} km</p>
<ol>
<li><strong>Location.</strong> Terme de {{term}} mois, du {{start_date}} au {{end_date}}.</li>
<li><strong>Montant servant à déterminer le loyer.</strong> Prix {{price}} ; mise de fonds (cash down) {{cash_down}} ; échange {{trade_in}} ; net {{financed}}.</li>
<li><strong>Dépôt de garantie.</strong> {{security_deposit}} (remboursable, non imposable, ne réduit pas le capital).</li>
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
<h1>LESSEE LEASE AGREEMENT</h1>
<p class="sub"><strong>PAUL MOTOR COMPANY INC. DBA PAUL MOTOR LEASING</strong><br/>
4009 rue de Verdun, Montreal, Quebec H4G 1L1<br/>
T: 514-767-0126 · GST 8630820380001 · QST 12081377070001</p>

<table class="meta-grid">
  <tr><td><strong>Lessee${isBiz ? " (Business)" : ""}</strong></td><td>{{client_name}}</td></tr>
  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>
  <tr><td><strong>Phone / Email</strong></td><td>{{phone}} · {{email}}</td></tr>
  <tr><td><strong>Guarantor(s)</strong></td><td>{{guarantor}}</td></tr>
  <tr><td><strong>Salesperson</strong></td><td>{{salesman}}</td></tr>
  <tr><td><strong>Quote date</strong></td><td>{{quote_date}}</td></tr>
</table>

<h2>1. VEHICLE</h2>
<table class="meta-grid">
  <tr><td><strong>Year / Make / Model / Trim</strong></td><td>{{vehicle}}</td></tr>
  <tr><td><strong>VIN</strong></td><td>{{vin}}</td></tr>
  <tr><td><strong>Colour</strong></td><td>{{color}}</td></tr>
  <tr><td><strong>Odometer</strong></td><td>{{km}} km</td></tr>
  <tr><td><strong>Stock #</strong></td><td>{{stock}}</td></tr>
</table>

<h2>2. LEASE TERM</h2>
<p>The Lessor leases the Vehicle to the Lessee for a term of <strong>{{term}} months</strong>,
commencing on <strong>{{start_date}}</strong> and ending on <strong>{{end_date}}</strong>
(the “Term”), unless earlier terminated in accordance with this Agreement.</p>

<h2>3. AMOUNT USED IN DETERMINING RENT</h2>
<table class="nums">
  <tr><td>Selling / capitalized cost</td><td class="num">{{price}}</td></tr>
  <tr><td>Cash down (down payment)</td><td class="num">{{cash_down}}</td></tr>
  <tr><td>Security deposit (refundable, not taxed)</td><td class="num">{{security_deposit}}</td></tr>
  <tr><td>Trade-in allowance</td><td class="num">{{trade_in}}</td></tr>
  <tr><td>Trade vehicle</td><td class="num">{{trade_vehicle}} · VIN {{trade_vin}} · {{trade_km}} km</td></tr>
  <tr><td><strong>Amount used in determining rent (financed)</strong></td><td class="num"><strong>{{financed}}</strong></td></tr>
  <tr><td>Residual / purchase option (ex tax)</td><td class="num">{{residual}}</td></tr>
  <tr><td>Contractual interest rate</td><td class="num">{{rate}} per annum</td></tr>
</table>

<h2>4. MONTHLY PAYMENTS</h2>
<table class="nums">
  <tr><td>Basic monthly rent</td><td class="num">{{payment}}</td></tr>
  <tr><td>Applicable taxes on payment ({{tax_rate}})</td><td class="num">{{tax}}</td></tr>
  <tr><td><strong>Total monthly rent (incl. taxes)</strong></td><td class="num"><strong>{{total_payment}}</strong></td></tr>
</table>
<p>Payments are due on the same calendar day each month as the lease start date (or the last day of the month if shorter), unless otherwise agreed in writing.</p>

<h2>5. AMOUNTS PAYABLE UPON DELIVERY</h2>
<table class="nums">
  <tr><td>Cash down (down payment)</td><td class="num">{{cash_down}}</td></tr>
  <tr><td>Security deposit (refundable, not taxed)</td><td class="num">{{security_deposit}}</td></tr>
  <tr><td>Pro-rata rent for delivery month</td><td class="num">{{pro_rata}}</td></tr>
  <tr><td><strong>Total due on delivery (estimate)</strong></td><td class="num"><strong>{{due_total}}</strong></td></tr>
</table>
<p>Amounts due on delivery may include cash down (taxed), security deposit (not taxed, refundable), pro-rata rent, administration, tracker, lien/PPSA, license, tire tax and applicable taxes, as itemized on the First Invoice attached or delivered with this Agreement.</p>

<h2>6. RESIDUAL / PURCHASE OPTION</h2>
<p>At the end of the Term, subject to the Lessee’s compliance with this Agreement, the Lessee may purchase the Vehicle for the residual amount of <strong>{{residual}}</strong>, plus applicable taxes and a transfer fee of <strong>$200.00</strong>, unless a different fee is required by law or by the Lessor’s then-current policy disclosed in writing.</p>

<h2>7. EXCESS KILOMETRES</h2>
<p>Allowed distance: <strong>{{km_year}} km per year</strong> of the Term (prorated). Excess kilometres are charged at <strong>{{excess_km}} per km</strong> plus applicable taxes, payable at end of Term or earlier termination, unless otherwise agreed.</p>

<h2>8. USE, INSURANCE AND MAINTENANCE</h2>
<ol>
<li>The Lessee shall use the Vehicle lawfully and keep it in good repair, ordinary wear excepted.</li>
<li>The Lessee shall maintain full insurance (including collision and comprehensive) naming the Lessor as loss payee / additional interest as required by the Lessor.</li>
<li>The Lessee shall not sell, pledge, or encumber the Vehicle.</li>
</ol>

<h2>9. DEFAULT AND REMEDIES</h2>
<p>If the Lessee fails to pay any amount when due or breaches a material term, the Lessor may, subject to applicable law, terminate this Agreement, repossess the Vehicle, and recover amounts owing including accelerated rent, residual shortfall, excess kilometres, costs of repossession and reasonable legal fees, to the extent permitted by law.</p>

<h2>10. APPLICABLE LAW</h2>
<p>This Agreement is governed by the laws of the province of the Lessee’s address above (or Quebec if blank), and the federal laws of Canada applicable therein. The parties attorn to the courts of that province.</p>

<h2>11. ENTIRE AGREEMENT</h2>
<p>This Agreement, together with the accepted lease quote option and first invoice (if any), constitutes the entire agreement between the parties concerning the lease of the Vehicle and supersedes prior negotiations, except for documents signed later that expressly amend this Agreement.</p>

<p style="margin-top:28px">Executed at Montreal on {{quote_date}}.</p>

<table class="sign">
  <tr>
    <td>
      <p><strong>LESSEE</strong></p>
      <p class="line">Signature</p>
      <p class="line">Name: {{client_name}}</p>
      <p class="line">Date</p>
    </td>
    <td>
      <p><strong>LESSOR — Paul Motor Leasing</strong></p>
      <p class="line">Authorized signature</p>
      <p class="line">Name / Title</p>
      <p class="line">Date</p>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <p><strong>GUARANTOR</strong> (if applicable)</p>
      <p class="line">Signature — {{guarantor}}</p>
      <p class="line">Date</p>
    </td>
  </tr>
</table>
<p class="note">${note}</p>
</div>`;
}

/** Full printable lease contract HTML (spreadsheet ENG tab style) filled from quote option. */
export function buildLeaseContractDocument(
  client: ClientQuoteInfo,
  option: LeaseOptionResult,
  taxRate: number,
  style: ContractStyleKey = "qc_individual_en",
  templateBody?: string | null,
): string {
  const bodySrc =
    templateBody && !/Template style:|Modèle /.test(templateBody)
      ? templateBody
      : defaultContractBody(style);
  const filled = renderContractTemplate(bodySrc, client, option, taxRate);
  const title = `Lease Contract — ${client.clientName}`;
  return wrapPrintable(title, filled);
}

export function wrapPrintable(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
body{font-family:Helvetica,Arial,sans-serif;margin:28px;color:#1a1a1a;font-size:12.5px;line-height:1.45}
h1{color:#008272;font-size:18px;margin:0 0 6px}
h2{color:#008272;font-size:13px;margin:18px 0 8px;border-bottom:1px solid #c8c6c4;padding-bottom:4px}
.sub{font-size:11px;color:#323130;margin:0 0 14px;line-height:1.4}
ol{padding-left:1.2rem} li{margin-bottom:8px}
table.meta-grid,table.nums,table.sign{width:100%;border-collapse:collapse;margin:8px 0 12px;font-size:12px}
table.meta-grid td,table.nums td{padding:5px 6px;border-bottom:1px solid #edebe9;vertical-align:top}
table.nums td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;width:28%}
table.sign td{width:50%;padding:12px 16px 12px 0;vertical-align:top}
table.sign .line{border-top:1px solid #323130;margin-top:28px;padding-top:4px;font-size:11px;color:#605e5c}
.note{font-size:10px;color:#605e5c;margin-top:16px}
@media print{body{margin:12px}}
</style></head><body>${bodyHtml}</body></html>`;
}
