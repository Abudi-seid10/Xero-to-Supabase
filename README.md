# Xero & QuickBooks → Supabase / Frappe

Read-only tooling for getting accounting data out of Xero and QuickBooks Online:

1. **Xero → Supabase sync** — contacts, invoices (ACCREC), bills (ACCPAY) and credit
   notes from every authorised Xero organisation, upserted into Supabase.
2. **Export to Frappe / ERPNext** — Data Import CSVs (with line items) and downloaded
   attachments, from Xero (via Supabase) or from QuickBooks Online (directly).

Nothing is ever written back to Xero or QuickBooks — only `GET` requests are made.

| Command | What it does |
|---|---|
| `npm run setup-auth` | One-time Xero OAuth connection (stores the token in Supabase) |
| `npm run sync` | Incremental Xero → Supabase sync |
| `npm run export:frappe` | Xero (from Supabase) → Frappe CSVs + attachments |
| `npm run setup-qbo-auth` | One-time QuickBooks OAuth connection for a company |
| `npm run export:qbo` | QuickBooks Online → Frappe CSVs + attachments |
| `npm run upload:attachments` | Attach exported files to imported Frappe documents |

The sync is incremental: after the first full run, each run only asks Xero for
records changed since the last run (`UpdatedDateUTC`), so daily/weekly syncs are
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

## 4. Install and connect (Xero)

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

The connection requests read-only scopes: contacts, invoices (which also covers
credit notes) and **attachments**. If you connected before attachments support was
added, run `npm run setup-auth` again so the stored token gains the attachments scope.

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

## Export to Frappe / ERPNext

Turns the data already synced into Supabase into Frappe **Data Import** CSVs, and
downloads every invoice, bill and credit note attachment from Xero (GET only).

```bash
npm run sync                                   # make sure Supabase is current
npm run export:frappe -- --tenant "My Org"     # one organisation per Frappe company
```

Set `FRAPPE_COMPANY` (and optionally the groups, tax accounts and account map) in
`.env` first. Output goes to `export/<organisation>/` (git-ignored); choose another
folder with `--out "D:\Frappe\xero"` or `EXPORT_DIR` in `.env`:

| File | Frappe DocType | Notes |
|---|---|---|
| `customers.csv` / `suppliers.csv` | Customer / Supplier | Contacts used on sales docs become Customers, on bills Suppliers |
| `contacts.csv` | Contact | Email/phone, linked to the Customer/Supplier |
| `sales_invoices.csv` | Sales Invoice | ACCREC invoices **and** ACCRECCREDIT credit notes (`Is Return`) |
| `purchase_invoices.csv` | Purchase Invoice | ACCPAY bills **and** ACCPAYCREDIT credit notes |
| `attachments/` + `attachments_manifest.csv` | File | Downloaded originals |

Import order in Frappe (**Data Import**, type *Insert New Records*): Customers,
Suppliers, Contacts, Sales Invoices, Purchase Invoices. Leave "Submit After
Import" off until you have spot-checked the drafts.

**Line items** are one child row each (`Items` table). `Rate` is the net line
amount divided by quantity, so discounts and tax-inclusive lines match Xero's
totals. Tax is exported as one `Actual` tax row per document equal to Xero's
`TotalTax`; set `FRAPPE_SALES_TAX_ACCOUNT` / `FRAPPE_PURCHASE_TAX_ACCOUNT`.
Xero account codes are only carried over if you provide `FRAPPE_ACCOUNT_MAP_FILE`.

**Attachments** cannot be bulk-imported by Data Import. After the documents exist,
upload them (needs a Frappe API key/secret in `.env`):

```bash
npm run upload:attachments -- export/MyOrg   # needs FRAPPE_URL, FRAPPE_API_KEY, FRAPPE_API_SECRET
```

Each exported document has `XERO:<id>` (or `QBO:…#` for QuickBooks) in its Remarks; the uploader uses it to find
the right document, and is safe to re-run. The export is also resumable: files
already on disk are skipped, which matters because Xero allows 5,000 calls/day per
organisation and each attachment costs a call (the script paces itself to ~55/min).

**Not exported (Xero):** documents with status `DELETED`/`VOIDED`, payments/allocations, Xero
inventory items (lines are free-text with no Item Code), and contact-level
attachments. Frappe column labels vary slightly by version; Data Import's column
mapping step lets you re-map any that differ.

