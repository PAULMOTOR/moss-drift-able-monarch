/** Deterministic Paul Motor underwriting gates — not model judgment. */

export type CitizenshipStatus =
  | "canadian_citizen"
  | "permanent_resident"
  | "work_permit"
  | "student"
  | "other"
  | "unknown";

export type UnderwriteInputs = {
  yieldPct: number | null;
  primeRate: number;
  creditScore: number | null;
  citizenship: CitizenshipStatus;
  vehicleYear: number | null;
  salePrice: number | null;
  marketValue: number | null;
  carfaxClaim: number | null;
  cashDown: number | null;
  financed: number | null;
};

export type PolicyFlag = {
  id: string;
  severity: "pass" | "warn" | "fail";
  label: string;
  detail: string;
};

export type PolicyResult = {
  asOfYear: number;
  vehicleAge: number | null;
  needsYieldFloor: boolean;
  yieldFloorPct: number;
  yieldOk: boolean | null;
  adjustedMarket: number | null;
  carfaxHaircut: number;
  priceOk: boolean | null;
  flags: PolicyFlag[];
  /** Plain approve is not allowed when true. */
  blockPlainApprove: boolean;
  suggestedCashDown: number | null;
};

const CLAIM_HAIRCUT_RATE = 0.2; // $25k claim → ~$5k value hit
const PRICE_TOLERANCE = 1.05;
const SCORE_FLOOR = 690;
const AGE_FLOOR = 8;

export function vehicleAgeYears(year: number | null, asOf = new Date().getFullYear()): number | null {
  if (!year || year < 1980 || year > asOf + 1) return null;
  return Math.max(0, asOf - year);
}

export function isNonCitizen(c: CitizenshipStatus): boolean {
  return c === "work_permit" || c === "student" || c === "other";
}

export function runUnderwritePolicy(input: UnderwriteInputs): PolicyResult {
  const asOfYear = new Date().getFullYear();
  const age = vehicleAgeYears(input.vehicleYear, asOfYear);
  const scoreLow = input.creditScore != null && input.creditScore < SCORE_FLOOR;
  const oldCar = age != null && age > AGE_FLOOR;
  const nonCitizen = isNonCitizen(input.citizenship);
  const needsYieldFloor = nonCitizen || scoreLow || oldCar;
  const yieldFloorPct = input.primeRate + 3;
  const yieldOk =
    input.yieldPct == null ? null : !needsYieldFloor || input.yieldPct + 1e-6 >= yieldFloorPct;

  const carfaxHaircut = Math.max(0, (input.carfaxClaim || 0) * CLAIM_HAIRCUT_RATE);
  const adjustedMarket =
    input.marketValue != null ? Math.max(0, input.marketValue - carfaxHaircut) : null;
  const priceOk =
    input.salePrice != null && adjustedMarket != null && adjustedMarket > 0
      ? input.salePrice <= adjustedMarket * PRICE_TOLERANCE
      : null;

  const flags: PolicyFlag[] = [];

  if (needsYieldFloor) {
    const why = [
      nonCitizen ? "non-citizen / no PR" : "",
      scoreLow ? `score ${input.creditScore} < ${SCORE_FLOOR}` : "",
      oldCar ? `vehicle ${age} yrs (> ${AGE_FLOOR})` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    flags.push({
      id: "yield_floor",
      severity: yieldOk === false ? "fail" : yieldOk ? "pass" : "warn",
      label: `Yield must be ≥ prime + 3% (${yieldFloorPct.toFixed(2)}%)`,
      detail:
        input.yieldPct == null
          ? `Required because ${why}. No yield on file — accept a quote first.`
          : `Deal yield ${input.yieldPct.toFixed(2)}% vs floor ${yieldFloorPct.toFixed(2)}% (${why}).`,
    });
  } else {
    flags.push({
      id: "yield_floor",
      severity: "pass",
      label: "Prime + 3% floor not required",
      detail: `Citizen/PR, score ${input.creditScore ?? "n/a"}, vehicle age ${age ?? "n/a"}.`,
    });
  }

  if (input.carfaxClaim && input.carfaxClaim > 0) {
    flags.push({
      id: "carfax",
      severity: priceOk === false ? "fail" : "warn",
      label: `Carfax claim ${money(input.carfaxClaim)} → haircut ${money(carfaxHaircut)}`,
      detail:
        adjustedMarket != null
          ? `Adjusted market ${money(adjustedMarket)}. Sale ${money(input.salePrice)}.`
          : "Enter a Canadian market value so we can test the sale price.",
    });
  } else if (input.marketValue != null && input.salePrice != null) {
    flags.push({
      id: "market",
      severity: priceOk === false ? "fail" : "pass",
      label: "Sale vs market",
      detail: `Sale ${money(input.salePrice)} vs market ${money(input.marketValue)}.`,
    });
  }

  if (input.creditScore != null && input.creditScore < 600) {
    flags.push({
      id: "score_very_low",
      severity: "fail",
      label: `Credit score ${input.creditScore} is very low`,
      detail: "Expect a large cash down or send back — do not treat as a standard file.",
    });
  }

  const blockPlainApprove = flags.some((f) => f.severity === "fail");

  let suggestedCashDown: number | null = null;
  if (input.salePrice && (yieldOk === false || priceOk === false || scoreLow)) {
    const base = input.cashDown || 0;
    const bump =
      (yieldOk === false ? 0.08 : 0) +
      (priceOk === false ? 0.05 : 0) +
      (scoreLow ? 0.07 : 0);
    suggestedCashDown = Math.round((Math.max(base, input.salePrice * (0.15 + bump)) + Number.EPSILON) / 100) * 100;
  }

  return {
    asOfYear,
    vehicleAge: age,
    needsYieldFloor,
    yieldFloorPct,
    yieldOk,
    adjustedMarket,
    carfaxHaircut,
    priceOk,
    flags,
    blockPlainApprove,
    suggestedCashDown,
  };
}

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(n);
}
