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

  const isAutoTrader =
    portalRule.startsWith("autotrader:") ||
    /dealerleads\.trader|1-source@|autotrader\.ca/i.test(`${fromLine}\n${text}`);
  const at = isAutoTrader ? parseAutoTraderLead(text) : null;
  if (at) matched.push("autotrader-parser");

  // Never treat form titles / dealer branding as the client name
  const name =
    (at?.name && !isDealerOrSelfName(at.name) ? at.name : "") ||
    pickClientName(text, subjectLine, lead_type, portalRule) ||
    "";

  if (name) matched.push("name");

  const email =
    (at?.email || "") ||
    pickLabeled(text, ["email", "e-mail", "email address", "from email", "customer email", "work email", "business email"]) ||
    extractEmail(text) ||
    "";
  if (email) matched.push("email");

  const phone =
    (at?.phone || "") ||
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
    (at?.stock || "") ||
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
    (at?.vehicle || "") ||
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
  const message =
    (at?.message || "") ||
    pickLabeled(text, [
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
      "message from customer",
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
    /^(tadvantage|cargurus|autotrader|trader|trader\.ca|dealer leads?|no-?reply|donotreply|mailer-daemon)\b/.test(
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
  const v = value.trim();
  if (/^trader$/i.test(v)) return true;
  return /tadvantage|cargurus|autotrader|\btrader\b|dealerleads|dealer\s*leads?|no.?reply|notifications?/i.test(
    v,
  );
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
  // AutoTrader / portal dealer account IDs look like phone numbers — strip them first
  const scrubbed = text
    .replace(/Customer\s*no\.?\s*[:#]?\s*\d{6,}/gi, " ")
    .replace(/Customer\s*number\s*[:#]?\s*\d{6,}/gi, " ");
  const banned = collectDealerCustomerNumbers(text);
  const matches = [
    ...scrubbed.matchAll(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g),
  ];
  for (const m of matches) {
    const raw = m[0]?.trim() || "";
    const digits = raw.replace(/\D/g, "");
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    if (banned.has(last10) || banned.has(digits)) continue;
    if (/^1000\d{6}$/.test(last10) && /customer\s*no/i.test(text)) continue;
    return raw;
  }
  return "";
}

function collectDealerCustomerNumbers(text: string): Set<string> {
  const s = new Set<string>();
  for (const m of text.matchAll(/Customer\s*no\.?\s*[:#]?\s*(\d{6,})/gi)) {
    const d = m[1].replace(/\D/g, "");
    s.add(d);
    if (d.length >= 10) s.add(d.slice(-10));
  }
  for (const m of text.matchAll(/Customer\s*number\s*[:#]?\s*(\d{6,})/gi)) {
    const d = m[1].replace(/\D/g, "");
    s.add(d);
    if (d.length >= 10) s.add(d.slice(-10));
  }
  return s;
}

/**
 * AutoTrader / Trader.ca leads (1-Source@dealerleads.trader.ca).
 * Buyer is in "New inquiry from X for your Y" + "Message from customer".
 * Dealer "Customer no." is NOT the buyer phone.
 */
function parseAutoTraderLead(text: string): {
  name?: string;
  phone?: string;
  email?: string;
  vehicle?: string;
  stock?: string;
  message?: string;
} {
  const out: {
    name?: string;
    phone?: string;
    email?: string;
    vehicle?: string;
    stock?: string;
    message?: string;
  } = {};
  const banned = collectDealerCustomerNumbers(text);

  const inq =
    text.match(
      /New\s+inquiry\s*(?:\r?\n|\s)+from\s+([^\n]+?)\s+for your\s+([^\n]+)/i,
    ) ||
    text.match(
      /from\s+([A-Za-z][A-Za-z .'-]{0,40}?)\s+for your\s+((?:19|20)\d{2}[^\n]{3,80})/i,
    );
  if (inq) {
    const n = inq[1].trim().replace(/\s+/g, " ");
    if (n && !isDealerOrSelfName(n) && !isPortalSenderName(n)) out.name = n;
    out.vehicle = inq[2].trim().replace(/\s+/g, " ");
  }

  const stock =
    text.match(/Stock\s*number\s*[:#]?\s*([A-Z0-9-]{2,20})/i) ||
    text.match(/Stock\s*#\s*[:#]?\s*([A-Z0-9-]{2,20})/i);
  if (stock) out.stock = stock[1].trim().toUpperCase();

  const msgMatch = text.match(
    /Message from customer\s*([\s\S]*?)(?=\n\s*Your vehicle\b|\n\s*View listing\b|\n\s*View vehicle\b|\n\s*Condition\s*:|$)/i,
  );
  if (msgMatch?.[1]) {
    const block = msgMatch[1].trim();
    out.message = block.slice(0, 1200);

    // Collapsed signature first: Eric7866894629eklein@sonnohomes.com
    const collapsed = block.match(
      /([A-Za-z][A-Za-z .'-]{1,30}?)(\d{10}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
    );
    if (collapsed) {
      if (!out.name) out.name = collapsed[1].trim();
      out.phone = collapsed[2].trim();
      out.email = collapsed[3].toLowerCase();
    }

    const emails = [...block.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(
      (m) => m[0],
    );
    const goodEmail = emails.find((e) => {
      if (/dealerleads|trader\.ca|noreply|no-reply|donotreply|paulmotor|autotrader/i.test(e)) {
        return false;
      }
      const local = e.split("@")[0] || "";
      // Reject local-parts that swallowed name+phone
      if (/\d{7,}/.test(local)) return false;
      return true;
    });
    if (goodEmail) out.email = goodEmail.toLowerCase();

    if (!out.phone) {
      const phones = [
        ...block.matchAll(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g),
      ].map((m) => m[0]);
      for (const ph of phones) {
        const digits = ph.replace(/\D/g, "");
        const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
        if (banned.has(last10) || banned.has(digits)) continue;
        if (/^1000\d{6}$/.test(last10) && banned.size > 0) continue;
        out.phone = ph.trim();
        break;
      }
    }

    const lines = block
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i--) {
      const line = lines[i];
      if (!out.email) {
        const em = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        if (
          em &&
          !/dealerleads|trader\.ca|noreply/i.test(em[0]) &&
          !/\d{7,}/.test(em[0].split("@")[0] || "")
        ) {
          out.email = em[0].toLowerCase();
        }
      }
      if (!out.phone) {
        const ph = line.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/);
        if (ph) {
          const digits = ph[0].replace(/\D/g, "");
          const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
          if (!banned.has(last10) && !banned.has(digits)) out.phone = ph[0].trim();
        }
      }
      if (
        !out.name &&
        /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(line) &&
        !/message|available|interesting|text me|car ?fax|trade|partner|inquiry/i.test(line)
      ) {
        out.name = line;
      }
    }
  }

  if (!out.phone) {
    const ph = extractPhone(text);
    if (ph) out.phone = ph;
  }
  if (!out.email) {
    const em = extractEmail(text);
    if (em && !/dealerleads|trader\.ca/i.test(em)) {
      const local = em.split("@")[0] || "";
      if (!/\d{7,}/.test(local)) out.email = em;
    }
  }

  return out;
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
