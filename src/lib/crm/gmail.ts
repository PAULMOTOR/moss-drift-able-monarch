import { google } from "googleapis";

export type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string | null;
  bodyText: string;
  snippet: string;
  internalDate: number;
};

function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/** True when Gmail OAuth env vars are present. */
export function isGmailConfigured(): boolean {
  return Boolean(
    env("GMAIL_CLIENT_ID") &&
      env("GMAIL_CLIENT_SECRET") &&
      env("GMAIL_REFRESH_TOKEN") &&
      (env("GMAIL_USER") || env("GMAIL_IMPERSONATE")),
  );
}

function getAuth() {
  const clientId = env("GMAIL_CLIENT_ID");
  const clientSecret = env("GMAIL_CLIENT_SECRET");
  const refreshToken = env("GMAIL_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Gmail not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER.",
    );
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

function header(
  headers: { name?: string | null; value?: string | null }[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const h = headers.find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
  return (h?.value || "").trim();
}

function decodeBodyData(data?: string | null): string {
  if (!data) return "";
  // Gmail uses URL-safe base64
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractTextFromPayload(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: unknown[] | null;
}): string {
  if (!payload) return "";
  const mime = payload.mimeType || "";
  if (mime === "text/plain" && payload.body?.data) {
    return decodeBodyData(payload.body.data);
  }
  if (mime === "text/html" && payload.body?.data) {
    const html = decodeBodyData(payload.body.data);
    return htmlToText(html);
  }
  const parts = (payload.parts || []) as Array<{
    mimeType?: string | null;
    body?: { data?: string | null } | null;
    parts?: unknown[] | null;
  }>;
  let plain = "";
  let html = "";
  for (const p of parts) {
    if (p.mimeType === "text/plain" && p.body?.data) {
      plain += decodeBodyData(p.body.data) + "\n";
    } else if (p.mimeType === "text/html" && p.body?.data) {
      html += decodeBodyData(p.body.data) + "\n";
    } else if (p.parts) {
      const nested = extractTextFromPayload(p as typeof payload);
      if (nested) plain += nested + "\n";
    }
  }
  if (plain.trim()) return plain.trim();
  if (html.trim()) return htmlToText(html);
  return "";
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/"/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * List recent inbox messages (newest first).
 * Default: last 7 days, max 40 messages per poll.
 */
export async function fetchRecentLeadEmails(opts?: {
  maxResults?: number;
  afterEpochSec?: number;
}): Promise<GmailMessage[]> {
  const auth = getAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const userId = env("GMAIL_USER") || "me";
  const maxResults = opts?.maxResults ?? 40;

  // Only inbound portal-ish mail + general inbox (skip spam/trash)
  const queryParts = [
    "in:inbox",
    "-category:promotions",
    "newer_than:14d",
  ];
  if (opts?.afterEpochSec) {
    queryParts.push(`after:${opts.afterEpochSec}`);
  }

  const list = await gmail.users.messages.list({
    userId,
    q: queryParts.join(" "),
    maxResults,
  });

  const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
  const out: GmailMessage[] = [];

  for (const id of ids) {
    const full = await gmail.users.messages.get({
      userId,
      id,
      format: "full",
    });
    const payload = full.data.payload;
    const headers = payload?.headers || [];
    const from = header(headers, "From");
    const subject = header(headers, "Subject");
    const date = header(headers, "Date") || null;
    const bodyText = extractTextFromPayload(payload || {});
    const snippet = full.data.snippet || "";
    const internalDate = Number(full.data.internalDate || 0);

    out.push({
      id: full.data.id || id,
      threadId: full.data.threadId || "",
      from,
      subject,
      date,
      bodyText: bodyText || snippet,
      snippet,
      internalDate,
    });
  }

  // Oldest first so merges process chronologically
  out.sort((a, b) => a.internalDate - b.internalDate);
  return out;
}

export function gmailConfigStatus() {
  return {
    configured: isGmailConfigured(),
    user: env("GMAIL_USER") || null,
    hasClientId: Boolean(env("GMAIL_CLIENT_ID")),
    hasClientSecret: Boolean(env("GMAIL_CLIENT_SECRET")),
    hasRefreshToken: Boolean(env("GMAIL_REFRESH_TOKEN")),
  };
}
