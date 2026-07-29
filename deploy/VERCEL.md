# Deploy PAUL MOTOR CO. CRM to Vercel (5 minutes)

Your code is on GitHub:  
**https://github.com/PAULMOTOR/moss-drift-able-monarch**

---

## One-click import

Open this link (signed into Vercel with the same Google/GitHub account):

**[Import this repo on Vercel →](https://vercel.com/new/import?s=https://github.com/PAULMOTOR/moss-drift-able-monarch)**

Or: [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → choose `PAULMOTOR/moss-drift-able-monarch`.

---

## Before you click Deploy — free Neon database

The CRM needs a real Postgres database (leads, logins, sessions). Free Neon:

1. Go to **[https://console.neon.tech](https://console.neon.tech)** → sign up free  
2. **Create project** → name it `paul-motor-crm`  
3. Copy the **pooled** connection string  
   (looks like `postgresql://…@ep-….aws.neon.tech/neondb?sslmode=require`  
   Prefer the one with `-pooler` in the host.)

---

## Environment variables (paste in Vercel before Deploy)

In the Vercel import screen → **Environment Variables** (or Project → Settings → Environment Variables after):

| Name | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Neon pooled connection string | Required |
| `BETTER_AUTH_SECRET` | long random string | Generate: `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `https://YOUR-PROJECT.vercel.app` | Set after you know the Vercel URL; no trailing slash |
| `CRM_SEED_DEMO` | `true` | First deploy only — creates team logins |
| `VITE_SHOW_DEMO_LOGINS` | `false` | Keep false in production |

**Tip:** Deploy once without `BETTER_AUTH_URL`, note the URL Vercel gives you (e.g. `https://moss-drift-able-monarch.vercel.app`), then add `BETTER_AUTH_URL` and **Redeploy**.

Or set `BETTER_AUTH_URL` after import but before first deploy if the project name is fixed.

---

## After deploy — first login

With `CRM_SEED_DEMO=true`, open your Vercel URL → **/login**:

| Person | Email | Password (change ASAP) |
|---|---|---|
| Jeremy (admin) | jeremyp@paulmotorcompany.com | `PaulMotor2026!` |
| Guillaume (admin) | guillaume.dec@paulmotorcompany.com | `PaulMotor2026!` |
| Lucas (sales) | lucasl@paulmotorcompany.com | `PaulMotor2026!` |
| Alex (sales) | alexh@paulmotorcompany.com | `PaulMotor2026!` |

Then:

1. Sign in as Jeremy → **Admin** → **Edit** each user → set a real password  
2. Set `CRM_SEED_DEMO` to `false` in Vercel → Redeploy  

---

## Optional: Neon SQL manually

If migrations fail on build, open Neon SQL Editor and paste:

`deploy/setup-database.sql`

Then redeploy (build runs `npm run db:migrate`).

---

## Custom domain later

Vercel → Project → Domains → `crm.paulmotorcompany.com`  
Update `BETTER_AUTH_URL` to that HTTPS origin → Redeploy.

---

## Architecture

| | |
|---|---|
| Host | Vercel |
| Database | Neon Postgres (`DATABASE_URL`) |
| Auth | Better Auth email/password (sessions in Postgres) |
| Schema | `migrations/*.sql` applied on each build |
