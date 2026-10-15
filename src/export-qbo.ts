/**
 * Export a QuickBooks Online company straight to Frappe/ERPNext Data Import CSVs
 * (no Supabase), plus invoice/bill/credit attachments. Read-only: GET requests only.
 * QuickBooks records are adapted into the Xero-shaped records the Frappe mappers use.
 *
 *   npm run export:qbo -- [--out <folder>] [--skip-attachments]
 */
import "dotenv/config";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentRealm, discoverRealms, qboCompanyName, qboFetch, qboQueryAll, useRealm } from "./qbo.js";
import { API_BASE } from "./qbo-env.js";
import { writeCsv, type CsvRow } from "./csv.js";
import { loadFrappeConfig, writeFrappeFiles } from "./frappe-writer.js";
import { isSalesDoc, type XeroContactRaw, type XeroDocRaw } from "./frappe-mappers.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Q = any;

const ATTACHMENT_HEADERS = ["doctype", "xero_id", "document_number", "file_name", "file_path"];
const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "unnamed";

// ------------------------------------------------------------------ adapters

function contactOf(c: Q, kind: "customer" | "vendor"): XeroContactRaw {
  const company = !!c.CompanyName;
  return {
    ContactID: c.Id,
    Name: c.FullyQualifiedName || c.DisplayName,
    FirstName: company ? undefined : c.GivenName,
    LastName: company ? undefined : c.FamilyName,
    EmailAddress: c.PrimaryEmailAddr?.Address,
    ContactStatus: c.Active === false ? "ARCHIVED" : "ACTIVE",
    IsCustomer: kind === "customer",
    IsSupplier: kind === "vendor",
    Phones: c.PrimaryPhone?.FreeFormNumber ? [{ PhoneType: "DEFAULT", PhoneNumber: c.PrimaryPhone.FreeFormNumber }] : [],
    TaxNumber: c.TaxIdentifier,
    DefaultCurrency: c.CurrencyRef?.value,
  };
}

/** Flatten QuickBooks lines (incl. bundle children, discounts) into Xero-style line items. */
function linesOf(d: Q): NonNullable<XeroDocRaw["LineItems"]> {
  const out: NonNullable<XeroDocRaw["LineItems"]> = [];
  const walk = (arr: Q[] | undefined) => {
    for (const l of arr ?? []) {
      const amount = Number(l.Amount ?? 0);
      switch (l.DetailType) {
        case "SalesItemLineDetail":
        case "ItemBasedExpenseLineDetail": {
          const x = l[l.DetailType];
          out.push({
            Description: l.Description || x.ItemRef?.name,
            Quantity: x.Qty ?? 1,
            UnitAmount: x.UnitPrice,
            ItemCode: x.ItemRef?.name,
            AccountCode: x.AccountRef?.name,
            LineAmount: amount,
          });
          break;
        }
        case "AccountBasedExpenseLineDetail": {
          const x = l.AccountBasedExpenseLineDetail;
          out.push({
            Description: l.Description || x.AccountRef?.name,
            Quantity: 1,
            UnitAmount: amount,
            AccountCode: x.AccountRef?.name,
            LineAmount: amount,
          });
          break;
        }
        case "DiscountLineDetail":
          out.push({ Description: l.Description || "Discount", Quantity: 1, UnitAmount: -amount, LineAmount: -amount });
          break;
        case "GroupLineDetail":
          walk(l.GroupLineDetail?.Line);
          break;
        // SubTotalLineDetail / DescriptionOnly carry no amount of their own
      }
    }
  };
  walk(d.Line);
  return out;
}

