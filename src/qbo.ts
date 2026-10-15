/** Minimal read-only QuickBooks Online client: token refresh + paged queries. */
import { readdir } from "node:fs/promises";
import {
  API_BASE, TOKEN_URL, basicAuth, fingerprint, readTokenFile, requireEnv, writeTokenFile,
} from "./qbo-env.js";

const MINOR_VERSION = "75";

const CLIENT_ID = requireEnv("QBO_CLIENT_ID");
const CLIENT_SECRET = requireEnv("QBO_CLIENT_SECRET");

// The company all calls go to. Switch with useRealm(); each switch drops the cached access token.
let realmId = process.env.QBO_REALM_ID ?? "";
export const currentRealm = (): string => realmId;
export function useRealm(id: string): void {
  realmId = id;
  accessToken = "";
}

/**
 * Companies to export: QBO_REALM_ID plus every company connected with this client ID
 * (one .qbo-auth-<companyId>.json per company, created by `npm run setup-qbo-auth`).
 */
export async function discoverRealms(): Promise<string[]> {
  const found = new Set<string>();
  if (process.env.QBO_REALM_ID) found.add(process.env.QBO_REALM_ID);
  for (const name of await readdir(".")) {
    const m = /^\.qbo-auth-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const saved = await readTokenFile(m[1]);
    if (saved?.client === fingerprint(CLIENT_ID)) found.add(m[1]);
  }
  return [...found];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let accessToken = "";
let tokenAt = 0;

/**
 * QuickBooks rotates the refresh token on use, so the newest one is kept on disk per company.
 * A saved token is trusted while the client ID is unchanged and it either came from
 * `npm run setup-qbo-auth` or grew from the current QBO_REFRESH_TOKEN seed; pasting a new seed
 * therefore takes effect without deleting the file.
 */
async function currentRefreshToken(): Promise<string> {
  const saved = await readTokenFile(realmId);
  // The QBO_REFRESH_TOKEN seed belongs to QBO_REALM_ID only, never to other discovered companies.
  const isEnvRealm = realmId === process.env.QBO_REALM_ID;
  const seed = isEnvRealm ? process.env.QBO_REFRESH_TOKEN : undefined;
  if (saved?.refresh_token && saved.client === fingerprint(CLIENT_ID)) {
    // For the .env company a changed seed means new tokens were pasted, so prefer them.
    if (!isEnvRealm || saved.seed === "oauth" || (seed && saved.seed === fingerprint(seed))) return saved.refresh_token;
  }
  if (!seed) {
    throw new Error(`No QuickBooks token for company ${realmId}. Run \`npm run setup-qbo-auth\` or set QBO_REFRESH_TOKEN.`);
  }
  return seed;
}

async function refresh(): Promise<void> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: await currentRefreshToken() }),
  });
  if (!res.ok) {
    throw new Error(
      `QuickBooks token refresh failed (${res.status}): ${await res.text()}. ` +
        `If the refresh token expired or was already rotated, ` +
        "run 'npm run setup-qbo-auth' again (the token must come from the same app/client ID and environment as QBO_CLIENT_ID)."
    );
  }
  const json = (await res.json()) as { access_token: string; refresh_token: string };
  const saved = await readTokenFile(realmId);
  const seed = realmId === process.env.QBO_REALM_ID ? process.env.QBO_REFRESH_TOKEN : undefined;
  // Keep the existing provenance marker so the next run still trusts the rotated token.
  const sameClient = saved?.client === fingerprint(CLIENT_ID);
  const marker = sameClient && saved?.seed && (saved.seed === "oauth" || realmId !== process.env.QBO_REALM_ID)
    ? saved.seed
    : fingerprint(seed ?? "");
  await writeTokenFile(realmId, CLIENT_ID, json.refresh_token, marker);
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
    const res = await qboFetch(`${API_BASE}/v3/company/${realmId}/query?minorversion=${MINOR_VERSION}&query=${encodeURIComponent(q)}`);
    const rows = ((await res.json()) as { QueryResponse?: Record<string, T[]> }).QueryResponse?.[entity] ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export async function qboCompanyName(): Promise<string> {
  const res = await qboFetch(`${API_BASE}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=${MINOR_VERSION}`);
  return ((await res.json()) as { CompanyInfo?: { CompanyName?: string } }).CompanyInfo?.CompanyName ?? `QuickBooks ${realmId}`;
}
