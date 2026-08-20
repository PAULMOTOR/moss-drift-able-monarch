/**
 * Resolve a listing photo for our own inventory.
 * Paul Motor units are on AutoTrader (same feed Palmetto crawls) — not behind Cloudflare.
 */
const AT_DEALER =
  "https://www.autotrader.ca/dealers/47941991?cid=47941991";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type InvPhotoHint = {
  year?: number | null;
  make?: string | null;
  model?: string | null;
  stock?: string | null;
  image_url?: string | null;
  external_url?: string | null;
};

export type AtListing = {
  year: number;
  make: string;
  model: string;
  image: string;
  xref: string;
};

let atCache: { at: number; listings: AtListing[] } | null = null;

export function upgradeAtImage(url: string): string {
  return url
    .replace(/\/\d+x\d+\.(?:jpe?g|webp)$/i, "")
    .replace(/\.(webp)$/i, ".jpg");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseAutoTraderListings(html: string): AtListing[] {
  const listings: AtListing[] = [];
  const seen = new Set<string>();

  const next = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (next?.[1]) {
    try {
      const data = JSON.parse(next[1]) as unknown;
      const root = asRecord(data);
      const props = asRecord(root?.props);
      const page = asRecord(props?.pageProps);
      const rows = page?.listings;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const rec = asRecord(row);
          if (!rec) continue;
          const v = asRecord(rec.vehicle) || {};
          const year = Number(v.modelYear);
          const make = String(v.make || "").trim();
          const model = String(v.model || "").trim();
          const images = Array.isArray(rec.images) ? rec.images : [];
          const first = images.find((x) => typeof x === "string" && /listing-images/i.test(x));
          const image = typeof first === "string" ? upgradeAtImage(first) : "";
          const ident = asRecord(rec.identifier);
          const xref = String(
            ident?.crossReferenceId || rec.crossReferenceId || rec.id || "",
          ).trim();
          if (!year || !make || !model || !image) continue;
          const key = `${year}|${make}|${model}|${image}`;
          if (seen.has(key)) continue;
          seen.add(key);
          listings.push({ year, make, model, image, xref });
        }
      }
    } catch {
      /* fall through to regex */
    }
  }

  if (listings.length) return listings;

  const re = /"make":"([^"]+)","model":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const chunk = html.slice(Math.max(0, m.index - 2500), m.index + 9000);
    const yearM = chunk.match(/"modelYear":"?(\d{4})"?/);
    const year = yearM ? Number(yearM[1]) : 0;
    const imgM = chunk.match(
      /https:\/\/prod\.pictures\.autoscout24\.net\/listing-images\/[^"\\]+/i,
    );
    if (!year || !imgM) continue;
    const image = upgradeAtImage(imgM[0]!);
    const key = `${year}|${m[1]}|${m[2]}|${image}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listings.push({
      year,
      make: m[1]!,
      model: m[2]!,
      image,
      xref: "",
    });
  }
  return listings;
}

async function loadAtListings(): Promise<AtListing[]> {
  const now = Date.now();
  if (atCache && now - atCache.at < 10 * 60_000) return atCache.listings;
  const res = await fetch(AT_DEALER, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "en-CA,en;q=0.9",
    },
    signal: AbortSignal.timeout(12_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`AutoTrader dealer page ${res.status}`);
  const html = await res.text();
  const listings = parseAutoTraderListings(html);
  atCache = { at: now, listings };
  return listings;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function xrefFromUrl(url: string | null | undefined): string {
  const m = String(url || "").match(/\/(\d{6,})\/?(?:[?#].*)?$/);
  return m?.[1] || "";
}

function matchListing(hint: InvPhotoHint, rows: AtListing[]): AtListing | null {
  const xref = xrefFromUrl(hint.external_url);
  if (xref) {
    const byX = rows.find((r) => r.xref && r.xref === xref);
    if (byX) return byX;
  }
  const year = hint.year || 0;
  const make = norm(hint.make || "");
  const model = norm(hint.model || "").split(" ")[0] || "";
  if (!year || !make || !model) return null;
  return (
    rows.find((r) => {
      if (r.year !== year) return false;
      if (norm(r.make) !== make) return false;
      const rm = norm(r.model);
      return rm === model || rm.startsWith(model) || model.startsWith(rm);
    }) || null
  );
}

function usableStoredUrl(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (/palmettoleasing\.com\/api\/thumb/i.test(url)) return null;
  if (/paulmotorleasing\.com/i.test(url)) return null;
  return url;
}

export async function resolveInventoryPhotoUrl(hint: InvPhotoHint): Promise<string | null> {
  const stored = usableStoredUrl(hint.image_url);
  if (stored) return stored;
  try {
    const rows = await loadAtListings();
    const hit = matchListing(hint, rows);
    if (hit?.image) return hit.image;
  } catch (e) {
    console.error("[inventory-photos] AutoTrader", e);
  }
  return null;
}

export async function fetchImageAsDataUrl(
  url: string,
): Promise<{ dataUrl: string; mime: string; name: string } | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const target = url.replace(
    /^https?:\/\/palmettoleasing\.com/i,
    "https://www.palmettoleasing.com",
  );
  try {
    const res = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "user-agent": UA,
      },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 400 || buf.length > 4_500_000) return null;
    let mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0]!.trim();
    if (!mime.startsWith("image/")) mime = "image/jpeg";
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    return {
      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
      mime,
      name: `inventory-listing.${ext}`,
    };
  } catch {
    return null;
  }
}
