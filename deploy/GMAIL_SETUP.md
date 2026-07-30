# Connect client@paulmotorcompany.com for auto lead import

The CRM reads **only** this shared inbox via Gmail API (read-only).  
It does **not** send email and does **not** need other staff inboxes.

## What the CRM does with each email

| From / subject | Lead type |
|---|---|
| **TAdvantage** `no-reply@tadvantage.ca` — *General Contact* / *Contact général* / *Contact Us* | **General Interest** |
| **TAdvantage** — *Financing Form Individuals* / *Location individuel* | **Lease** |
| **TAdvantage** — *Leasing Form Business* / *Location Entreprise* | **Lease** |
| **CarGurus** `dealer-leads@messages.cargurus.com` — Phone Lead / Lead Submission | **Inventory** |
| **AutoTrader** `1-Source@dealerleads.trader.ca` | **Inventory** |

**Duplicate protection:** same customer email or phone + same vehicle/stock (open lead, last 90 days) → merge into existing lead (adds activity note), no second card.

---

## Step 1 — Google Cloud (one-time, ~10 min)

1. Sign in to [Google Cloud Console](https://console.cloud.google.com) with a Google admin that can manage Workspace (or with `client@…` if allowed).
2. Create or pick a project, e.g. **Paul Motor CRM**.
3. **APIs & Services → Library** → enable **Gmail API**.
4. **APIs & Services → OAuth consent screen**
   - User type: **Internal** (if Workspace) or **External** (then add `client@…` as test user).
   - App name: `Paul Motor CRM`
   - Scopes: add `https://www.googleapis.com/auth/gmail.readonly`
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: `CRM Gmail Import`
   - Copy **Client ID** and **Client secret**

## Step 2 — Get refresh token (one-time)

On any computer with Node:

```bash
git clone https://github.com/PAULMOTOR/moss-drift-able-monarch.git
cd moss-drift-able-monarch
npm install

GMAIL_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
GMAIL_CLIENT_SECRET="your-secret" \
node scripts/gmail-oauth.mjs
```

- Browser opens → **sign in as `client@paulmotorcompany.com`** (important).
- Click Allow.
- Terminal prints `GMAIL_REFRESH_TOKEN=...`

## Step 3 — Vercel environment variables

Project → **Settings → Environment Variables** (Production) add:

| Key | Value |
|---|---|
| `GMAIL_CLIENT_ID` | from Google Cloud |
| `GMAIL_CLIENT_SECRET` | from Google Cloud |
| `GMAIL_REFRESH_TOKEN` | from step 2 |
| `GMAIL_USER` | `client@paulmotorcompany.com` |
| `CRON_SECRET` | random string, e.g. `openssl rand -hex 24` |

**Redeploy** after saving.

## Step 4 — Near real-time polling

Vercel **Hobby** crons only run about **once per day**. For every 2 minutes:

1. Create a free job at [cron-job.org](https://cron-job.org) (or similar).
2. URL:

```text
https://moss-drift-able-monarch.vercel.app/api/cron/import-emails?secret=YOUR_CRON_SECRET
```

3. Schedule: every **2 minutes**.
4. Method: GET.

Optional: Vercel Pro can use built-in crons (`vercel.json` already documents the path).

## Step 5 — Test

1. As admin → **Admin** → **Email import** → **Import now**.
2. Or open the cron URL once in a browser (with secret).
3. Check **Pipeline** for new cards; **Admin** shows recent import log.

---

## Security notes

- Scope is **read-only** Gmail.
- Only the shared `client@` account is authorized.
- Rotate `CRON_SECRET` if the URL is leaked.
- Revoke access anytime: Google Account → Security → Third-party access for `client@`.
