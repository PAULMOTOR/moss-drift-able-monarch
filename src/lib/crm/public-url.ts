/** Public origin for emails, token links, and redirects. No trailing slash. */
export function publicAppUrl(): string {
  return (
    process.env.BETTER_AUTH_URL?.replace(/\/$/, "") ||
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.VITE_APP_URL?.replace(/\/$/, "") ||
    "https://crm.paulmotorcompany.com"
  );
}
