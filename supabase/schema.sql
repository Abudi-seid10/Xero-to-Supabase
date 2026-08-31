-- ============================================================
-- Xero -> Supabase Sync Schema
-- Run this once in the Supabase SQL editor before first sync.
-- ============================================================

-- Stores the single Xero OAuth connection (refresh token rotates on
-- every use, so this table is written to on every run).
create table if not exists xero_auth (
  id smallint primary key default 1,
  tenant_id text not null,
  tenant_name text,
  refresh_token text not null,
  updated_at timestamptz not null default now(),
  constraint xero_auth_singleton check (id = 1)
);

-- Lists every Xero organisation available through the shared OAuth connection.
create table if not exists xero_tenants (
  tenant_id text primary key,
  tenant_name text,
  updated_at timestamptz not null default now()
);

-- Tracks the last successful "UpdatedDateUTC" cursor per resource so
-- each run only pulls records changed since the previous run.
create table if not exists xero_sync_state (
  tenant_id text not null,
  resource text not null,
  last_synced_at timestamptz,
  last_run_at timestamptz,
  last_run_count integer,
  primary key (tenant_id, resource)
);

-- ---------------- Contacts ----------------
create table if not exists xero_contacts (
  tenant_id text not null,
  xero_contact_id uuid not null,
  contact_number text,
  name text,
  first_name text,
  last_name text,
  email_address text,
  contact_status text,
  is_customer boolean,
  is_supplier boolean,
  phone text,
  tax_number text,
  default_currency text,
  updated_date_utc timestamptz,
  raw jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (tenant_id, xero_contact_id)
);
create index if not exists idx_xero_contacts_tenant_updated on xero_contacts (tenant_id, updated_date_utc);
create index if not exists idx_xero_contacts_name on xero_contacts (tenant_id, name);

-- ---------------- Invoices (Type = ACCREC, sales) ----------------
create table if not exists xero_invoices (
  tenant_id text not null,
  xero_invoice_id uuid not null,
  invoice_number text,
  reference text,
  type text,
  status text,
  contact_id uuid,
  contact_name text,
  currency_code text,
  invoice_date date,
  due_date date,
  fully_paid_on_date date,
  sub_total numeric,
  total_tax numeric,
  total numeric,
  amount_due numeric,
  amount_paid numeric,
  amount_credited numeric,
  updated_date_utc timestamptz,
  raw jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (tenant_id, xero_invoice_id)
);
create index if not exists idx_xero_invoices_tenant_updated on xero_invoices (tenant_id, updated_date_utc);
create index if not exists idx_xero_invoices_contact on xero_invoices (tenant_id, contact_id);
create index if not exists idx_xero_invoices_status on xero_invoices (tenant_id, status);

-- ---------------- Bills (Type = ACCPAY, purchases) ----------------
create table if not exists xero_bills (
  tenant_id text not null,
  xero_invoice_id uuid not null,
  invoice_number text,
  reference text,
  type text,
  status text,
  contact_id uuid,
  contact_name text,
  currency_code text,
  invoice_date date,
  due_date date,
  fully_paid_on_date date,
  sub_total numeric,
  total_tax numeric,
  total numeric,
  amount_due numeric,
  amount_paid numeric,
  amount_credited numeric,
  updated_date_utc timestamptz,
  raw jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (tenant_id, xero_invoice_id)
);
create index if not exists idx_xero_bills_tenant_updated on xero_bills (tenant_id, updated_date_utc);
create index if not exists idx_xero_bills_contact on xero_bills (tenant_id, contact_id);
create index if not exists idx_xero_bills_status on xero_bills (tenant_id, status);

-- ---------------- Credit Notes ----------------
create table if not exists xero_credit_notes (
  tenant_id text not null,
  xero_credit_note_id uuid not null,
  credit_note_number text,
  reference text,
  type text,
  status text,
  contact_id uuid,
  contact_name text,
  currency_code text,
  credit_note_date date,
  sub_total numeric,
  total_tax numeric,
  total numeric,
  remaining_credit numeric,
  updated_date_utc timestamptz,
  raw jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (tenant_id, xero_credit_note_id)
);
create index if not exists idx_xero_credit_notes_tenant_updated on xero_credit_notes (tenant_id, updated_date_utc);
create index if not exists idx_xero_credit_notes_contact on xero_credit_notes (tenant_id, contact_id);

-- Row Level Security: locked down by default. The sync script uses the
-- Supabase SECRET key or legacy SERVICE ROLE key, which bypasses RLS entirely,
-- so these tables stay inaccessible to anon/authenticated clients unless you
-- explicitly add policies for your dashboard app later.
alter table xero_auth enable row level security;
alter table xero_tenants enable row level security;
alter table xero_sync_state enable row level security;
alter table xero_contacts enable row level security;
alter table xero_invoices enable row level security;
alter table xero_bills enable row level security;
alter table xero_credit_notes enable row level security;

