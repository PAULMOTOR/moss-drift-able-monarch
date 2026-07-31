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
        };

        const gmail = {
          hasClientId: Boolean(process.env.GMAIL_CLIENT_ID?.trim()),
          hasClientSecret: Boolean(process.env.GMAIL_CLIENT_SECRET?.trim()),
          hasRefreshToken: Boolean(process.env.GMAIL_REFRESH_TOKEN?.trim()),
          user: process.env.GMAIL_USER?.trim() || null,
          hasCronSecret: Boolean(process.env.CRON_SECRET?.trim()),
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

        const hints: string[] = [];
        if (!hasDatabaseUrl) hints.push("Missing DATABASE_URL");
        if (!gmail.configured) {
          hints.push(
            "Gmail incomplete: need GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER on Production + Redeploy",
          );
        }
        if (gmail.configured && gmailProbe && !gmailProbe.ok) {
          hints.push(
            "Gmail token invalid — re-run scripts/gmail-oauth.mjs as client@ and update GMAIL_REFRESH_TOKEN",
          );
        }
        if (db.ok && !db.email_imports_table) {
          hints.push("DB missing email_imports table — redeploy so migrations run, or run migrations/0005");
        }
        if (db.ok && !db.email_portal_column) {
          hints.push("DB missing email_portal column — redeploy so migration 0005 applies");
        }
        if (!gmail.hasCronSecret) {
          hints.push("CRON_SECRET not set — Vercel cron will get 401");
        }
        if (!mail.hasResendKey) {
          hints.push(
            "RESEND_API_KEY not set — assignment/reminder emails are queued only (not delivered). Add Resend key + optional CRM_FROM_EMAIL on Production, redeploy.",
          );
        }
        if (hints.length === 0) {
          hints.push("Config looks good. Use Admin → Import now, or wait for the 2-minute cron.");
        }

        const body = {
          ok: db.ok && gmail.configured && (gmailProbe?.ok ?? false),
          env: {
            hasDatabaseUrl,
            hasAuthSecret,
            betterAuthUrl,
            vercelUrl,
            crmSeedDemo,
          },
          mail,
          gmail,
          gmailProbe,
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
