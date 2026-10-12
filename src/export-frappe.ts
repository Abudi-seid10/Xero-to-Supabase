/**
 * Export synced Xero data (read from Supabase) to Frappe/ERPNext Data Import CSVs,
 * and download invoice/bill/credit-note attachments from Xero (GET requests only).
 *
 *   npm run export:frappe -- [--tenant <id|name>] [--out <folder>] [--skip-attachments]
 */
import "dotenv/config";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { supabase } from "./supabase.js";
import { loadStoredAuth, loadTenants, refreshAccessToken, xeroGetRaw, type XeroTenant } from "./xero.js";
import { writeCsv, type CsvRow } from "./csv.js";
import { loadFrappeConfig, writeFrappeFiles } from "./frappe-writer.js";
import {
  CONTACT_HEADERS, CUSTOMER_HEADERS, PURCHASE_INVOICE_HEADERS, SALES_INVOICE_HEADERS, SKIPPED_STATUSES,
  SUPPLIER_HEADERS, contactRow, customerRow, documentRows, isSalesDoc, supplierRow, xeroDocId, xeroDocNumber,
  xeroMarker, type FrappeConfig, type XeroContactRaw, type XeroDocRaw,
} from "./frappe-mappers.js";

const ATTACHMENT_HEADERS = ["doctype", "xero_id", "document_number", "file_name", "file_path"];
const CALL_SPACING_MS = 1100; // stay under Xero's 60 calls/minute per organisation

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "unnamed";