function docOf(d: Q, type: "ACCREC" | "ACCRECCREDIT" | "ACCPAY" | "ACCPAYCREDIT"): XeroDocRaw {
  const sales = type.startsWith("ACCREC");
  const ref = sales ? d.CustomerRef : d.VendorRef;
  const totalTax = Number(d.TxnTaxDetail?.TotalTax ?? 0);
  const inclusive = d.GlobalTaxCalculation === "TaxInclusive" && totalTax !== 0;
  const items = linesOf(d);

  if (inclusive) {
    // QuickBooks gives only a document-level tax total; spread it over the lines pro rata.
    const sum = items.reduce((t, l) => t + (l.LineAmount ?? 0), 0) || 1;
    for (const l of items) l.TaxAmount = (totalTax * (l.LineAmount ?? 0)) / sum;
  }

  return {
    InvoiceID: `${d.__entity}-${d.Id}`,
    InvoiceNumber: d.DocNumber,
    Reference: d.PrivateNote || undefined,
    Type: type,
    Status: d.PrivateNote === "Voided" ? "VOIDED" : Number(d.Balance ?? 1) === 0 ? "PAID" : "AUTHORISED",
    Contact: { ContactID: ref?.value, Name: ref?.name },
    CurrencyCode: d.CurrencyRef?.value,
    CurrencyRate: d.ExchangeRate,
    Date: d.TxnDate,
    DateString: d.TxnDate,
    DueDate: d.DueDate,
    DueDateString: d.DueDate,
    LineAmountTypes: inclusive ? "Inclusive" : "Exclusive",
    LineItems: items,
    TotalTax: totalTax,
    Total: Number(d.TotalAmt ?? 0),
    // QuickBooks ids are small integers, so the delimiter keeps "QBO:1#" from matching "QBO:10#".
    Marker: `QBO:${d.__entity}-${d.Id}#`,
  };
}

// ------------------------------------------------------------------ attachments

interface QboDoc { entity: string; id: string; doc: XeroDocRaw }

/**
 * TempDownloadUri links expire after ~15 minutes, far less than a large export takes, so ask for
 * a fresh signed link per file. The listing's own link is only a fallback.
 */
