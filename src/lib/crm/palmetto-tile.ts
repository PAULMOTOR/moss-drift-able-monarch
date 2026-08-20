/**
 * Palmetto inventory tile via xAI Grok Imagine (dual-image edit).
 * Same composition as palmettoleasing.com. Never store imgen.x.ai URLs.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "@/lib/db";
import { HERO_SHOT_KIND } from "./types";

const STYLE_LOCK_URL = "https://www.palmettoleasing.com/vehicles/palmetto-style-lock.jpg";
const IMAGINE_MODEL = "grok-imagine-image-quality";

let styleLockDataUri: string | null = null;

function uid() {
  return crypto.randomUUID();
}

function xaiKey(): string {
  const key =
    process.env.XAI_IMAGINE_API_KEY?.trim() || process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Add XAI_IMAGINE_API_KEY (or XAI_API_KEY) in Vercel on the CRM project, then Redeploy.",
    );
  }
  return key;
}

export function cleanVehicleLabel(raw: string): string {
  return raw
    .replace(
      /\b(warranty!?|full ppf!?|highly optioned!?|must see!?|loaded!?|rare!?|stunning!?|beautiful!?|mint!?|low kms?|no accidents?|certified|one owner|don't miss|dont miss)\b/gi,
      " ",
    )
    .replace(/[!]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalMake(raw: string): string {
  const s = raw.trim();
  if (/^rolls[\s-]*royce$/i.test(s) || /^rr$/i.test(s)) return "Rolls-Royce";
  if (/^mercedes([\s-]*benz)?$/i.test(s) || /^mb$/i.test(s)) return "Mercedes-Benz";
  if (/^bmw$/i.test(s)) return "BMW";
  if (/^mercedes-benz$/i.test(s)) return "Mercedes-Benz";
  return s;
}

export type VehicleBits = {
  year: string;
  make: string;
  model: string;
  trim: string;
  color: string;
};

export function parseVehicleBits(
  label: string,
  inv?: { year?: string | number | null; make?: string | null; model?: string | null; trim?: string | null; color?: string | null },
): VehicleBits {
  if (inv?.year && inv.make && inv.model) {
    return {
      year: String(inv.year),
      make: canonicalMake(inv.make),
      model: String(inv.model).trim(),
      trim: String(inv.trim || "").trim(),
      color: String(inv.color || "").trim() || "as photographed",
    };
  }
  const cleaned = cleanVehicleLabel(label || "");
  const m = cleaned.match(/^(\d{4})\s+(.+)$/);
  const rest = (m ? m[2] : cleaned).trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const makeRaw = parts[0] || "Vehicle";
  let make = canonicalMake(makeRaw);
  let idx = 1;
  if (/^rolls$/i.test(makeRaw) && /^royce$/i.test(parts[1] || "")) {
    make = "Rolls-Royce";
    idx = 2;
  }
  if (/^mercedes$/i.test(makeRaw) && /^benz$/i.test(parts[1] || "")) {
    make = "Mercedes-Benz";
    idx = 2;
  }
  const model = parts[idx] || rest || "car";
  const trim = parts.slice(idx + 1).join(" ");
  return {
    year: m?.[1] || String(inv?.year || ""),
    make,
    model,
    trim,
    color: String(inv?.color || "").trim() || "as photographed",
  };
}

const JUNK_NAME =
  /flag|maple|leaf|logo|icon|banner|watermark|carfax|price|warranty|silhouette|generic|language|lang-?icon|chrome|header|interior|dash|seat|vin.?sticker|body.?style/i;

export function pickListingPhoto<T extends { file_name: string; mime_type?: string | null; file_data: string }>(
  docs: T[],
): T | null {
  const images = docs.filter((d) => {
    const mime = (d.mime_type || "").toLowerCase();
    if (mime.includes("pdf") || /\.pdf$/i.test(d.file_name)) return false;
    return (
      /^data:image\//i.test(d.file_data) ||
      mime.startsWith("image/") ||
      /\.(jpe?g|png|webp|gif)$/i.test(d.file_name)
    );
  });
  if (!images.length) return null;
  const clean = images.filter((d) => !JUNK_NAME.test(d.file_name));
  const pool = clean.length ? clean : images;
  if (pool.length >= 3 && /chrome|logo|icon|header|banner/i.test(pool[0].file_name)) {
    return pool[Math.min(2, pool.length - 1)];
  }
  return [...pool].sort((a, b) => b.file_data.length - a.file_data.length)[0];
}

function palmettoEditPrompt(v: VehicleBits): string {
  const ident = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
  const color = v.color || "as photographed";
  return `Create a photorealistic luxury dealership inventory thumbnail of this exact car: ${ident}. Exact paint from references: ${color}. Use the references only for the car's identity (shape, paint, badges). Ignore any text, banners, prices, watermarks, or photo overlays in the references. SHOW THE ENTIRE CAR — nose to tail, complete silhouette. Do not crop to front half only. Mirrors, roof, rear bumper, and any rear wing must all be inside the frame. CENTERING (mandatory): the car is perfectly dead-centered in the square on both axes. The car's longitudinal centerline is the exact vertical midline of the image — equal white space left and right, pixel-perfect. The hood badge / front emblem sits on that vertical centerline. Do not shift the car left, right, up, or down. ORIENTATION LOCK: the nose of the car points DOWN. Front bumper, headlights, and grille are at the BOTTOM of the image. The rear of the car (tail lights, rear bumper, rear wing/spoiler) is at the TOP of the image. Think: the car is driving toward the bottom edge of the square. NEVER put the nose at the top. NEVER put the rear wing at the bottom. That is upside down and rejected. CAMERA (mandatory): copy the TEMPLATE camera. Elevated FRONT-TOP — camera sits above AND in front of the windshield, looking down the hood. The FRONT FACE of the car (grille, headlights, bumper) must fill much of the BOTTOM third of the square, as large and readable as the roof. The windshield is a wide trapezoid, not a thin slit. You are looking slightly down the nose, not straight down at the roof. FORBIDDEN — drone / satellite / nadir / plan view (roof-only, headlights tiny or hidden). Classic cars like Testarossa are often listed as top-down photos — NEVER copy that angle. FORBIDDEN — eye-level 3/4 hero, side profile, rear 3/4, low front shot. Tilt ~40–50° from vertical, same as the template. Body axis vertical in the frame. WHEELS (mandatory): steering is locked STRAIGHT at 0°. Front wheels point exactly toward the bottom of the frame, parallel to the car's centerline. Do NOT turn, steer, or angle the wheels left or right. No opposite lock. No toe-out. Both fronts match. From this camera the tires sit in the arches — do not render visible turned tire sidewalls or wheel faces kicking out to the sides. CANVAS: output a SQUARE (width in pixels == height). The photo fills that square EDGE TO EDGE. Background is pure #FFFFFF (RGB 255,255,255) to every pixel — never gray, never off-white, never a gray studio plate floating inside a white tile. No inset picture, no letterbox bars, no portrait crop, no landscape crop, no border, no frame. SCALE: whole car ~70% of frame height with even white margin (~8–12%) on all four sides. Nothing clipped. BACKGROUND: pure seamless #FFFFFF only. SHADOW: soft short contact shadow under the car, centered with the car. LIGHTING: soft-box studio, even, realistic paint and glass. Photoreal — not CGI plastic. NO TEXT of any kind — no letters, numbers, prices, slogans, "Warranty", "PPF", license-plate words, watermarks, logos, people, or props. Output one 1:1 square image that bleeds to the edges.

DUAL-IMAGE RULES: Image 0 is the studio TEMPLATE (full car, elevated FRONT-TOP, nose DOWN / front at bottom, dead-centered, straight wheels, white to the edges). Image 1 is the SUBJECT car identity only (paint, body, badges). Discard every overlay, caption, and watermark on Image 1. Output MUST match Image 0 for CAMERA HEIGHT and ANGLE (headlights large at the bottom — not a roof-only drone shot), nose-DOWN orientation, straight unturned wheels, perfect centering, #FFFFFF filling the square with equal width and height, soft shadow. NEVER copy Image 1's camera, crop, gray backdrop, or portrait framing — dealer photos of older Ferraris are often nadir and must be discarded. Final check: car dead-center; headlights and grille readable near the BOTTOM; roof visible; rear at TOP; wheels straight; no text; white to all four edges.`;
}

function palmettoTextPrompt(v: VehicleBits): string {
  const ident = [v.year, v.make, v.model].filter(Boolean).join(" ");
  const color = v.color || "as photographed";
  return `Photoreal luxury inventory thumbnail of a complete ${ident} in ${color}. ENTIRE car nose-to-tail. Perfectly dead-centered. ORIENTATION: nose DOWN — front bumper at BOTTOM, rear at TOP. CAMERA: elevated front-top (grille AND roof both visible). NOT a straight-down overhead. Wheels steered STRAIGHT, hidden in the arches. Pure #FFFFFF fills the square edge to edge. Soft under-car shadow. No text, no gray inset, no 3/4 hero.`;
}

async function loadStyleLockDataUri(): Promise<string> {
  if (styleLockDataUri) return styleLockDataUri;
  try {
    const buf = await readFile(path.join(process.cwd(), "public/vehicles/palmetto-style-lock.jpg"));
    if (buf.length > 1000) {
      styleLockDataUri = `data:image/jpeg;base64,${buf.toString("base64")}`;
      return styleLockDataUri;
    }
  } catch {
    /* fetch */
  }
  const res = await fetch(STYLE_LOCK_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: "image/jpeg,image/*" },
  });
  if (!res.ok) throw new Error(`Style lock fetch failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("Style lock file is empty");
  styleLockDataUri = `data:image/jpeg;base64,${buf.toString("base64")}`;
  return styleLockDataUri;
}

function b64ToDataUrl(b64: string, mime = "image/jpeg"): string {
  const raw = b64.replace(/\s/g, "");
  if (raw.startsWith("data:")) return raw;
  return `data:${mime};base64,${raw}`;
}

async function imagineJson(
  pathUrl: string,
  body: Record<string, unknown>,
): Promise<{ b64: string } | { error: string }> {
  const res = await fetch(`https://api.x.ai/v1/${pathUrl}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${xaiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: `Imagine returned non-JSON (${res.status})` };
  }
  if (!res.ok) {
    const err = json.error;
    const msg =
      typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : text.slice(0, 280);
    return { error: msg || `Imagine HTTP ${res.status}` };
  }
  const data = json.data;
  const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  const b64 = first && typeof first.b64_json === "string" ? first.b64_json : "";
  if (!b64) return { error: "Imagine returned no image bytes" };
  return { b64 };
}

