/**
 * Collapse portal / TAdvantage email bodies so the lead timeline
 * is not a wall of &nbsp; and blank lines.
 */
export function compactEmailBody(raw: string, maxLen = 4000): string {
  if (!raw) return "";
  let s = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Only strip markup when this is actually HTML — not "From: Name <email@x>"
  const looksLikeHtml =
    /<(?:p|div|br|table|tr|td|th|span|html|body|style|script|li|ul|ol|h[1-6]|img|font)\b/i.test(s) ||
    /<\/(?:p|div|table|tr|td|span|html|body|li|ul|ol|h[1-6])>/i.test(s);

  if (looksLikeHtml) {
    s = s
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|thead|tbody|blockquote)>/gi, "\n")
      .replace(/<td[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }

  s = s
    .replace(/&nbsp;?/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/&#x0*a0;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;|'/gi, "'")
    .replace(/&deg;|&#176;/g, "°");

  s = s.replace(/^\s*email template\s*$/gim, "");
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  if (s.length > maxLen) s = `${s.slice(0, maxLen).trimEnd()}…`;
  return s.trim();
}

/** True when a Gmail text/plain part is spacer junk (prefer HTML instead). */
export function isSpacerEmailBody(raw: string): boolean {
  const c = compactEmailBody(raw, 800);
  const words = c.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w) && !/^nbsp$/i.test(w));
  return words.length < 8;
}
