// Xero returns dates either as plain "YYYY-MM-DD" strings (rare) or,
// far more commonly, as ".NET JSON dates" like "/Date(1706572800000+0000)/".
// This normalises both into a plain "YYYY-MM-DD" string for Postgres `date`
// columns, or null if absent.
export function toDateOnly(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/\/Date\((\d+)/);
  const ms = match ? Number(match[1]) : Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// Same idea but keeps full timestamp precision for `timestamptz` columns.
function toTimestamp(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/\/Date\((\d+)/);
  const ms = match ? Number(match[1]) : Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

interface XeroContact {
  ContactID: string;
  ContactNumber?: string;
  Name?: string;
  FirstName?: string;
  LastName?: string;
  EmailAddress?: string;
  ContactStatus?: string;
  IsCustomer?: boolean;
  IsSupplier?: boolean;
  Phones?: Array<{ PhoneType?: string; PhoneNumber?: string; PhoneAreaCode?: string }>;
  TaxNumber?: string;
  DefaultCurrency?: string;
  UpdatedDateUTC?: string;
}

export function contactToRow(c: XeroContact) {
  const defaultPhone = c.Phones?.find((p) => p.PhoneType === "DEFAULT") ?? c.Phones?.[0];
  const phone = defaultPhone
    ? [defaultPhone.PhoneAreaCode, defaultPhone.PhoneNumber].filter(Boolean).join(" ")
    : null;

  return {
    xero_contact_id: c.ContactID,
    contact_number: c.ContactNumber ?? null,
    name: c.Name ?? null,
    first_name: c.FirstName ?? null,
    last_name: c.LastName ?? null,
    email_address: c.EmailAddress ?? null,
    contact_status: c.ContactStatus ?? null,
    is_customer: c.IsCustomer ?? null,
    is_supplier: c.IsSupplier ?? null,
    phone: phone || null,
    tax_number: c.TaxNumber ?? null,
    default_currency: c.DefaultCurrency ?? null,
    updated_date_utc: toTimestamp(c.UpdatedDateUTC),
    raw: c,
    synced_at: new Date().toISOString(),
  };
}

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Reference?: string;
  Type?: string;
  Status?: string;
  Contact?: { ContactID?: string; Name?: string };
  CurrencyCode?: string;
  Date?: string;
  DueDate?: string;
  FullyPaidOnDate?: string;
  SubTotal?: number;
  TotalTax?: number;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  AmountCredited?: number;
  UpdatedDateUTC?: string;
}

/** Used for both Invoices (ACCREC) and Bills (ACCPAY) — same shape, different tables. */
export function invoiceToRow(inv: XeroInvoice) {
  return {
    xero_invoice_id: inv.InvoiceID,
    invoice_number: inv.InvoiceNumber ?? null,
    reference: inv.Reference ?? null,
    type: inv.Type ?? null,
    status: inv.Status ?? null,
    contact_id: inv.Contact?.ContactID ?? null,
    contact_name: inv.Contact?.Name ?? null,
    currency_code: inv.CurrencyCode ?? null,
    invoice_date: toDateOnly(inv.Date),
    due_date: toDateOnly(inv.DueDate),
    fully_paid_on_date: toDateOnly(inv.FullyPaidOnDate),
    sub_total: inv.SubTotal ?? null,
    total_tax: inv.TotalTax ?? null,
    total: inv.Total ?? null,
    amount_due: inv.AmountDue ?? null,
    amount_paid: inv.AmountPaid ?? null,
    amount_credited: inv.AmountCredited ?? null,
    updated_date_utc: toTimestamp(inv.UpdatedDateUTC),
    raw: inv,
    synced_at: new Date().toISOString(),
  };
}

interface XeroCreditNote {
  CreditNoteID: string;
  CreditNoteNumber?: string;
  Reference?: string;
  Type?: string;
  Status?: string;
  Contact?: { ContactID?: string; Name?: string };
  CurrencyCode?: string;
  Date?: string;
  SubTotal?: number;
  TotalTax?: number;
  Total?: number;
  RemainingCredit?: number;
  UpdatedDateUTC?: string;
}

export function creditNoteToRow(cn: XeroCreditNote) {
  return {
    xero_credit_note_id: cn.CreditNoteID,
    credit_note_number: cn.CreditNoteNumber ?? null,
    reference: cn.Reference ?? null,
    type: cn.Type ?? null,
    status: cn.Status ?? null,
    contact_id: cn.Contact?.ContactID ?? null,
    contact_name: cn.Contact?.Name ?? null,
    currency_code: cn.CurrencyCode ?? null,
    credit_note_date: toDateOnly(cn.Date),
    sub_total: cn.SubTotal ?? null,
    total_tax: cn.TotalTax ?? null,
    total: cn.Total ?? null,
    remaining_credit: cn.RemainingCredit ?? null,
    updated_date_utc: toTimestamp(cn.UpdatedDateUTC),
    raw: cn,
    synced_at: new Date().toISOString(),
  };
}
