import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeCsv, type CsvRow } from "./csv.js";
import {
  CONTACT_HEADERS, CUSTOMER_HEADERS, PURCHASE_INVOICE_HEADERS, SALES_INVOICE_HEADERS, SUPPLIER_HEADERS,
  contactRow, customerRow, documentRows, isSalesDoc, supplierRow,
  type FrappeConfig, type XeroContactRaw, type XeroDocRaw,
} from "./frappe-mappers.js";

/**
 * Write the five Frappe Data Import CSVs. Source-agnostic: Xero records are passed
 * as-is, QuickBooks records are adapted into the same shape first.
 */
export async function writeFrappeFiles(
  outDir: string,
  contacts: XeroContactRaw[],
  docs: XeroDocRaw[],
  cfg: FrappeConfig
): Promise<void> {
  // A contact only gets IsCustomer/IsSupplier once it has transacted; infer from usage too.
  const customerNames = new Set<string>();
  const supplierNames = new Set<string>();
  for (const doc of docs) (isSalesDoc(doc) ? customerNames : supplierNames).add(doc.Contact?.Name ?? "");

  const customers: CsvRow[] = [];
  const suppliers: CsvRow[] = [];
  const contactRows: CsvRow[] = [];
  const seen = { Customer: new Set<string>(), Supplier: new Set<string>() };
  for (const c of contacts) {
    if (!c.Name) continue;
    const asSupplier = c.IsSupplier || supplierNames.has(c.Name);
    const asCustomer = c.IsCustomer || customerNames.has(c.Name) || !asSupplier;
    if (asCustomer && !seen.Customer.has(c.Name)) {
      seen.Customer.add(c.Name);
      customers.push(customerRow(c, cfg));
      const row = contactRow(c, "Customer");
      if (row) contactRows.push(row);
    }
    if (asSupplier && !seen.Supplier.has(c.Name)) {
      seen.Supplier.add(c.Name);
      suppliers.push(supplierRow(c, cfg));
      const row = contactRow(c, "Supplier");
      if (row) contactRows.push(row);
    }
  }

  const byDate = (a: XeroDocRaw, b: XeroDocRaw) => (a.DateString ?? "").localeCompare(b.DateString ?? "");
  const salesDocs = docs.filter(isSalesDoc).sort(byDate);
  const purchaseDocs = docs.filter((d) => !isSalesDoc(d)).sort(byDate);

  await writeCsv(path.join(outDir, "customers.csv"), CUSTOMER_HEADERS, customers);
  await writeCsv(path.join(outDir, "suppliers.csv"), SUPPLIER_HEADERS, suppliers);
  await writeCsv(path.join(outDir, "contacts.csv"), CONTACT_HEADERS, contactRows);
  await writeCsv(path.join(outDir, "sales_invoices.csv"), SALES_INVOICE_HEADERS, salesDocs.flatMap((d) => documentRows(d, cfg)));
  await writeCsv(path.join(outDir, "purchase_invoices.csv"), PURCHASE_INVOICE_HEADERS, purchaseDocs.flatMap((d) => documentRows(d, cfg)));
  console.log(
    `  customers ${customers.length}, suppliers ${suppliers.length}, contacts ${contactRows.length}, ` +
      `sales invoices/credit notes ${salesDocs.length}, purchase invoices/credit notes ${purchaseDocs.length}`
  );
}

/** Read FRAPPE_* settings from the environment. `defaultCompany` is used when FRAPPE_COMPANY is unset. */
export async function loadFrappeConfig(defaultCompany?: string): Promise<FrappeConfig> {
  const company = process.env.FRAPPE_COMPANY || defaultCompany;
  if (!company) throw new Error("Missing required env var: FRAPPE_COMPANY (the exact Company name in Frappe).");
  const mapFile = process.env.FRAPPE_ACCOUNT_MAP_FILE;
  return {
    company,
    customerGroup: process.env.FRAPPE_CUSTOMER_GROUP || "All Customer Groups",
    supplierGroup: process.env.FRAPPE_SUPPLIER_GROUP || "All Supplier Groups",
    territory: process.env.FRAPPE_TERRITORY || "All Territories",
    salesTaxAccount: process.env.FRAPPE_SALES_TAX_ACCOUNT || "",
    purchaseTaxAccount: process.env.FRAPPE_PURCHASE_TAX_ACCOUNT || "",
    accountMap: mapFile ? (JSON.parse(await readFile(mapFile, "utf8")) as Record<string, string>) : {},
  };
}
