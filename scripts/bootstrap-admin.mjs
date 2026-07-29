#!/usr/bin/env node
/**
 * Create the first admin user against production Neon (or any DATABASE_URL).
 *
 * Usage:
 *   DATABASE_URL=... \
 *   BOOTSTRAP_ADMIN_EMAIL=jeremyp@paulmotorcompany.com \
 *   BOOTSTRAP_ADMIN_PASSWORD='your-long-secret' \
 *   BOOTSTRAP_ADMIN_NAME='Jeremy Paul' \
 *   node scripts/bootstrap-admin.mjs
 *
 * Requires migrations already applied (`npm run db:migrate`).
 * Uses Better Auth-compatible password hashing (scrypt via better-auth/crypto).
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";

const databaseUrl = process.env.DATABASE_URL?.trim();
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "Admin";
const phone = process.env.BOOTSTRAP_ADMIN_PHONE?.trim() || null;
const title = process.env.BOOTSTRAP_ADMIN_TITLE?.trim() || "Administrator";

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!email || !email.includes("@")) {
  console.error("BOOTSTRAP_ADMIN_EMAIL is required");
  process.exit(1);
}
if (password.length < 10) {
  console.error("BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

async function main() {
  const client = await pool.connect();
  try {
    const existing = await client.query("select id from profiles where email = $1", [email]);
    if (existing.rows[0]) {
      console.log(`[bootstrap] profile already exists for ${email} — nothing to do`);
      return;
    }

    const userId = randomUUID();
    const profileId = randomUUID();
    const accountId = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);

    await client.query("BEGIN");
    await client.query(
      `insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
       values ($1, $2, $3, true, null, $4, $4)`,
      [userId, name, email, now],
    );
    await client.query(
      `insert into account (
         id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
       ) values ($1, $2, 'credential', $3, $4, $5, $5)`,
      [accountId, email, userId, passwordHash, now],
    );
    await client.query(
      `insert into profiles (id, user_id, email, name, role, active, phone, title)
       values ($1, $2, $3, $4, 'admin', true, $5, $6)`,
      [profileId, userId, email, name, phone, title],
    );
    await client.query("COMMIT");
    console.log(`[bootstrap] admin created: ${name} <${email}>`);
    console.log("[bootstrap] sign in at your BETTER_AUTH_URL /login");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[bootstrap] failed:", err?.message || err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
