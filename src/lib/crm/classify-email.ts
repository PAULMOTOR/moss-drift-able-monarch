import type { LeadType, SourceId } from "./types";

export type EmailPortal =
  | "tadvantage"
  | "cargurus"
  | "autotrader"
  | "other"
  | "manual";

export type ClassifiedInbound = {
  lead_type: LeadType;
  source: SourceId;
  portal: EmailPortal;
  rule: string;
};

/**
 * Classify inbound mail by From + Subject (Paul Motor production rules).
 *
 * TAdvantage (no-reply@tadvantage.ca):
 *  - General Contact / Contact général / Contact Us → general
 *  - Financing Form Individuals / Location individuel → lease
 *  - Leasing Form Business / Location Entreprise → lease
 *
 * CarGurus (dealer-leads@messages.cargurus.com) → inventory
 * AutoTrader (1-Source@dealerleads.trader.ca) → inventory
 */
export function classifyInboundEmail(opts: {
  from: string;
  subject: string;
  body?: string;
}): ClassifiedInbound {
  const from = (opts.from || "").toLowerCase();
  const subject = (opts.subject || "").trim();
  const subjectL = subject.toLowerCase();
  const bodyL = (opts.body || "").toLowerCase();

  // --- TAdvantage ---
  if (
    from.includes("tadvantage.ca") ||
    from.includes("tadvantage") ||
    /no-?reply@tadvantage/i.test(opts.from || "")
  ) {
    if (
      /financing form individuals|location individuel|location individuelle/i.test(subject)
    ) {
      return {
        lead_type: "lease",
        source: "web",
        portal: "tadvantage",
        rule: "tadvantage:financing-individuals",
      };
    }
    if (/leasing form business|location entreprise/i.test(subject)) {
      return {
        lead_type: "lease",
        source: "web",
        portal: "tadvantage",
        rule: "tadvantage:leasing-business",
      };
    }
    if (
      /general contact|contact général|contact general|contact us|contactez/i.test(subject)
    ) {
      return {
        lead_type: "general",
        source: "web",
        portal: "tadvantage",
        rule: "tadvantage:general-contact",
      };
    }
    return {
      lead_type: "general",
      source: "web",
      portal: "tadvantage",
      rule: "tadvantage:default-general",
    };
  }

  // --- CarGurus ---
  if (from.includes("cargurus.com") || from.includes("messages.cargurus")) {
    return {
      lead_type: "inventory",
      source: "email",
      portal: "cargurus",
      rule: "cargurus:lead",
    };
  }
  if (
    /phone lead from cargurus|lead submission from cargurus/i.test(subjectL) ||
    (/cargurus/i.test(subjectL) && from.includes("dealer-leads"))
  ) {
    return {
      lead_type: "inventory",
      source: "email",
      portal: "cargurus",
      rule: "cargurus:subject",
    };
  }

  // --- AutoTrader / Trader.ca ---
  if (
    from.includes("dealerleads.trader.ca") ||
    from.includes("autotrader") ||
    from.includes("trader.ca") ||
    /1-source@/i.test(opts.from || "")
  ) {
    return {
      lead_type: "inventory",
      source: "email",
      portal: "autotrader",
      rule: "autotrader:dealer-lead",
    };
  }

  // Body / subject heuristics for other mail
  if (/financing form|location individuel|location entreprise|lease quote|leasing/i.test(subjectL + bodyL)) {
    return {
      lead_type: "lease",
      source: "email",
      portal: "other",
      rule: "body:lease-heuristic",
    };
  }
  if (/stock\s*#|vehicle of interest|cargurus|autotrader|for sale/i.test(subjectL + bodyL)) {
    return {
      lead_type: "inventory",
      source: "email",
      portal: "other",
      rule: "body:inventory-heuristic",
    };
  }
  if (/general contact|contact us|general interest/i.test(subjectL)) {
    return {
      lead_type: "general",
      source: "web",
      portal: "other",
      rule: "body:general-heuristic",
    };
  }

  return {
    lead_type: "inventory",
    source: "email",
    portal: "other",
    rule: "default-inventory",
  };
}

/** Normalize phone to digits only (NA, keep last 10). */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return null;
  if (/noreply|no-reply|donotreply|dealer-leads|1-source|messages\.cargurus|tadvantage|dealerleads\.trader|autotrader\.ca/i.test(e)) {
    return null;
  }
  // Garbled portal tracking addresses sometimes look real
  if (/^\d{3}-\d{4}[a-z0-9]+@/i.test(e)) return null;
  return e;
}

export function vehicleKey(interest: string | null | undefined): string | null {
  if (!interest) return null;
  const cleaned = interest
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 4) return null;
  return cleaned.slice(0, 80);
}

export function stockKey(stock: string | null | undefined): string | null {
  if (!stock) return null;
  const s = stock.trim().toUpperCase();
  return s.length >= 2 ? s : null;
}
