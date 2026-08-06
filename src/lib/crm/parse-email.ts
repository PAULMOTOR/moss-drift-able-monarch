import type { LeadType, ParsedEmailLead, SourceId } from "./types";
import { classifyInboundEmail } from "./classify-email";

/**
 * Fast floor helper: paste a whole inventory or lease-inquiry email and
 * extract name / phone / email / vehicle / stock # for the capture form.
 */
export function parseLeadEmail(raw: string): ParsedEmailLead {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const flat = text.replace(/[ \t]+/g, " ");
  const lower = flat.toLowerCase();

  const matched: string[] = [];

  // Prefer From/Subject portal rules when present in the paste
  const fromLine = text.match(/^From:\s*(.+)$/im)?.[1]?.trim() || "";
  const subjectLine = text.match(/^Subject:\s*(.+)$/im)?.[1]?.trim() || "";
  let lead_type: LeadType = detectLeadType(lower, flat);
  let portalRule = "";
  if (fromLine || subjectLine) {
    const classified = classifyInboundEmail({
      from: fromLine,
      subject: subjectLine,
      body: text,
    });
    lead_type = classified.lead_type;
    portalRule = classified.rule;
  }
  matched.push(`type:${lead_type}`);

  // Never treat form titles / dealer branding as the client name
  const name =
    pickClientName(text, subjectLine, lead_type, portalRule) ||
    "";

  if (name) matched.push("name");

  const email =
    pickLabeled(text, ["email", "e-mail", "email address", "from email", "customer email", "work email", "business email"]) ||
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
      "business phone",
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

  if (lead_type === "lease") {
    for (const key of ["term", "lease term", "months", "km", "kilometers", "down payment", "trade", "company", "business name"]) {
      const v = pickLabeled(text, [key]);
      if (v && !isDealerOrSelfName(v)) notesBits.push(`${titleCase(key)}: ${v}`);
    }
  }

  if (!notesBits.length && text.length > 0) {
    const cleaned = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^(from|to|subject|date|sent):/i.test(l))
      .filter((l) => !isDealerOrSelfName(l))
      .slice(0, 8)
      .join("\n");
    if (cleaned) notesBits.push(cleaned.slice(0, 600));
  }

  const source: SourceId =
    lead_type === "lease" || /broker|dealer request|outside dealer/i.test(lower)
      ? "broker"
      : lead_type === "general"
        ? "web"
        : /walk[- ]?in/i.test(lower)
          ? "walk_in"
          : "email";

  // TAdvantage lease forms come from web, not brokers
  const sourceFinal: SourceId =
    portalRule.startsWith("tadvantage:") || portalRule.startsWith("cargurus:") || portalRule.startsWith("autotrader:")
      ? portalRule.startsWith("tadvantage:")
        ? "web"
        : "email"
      : source;

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
    source: sourceFinal,
    confidence,
    matched_fields: matched,
  };
}

/** Prefer real lessee/contact fields; never return dealer/self branding. */
function pickClientName(
  text: string,
  subjectLine: string,
  leadType: LeadType,
  portalRule: string,
): string {
  // Business lease forms: company / business name first, then contact person
  const businessFirst =
    leadType === "lease" &&
    (/business|entreprise|company|corp|inc\.?/i.test(subjectLine) ||
      portalRule.includes("leasing-business") ||
      portalRule.includes("entreprise"));

  const businessLabels = [
    "company name",
    "business name",
    "company",
    "business",
    "legal name",
    "corporation name",
    "organization",
    "organisation",
    "entreprise",
    "nom de l'entreprise",
    "raison sociale",
  ];
  const personLabels = [
    "customer name",
    "client name",
    "contact name",
    "full name",
    "contact person",
    "contact",
    "buyer name",
    "prospect name",
    "lessee name",
    "lessee",
    "applicant name",
    "applicant",
    "driver name",
  ];
  // Avoid bare "name" first — it often matches form chrome / wrong rows
  const weakLabels = ["name", "from name"];

  const tryLabels = (labels: string[]) => {
    for (const label of labels) {
      const v = pickLabeled(text, [label]);
      if (v && !isDealerOrSelfName(v) && !isFormTitle(v, subjectLine)) return v;
    }
    return "";
  };

  let name = "";
  if (businessFirst) {
    name = tryLabels(businessLabels) || combineFirstLast(text) || tryLabels(personLabels);
  } else {
    name =
      tryLabels(personLabels) ||
      combineFirstLast(text) ||
      tryLabels(businessLabels);
  }

  if (!name) {
    const weak = tryLabels(weakLabels);
    if (weak) name = weak;
  }

  // From: display name only if not a portal/no-reply and not our company
  if (!name) {
    const fromName = fromHeaderName(text);
    if (fromName && !isDealerOrSelfName(fromName) && !isPortalSenderName(fromName)) {
      name = fromName;
    }
  }

  // Never use the email subject as a client name (e.g. "Leasing Form Business")
  if (name && subjectLine && name.toLowerCase() === subjectLine.toLowerCase()) {
    name = "";
  }
  if (name && isFormTitle(name, subjectLine)) name = "";
  if (name && isDealerOrSelfName(name)) name = "";

  return name;
}

