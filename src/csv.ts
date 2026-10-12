import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type CsvRow = Record<string, string | number | null | undefined>;

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Write rows as CSV using a fixed header order; missing keys become empty cells. */
export async function writeCsv(file: string, headers: string[], rows: CsvRow[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const lines = [headers.map(cell).join(",")];
  for (const row of rows) lines.push(headers.map((h) => cell(row[h])).join(","));
  await writeFile(file, lines.join("\n") + "\n", "utf8");
}

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, embedded newlines). */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) records.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => c !== "")) records.push(row);
  }
  const [header, ...data] = records;
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