/** Page through a Supabase table; PostgREST caps responses at 1000 rows. */
async function loadRaw<T>(table: string, idColumn: string, tenantId: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select("raw")
      .eq("tenant_id", tenantId)
      .order(idColumn, { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Failed to read ${table}: ${error.message}`);
    out.push(...(data ?? []).map((r) => r.raw as T));
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

// ------------------------------------------------------------------ auth

let accessToken = "";
let tokenAt = 0;
async function getAccessToken(): Promise<string> {
  // Xero access tokens last 30 minutes; refresh well before that.
  if (!accessToken || Date.now() - tokenAt > 20 * 60 * 1000) {
    const stored = await loadStoredAuth();
    accessToken = (await refreshAccessToken(stored.tenant_id, stored.tenant_name, stored.refresh_token)).accessToken;
    tokenAt = Date.now();
  }
  return accessToken;
}

let lastCall = 0;
async function xeroGet(tenantId: string, apiPath: string, accept?: string): Promise<Response> {
  const wait = lastCall + CALL_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    return await xeroGetRaw(apiPath, { accessToken: await getAccessToken(), tenantId, accept });
  } finally {
    lastCall = Date.now();
  }
}

// ------------------------------------------------------------------ attachments

interface XeroAttachment { AttachmentID: string; FileName: string; MimeType?: string; ContentLength?: number }

async function downloadAttachments(
  tenantId: string,
  outDir: string,
  docs: { doc: XeroDocRaw; endpoint: "Invoices" | "CreditNotes"; doctype: string }[]
): Promise<CsvRow[]> {
  const manifest: CsvRow[] = [];
  const withFiles = docs.filter((d) => d.doc.HasAttachments);
  console.log(`  Attachments: ${withFiles.length} document(s) have files.`);
  let n = 0;

  for (const { doc, endpoint, doctype } of withFiles) {
    n++;
    const id = xeroDocId(doc);
    const number = xeroDocNumber(doc);
    const dir = path.join("attachments", `${safe(number || id)}__${id.slice(0, 8)}`);
    const metaFile = path.join(outDir, dir, "_attachments.json");

    let list: XeroAttachment[];
    try {
      list = JSON.parse(await readFile(metaFile, "utf8")) as XeroAttachment[];
    } catch {
      const res = await xeroGet(tenantId, `${endpoint}/${id}/Attachments`);
      list = ((await res.json()) as { Attachments?: XeroAttachment[] }).Attachments ?? [];
      await mkdir(path.join(outDir, dir), { recursive: true });
      await writeFile(metaFile, JSON.stringify(list), "utf8");
    }

    const used = new Set<string>();
    for (const att of list) {
      // Names within one document can collide; keep every file.
      let name = safe(att.FileName);
      if (used.has(name)) name = `${att.AttachmentID.slice(0, 8)}_${name}`;
      used.add(name);
      const rel = path.join(dir, name);
      const abs = path.join(outDir, rel);

      const existing = await stat(abs).catch(() => null);
      if (!existing || (att.ContentLength && existing.size !== att.ContentLength)) {
        const res = await xeroGet(tenantId, `${endpoint}/${id}/Attachments/${att.AttachmentID}`, "*/*");
        await writeFile(abs, Buffer.from(await res.arrayBuffer()));
      }
      manifest.push({
        doctype, xero_id: xeroMarker(id), document_number: number, file_name: name, file_path: rel.replace(/\\/g, "/"),
      });
    }
    if (n % 25 === 0) console.log(`    ${n}/${withFiles.length} documents done`);
  }
  return manifest;
}

// ------------------------------------------------------------------ per-organisation export

async function exportTenant(tenant: XeroTenant, baseDir: string, cfg: FrappeConfig, skipAttachments: boolean) {
  const label = tenant.tenantName ?? tenant.tenantId;
  const outDir = path.join(baseDir, safe(label));
  console.log(`\nExporting ${label} -> ${outDir}`);

  const [contacts, invoices, bills, creditNotes] = await Promise.all([
    loadRaw<XeroContactRaw>("xero_contacts", "xero_contact_id", tenant.tenantId),
    loadRaw<XeroDocRaw>("xero_invoices", "xero_invoice_id", tenant.tenantId),
    loadRaw<XeroDocRaw>("xero_bills", "xero_invoice_id", tenant.tenantId),
    loadRaw<XeroDocRaw>("xero_credit_notes", "xero_credit_note_id", tenant.tenantId),
  ]);

  const keep = (d: XeroDocRaw) => !SKIPPED_STATUSES.has(d.Status ?? "");
  const tagged = [
    ...invoices.filter(keep).map((doc) => ({ doc, endpoint: "Invoices" as const })),
    ...bills.filter(keep).map((doc) => ({ doc, endpoint: "Invoices" as const })),
    ...creditNotes.filter(keep).map((doc) => ({ doc, endpoint: "CreditNotes" as const })),
  ].map((t) => ({ ...t, doctype: isSalesDoc(t.doc) ? "Sales Invoice" : "Purchase Invoice" }));

  const noLines = tagged.filter((t) => !t.doc.LineItems?.length && t.doc.Total);
  if (noLines.length) console.warn(`  Warning: ${noLines.length} document(s) have a total but no line items in Supabase.`);

  await writeFrappeFiles(outDir, contacts, tagged.map((t) => t.doc), cfg);

  if (skipAttachments) return;
  const manifest: CsvRow[] = [];
  try {
    manifest.push(...(await downloadAttachments(tenant.tenantId, outDir, tagged)));
  } finally {
    // Written even if a rate limit aborts the run; re-running resumes from disk.
    await writeCsv(path.join(outDir, "attachments_manifest.csv"), ATTACHMENT_HEADERS, manifest);
    console.log(`  Attachment manifest: ${manifest.length} file(s).`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const tenantArg = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : undefined;
  const skipAttachments = args.includes("--skip-attachments");

  const cfg = await loadFrappeConfig();
  const outArg = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
  const baseDir = outArg || process.env.EXPORT_DIR || "export";

  let tenants = await loadTenants();
  if (tenantArg) {
    const q = tenantArg.toLowerCase();
    tenants = tenants.filter((t) => t.tenantId === tenantArg || (t.tenantName ?? "").toLowerCase().includes(q));
    if (!tenants.length) throw new Error(`No organisation matches --tenant "${tenantArg}".`);
  }
  if (tenants.length > 1) {
    console.warn(
      `Exporting ${tenants.length} organisations with the same FRAPPE_COMPANY ("${cfg.company}"). ` +
        `Use --tenant to export one organisation per Frappe company.`
    );
  }
  for (const tenant of tenants) await exportTenant(tenant, baseDir, cfg, skipAttachments);
  console.log("\nExport complete.");
}

main().catch((err) => {
  console.error("\nExport failed:", err);
  process.exit(1);
});
