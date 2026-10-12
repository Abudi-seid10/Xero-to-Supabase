/**
 * Xero -> Frappe/ERPNext Data Import row builders.
 *
 * Column headers use the labels Frappe's own import template uses, e.g.
 * "Quantity (Items)" for a child-table field. Frappe Data Import has a column
 * mapping step, so a label that differs on your version can be re-mapped there.
 *
 * Multi-row documents: the first row carries the parent fields plus child row 1;
 * following rows carry only child rows 2..n.
 */
import { toDateOnly } from "./mappers.js";
import type { CsvRow } from "./csv.js";

export interface FrappeConfig {
  company: string;
  customerGroup: string;
  supplierGroup: string;
  territory: string;
  salesTaxAccount: string;
  purchaseTaxAccount: string;
  /** Xero account code -> Frappe account name. Unmapped codes are left blank. */
  accountMap: Record<string, string>;
}

// ---------------------------------------------------------------- headers

export const CUSTOMER_HEADERS = [
  "Customer Name", "Customer Type", "Customer Group", "Territory", "Tax ID", "Billing Currency", "Disabled",
];
export const SUPPLIER_HEADERS = [
  "Supplier Name", "Supplier Type", "Supplier Group", "Tax ID", "Billing Currency", "Disabled",
];
export const CONTACT_HEADERS = [
  "First Name", "Last Name", "Email Address (Email IDs)", "Is Primary (Email IDs)",
  "Phone (Phone Nos)", "Is Primary Phone (Phone Nos)",
  "Link Document Type (Links)", "Link Name (Links)",
];

const SHARED_INVOICE_HEADERS = [
  "Company", "Edit Posting Date and Time", "Posting Date", "Due Date", "Currency", "Exchange Rate",
  "Is Return (Credit Note)", "Remarks",
];
export const SALES_INVOICE_HEADERS = [
  "Customer", ...SHARED_INVOICE_HEADERS,
  "Item Code (Items)", "Item Name (Items)", "Description (Items)", "Quantity (Items)", "Rate (Items)",
  "Income Account (Items)",
  "Type (Sales Taxes and Charges)", "Account Head (Sales Taxes and Charges)",
  "Description (Sales Taxes and Charges)", "Tax Rate (Sales Taxes and Charges)",
  "Tax Amount (Sales Taxes and Charges)",
];
export const PURCHASE_INVOICE_HEADERS = [
  "Supplier", "Supplier Invoice No", "Supplier Invoice Date", ...SHARED_INVOICE_HEADERS,
  "Item Code (Items)", "Item Name (Items)", "Description (Items)", "Quantity (Items)", "Rate (Items)",
  "Expense Account (Items)",
  "Type (Purchase Taxes and Charges)", "Category (Purchase Taxes and Charges)",
  "Add or Deduct (Purchase Taxes and Charges)", "Account Head (Purchase Taxes and Charges)",
  "Description (Purchase Taxes and Charges)", "Tax Rate (Purchase Taxes and Charges)",
  "Tax Amount (Purchase Taxes and Charges)",
];

// ---------------------------------------------------------------- Xero shapes

interface XeroPhone { PhoneType?: string; PhoneNumber?: string; PhoneAreaCode?: string; PhoneCountryCode?: string }
export interface XeroContactRaw {
  ContactID: string;
  Name?: string;
  FirstName?: string;
  LastName?: string;
  EmailAddress?: string;
  ContactStatus?: string;
  IsCustomer?: boolean;
  IsSupplier?: boolean;
  Phones?: XeroPhone[];
  TaxNumber?: string;
  DefaultCurrency?: string;
}

interface XeroLineItem {
  Description?: string;
  Quantity?: number;
  UnitAmount?: number;
  ItemCode?: string;
  AccountCode?: string;
  TaxType?: string;
  TaxAmount?: number;
  LineAmount?: number;
}