## Export QuickBooks Online to Frappe

```bash
npm run export:qbo -- --out "D:\Frappe\qb"
```

Reads the company directly from the QuickBooks API (no Supabase) and writes the same
CSV set as the Xero export, plus attachments: customers, vendors, invoices, bills,
credit memos and vendor credits, with line items. Voided documents are skipped. The
output folder is named after the QuickBooks company.

**Setup** (Intuit developer portal → your app):

1. Use keys matching your data: **Production** keys for a real company, Development keys
   for a sandbox company. Production keys may require Intuit's app questionnaire first.
2. Put `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and `QBO_ENVIRONMENT` (`production` or `sandbox`)
   in `.env`.
3. Connect the company:
   ```bash
   npm run setup-qbo-auth
   ```
   It opens QuickBooks' consent page. Pick the company and approve. The browser then lands
   on an Intuit Playground page; **don't click anything there**, just copy the full
   address-bar URL (it holds the code and company ID) and paste it into the terminal within
   about 5 minutes. The script exchanges the code, saves the refresh token, confirms the
   company name and prints the company ID. Put it in `.env` as `QBO_REALM_ID`.

   (Alternative: authorise in the Intuit OAuth 2.0 Playground yourself and put the
   refresh token in `QBO_REFRESH_TOKEN`.)

**More than one company:** QuickBooks needs a separate authorisation per company. Run
`npm run setup-qbo-auth` once for each (choosing a different company each time; give the
extra ones their own settings file with `--env-file .env.qbo2` if you want, which gets that
company's `QBO_REALM_ID` written into it). Each company's token is kept in its own
git-ignored `.qbo-auth-<companyId>.json`.

`npm run export:qbo` then exports **every connected company in one run**: `QBO_REALM_ID`
plus every company with a token file for the current client ID. Each company goes to its own
folder named after it, a failure in one company doesn't stop the others, and `--realm <id>`
limits a run to one company. With several companies `FRAPPE_COMPANY` is ignored so each
uses its own QuickBooks company name. Re-running skips attachments already downloaded.

Saved tokens rotate on every use. For the company in `.env`, a changed `QBO_REFRESH_TOKEN`
or client ID is detected and takes precedence; refresh tokens last ~100 days.

Mapping notes: QuickBooks only provides a document-level tax total, so tax is one row
per document (tax-inclusive documents spread it pro rata over the lines). Bill lines
carry their QuickBooks account name; sales lines have no income account (Frappe's
default applies). Documents carry a `QBO:<type>-<id>#` marker in Remarks so
`upload:attachments` matches them. Attachments linked to customers/vendors are skipped.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY contains a publishable key` | Put a **Secret key** (`sb_secret_…`) in `SUPABASE_SECRET_KEY`, or a legacy `service_role` JWT in `SUPABASE_SERVICE_ROLE_KEY`. An `sbp_…` value is an account access token, not a project key. |
| Xero `Invalid redirect_uri` | `XERO_REDIRECT_URI` must exactly match a redirect URI on the Xero app, including `http` vs `https`, port and path. |
| Xero attachments return `401 AuthorizationUnsuccessful` | The stored token predates the attachments scope. Run `npm run setup-auth` and approve every organisation again. |
| QuickBooks `invalid_grant … Incorrect Token type or clientID` | The refresh token was issued for a different app/environment than `QBO_CLIENT_ID`. Run `npm run setup-qbo-auth` again with the same keys. |
| QuickBooks `403 ApplicationAuthorizationFailed` | Wrong environment or company ID: sandbox credentials against the production host (or vice versa), or a `QBO_REALM_ID` that isn't the authorised company. |
| `Missing required env var: FRAPPE_COMPANY` | Xero export needs the exact Frappe Company name. The QuickBooks export defaults to the QuickBooks company name. |

**Secrets:** never paste keys or tokens into chat, issues or commits — edit `.env`
directly. Anything exposed should be rotated. `.env`, `.qbo-auth.json` and `export/`
are git-ignored.

## Extending

- **More resources** (Payments, Purchase Orders, Bank Transactions, etc.): add
  another `syncResource(...)` call in `sync.ts` plus a matching table/mapper —
  the pagination, rate-limit, and incremental-cursor logic is already generic.

## License

This project is open-source and licensed under the [MIT License](LICENSE).

