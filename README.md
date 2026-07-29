# PAUL MOTOR CO. CRM

Luxury & exotic vehicle **sales CRM** for Paul Motor Company (Montréal / Verdun).

Floor-first lead capture · inventory · pipeline · test drives · admin metrics.

## Stack

- **TanStack Start** (React 19 + Vite) on **Vercel**
- **Postgres** via **Neon** in production (PGLite only for local/sandbox preview)
- **Better Auth** — email/password sessions (secure, DB-backed)
- Tailwind + shadcn-style UI

## Team logins (after seed / Admin setup)

| Role | Name | Email |
|---|---|---|
| Admin | Jeremy Paul | jeremyp@paulmotorcompany.com |
| Admin | Guillaume Decroocq | guillaume.dec@paulmotorcompany.com |
| Sales | Lucas Legatos | lucasl@paulmotorcompany.com |
| Sales | Alex Hudon | alexh@paulmotorcompany.com |

## Local development

```bash
npm install
npm run dev          # http://127.0.0.1:8080  (PGLite if no DATABASE_URL)
npm run typecheck
npm run build
```

## Production

See **[deploy/VERCEL.md](./deploy/VERCEL.md)** for:

1. Neon Postgres setup  
2. GitHub → Vercel deploy  
3. Environment variables (`deploy/env.template`)  
4. SQL setup (`deploy/setup-database.sql`)  

## Features

- **Parse from email** — paste inventory or lease inquiries  
- **Inventory vs Lease** lead types  
- Live inventory dropdown (paulmotorleasing.com snapshot + admin sync)  
- PDF quote attach  
- Kanban pipeline, test drives, Google review tracking  
- Admin: metrics, create / **edit** / deactivate / **remove** users  

## License

Private — Paul Motor Company internal use.