export interface XeroDocRaw {
  InvoiceID?: string;
  CreditNoteID?: string;
  InvoiceNumber?: string;
  CreditNoteNumber?: string;
  Reference?: string;
  Type?: string;
  Status?: string;
  Contact?: { ContactID?: string; Name?: string };
  CurrencyCode?: string;
  CurrencyRate?: number;
  Date?: string;
  DateString?: string;
  DueDate?: string;
  DueDateString?: string;
  LineAmountTypes?: string;
  LineItems?: XeroLineItem[];
  TotalTax?: number;
  Total?: number;
  HasAttachments?: boolean;
  /** Unique Remarks marker; defaults to XERO:<id>. QuickBooks sets its own. */
  Marker?: string;
}

export const xeroDocId = (d: XeroDocRaw): string => (d.InvoiceID ?? d.CreditNoteID) as string;
export const xeroDocNumber = (d: XeroDocRaw): string => d.InvoiceNumber ?? d.CreditNoteNumber ?? "";
export const isCreditNote = (d: XeroDocRaw): boolean => d.Type === "ACCRECCREDIT" || d.Type === "ACCPAYCREDIT";
export const isSalesDoc = (d: XeroDocRaw): boolean => d.Type === "ACCREC" || d.Type === "ACCRECCREDIT";

/** Statuses that never made it into the books; skipped by default. */
export const SKIPPED_STATUSES = new Set(["DELETED", "VOIDED"]);

/** The marker written into Remarks; the attachment uploader finds documents by it. */
export const xeroMarker = (id: string): string => `XERO:${id}`;

// ---------------------------------------------------------------- helpers

const round = (n: number, dp: number): number => Number(n.toFixed(dp));

function dateOf(d: XeroDocRaw, field: "Date" | "DueDate"): string | null {
  return toDateOnly(d[field]) ?? toDateOnly(field === "Date" ? d.DateString : d.DueDateString);
}

