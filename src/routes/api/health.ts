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

        let db: {
          ok: boolean;
          source: string;
          profiles?: number;
          users?: number;
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
          db = {
            ok: true,
            source: dbSource,
            profiles: profiles[0]?.n ?? 0,
            users: users[0]?.n ?? 0,
          };
        } catch (e) {
          db = {
            ok: false,
            source: hasDatabaseUrl ? "neon" : "pglite",
            error: e instanceof Error ? e.message : String(e),
          };
        }

        // Optionally seed if empty and DB works
        let seed: { ran: boolean; error?: string } = { ran: false };
        if (db.ok && (db.profiles ?? 0) === 0) {
          try {
            const { ensureCrmSeeded } = await import("@/lib/crm/seed");
            const { getSql } = await import("@/lib/db");
            await ensureCrmSeeded(await getSql());
            const { getSql: getSql2 } = await import("@/lib/db");
            const sql2 = await getSql2();
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

        const body = {
          ok: db.ok,
          env: {
            hasDatabaseUrl,
            hasAuthSecret,
            betterAuthUrl,
            vercelUrl,
            crmSeedDemo,
          },
          db,
          seed,
          hint:
            !hasDatabaseUrl
              ? "Set DATABASE_URL (Neon pooled connection string) in Vercel → Settings → Environment Variables, then Redeploy."
              : !db.ok
                ? "DATABASE_URL is set but connection failed. Use Neon pooled URL with ?sslmode=require."
                : (db.profiles ?? 0) === 0
                  ? "Database connected but no users. Open /login once or set CRM_SEED_DEMO=true and redeploy."
                  : "Database OK. If login still fails, confirm password PaulMotor2026! and clear cookies.",
        };

        return new Response(JSON.stringify(body, null, 2), {
          status: db.ok ? 200 : 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
