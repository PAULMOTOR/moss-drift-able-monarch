# DMS lab environment (parallel to CRM v1)

Clone of the CRM for building a full DMS + Business Central — **without touching live deals**.

## 1. Neon (database)

1. [console.neon.tech](https://console.neon.tech) → **New project** → `paul-motor-dms-dev`
2. Optional: create a **branch** from prod Neon for a one-time data copy, then disconnect
3. Copy the **pooled** connection string → lab `DATABASE_URL` only

Never reuse production `DATABASE_URL` on the lab project.

## 2. Vercel (second project)

1. [vercel.com/new](https://vercel.com/new) → import **same** GitHub repo `PAULMOTOR/moss-drift-able-monarch`
2. Project name e.g. `paul-motor-dms-lab`
3. **Production Branch** = `dms` (not `main`)
4. Set environment variables (below)
5. Deploy

Keep the existing CRM project on **`main`** unchanged.

## 3. Environment variables (lab only)

| Name | Value | Notes |
|---|---|---|
| `DATABASE_URL` | DMS Neon pooled URL | Required |
| `BETTER_AUTH_SECRET` | New random secret | Different from prod |
| `BETTER_AUTH_URL` | `https://YOUR-LAB.vercel.app` | Lab URL |
| `APP_URL` | same as lab URL | Credit links point at lab |
| `APP_TRACK` | `dms` | Server track |
| `VITE_APP_TRACK` | `dms` | Shows amber **DMS LAB** banner |
| `LAB_DISABLE_SIDE_EFFECTS` | `true` | Blocks Gmail import + reminder emails |
| `CRM_SEED_DEMO` | `true` (optional) | Fake data if empty DB |
| Gmail / Drive / Resend | **omit** or sandbox | Avoid real client mail |

`vercel.json` on the `dms` branch has **no crons**. Even if someone re-enables them, `LAB_DISABLE_SIDE_EFFECTS` makes jobs no-op.

## 4. Weekly CRM → DMS feed

Documented in **[docs/BRANCHING.md](../docs/BRANCHING.md)**.

- GitHub Action merges `main` → `dms` every Monday
- Or run `./scripts/merge-main-into-dms.sh` locally

## 5. Sanity checks after first lab deploy

- [ ] Amber **DMS LAB** banner visible after login  
- [ ] Login works against lab Neon (not prod users unless you copied DB)  
- [ ] `/api/cron/import-emails` returns `skipped: lab_side_effects_disabled`  
- [ ] Prod CRM still on previous Vercel project / `main`  

## 6. Building DMS features

- New UI under `/dms` (scaffold already on the `dms` branch)
- BC config stubs: see `src/lib/dms/` on `dms`
- Do not rewrite core lead/credit flows only on `dms` — improve them on `main` so the floor benefits and the weekly merge keeps lab current
