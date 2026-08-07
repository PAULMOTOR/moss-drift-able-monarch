# CRM + DMS dual-track branching

Paul Motor keeps **one repo**, two tracks:

| Track | Git branch | Deploy | Database | Purpose |
|---|---|---|---|---|
| **CRM v1 (live)** | `main` | Production Vercel | Prod Neon | Floor CRM; employee feedback |
| **DMS lab** | `dms` | Separate Vercel project | Separate Neon | Future DMS + Business Central |

## Rules (non-negotiable)

1. **CRM feedback always lands on `main` first** and deploys to production CRM.
2. **DMS-only work lives on `dms`** (BC, GL hooks, accounting modules) until proven.
3. **`main` is merged into `dms` at least weekly** so lab always inherits CRM wins.
4. **Never point the lab at the production database** or production Gmail/Drive tokens.
5. **Never force-push `main`.** Prefer PRs for both tracks when more than one person commits.

```text
employee feedback ──► PR ──► main ──► production CRM
                              │
                              └── weekly merge ──► dms ──► DMS lab Vercel
```

## Weekly feed (automated)

GitHub Action: **`.github/workflows/weekly-merge-main-into-dms.yml`**

- Runs **every Monday 14:00 UTC** (~10:00 America/Toronto)
- Also runnable manually: Actions → “Weekly merge main → dms” → Run workflow
- On success: pushes updated `dms`
- On conflict: fails loudly (check Actions log; resolve locally — see below)

## Manual merge (if the Action fails or you want it sooner)

```bash
git fetch origin
git checkout dms
git pull origin dms
git merge origin/main
# resolve conflicts if any — prefer CRM behavior for sales/credit UI
git push origin dms
```

Or run:

```bash
./scripts/merge-main-into-dms.sh
```

## Where to put new code

| Kind of change | Branch |
|---|---|
| Lead routing, credit sheet, calendar, quotes, permissions, performance | `main` |
| Business Central API, GL posting, AR aging, inventory cost accounting | `dms` |
| Service WO the floor needs now | `main` (polish); BC post on `dms` |
| Shared auth / types | `main` first, then merge feeds `dms` |

## Lab environment checklist

See **[deploy/DMS_LAB.md](../deploy/DMS_LAB.md)**.

Minimum lab env:

```bash
APP_TRACK=dms
VITE_APP_TRACK=dms
LAB_DISABLE_SIDE_EFFECTS=true
DATABASE_URL=<dms-dev neon, not prod>
BETTER_AUTH_URL=<lab vercel url>
APP_URL=<lab vercel url>
# Do NOT paste prod Gmail refresh tokens
```

## Promoting DMS features to production later

When a DMS module is ready for the floor:

1. Open a PR **`dms` → `main`** with only the safe modules (or cherry-pick).
2. Feature-flag if needed (`APP_TRACK` / module flags).
3. Deploy CRM prod only after QA on lab Neon + BC sandbox.

Until then, **production stays CRM-shaped**; lab is allowed to grow DMS modules.
