/** Minimal read-only QuickBooks Online client: token refresh + paged queries. */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const TOKEN_FILE = ".qbo-auth.json";
const MINOR_VERSION = "75";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const CLIENT_ID = requireEnv("QBO_CLIENT_ID");
const CLIENT_SECRET = requireEnv("QBO_CLIENT_SECRET");
export const REALM_ID = requireEnv("QBO_REALM_ID");
const API_BASE =
  process.env.QBO_ENVIRONMENT === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let accessToken = "";
let tokenAt = 0;

/**
 * QuickBooks rotates the refresh token on use, so the newest one is kept in .qbo-auth.json.
 * The saved token is only trusted while the client ID and the seed token in .env are unchanged;
 * pasting new keys or a new QBO_REFRESH_TOKEN therefore takes effect without deleting the file.
 */
const fingerprint = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16);

async function currentRefreshToken(): Promise<string> {
  const seed = requireEnv("QBO_REFRESH_TOKEN");
  try {
    const saved = JSON.parse(await readFile(TOKEN_FILE, "utf8")) as { refresh_token?: string; client?: string; seed?: string };
    if (saved.refresh_token && saved.client === fingerprint(CLIENT_ID) && saved.seed === fingerprint(seed)) {
      return saved.refresh_token;
    }
  } catch {
    /* first run */
  }
  return seed;
}

async function refresh(): Promise<void> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: await currentRefreshToken() }),
  });
  if (!res.ok) {
    throw new Error(
      `QuickBooks token refresh failed (${res.status}): ${await res.text()}. ` +
        `If the refresh token expired or was already rotated, generate a new one in the Intuit OAuth Playground, ` +
        `put it in QBO_REFRESH_TOKEN (it must come from the same app/client ID and environment as QBO_CLIENT_ID).`
    );
  }
  const json = (await res.json()) as { access_token: string; refresh_token: string };
  await writeFile(TOKEN_FILE, JSON.stringify({
      refresh_token: json.refresh_token,
      client: fingerprint(CLIENT_ID),
      seed: fingerprint(requireEnv("QBO_REFRESH_TOKEN")),
      updated_at: new Date().toISOString(),
    }), "utf8");
  accessToken = json.access_token;
  tokenAt = Date.now();
}

export async function qboFetch(url: string, init: RequestInit = {}, auth = true): Promise<Response> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (auth && (!accessToken || Date.now() - tokenAt > 50 * 60 * 1000)) await refresh();
    const res = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(auth ? { Authorization: `Bearer ${accessToken}` } : {}), ...init.headers },
    });
    if (res.status === 401 && auth && attempt === 0) {
      accessToken = ""; // expired early: refresh once and retry
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(60, 2 ** attempt * 2) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`QuickBooks error ${res.status} on ${url.split("?")[0]}: ${(await res.text()).slice(0, 500)}`);
    return res;
  }
  throw new Error(`Exceeded retry budget for ${url.split("?")[0]}`);
}

/** Fetch every row of `SELECT * FROM <entity>` (1000 per page). */
export async function qboQueryAll<T>(entity: string): Promise<T[]> {
  const out: T[] = [];
  for (let start = 1; ; start += 1000) {
    const q = `SELECT * FROM ${entity} ORDERBY Id STARTPOSITION ${start} MAXRESULTS 1000`;
    const res = await qboFetch(`${API_BASE}/v3/company/${REALM_ID}/query?minorversion=${MINOR_VERSION}&query=${encodeURIComponent(q)}`);
    const rows = ((await res.json()) as { QueryResponse?: Record<string, T[]> }).QueryResponse?.[entity] ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export async function qboCompanyName(): Promise<string> {
  const res = await qboFetch(`${API_BASE}/v3/company/${REALM_ID}/companyinfo/${REALM_ID}?minorversion=${MINOR_VERSION}`);
  return ((await res.json()) as { CompanyInfo?: { CompanyName?: string } }).CompanyInfo?.CompanyName ?? `QuickBooks ${REALM_ID}`;
}