/** Paul Motor / portals / form titles — never the lessee. */
function isDealerOrSelfName(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (
    /paul\s*motor|paulmotor|p\.?\s*m\.?\s*l\.?\b|paul motor co|paul motor leasing|paul motor company/.test(
      v,
    )
  ) {
    return true;
  }
  if (
    /^(tadvantage|cargurus|autotrader|trader\.ca|dealer leads?|no-?reply|donotreply|mailer-daemon)\b/.test(
      v,
    )
  ) {
    return true;
  }
  if (/noreply|no-reply|donotreply|dealer-leads|messages\.cargurus|tadvantage/.test(v)) {
    return true;
  }
  // Pure form labels that sometimes leak into the name field
  if (
    /^(leasing form|financing form|location|contact us|general contact|business form|individual form)\b/i.test(
      v,
    )
  ) {
    return true;
  }
  return false;
}

function isFormTitle(value: string, subjectLine: string): boolean {
  const v = value.trim().toLowerCase();
  if (/leasing form|financing form|location individuel|location entreprise|general contact|contact général/i.test(v)) {
    return true;
  }
  if (subjectLine && v === subjectLine.trim().toLowerCase()) return true;
  return false;
}

function isPortalSenderName(value: string): boolean {
  return /tadvantage|cargurus|autotrader|dealer|no.?reply|notifications?/i.test(value);
}

function detectLeadType(lower: string, flat: string): LeadType {
  if (/general contact|contact général|contact us|general interest/i.test(lower)) {
    return "general";
  }
  const leaseHits =
    (lower.match(
      /\blease\b|\bleasing\b|lease quote|quote request|broker request|dealer request|payment quote|monthly payment|financing form|location individuel|location entreprise/g,
    )?.length ?? 0) + (/\bterm\b.*\b(24|36|48|60)\b/i.test(flat) ? 1 : 0);
  const invHits =
    lower.match(
      /\bstock\s*(#|number|no)?\b|\binventory\b|\bfor sale\b|\bvehicle of interest\b|\bunits?\b|\bvin\b|\bodometer\b|\bcarfax\b|\bcargurus\b|\bautotrader\b/g,
    )?.length ?? 0;

  if (leaseHits > invHits && leaseHits > 0) return "lease";
  if (invHits > 0) return "inventory";
  if (leaseHits > 0) return "lease";
  return "inventory";
}

function pickLabeled(text: string, labels: string[]): string {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      // Prefer end-of-label match with word boundary so "name" doesn't steal from "Company name"
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
  const first = pickLabeled(text, ["first name", "firstname", "given name", "prénom", "prenom"]);
  const last = pickLabeled(text, ["last name", "lastname", "surname", "family name", "nom de famille"]);
  if (first || last) {
    const joined = [first, last].filter(Boolean).join(" ");
    if (!isDealerOrSelfName(joined)) return joined;
  }
  return "";
}

function fromHeaderName(text: string): string {
  const m = text.match(/^From:\s*(?:"?([^"<\n]+)"?\s*)?</im);
  if (m?.[1]) {
    const n = m[1].trim();
    if (n && !n.includes("@") && n.length < 60) return n;
  }
  return "";
}

function extractEmail(text: string): string {
  const all = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0]);
  if (!all.length) return "";
  const external = all.find(
    (e) =>
      !/paulmotor/i.test(e) &&
      !/noreply|no-reply|donotreply|tadvantage|cargurus|dealerleads|trader\.ca/i.test(e),
  );
  return (external || all[0] || "").toLowerCase();
}

function extractPhone(text: string): string {
  const m = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/);
  return m?.[0]?.trim() || "";
}

function extractStock(text: string): string {
  const m =
    text.match(/Stock\s*(?:#|Number|No\.?)?\s*[:#]?\s*([A-Z0-9-]{3,20})/i) ||
    text.match(/\bSTK\s*[:#]?\s*([A-Z0-9-]{3,20})/i);
  return m?.[1] || "";
}

function extractVehicleLine(text: string): string {
  const m = text.match(
    /\b((?:19|20)\d{2}\s+(?:[A-Z][A-Za-zÀ-ÿ0-9-]+(?:\s+[A-Z0-9][A-Za-zÀ-ÿ0-9-]*){1,6}))/,
  );
  if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
  return "";
}

function cleanName(n: string) {
  const cleaned = n
    .replace(/[<>"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(mr|mrs|ms|dr)\.?\b/gi, "")
    .trim();
  if (isDealerOrSelfName(cleaned)) return "";
  return cleaned;
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
