/**
 * Attach the files downloaded by `export:frappe` to the documents created by Data Import.
 * Documents are found by the `XERO:<id>` marker the export writes into Remarks.
 *
 *   npm run upload:attachments -- <export/OrgName> [--public]
 *
 * Needs FRAPPE_URL, FRAPPE_API_KEY, FRAPPE_API_SECRET (User > API Access > Generate Keys).
 * Safe to re-run: files already attached under the same name are skipped.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./csv.js";

const base = (process.env.FRAPPE_URL ?? "").replace(/\/+$/, "");
const key = process.env.FRAPPE_API_KEY;
const secret = process.env.FRAPPE_API_SECRET;
if (!base || !key || !secret) throw new Error("Set FRAPPE_URL, FRAPPE_API_KEY and FRAPPE_API_SECRET in .env.");

const headers = { Authorization: `token ${key}:${secret}` };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${url}`, { ...init, headers: { ...headers, ...init?.headers } });
  if (!res.ok) throw new Error(`Frappe ${res.status} on ${url}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

const list = async (doctype: string, filters: unknown[], fields: string[]) =>
  (
    await api<{ data: Record<string, string>[] }>(
      `/api/resource/${encodeURIComponent(doctype)}?filters=${encodeURIComponent(JSON.stringify(filters))}` +
        `&fields=${encodeURIComponent(JSON.stringify(fields))}&limit_page_length=1`
    )
  ).data;

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const isPrivate = process.argv.includes("--public") ? 0 : 1;
  const dir = args[0];
  if (!dir) throw new Error("Usage: npm run upload:attachments -- <export/OrgName> [--public]");

  const manifest = parseCsv(await readFile(path.join(dir, "attachments_manifest.csv"), "utf8"));
  console.log(`Uploading ${manifest.length} file(s) to ${base}`);

  const docNames = new Map<string, string | null>();
  let uploaded = 0, skipped = 0, missing = 0;

  for (const m of manifest) {
    const cacheKey = `${m.doctype}|${m.xero_id}`;
    if (!docNames.has(cacheKey)) {
      const found = await list(m.doctype, [["remarks", "like", `%${m.xero_id}%`]], ["name"]);
      docNames.set(cacheKey, found[0]?.name ?? null);
    }
    const docname = docNames.get(cacheKey);
    if (!docname) {
      missing++;
      console.warn(`  No ${m.doctype} found for ${m.document_number} (${m.xero_id}) — import it first. Skipping ${m.file_name}`);
      continue;
    }

    const already = await list(
      "File",
      [["attached_to_doctype", "=", m.doctype], ["attached_to_name", "=", docname], ["file_name", "=", m.file_name]],
      ["name"]
    );
    if (already.length) {
      skipped++;
      continue;
    }

    const form = new FormData();
    form.set("file", new Blob([await readFile(path.join(dir, m.file_path))]), m.file_name);
    form.set("file_name", m.file_name);
    form.set("doctype", m.doctype);
    form.set("docname", docname);
    form.set("is_private", String(isPrivate));
    await api("/api/method/upload_file", { method: "POST", body: form });
    uploaded++;
    if (uploaded % 25 === 0) console.log(`  ${uploaded} uploaded...`);
  }

  console.log(`Done: ${uploaded} uploaded, ${skipped} already attached, ${missing} skipped (document not found).`);
}

main().catch((err) => {
  console.error("\nUpload failed:", err);
  process.exit(1);
});
