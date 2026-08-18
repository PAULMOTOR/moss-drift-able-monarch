import { createFileRoute } from "@tanstack/react-router";

/**
 * Public health check for production debugging (no secrets returned).
 * GET /api/health
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());
        const hasAuthSecret = Boolean(process.env.BETTER_AUTH_SECRET?.trim());
        const betterAuthUrl = process.env.BETTER_AUTH_URL?.trim() || null;
        const vercelUrl = process.env.VERCEL_URL?.trim() || null;
        const crmSeedDemo = process.env.CRM_SEED_DEMO?.trim() || null;
        const mail = {
          hasResendKey: Boolean(process.env.RESEND_API_KEY?.trim()),
          fromEmail: process.env.CRM_FROM_EMAIL?.trim() || "onboarding@resend.dev",
          keyPrefix: process.env.RESEND_API_KEY?.trim()
            ? process.env.RESEND_API_KEY.trim().slice(0, 6) + "…"
            : null,
        };

        const gmail = {
          hasClientId: Boolean(process.env.GMAIL_CLIENT_ID?.trim()),
          hasClientSecret: Boolean(process.env.GMAIL_CLIENT_SECRET?.trim()),
          hasRefreshToken: Boolean(process.env.GMAIL_REFRESH_TOKEN?.trim()),
          hasDriveRefreshToken: Boolean(
            process.env.GOOGLE_DRIVE_REFRESH_TOKEN?.trim() ||
              process.env.GMAIL_REFRESH_TOKEN?.trim(),
          ),
          hasDriveParentFolder: Boolean(
            process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID?.trim(),
          ),
          user: process.env.GMAIL_USER?.trim() || null,
          hasCronSecret: Boolean(process.env.CRON_SECRET?.trim()),
          hasHandoffSecret: Boolean(
            process.env.CRM_HANDOFF_SECRET?.trim() || process.env.HANDOFF_SECRET?.trim(),
          ),
          configured: Boolean(
            process.env.GMAIL_CLIENT_ID?.trim() &&
              process.env.GMAIL_CLIENT_SECRET?.trim() &&
              process.env.GMAIL_REFRESH_TOKEN?.trim() &&
              process.env.GMAIL_USER?.trim(),
          ),
        };


        let db: {
          ok: boolean;
          source: string;
          profiles?: number;
          users?: number;
          email_imports_table?: boolean;
          email_portal_column?: boolean;
          error?: string;
        } = { ok: false, source: hasDatabaseUrl ? "neon" : "pglite" };

        try {
          const { getSql, dbSource } = await import("@/lib/db");
          const sql = await getSql();
          db.source = dbSource;
          const profiles = await sql<{ n: number }>`
            select count(*)::int as n from profiles
          `;
          const users = await sql<{ n: number }>`
            select count(*)::int as n from "user"
          `;
          const cols = await sql<{ column_name: string }>`
            select column_name from information_schema.columns
            where table_name = 'leads' and column_name in ('email_portal', 'gmail_message_id')
          `;
          const tables = await sql<{ table_name: string }>`
            select table_name from information_schema.tables
            where table_schema = 'public' and table_name = 'email_imports'
          `;
          db = {
            ok: true,
            source: dbSource,
            profiles: profiles[0]?.n ?? 0,
            users: users[0]?.n ?? 0,
            email_portal_column: cols.some((c) => c.column_name === "email_portal"),
            email_imports_table: tables.length > 0,
          };
        } catch (e) {
          db = {
            ok: false,
            source: hasDatabaseUrl ? "neon" : "pglite",
            error: e instanceof Error ? e.message : String(e),
          };
        }

        let seed: { ran: boolean; error?: string } = { ran: false };
        if (db.ok && (db.profiles ?? 0) === 0) {
          try {
            const { ensureCrmSeeded } = await import("@/lib/crm/seed");
            const { getSql } = await import("@/lib/db");
            await ensureCrmSeeded(await getSql());
            const sql2 = await getSql();
            const after = await sql2<{ n: number }>`select count(*)::int as n from profiles`;
            seed = { ran: true };
            db.profiles = after[0]?.n ?? 0;
          } catch (e) {
            seed = {
              ran: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }

        // Light Gmail API probe (token only — no inbox read)
        let gmailProbe: { ok: boolean; error?: string } | null = null;
        if (gmail.configured) {
          try {
            const { google } = await import("googleapis");
            const oauth2 = new google.auth.OAuth2(
              process.env.GMAIL_CLIENT_ID!.trim(),
              process.env.GMAIL_CLIENT_SECRET!.trim(),
            );
            oauth2.setCredentials({
              refresh_token: process.env.GMAIL_REFRESH_TOKEN!.trim(),
            });
            const { credentials } = await oauth2.refreshAccessToken();
            gmailProbe = {
              ok: Boolean(credentials.access_token),
            };
          } catch (e) {
            gmailProbe = {
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }

        // Drive probe: can we see the parent folder?
        let driveProbe: {
          ok: boolean;
          error?: string;
          parentId?: string;
          usingToken?: string;
        } | null = null;
        try {
          const { probeDrive, isDriveConfigured, driveParentFolderId } =
            await import("@/lib/crm/google-drive");
          if (!isDriveConfigured()) {
            driveProbe = {
              ok: false,
              error: "missing_oauth_env",
              parentId: driveParentFolderId(),
            };
          } else {
            const r = await probeDrive();
            driveProbe = {
              ok: r.ok,
              error: r.error,
              parentId: r.parentId || driveParentFolderId(),
              usingToken: process.env.GOOGLE_DRIVE_REFRESH_TOKEN?.trim()
                ? "GOOGLE_DRIVE_REFRESH_TOKEN"
                : "GMAIL_REFRESH_TOKEN",
            };
          }
        } catch (e) {
          driveProbe = {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }

        // Resend probe: does THIS API key see paulmotorcompany.com as verified?
        let resendProbe: {
          ok: boolean;
          error?: string;
          fromDomain?: string;
          domainStatus?: string | null;
          domainVerified?: boolean;
          domainsFound?: string[];
          recentOutbox?: Array<{
            status: string;
            kind: string | null;
            error: string | null;
            to: string;
            created_at: string;
          }>;
        } | null = null;
        {
          const key = process.env.RESEND_API_KEY?.trim();
          const fromEmail = mail.fromEmail;
          const fromDomain = fromEmail.includes("@")
            ? fromEmail.split("@")[1]!.toLowerCase()
            : "";
          if (!key) {
            resendProbe = { ok: false, error: "RESEND_API_KEY missing", fromDomain };
          } else {
            try {
              const res = await fetch("https://api.resend.com/domains", {
                headers: { Authorization: "Bearer " + key },
              });
              const text = await res.text();
              if (!res.ok) {
                resendProbe = {
                  ok: false,
                  error: `Resend API ${res.status}: ${text.slice(0, 200)}`,
                  fromDomain,
                };
              } else {
                let domains: Array<{ name?: string; status?: string }> = [];
                try {
                  const j = JSON.parse(text) as {
                    data?: Array<{ name?: string; status?: string }>;
                  };
                  domains = j.data || [];
                } catch {
                  domains = [];
                }
                const match = domains.find(
                  (d) => (d.name || "").toLowerCase() === fromDomain,
                );
                const status = match?.status || null;
                const verified =
                  status === "verified" ||
                  status === "Verified" ||
                  (status || "").toLowerCase() === "verified";
                resendProbe = {
                  ok: verified,
                  fromDomain,
                  domainStatus: status,
                  domainVerified: verified,
                  domainsFound: domains.map((d) => `${d.name}:${d.status}`),
                  error: verified
                    ? undefined
                    : match
                      ? `Domain ${fromDomain} status is "${status}" (need verified)`
                      : `Domain ${fromDomain} not on this API key's account. Domains: ${domains.map((d) => d.name).join(", ") || "(none)"}`,
                };
              }
            } catch (e) {
              resendProbe = {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
                fromDomain,
              };
            }
          }

          // Last outbound attempts (errors show real Resend messages)
          if (db.ok) {
            try {
              const { getSql } = await import("@/lib/db");
              const sql = await getSql();
              const rows = await sql<{
                status: string;
                kind: string | null;
                error: string | null;
                to_email: string;
                created_at: string;
              }>`
                select status, kind, error, to_email, created_at::text as created_at
                from email_outbox
                order by created_at desc
                limit 5
              `;
              resendProbe = {
                ...(resendProbe || { ok: false }),
                recentOutbox: rows.map((r) => ({
                  status: r.status,
                  kind: r.kind,
                  error: r.error,
                  to: r.to_email,
                  created_at: r.created_at,
                })),
              };
            } catch {
              /* table may not exist */
            }
          }
        }

        const hints: string[] = [];
        if (!hasDatabaseUrl) hints.push("Missing DATABASE_URL");
        if (!gmail.configured) {
          hints.push(
            "Gmail incomplete: need GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER on Production + Redeploy",
          );
        }
        if (gmail.configured && gmailProbe && !gmailProbe.ok) {
          hints.push(
            "Gmail token invalid (invalid_grant) — paste the NEW GMAIL_REFRESH_TOKEN from Terminal into Vercel Production, then Redeploy. Old tokens stop working after re-auth.",
          );
        }
        if (driveProbe && !driveProbe.ok) {
          hints.push(
            `Drive not ready: ${driveProbe.error || "unknown"}. Need valid refresh token with drive.file + parent folder shared with client@ as Editor.`,
          );
        }
        if (db.ok && !db.email_imports_table) {
          hints.push("DB missing email_imports table — redeploy so migrations run, or run migrations/0005");
        }
        if (db.ok && !db.email_portal_column) {
          hints.push("DB missing email_portal column — redeploy so migration 0005 applies");
        }
        if (!gmail.hasHandoffSecret) {
          hints.push("CRM_HANDOFF_SECRET not set — Palmetto Apply cannot post into the CRM");
        }
        if (!mail.hasResendKey) {
          hints.push(
            "RESEND_API_KEY not set — assignment/reminder emails are queued only (not delivered). Add Resend key + optional CRM_FROM_EMAIL on Production, redeploy.",
          );
        }
        if (mail.hasResendKey && resendProbe && !resendProbe.domainVerified) {
          hints.push(
            resendProbe.error ||
              "RESEND_API_KEY does not see CRM_FROM_EMAIL domain as verified — use a key from the Resend account where the domain is Verified.",
          );
        }
        if (resendProbe?.recentOutbox?.some((r) => r.status === "error" || r.status === "queued_no_provider")) {
          const lastErr = resendProbe.recentOutbox.find(
            (r) => r.status === "error" || r.status === "queued_no_provider",
          );
          if (lastErr?.error) {
            hints.push(`Last email error: ${lastErr.error}`);
          }
        }
        if (hints.length === 0) {
          hints.push("Config looks good. Use Admin → Import now, or wait for the 2-minute cron.");
        }

        const body = {
          ok:
            db.ok &&
            gmail.configured &&
            (gmailProbe?.ok ?? false) &&
            (driveProbe?.ok ?? false),
          env: {
            hasDatabaseUrl,
            hasAuthSecret,
            betterAuthUrl,
            vercelUrl,
            crmSeedDemo,
            hasHandoffSecret: gmail.hasHandoffSecret,
          },
          mail,
          resendProbe,
          gmail,
          gmailProbe,
          driveProbe,
          db,
          seed,
          hint: hints.join(" · "),
        };

        return new Response(JSON.stringify(body, null, 2), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
