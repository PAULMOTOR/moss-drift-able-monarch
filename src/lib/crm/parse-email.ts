import type { LeadType, ParsedEmailLead, SourceId } from "./types";

/**
 * Fast floor helper: paste a whole inventory or lease-inquiry email and
 * extract name / phone / email / vehicle / stock # for the capture form.
 */
export function parseLeadEmail(raw: string): ParsedEmailLead {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const flat = text.replace(/[ \t]+/g, " ");
  const lower = flat.toLowerCase();

  const matched: string[] = [];

  const lead_type = detectLeadType(lower, flat);
  matched.push(`type:${lead_type}`);

  const name =
    pickLabeled(text, [
      "customer name",
      "client name",
      "contact name",
      "full name",
      "name",
      "from name",
      "buyer name",
      "prospect name",
    ]) ||
    combineFirstLast(text) ||
    fromHeaderName(text) ||
    "";

  if (name) matched.push("name");

  const email =
    pickLabeled(text, ["email", "e-mail", "email address", "from email", "customer email"]) ||
    extractEmail(text) ||
    "";
  if (email) matched.push("email");

  const phone =
    pickLabeled(text, [
      "phone",
      "telephone",
      "mobile",
      "cell",
      "cell phone",
      "phone number",
      "tel",
      "contact number",
    ]) ||
    extractPhone(text) ||
    "";
  if (phone) matched.push("phone");

  const stock_number =
    pickLabeled(text, [
      "stock number",
      "stock #",
      "stock#",
      "stock no",
      "stock no.",
      "stock",
      "stk",
      "inventory number",
      "unit number",
    ]) ||
    extractStock(text) ||
    "";
  if (stock_number) matched.push("stock");

  const vehicle_interest =
    pickLabeled(text, [
      "vehicle of interest",
      "vehicle interest",
      "vehicle",
      "interested in",
      "interest",
      "unit",
      "car",
      "model of interest",
      "requested vehicle",
      "vehicle requested",
      "looking for",
      "lease vehicle",
      "vehicle wanted",
      "year make model",
    ]) ||
    extractVehicleLine(text) ||
    "";
  if (vehicle_interest) matched.push("vehicle");

  const notesBits: string[] = [];
  const message = pickLabeled(text, [
    "message",
    "comments",
    "comment",
    "notes",
    "note",
    "inquiry",
    "details",
    "additional information",
    "additional info",
    "body",
  ]);
  if (message) {
    notesBits.push(message);
    matched.push("message");
  }

  // Lease-specific extras
  if (lead_type === "lease") {
    for (const key of ["term", "lease term", "months", "km", "kilometers", "down payment", "trade"]) {
      const v = pickLabeled(text, [key]);
      if (v) notesBits.push(`${titleCase(key)}: ${v}`);
    }
  }

  // Keep a short raw snippet if we have almost nothing structured
  if (!notesBits.length && text.length > 0) {
    const cleaned = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^(from|to|subject|date|sent):/i.test(l))
      .slice(0, 8)
      .join("\n");
    if (cleaned) notesBits.push(cleaned.slice(0, 600));
  }

  const source: SourceId =
    lead_type === "lease" || /broker|dealer request|outside dealer/i.test(lower)
      ? "broker"
      : /walk[- ]?in/i.test(lower)
        ? "walk_in"
        : "email";

  const score = matched.filter((m) => !m.startsWith("type:")).length;
  const confidence: ParsedEmailLead["confidence"] =
    score >= 4 ? "high" : score >= 2 ? "medium" : "low";

  return {
    lead_type,
    name: cleanName(name),
    phone: cleanPhone(phone),
    email: email.trim().toLowerCase(),
    vehicle_interest: vehicle_interest.trim(),
    stock_number: stock_number.trim().toUpperCase(),
    notes: notesBits.join("\n").trim(),
    source,
    confidence,
    matched_fields: matched,
  };
}

function detectLeadType(lower: string, flat: string): LeadType {
  const leaseHits =
    (lower.match(
      /\blease\b|\bleasing\b|lease quote|quote request|broker request|dealer request|payment quote|monthly payment/g,
    )?.length ?? 0) + (/\bterm\b.*\b(24|36|48|60)\b/i.test(flat) ? 1 : 0);
  const invHits =
    lower.match(
      /\bstock\s*(#|number|no)?\b|\binventory\b|\bfor sale\b|\bvehicle of interest\b|\bunits?\b|\bvin\b|\bodometer\b|\bcarfax\b/g,
    )?.length ?? 0;

  if (leaseHits > invHits && leaseHits > 0) return "lease";
  if (invHits > 0) return "inventory";
  if (leaseHits > 0) return "lease";
  return "inventory";
}

function pickLabeled(text: string, labels: string[]): string {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Label: value  OR  Label = value  OR  **Label** value
    const patterns = [
      new RegExp(`(?:^|\\n)\\s*\\*?\\*?${esc}\\*?\\*?\\s*[:\\-–—=]\\s*(.+)$`, "im"),
      new RegExp(`(?:^|\\n)\\s*${esc}\\s{2,}(.+)$`, "im"),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m?.[1]) {
        const val = m[1].trim().split(/\n/)[0]?.trim() ?? "";
        if (val && val.length < 200) return stripJunk(val);
      }
    }
  }
  return "";
}

function combineFirstLast(text: string): string {
  const first = pickLabeled(text, ["first name", "firstname", "given name"]);
  const last = pickLabeled(text, ["last name", "lastname", "surname", "family name"]);
  if (first || last) return [first, last].filter(Boolean).join(" ");
  return "";
}

function fromHeaderName(text: string): string {
  // From: "Alex Hudon" <alexh@...>
  const m = text.match(/^From:\s*(?:"?([^"<\n]+)"?\s*)?</im);
  if (m?.[1]) {
    const n = m[1].trim();
    if (n && !n.includes("@") && n.length < 60) return n;
  }
  return "";
}

function extractEmail(text: string): string {
  // Prefer emails not belonging to paulmotor domains when multiple
  const all = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0]);
  if (!all.length) return "";
  const external = all.find((e) => !/paulmotor/i.test(e) && !/noreply|no-reply|donotreply/i.test(e));
  return (external || all[0] || "").toLowerCase();
}

function extractPhone(text: string): string {
  const m = text.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/,
  );
  return m?.[0]?.trim() || "";
}

function extractStock(text: string): string {
  const m =
    text.match(/Stock\s*(?:#|Number|No\.?)?\s*[:#]?\s*([A-Z0-9-]{3,20})/i) ||
    text.match(/\bSTK\s*[:#]?\s*([A-Z0-9-]{3,20})/i);
  return m?.[1] || "";
}

function extractVehicleLine(text: string): string {
  // 2015 Ferrari 458 Speciale / 2024 Ferrari Purosangue AWD
  const m = text.match(
    /\b((?:19|20)\d{2}\s+(?:[A-Z][A-Za-zÀ-ÿ0-9-]+(?:\s+[A-Z0-9][A-Za-zÀ-ÿ0-9-]*){1,6}))/,
  );
  if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
  return "";
}

function cleanName(n: string) {
  return n
    .replace(/[<>"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(mr|mrs|ms|dr)\.?\b/gi, "")
    .trim();
}

function cleanPhone(p: string) {
  return p.replace(/\s+/g, " ").trim();
}

function stripJunk(v: string) {
  return v.replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s{2,}/g, " ");
}

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