function phoneOf(c: XeroContactRaw): string | null {
  const p = c.Phones?.find((x) => x.PhoneNumber && x.PhoneType === "DEFAULT") ?? c.Phones?.find((x) => x.PhoneNumber);
  if (!p) return null;
  return [p.PhoneCountryCode && `+${p.PhoneCountryCode}`, p.PhoneAreaCode, p.PhoneNumber].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- contacts

export function customerRow(c: XeroContactRaw, cfg: FrappeConfig): CsvRow {
  return {
    "Customer Name": c.Name,
    "Customer Type": c.FirstName || c.LastName ? "Individual" : "Company",
    "Customer Group": cfg.customerGroup,
    Territory: cfg.territory,
    "Tax ID": c.TaxNumber,
    "Billing Currency": c.DefaultCurrency,
    Disabled: c.ContactStatus === "ARCHIVED" ? 1 : 0,
  };
}

export function supplierRow(c: XeroContactRaw, cfg: FrappeConfig): CsvRow {
  return {
    "Supplier Name": c.Name,
    "Supplier Type": c.FirstName || c.LastName ? "Individual" : "Company",
    "Supplier Group": cfg.supplierGroup,
    "Tax ID": c.TaxNumber,
    "Billing Currency": c.DefaultCurrency,
    Disabled: c.ContactStatus === "ARCHIVED" ? 1 : 0,
  };
}

/** One Contact per party role, linked to the Customer/Supplier of the same name. */
export function contactRow(c: XeroContactRaw, linkType: "Customer" | "Supplier"): CsvRow | null {
  const email = c.EmailAddress;
  const phone = phoneOf(c);
  if (!email && !phone && !c.FirstName && !c.LastName) return null;
  return {
    "First Name": c.FirstName || c.Name,
    "Last Name": c.LastName,
    "Email Address (Email IDs)": email,
    "Is Primary (Email IDs)": email ? 1 : "",
    "Phone (Phone Nos)": phone,
    "Is Primary Phone (Phone Nos)": phone ? 1 : "",
    "Link Document Type (Links)": linkType,
    "Link Name (Links)": c.Name,
  };
}

// ---------------------------------------------------------------- invoices / credit notes

/**
 * Xero line amounts depend on LineAmountTypes: "Inclusive" lines already contain
 * tax, so the net is LineAmount - TaxAmount. Rate = net / qty, so discounts are
 * baked in and the Frappe line total matches Xero's.
 */
function lineNet(line: XeroLineItem, lineAmountTypes: string | undefined): number {
  const amount = line.LineAmount ?? (line.Quantity ?? 1) * (line.UnitAmount ?? 0);
  return lineAmountTypes === "Inclusive" ? amount - (line.TaxAmount ?? 0) : amount;
}

/** Returns the CSV rows (parent + child lines) for one Xero invoice, bill or credit note. */
export function documentRows(d: XeroDocRaw, cfg: FrappeConfig): CsvRow[] {
  const sales = isSalesDoc(d);
  const credit = isCreditNote(d);
  const sign = credit ? -1 : 1; // Frappe returns carry negative quantities and taxes
  const id = xeroDocId(d);
  const number = xeroDocNumber(d);
  const accountKey = sales ? "Income Account (Items)" : "Expense Account (Items)";
  const taxKey = sales ? "Sales Taxes and Charges" : "Purchase Taxes and Charges";

  const lines: CsvRow[] = (d.LineItems ?? []).map((line) => {
    const qty = line.Quantity && line.Quantity !== 0 ? line.Quantity : 1;
    const net = lineNet(line, d.LineAmountTypes);
    const description = line.Description?.trim() || number || "Xero line";
    return {
      "Item Code (Items)": "", // Xero items are not exported; see README
      "Item Name (Items)": (line.ItemCode ? `${line.ItemCode}: ` : "") + description.slice(0, 140).replace(/\s+/g, " "),
      "Description (Items)": description,
      "Quantity (Items)": round(qty * sign, 6),
      "Rate (Items)": round(net / qty, 6),
      [accountKey]: (line.AccountCode && cfg.accountMap[line.AccountCode]) || "",
    };
  });

  const taxes: CsvRow[] = [];
  if (d.TotalTax) {
    taxes.push({
      [`Type (${taxKey})`]: "Actual",
      [`Account Head (${taxKey})`]: sales ? cfg.salesTaxAccount : cfg.purchaseTaxAccount,
      [`Description (${taxKey})`]: "Tax (from Xero)",
      [`Tax Rate (${taxKey})`]: 0,
      [`Tax Amount (${taxKey})`]: round(d.TotalTax * sign, 6),
      ...(sales ? {} : {
        [`Category (${taxKey})`]: "Total",
        [`Add or Deduct (${taxKey})`]: "Add",
      }),
    });
  }

  const remarks = [`${d.Marker ? "QuickBooks" : "Xero"} ${number}`.trim(), d.Reference, d.Status, d.Marker ?? xeroMarker(id)].filter(Boolean).join(" | ");
  const parent: CsvRow = {
    Company: cfg.company,
    "Edit Posting Date and Time": 1,
    "Posting Date": dateOf(d, "Date"),
    "Due Date": dateOf(d, "DueDate"),
    Currency: d.CurrencyCode,
    "Exchange Rate": d.CurrencyRate,
    "Is Return (Credit Note)": credit ? 1 : 0,
    Remarks: remarks,
    ...(sales
      ? { Customer: d.Contact?.Name }
      : {
          Supplier: d.Contact?.Name,
          "Supplier Invoice No": number || d.Reference || id,
          "Supplier Invoice Date": dateOf(d, "Date"),
        }),
  };

  const count = Math.max(lines.length, taxes.length, 1);
  const rows: CsvRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({ ...(i === 0 ? parent : {}), ...(lines[i] ?? {}), ...(taxes[i] ?? {}) });
  }
  return rows;
}
