# Deploy PAUL MOTOR CO. CRM to production

This app is a **TanStack Start** (Vite) full-stack CRM. Production target: **Vercel** + **Neon Postgres** + **Better Auth** (email/password sessions).

## Architecture

| Layer | Local preview | Production |
|---|---|---|
| Database | Embedded PGLite (in-memory) | **Neon Postgres** via `DATABASE_URL` |
| Auth | Better Auth email/password | Same — sessions in Postgres |
| Host | Grok sandbox preview | **Vercel** |
| Schema | `migrations/*.sql` auto-applied | Same files via `npm run build` → `db:migrate` |

There are **no mock data arrays** for core CRM data. Inventory, leads, users, and sessions all live in Postgres tables defined in `migrations/`.

---

## 1. Create a free Neon database

1. Sign up at [https://neon.tech](https://neon.tech) (free tier is fine).
2. Create a project, e.g. `paul-motor-crm`.
3. Copy the **pooled** connection string (includes `-pooler` and `?sslmode=require`).
4. Optional: open SQL Editor and paste `deploy/setup-database.sql` once.  
   Otherwise Vercel’s build will apply `migrations/` automatically when `DATABASE_URL` is set.

## 2. Push this repo to GitHub

If the code is only local:

```bash
cd /path/to/paul-motor-crm
git remote add origin https://github.com/YOUR_ORG/paul-motor-crm.git
git push -u origin main
```

Create an empty repo on GitHub first (no README), then push.

## 3. Deploy on Vercel

1. [vercel.com](https://vercel.com) → **Add New Project** → import the GitHub repo.
2. Framework: leave defaults (Vite / Nitro from this template).
3. **Environment variables** (Production + Preview):

| Name | Example | Required |
|---|---|---|
| `DATABASE_URL` | `postgresql://…@…-pooler…/neondb?sslmode=require` | Yes |
| `BETTER_AUTH_URL` | `https://your-app.vercel.app` | Yes |
| `BETTER_AUTH_SECRET` | output of `openssl rand -base64 32` | Yes |
| `CRM_SEED_DEMO` | `false` | Recommended in prod |
| `VITE_SHOW_DEMO_LOGINS` | `false` | Recommended in prod |

4. Deploy. Build runs `vite build` then `node scripts/migrate.mjs` against Neon.
5. After first deploy, open `/login` and sign in with an admin account you create (see below).

### First admin user

With `CRM_SEED_DEMO=false`, the database starts empty (schema only). Options:

**A. Temporary demo seed (fastest)**  
Set `CRM_SEED_DEMO=true` for **one** deploy, sign in as:

- `jeremyp@paulmotorcompany.com` / `PaulMotor2026!`

Then **change passwords** in Admin, set `CRM_SEED_DEMO=false`, redeploy.

**B. Create users only via Admin after a bootstrap**  
Set `CRM_SEED_DEMO=true` once to get Jeremy, then Admin → Create user for Lucas, Alex, Guillaume. Turn seed off.

## 4. Custom domain (optional)

Vercel → Project → Domains → add `crm.paulmotorcompany.com`.  
Update `BETTER_AUTH_URL` to that exact `https://…` origin and redeploy.

## 5. Security checklist

- [ ] Strong unique `BETTER_AUTH_SECRET`
- [ ] `CRM_SEED_DEMO=false` after bootstrap
- [ ] `VITE_SHOW_DEMO_LOGINS=false` (hides demo chips on login)
- [ ] Each rep has their **own** email + password (Admin → Users)
- [ ] Demo password `PaulMotor2026!` changed for every seeded account
- [ ] Neon backups / branch strategy considered for long-term data
- [ ] Only Jeremy & Guillaume have `admin` role

## 6. Local production-like run

```bash
cp deploy/env.template .env.local
# fill DATABASE_URL, BETTER_AUTH_URL=http://127.0.0.1:8080, BETTER_AUTH_SECRET=…
export $(grep -v '^#' .env.local | xargs)
npm run db:migrate
npm run dev
```

## Files in `deploy/`

| File | Purpose |
|---|---|
| `setup-database.sql` | Full schema for Neon/Supabase SQL editor |
| `env.template` | All env vars for Vercel |
| `seed-team.sql` | Notes only — create users via Admin UI |
| `VERCEL.md` | This guide |
