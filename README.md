# Xero → Supabase Sync

Read-only sync. Pulls **Contacts, Invoices (ACCREC), Bills (ACCPAY), and Credit Notes**
from every Xero organisation authorised for the connection and upserts them into
Supabase. Nothing is ever written back to Xero — only `GET` requests are made.

Incremental: after the first full sync, each run only asks Xero for records
changed since the last run (`UpdatedDateUTC`), so ongoing daily/weekly syncs are
small and fast.

## Cost / rate-limit notes (read this once)

- Xero API access has **no per-call fee** for a normal integration like this.
- Rate limits (per connected organisation): **60 calls/minute, 5,000 calls/day**.
  This sync uses roughly 10–50 calls per run for a small-to-mid-size org — nowhere
  close to the limit, whether run daily or weekly.
- Since March 2026 Xero bills **data egress** on some app tiers ($2.40 AUD/GB over
  the free allowance). A daily/weekly sync of your own org's data is a few MB per
  run — well under the free tier in virtually all cases. Worth a quick glance at
  your app's tier at developer.xero.com if you're syncing many organisations, not
  just your own.
- The script backs off automatically and retries if it ever hits a 429.

## 1. Create a Xero app

1. Go to https://developer.xero.com/app/manage → **New app**.
2. Type: **Web app**.
3. Redirect URI: `http://localhost:5000/callback` (must match `.env` exactly).
4. Copy the **Client ID** and **Client Secret**.

## 2. Create the Supabase tables

Open the Supabase SQL editor for the project named by `SUPABASE_URL`, copy the
complete contents of `supabase/schema.sql`, and run it. Confirm that the
`xero_auth` table appears in the Table Editor before continuing. This SQL script
creates all tables with full multi-organisation support, indexes, and enables
Row Level Security (RLS) on all of them.

## 3. Configure environment

```bash
cp .env.example .env
# fill in XERO_CLIENT_ID, XERO_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY
```

Use a Supabase **Secret key** (Project Settings → API), not the publishable/anon
key — the sync needs to bypass Row Level Security to write. A legacy
`service_role` key is also supported through `SUPABASE_SERVICE_ROLE_KEY`.

## 4. Install and connect

```bash
npm install
npm run setup-auth
```

This opens your browser to Xero's consent screen. Approve access for one or
more organisations, then paste the browser's redirected URL into the terminal. You
can paste it even if the browser displays an error because it upgraded
`localhost` to HTTPS: the URL still contains the authorization code needed by
the script. It stores a refresh token in the `xero_auth` table in Supabase —
you only need to do this once (see "Token lifetime" below).

## 5. Run a sync

```bash
npm run sync
```

First run pulls everything (may take a few minutes for a large org). Every run
after that only pulls what changed.

## Scheduling it daily/weekly

Pick whichever fits how you already run things:

**Plain cron (VPS / always-on server)**
```
0 6 * * *  cd /path/to/xero-supabase-sync && npm run sync >> sync.log 2>&1
```

**GitHub Actions** (`.github/workflows/sync.yml`) — runs in GitHub's cloud, no
server needed:
```yaml
name: Xero Sync
on:
  schedule:
    - cron: "0 6 * * *"   # daily at 06:00 UTC
  workflow_dispatch: {}
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npm run sync
        env:
          XERO_CLIENT_ID: ${{ secrets.XERO_CLIENT_ID }}
          XERO_CLIENT_SECRET: ${{ secrets.XERO_CLIENT_SECRET }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```
(`setup-auth` must still be run once locally first — GitHub Actions only runs
`sync`, which reuses the refresh token already stored in Supabase.)

## Token lifetime

Xero refresh tokens are valid for 60 days **of inactivity**. Every time
`npm run sync` runs, it refreshes and re-stores the token, resetting that
60-day clock — so as long as the scheduled job keeps running at least once
every 60 days, you never need to re-run `setup-auth`. If the schedule ever
lapses that long (or access is revoked in Xero), the next run will fail with a
clear error telling you to reconnect — just run `npm run setup-auth` again.

## What gets synced where

| Xero | Supabase table | Filter |
|---|---|---|
| Contacts | `xero_contacts` | — |
| Invoices | `xero_invoices` | `Type=="ACCREC"` |
| Invoices | `xero_bills` | `Type=="ACCPAY"` |
| Credit Notes | `xero_credit_notes` | — |

Every synced table has a `tenant_id` column. Combined with its Xero record ID,
it forms the primary key, so data from different organisations remains separate.
Every row also stores the full original Xero record in a `raw jsonb` column, so
you're never blocked by a field the flattened columns didn't anticipate.

## Extending

- **More resources** (Payments, Purchase Orders, Bank Transactions, etc.): add
  another `syncResource(...)` call in `sync.ts` plus a matching table/mapper —
  the pagination, rate-limit, and incremental-cursor logic is already generic.

## License

This project is open-source and licensed under the [MIT License](LICENSE).