export async function generatePalmettoTileImage(opts: {
  vehicle: VehicleBits;
  listingDataUrl: string | null;
}): Promise<{ dataUrl: string; via: "edit" | "generate" }> {
  if (opts.listingDataUrl) {
    const style = await loadStyleLockDataUri();
    const edited = await imagineJson("images/edits", {
      model: IMAGINE_MODEL,
      prompt: palmettoEditPrompt(opts.vehicle),
      aspect_ratio: "1:1",
      response_format: "b64_json",
      image: [
        { url: style, type: "image_url" },
        { url: opts.listingDataUrl, type: "image_url" },
      ],
    });
    if ("b64" in edited) return { dataUrl: b64ToDataUrl(edited.b64), via: "edit" };
    console.error("[palmetto-tile] dual-image edit failed", edited.error);
  }
  const generated = await imagineJson("images/generations", {
    model: IMAGINE_MODEL,
    prompt: palmettoTextPrompt(opts.vehicle),
    aspect_ratio: "1:1",
    response_format: "b64_json",
  });
  if ("b64" in generated) return { dataUrl: b64ToDataUrl(generated.b64), via: "generate" };
  throw new Error(generated.error || "Palmetto tile generate failed");
}

export async function saveHeroShot(
  sql: Sql,
  opts: {
    leadId: string;
    applicationId: string;
    dataUrl: string;
    via: string;
  },
): Promise<string> {
  const id = uid();
  await sql`
    insert into credit_documents (
      id, application_id, lead_id, kind, file_name, mime_type, file_data, uploaded_via
    ) values (
      ${id}, ${opts.applicationId}, ${opts.leadId}, ${HERO_SHOT_KIND},
      ${"palmetto-tile.jpg"}, ${"image/jpeg"}, ${opts.dataUrl}, ${"crm"}
    )
  `;
  await sql`
    delete from credit_documents
    where lead_id = ${opts.leadId} and kind = ${HERO_SHOT_KIND} and id <> ${id}
  `;
  await sql`
    insert into lead_activities (id, lead_id, kind, body, created_by_name)
    values (
      ${uid()}, ${opts.leadId}, 'credit',
      ${`Palmetto tile saved as Hero Shot (${opts.via})`},
      ${"Imagine"}
    )
  `;
  return id;
}
