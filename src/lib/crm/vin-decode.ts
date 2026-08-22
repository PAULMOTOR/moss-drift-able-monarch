/**
 * VIN decode ("explosion") via NHTSA vPIC — free US DOT API.
 * Colour is not encoded in the VIN and is never returned.
 * https://vpic.nhtsa.dot.gov/api/
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

export const DRIVE_TYPE_OPTIONS = ["RWD", "FWD", "AWD", "4×4"] as const;
export type DriveTypeOption = (typeof DRIVE_TYPE_OPTIONS)[number];

/** Map NHTSA DriveType (and similar) to RWD / FWD / AWD / 4×4. */
export function normalizeDriveType(raw: string): DriveTypeOption | "" {
  const s = String(raw || "").toLowerCase();
  if (!s.trim()) return "";
  if (/all[-\s]?wheel|\bawd\b/.test(s)) return "AWD";
  if (/4x4|four[-\s]?wheel|\b4wd\b|4-wheel/.test(s)) return "4×4";
  if (/rear[-\s]?wheel|\brwd\b/.test(s)) return "RWD";
  if (/front[-\s]?wheel|\bfwd\b/.test(s)) return "FWD";
  if (/4x2|2wd/.test(s)) return "RWD";
  return "";
}

export type VinDecodeResult = {
  vin: string;
  year: number | null;
  make: string;
  model: string;
  trim: string;
  series: string;
  bodyClass: string;
  driveType: string;
  fuelType: string;
  plantCountry: string;
  manufacturer: string;
  /** True when NHTSA returned a usable year + make + model */
  ok: boolean;
  message: string;
};

/** Strip to 17-char VIN alphabet (no I, O, Q). */
export function normalizeVin(raw: string): string {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-HJ-NPR-Z0-9]/g, "")
    .slice(0, 17);
}

function pick(...vals: Array<string | null | undefined>): string {
  for (const v of vals) {
    const s = String(v || "").trim();
    if (s && s !== "Not Applicable" && s !== "null") return s;
  }
  return "";
}

export async function decodeVinNhtsa(rawVin: string): Promise<VinDecodeResult> {
  const vin = normalizeVin(rawVin);
  if (vin.length !== 17) {
    return {
      vin,
      year: null,
      make: "",
      model: "",
      trim: "",
      series: "",
      bodyClass: "",
      driveType: "",
      fuelType: "",
      plantCountry: "",
      manufacturer: "",
      ok: false,
      message: "VIN must be exactly 17 characters (letters I, O, Q are invalid).",
    };
  }

  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    // NHTSA is public; short timeout-friendly
  });
  if (!res.ok) {
    throw new Error(`NHTSA VIN service error (${res.status})`);
  }
  const json = (await res.json()) as {
    Results?: Array<Record<string, string | number | null>>;
    Message?: string;
  };
  const row = json.Results?.[0] || {};
  const yearRaw = String(row.ModelYear || "").trim();
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
  const make = pick(String(row.Make || ""));
  const model = pick(String(row.Model || ""));
  const series = pick(String(row.Series || ""), String(row.Series2 || ""));
  const trim = pick(String(row.Trim || ""), String(row.Trim2 || ""), series);
  const bodyClass = pick(String(row.BodyClass || ""));
  const driveType = normalizeDriveType(
    pick(String(row.DriveType || ""), String(row.DriveType2 || "")),
  );
  const fuelType = pick(String(row.FuelTypePrimary || ""));
  const plantCountry = pick(String(row.PlantCountry || ""));
  const manufacturer = pick(String(row.Manufacturer || ""), String(row.ManufacturerName || ""));

  const errCode = String(row.ErrorCode || "");
  const errText = String(row.ErrorText || row.AdditionalErrorText || "").trim();
  // NHTSA uses "0" for success; sometimes multi-code "0,1,..." still has usable data
  const hasCore = Boolean(year && make && model);
  const ok = hasCore;

  let message = "";
  if (ok) {
    message = `Decoded ${year} ${make} ${model}${trim ? ` ${trim}` : ""}${driveType ? ` ${driveType}` : ""}`;
    if (errCode && errCode !== "0" && !errCode.startsWith("0,")) {
      message += ` (NHTSA note: ${errText || errCode})`;
    }
  } else {
    message =
      errText ||
      json.Message ||
      "Could not decode this VIN. Check the number or enter vehicle fields manually.";
  }

  return {
    vin,
    year,
    make,
    model,
    trim,
    series,
    bodyClass,
    driveType,
    fuelType,
    plantCountry,
    manufacturer,
    ok,
    message,
  };
}

export const decodeVin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { vin: string }) => data)
  .handler(async ({ data }) => {
    return decodeVinNhtsa(data.vin);
  });
