import { google } from "googleapis";
import { compactEmailBody, isSpacerEmailBody } from "./email-text";

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
    return htmlToText(decodeBodyData(payload.body.data));
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
  const compactPlain = compactEmailBody(plain);
  const compactHtml = html.trim() ? compactEmailBody(htmlToText(html)) : "";
  if (plain.trim() && !isSpacerEmailBody(plain)) return compactPlain || plain.trim();
  if (compactHtml) return compactHtml;
  return compactPlain;
}

function htmlToText(html: string): string {
  const amp = String.fromCharCode(38);
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(amp + "nbsp;")
    .join(" ")
    .split(amp + "deg;")
    .join("°")
    .split(amp + "#176;")
    .join("°")
    .split(amp + "amp;")
    .join(amp)
    .split(amp + "lt;")
    .join("<")
    .split(amp + "gt;")
    .join(">")
    .split(amp + "#39;")
    .join("'")
    .split(amp + "quot;")
    .join('"');
  return compactEmailBody(stripped);
}

/**
 * List inbox messages. Default: last 14 days.
 * Pass newerThanDays: 25 for historical backfill.
 * Paginates until maxResults or no more pages.
 *
 * AutoTrader leads often land in Promotions (Unsubscribe + branded HTML).
 * Inbox query still skips Promotions; a second query always pulls known
 * lead senders regardless of Gmail category.
 */
export async function fetchRecentLeadEmails(opts?: {
  maxResults?: number;
  newerThanDays?: number;
  afterEpochSec?: number;
}): Promise<GmailMessage[]> {
  const auth = getAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const userId = env("GMAIL_USER") || "me";
  const maxResults = opts?.maxResults ?? 60;
  const days = opts?.newerThanDays ?? 14;

  const after = opts?.afterEpochSec ? ` after:${opts.afterEpochSec}` : "";
  const inboxQ = `in:inbox -category:promotions newer_than:${days}d${after}`;
  const portalQ =
    `(from:dealerleads.trader.ca OR from:1-source@dealerleads.trader.ca ` +
    `OR from:messages.cargurus.com OR from:dealer-leads@messages.cargurus.com ` +
    `OR from:tadvantage.ca OR from:noreply@tadvantage.ca OR from:autotrader.ca) ` +
    `newer_than:${days}d -in:trash -in:spam${after}`;

  const messageIds: string[] = [];
  const seen = new Set<string>();
  async function collect(q: string, cap: number) {
    let pageToken: string | undefined;
    while (messageIds.length < cap) {
      const pageSize = Math.min(100, cap - messageIds.length);
      const list = await gmail.users.messages.list({
        userId,
        q,
        maxResults: pageSize,
        pageToken,
      });
      for (const m of list.data.messages || []) {
        if (!m.id || seen.has(m.id)) continue;
        seen.add(m.id);
        messageIds.push(m.id);
      }
      pageToken = list.data.nextPageToken || undefined;
      if (!pageToken) break;
    }
  }
  await collect(inboxQ, maxResults);
  await collect(portalQ, maxResults + 40);

  const out: GmailMessage[] = [];
  for (const id of messageIds) {
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
