/** Read-only, tenant-scoped Xero -> Supabase sync. */
import "dotenv/config";
import { supabase, upsertInBatches } from "./supabase.js";
import { fetchAllPages, loadStoredAuth, loadTenants, refreshAccessToken } from "./xero.js";
import { contactToRow, creditNoteToRow, invoiceToRow } from "./mappers.js";

interface SyncStateRow {
  last_synced_at: string | null;
}

async function getLastSyncedAt(tenantId: string, resource: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from("xero_sync_state")
    .select("last_synced_at")
    .eq("tenant_id", tenantId)
    .eq("resource", resource)
    .maybeSingle<SyncStateRow>();

  if (error) throw new Error(`Failed to read sync state for ${resource}: ${error.message}`);
  return data?.last_synced_at ? new Date(data.last_synced_at) : null;
}

async function setSyncState(tenantId: string, resource: string, syncedAt: Date, count: number): Promise<void> {
  const { error } = await supabase.from("xero_sync_state").upsert(
    {
      tenant_id: tenantId,
      resource,
      last_synced_at: syncedAt.toISOString(),
      last_run_at: new Date().toISOString(),
      last_run_count: count,
    },
    { onConflict: "tenant_id,resource" }
  );
  if (error) throw new Error(`Failed to update sync state for ${resource}: ${error.message}`);
}

interface SyncResourceOptions<T> {
  resource: string;
  arrayKey: string;
  table: string;
  conflictColumns: string;
  mapRow: (record: T) => Record<string, unknown>;
  tenantId: string;
  accessToken: string;
  runStartedAt: Date;
  safetyBufferMs: number;
  where?: string;
  stateKey?: string;
}

async function syncResource<T>(opts: SyncResourceOptions<T>): Promise<void> {
  const stateKey = opts.stateKey ?? opts.resource.toLowerCase();
  const lastSyncedAt = await getLastSyncedAt(opts.tenantId, stateKey);

  console.log(
    `  Fetching ${opts.table}${opts.where ? ` (${opts.where})` : ""}` +
      (lastSyncedAt ? ` — changed since ${lastSyncedAt.toISOString()}` : " — full sync")
  );

  const records = await fetchAllPages<T>(opts.resource, opts.arrayKey, {
    accessToken: opts.accessToken,
    tenantId: opts.tenantId,
    where: opts.where,
    order: "UpdatedDateUTC ASC",
    ifModifiedSince: lastSyncedAt,
  });

  if (records.length > 0) {
    const rows = records.map((record) => ({ tenant_id: opts.tenantId, ...opts.mapRow(record) }));
    await upsertInBatches(opts.table, rows, opts.conflictColumns);
    console.log(`    Upserted ${rows.length} row(s).`);
  } else {
    console.log("    No changes.");
  }

  await setSyncState(
    opts.tenantId,
    stateKey,
    new Date(opts.runStartedAt.getTime() - opts.safetyBufferMs),
    records.length
  );
}

async function syncTenant(tenantId: string, tenantName: string | null, accessToken: string, runStartedAt: Date) {
  console.log(`\nSyncing ${tenantName ?? "unnamed organisation"} (${tenantId})`);
  const common = { tenantId, accessToken, runStartedAt, safetyBufferMs: 5 * 60 * 1000 };

  await syncResource({
    ...common,
    resource: "Contacts",
    arrayKey: "Contacts",
    table: "xero_contacts",
    conflictColumns: "tenant_id,xero_contact_id",
    mapRow: contactToRow,
  });
  await syncResource({
    ...common,
    resource: "Invoices",
    arrayKey: "Invoices",
    table: "xero_invoices",
    conflictColumns: "tenant_id,xero_invoice_id",
    mapRow: invoiceToRow,
    where: 'Type=="ACCREC"',
    stateKey: "invoices",
  });
  await syncResource({
    ...common,
    resource: "Invoices",
    arrayKey: "Invoices",
    table: "xero_bills",
    conflictColumns: "tenant_id,xero_invoice_id",
    mapRow: invoiceToRow,
    where: 'Type=="ACCPAY"',
    stateKey: "bills",
  });
  await syncResource({
    ...common,
    resource: "CreditNotes",
    arrayKey: "CreditNotes",
    table: "xero_credit_notes",
    conflictColumns: "tenant_id,xero_credit_note_id",
    mapRow: creditNoteToRow,
  });
}

async function main() {
  const runStartedAt = new Date();
  console.log(`Xero -> Supabase sync starting at ${runStartedAt.toISOString()}`);

  const stored = await loadStoredAuth();
  const { accessToken } = await refreshAccessToken(
    stored.tenant_id,
    stored.tenant_name,
    stored.refresh_token
  );
  const tenants = await loadTenants();
  console.log(`Authenticated. Syncing ${tenants.length} organisation(s).`);

  for (const tenant of tenants) {
    await syncTenant(tenant.tenantId, tenant.tenantName, accessToken, runStartedAt);
  }

  console.log(`\nSync complete in ${((Date.now() - runStartedAt.getTime()) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("\nSync failed:", err);
  process.exit(1);
});
