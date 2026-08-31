import "dotenv/config";
import { supabase } from "./supabase.js";

const TOKEN_URL = "https://identity.xero.com/connect/token";
const API_BASE = "https://api.xero.com/api.xro/2.0";
const CONNECTIONS_URL = "https://api.xero.com/connections";

const CLIENT_ID = requireEnv("XERO_CLIENT_ID");
const CLIENT_SECRET = requireEnv("XERO_CLIENT_SECRET");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function basicAuthHeader(): string {
  return "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

interface StoredAuth {
  tenant_id: string;
  tenant_name: string | null;
  refresh_token: string;
}

export interface XeroTenant {
  tenantId: string;
  tenantName: string | null;
}

/** Confirm that the one-time schema setup was applied before starting OAuth. */
export async function verifyAuthTable(): Promise<void> {
  const { error } = await supabase.from("xero_auth").select("id").limit(1);

  if (error) {
    if (error.code === "PGRST205") {
      throw new Error(
        "Supabase table public.xero_auth is missing. Open your Supabase project's SQL Editor, " +
          "run the complete supabase/schema.sql file from this project, then run npm run setup-auth again."
      );
    }
    throw new Error(`Failed to verify the Supabase xero_auth table: ${error.message}`);
  }

  const { error: tenantsError } = await supabase.from("xero_tenants").select("tenant_id").limit(1);
  if (tenantsError) {
    if (tenantsError.code === "PGRST205") {
      throw new Error(
        "Supabase table public.xero_tenants is missing. Open your Supabase project's SQL Editor, " +
          "run the complete supabase/schema.sql file from this project, then run npm run setup-auth again."
      );
    }
    throw new Error(`Failed to verify the Supabase xero_tenants table: ${tenantsError.message}`);
  }
}

/** Read the single stored Xero connection from Supabase. */
export async function loadStoredAuth(): Promise<StoredAuth> {
  const { data, error } = await supabase
    .from("xero_auth")
    .select("tenant_id, tenant_name, refresh_token")
    .eq("id", 1)
    .single();

  if (error || !data) {
    throw new Error(
      "No Xero connection found in Supabase (xero_auth table is empty). " +
        "Run `npm run setup-auth` once first."
    );
  }
  return data as StoredAuth;
}

/** Persist a (possibly rotated) refresh token immediately after use. */
export async function saveAuth(
  tenantId: string,
  tenantName: string | null,
  refreshToken: string
): Promise<void> {
  const { error } = await supabase
    .from("xero_auth")
    .upsert(
      {
        id: 1,
        tenant_id: tenantId,
        tenant_name: tenantName,
        refresh_token: refreshToken,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
  if (error) throw new Error(`Failed to persist Xero auth: ${error.message}`);
}

/** Save every organisation authorised by the current Xero OAuth connection. */
export async function saveTenants(tenants: XeroTenant[]): Promise<void> {
  const { error } = await supabase.from("xero_tenants").upsert(
    tenants.map((tenant) => ({
      tenant_id: tenant.tenantId,
      tenant_name: tenant.tenantName,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "tenant_id" }
  );
  if (error) throw new Error(`Failed to persist Xero organisations: ${error.message}`);
}

/** List all organisations available to the shared Xero OAuth connection. */
export async function loadTenants(): Promise<XeroTenant[]> {
  const { data, error } = await supabase
    .from("xero_tenants")
    .select("tenant_id, tenant_name")
    .order("tenant_name", { ascending: true });

  if (error) throw new Error(`Failed to load Xero organisations: ${error.message}`);
  if (!data?.length) {
    throw new Error("No Xero organisations found. Run npm run setup-auth to connect one or more organisations.");
  }

  return data.map((tenant) => ({ tenantId: tenant.tenant_id, tenantName: tenant.tenant_name }));
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Exchange a refresh token for a fresh access token.
 * Xero ROTATES the refresh token on every use — the new one is saved
 * to Supabase immediately, before it's used for anything else, so a
 * mid-run failure never strands you with an already-invalidated token.
 */
export async function refreshAccessToken(
  tenantId: string,
  tenantName: string | null,
  refreshToken: string
): Promise<{ accessToken: string; tenantId: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Xero token refresh failed (${res.status}): ${body}. ` +
        `If this persists, the refresh token has likely expired or was revoked — ` +
        `run \`npm run setup-auth\` again to reconnect.`
    );
  }

  const json = (await res.json()) as TokenResponse;
  await saveAuth(tenantId, tenantName, json.refresh_token);

  return { accessToken: json.access_token, tenantId };
}

/** Exchange an OAuth authorization code for tokens (used only by setup-auth). */
export async function exchangeAuthCode(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Xero code exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

/** List the Xero organisations (tenants) this token is connected to. */
export async function getConnections(
  accessToken: string
): Promise<XeroTenant[]> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to list Xero connections (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as XeroTenant[];
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FetchPageOptions {
  accessToken: string;
  tenantId: string;
  where?: string;
  order?: string;
  page: number;
  ifModifiedSince?: Date | null;
}

/**
 * Fetch a single page of a Xero Accounting API list endpoint
 * (e.g. "Contacts", "Invoices", "CreditNotes"), pageSize is fixed
 * at Xero's default of 100 records per page.
 *
 * Handles:
 *  - Xero-tenant-id / Bearer auth headers
 *  - If-Modified-Since for incremental sync
 *  - 429 rate limiting, backing off using the Retry-After header
 */
async function fetchXeroPage(
  resource: string,
  opts: FetchPageOptions,
  maxRetries = 5
): Promise<Record<string, unknown>> {
  const url = new URL(`${API_BASE}/${resource}`);
  url.searchParams.set("page", String(opts.page));
  if (opts.where) url.searchParams.set("where", opts.where);
  if (opts.order) url.searchParams.set("order", opts.order);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    "Xero-tenant-id": opts.tenantId,
    Accept: "application/json",
  };
  if (opts.ifModifiedSince) {
    headers["If-Modified-Since"] = opts.ifModifiedSince.toUTCString();
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
      console.warn(
        `Rate limited on ${resource} page ${opts.page} — waiting ${retryAfter}s ` +
          `(${res.headers.get("X-Rate-Limit-Problem") ?? "unknown limit"})`
      );
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    if (!res.ok) {
      throw new Error(
        `Xero API error on ${resource} page ${opts.page} (${res.status}): ${await res.text()}`
      );
    }

    const dayRemaining = res.headers.get("X-DayLimit-Remaining");
    if (dayRemaining && Number(dayRemaining) < 200) {
      console.warn(`Warning: only ${dayRemaining} Xero API calls left today for this org.`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  throw new Error(`Exceeded retry budget fetching ${resource} page ${opts.page}`);
}

/**
 * Fetch every page of a Xero list resource and return the combined
 * array of records. `arrayKey` is the JSON property Xero nests the
 * list under (e.g. "Contacts", "Invoices", "CreditNotes").
 */
export async function fetchAllPages<T>(
  resource: string,
  arrayKey: string,
  opts: Omit<FetchPageOptions, "page">
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;

  // Small delay between pages keeps us comfortably under the
  // 60-calls/minute-per-org limit even on a large first sync.
  const DELAY_BETWEEN_PAGES_MS = 250;

  while (true) {
    const body = await fetchXeroPage(resource, { ...opts, page });
    const records = (body[arrayKey] as T[] | undefined) ?? [];
    all.push(...records);

    if (records.length < 100) break; // last page
    page += 1;
    await sleep(DELAY_BETWEEN_PAGES_MS);
  }

  return all;
}