async function freshDownloadUrl(att: Q): Promise<string> {
  try {
    const res = await qboFetch(`${API_BASE}/v3/company/${currentRealm()}/download/${att.Id}?minorversion=75`, {
      headers: { Accept: "application/octet-stream, text/plain, */*" },
    });
    const url = (await res.text()).trim().replace(/^"|"$/g, "");
    if (/^https:\/\//.test(url)) return url;
  } catch {
    /* fall through to the listing link */
  }
  return att.TempDownloadUri;
}

/** Appends to `manifest` as it goes, so a partial run still leaves a usable manifest. */
async function downloadAttachments(outDir: string, docs: QboDoc[], manifest: CsvRow[]): Promise<void> {
  const byRef = new Map(docs.map((d) => [`${d.entity}:${d.id}`, d]));
  const failures: string[] = [];
  const used = new Map<string, Set<string>>();

  const attachables = await qboQueryAll<Q>("Attachable");
  const candidates = attachables.filter((a) => a.FileName && a.TempDownloadUri);
  console.log(`  Attachments: ${attachables.length} attachable(s), ${candidates.length} with files.`);

  let n = 0;
  for (const att of candidates) {
    const targets = ((att.AttachableRef ?? []) as Q[])
      .map((r) => byRef.get(`${r.EntityRef?.type}:${r.EntityRef?.value}`))
      .filter((t): t is QboDoc => !!t);
    if (!targets.length) continue; // attached to a customer/vendor/etc., which this export skips

    // One download, copied under every document it is attached to.
    let bytes: Buffer | null = null;
    for (const t of targets) {
      const number = t.doc.InvoiceNumber || t.id;
      const dir = path.join("attachments", `${safe(number)}__${t.entity}-${t.id}`);
      const names = used.get(dir) ?? new Set<string>();
      used.set(dir, names);
      let name = safe(att.FileName);
      if (names.has(name)) name = `${att.Id}_${name}`;
      names.add(name);
      const rel = path.join(dir, name);
      const abs = path.join(outDir, rel);

      const existing = await stat(abs).catch(() => null);
      if (!existing || (att.Size && existing.size !== Number(att.Size))) {
        try {
          // The signed link needs no Authorization header.
          bytes ??= Buffer.from(await (await qboFetch(await freshDownloadUrl(att), { headers: { Accept: "*/*" } }, false)).arrayBuffer());
          await mkdir(path.join(outDir, dir), { recursive: true });
          await writeFile(abs, bytes);
        } catch (err) {
          failures.push(`${number}/${att.FileName}: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
          continue; // keep going; re-running retries only the missing files
        }
      }
      manifest.push({
        doctype: isSalesDoc(t.doc) ? "Sales Invoice" : "Purchase Invoice",
        xero_id: t.doc.Marker,
        document_number: number,
        file_name: name,
        file_path: rel.replace(/\\/g, "/"),
      });
    }
    if (++n % 25 === 0) console.log(`    ${n} files processed`);
  }
  if (failures.length) {
    console.warn(`  ${failures.length} attachment(s) could not be downloaded (re-run to retry just those):`);
    for (const f of failures.slice(0, 10)) console.warn(`    - ${f}`);
    if (failures.length > 10) console.warn(`    ...and ${failures.length - 10} more`);
  }
}

// ------------------------------------------------------------------ main

async function exportCompany(baseDir: string, skipAttachments: boolean, multiple: boolean) {
  const company = await qboCompanyName();
  // With several companies one FRAPPE_COMPANY would mislabel all but one, so use each QuickBooks name.
  if (multiple) delete process.env.FRAPPE_COMPANY;
  const cfg = await loadFrappeConfig(company);
  const outDir = path.join(baseDir, safe(company));
  console.log(`Exporting QuickBooks company "${company}" -> ${outDir}`);

  const tag = (rows: Q[], entity: string): Q[] => rows.map((r) => ({ ...r, __entity: entity }));
  const [customers, vendors, invoices, creditMemos, bills, vendorCredits] = await Promise.all([
    qboQueryAll<Q>("Customer"),
    qboQueryAll<Q>("Vendor"),
    qboQueryAll<Q>("Invoice").then((r) => tag(r, "Invoice")),
    qboQueryAll<Q>("CreditMemo").then((r) => tag(r, "CreditMemo")),
    qboQueryAll<Q>("Bill").then((r) => tag(r, "Bill")),
    qboQueryAll<Q>("VendorCredit").then((r) => tag(r, "VendorCredit")),
  ]);

  const all: QboDoc[] = [
    ...invoices.map((d) => ({ entity: "Invoice", id: d.Id, doc: docOf(d, "ACCREC") })),
    ...creditMemos.map((d) => ({ entity: "CreditMemo", id: d.Id, doc: docOf(d, "ACCRECCREDIT") })),
    ...bills.map((d) => ({ entity: "Bill", id: d.Id, doc: docOf(d, "ACCPAY") })),
    ...vendorCredits.map((d) => ({ entity: "VendorCredit", id: d.Id, doc: docOf(d, "ACCPAYCREDIT") })),
  ].filter((d) => d.doc.Status !== "VOIDED");

  const noLines = all.filter((d) => !d.doc.LineItems?.length && d.doc.Total);
  if (noLines.length) console.warn(`  Warning: ${noLines.length} document(s) have a total but no recognised line items.`);

  // A name can exist as both customer and vendor; the writer decides roles from document usage.
  const contacts = [...customers.map((c) => contactOf(c, "customer")), ...vendors.map((v) => contactOf(v, "vendor"))];
  await writeFrappeFiles(outDir, contacts, all.map((d) => d.doc), cfg);

  if (skipAttachments) return;
  const manifest: CsvRow[] = [];
  try {
    await downloadAttachments(outDir, all, manifest);
  } finally {
    await writeCsv(path.join(outDir, "attachments_manifest.csv"), ATTACHMENT_HEADERS, manifest);
    console.log(`  Attachment manifest: ${manifest.length} file(s).`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const baseDir = arg("--out") || process.env.EXPORT_DIR || "export";
  const skipAttachments = args.includes("--skip-attachments");
  const only = arg("--realm");

  const realms = only ? [only] : await discoverRealms();
  if (!realms.length) throw new Error("No QuickBooks company configured. Run `npm run setup-qbo-auth` or set QBO_REALM_ID.");
  console.log(`QuickBooks companies to export: ${realms.length} (${realms.join(", ")})`);
  if (realms.length > 1 && process.env.FRAPPE_COMPANY) {
    console.warn("FRAPPE_COMPANY is ignored when exporting several companies; each uses its QuickBooks company name.");
  }

  const failed: string[] = [];
  for (const realm of realms) {
    console.log(`
=== Company ${realm} ===`);
    useRealm(realm);
    try {
      await exportCompany(baseDir, skipAttachments, realms.length > 1);
    } catch (err) {
      // One company failing (expired token, wrong environment) must not stop the others.
      console.error(`Company ${realm} failed:`, err instanceof Error ? err.message : err);
      failed.push(realm);
    }
  }

  console.log(`
Export finished: ${realms.length - failed.length}/${realms.length} company(ies) succeeded.`);
  if (failed.length) {
    console.error(`Failed: ${failed.join(", ")}. Re-run npm run setup-qbo-auth for those, or retry with --realm <id>.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nExport failed:", err);
  process.exit(1);
});
