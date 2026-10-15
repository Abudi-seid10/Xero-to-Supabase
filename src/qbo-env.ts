/** QuickBooks env + token-file helpers shared by the client and the OAuth setup script. */
import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// `--env-file <path>` layers a second company's settings over .env, so several
// QuickBooks companies can be handled from one checkout.
dotenv.config();
const flag = process.argv.indexOf("--env-file");
export const ENV_FILE: string | null = flag === -1 ? null : (process.argv[flag + 1] ?? null);
if (flag !== -1) {
  if (!ENV_FILE) throw new Error("--env-file needs a path.");
  const loaded = dotenv.config({ path: ENV_FILE, override: true });
  if (loaded.error) throw new Error(`Could not read --env-file ${ENV_FILE}: ${loaded.error.message}`);
}

export const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const API_BASE =
  process.env.QBO_ENVIRONMENT === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const basicAuth = (id: string, secret: string) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

export const fingerprint = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16);

/** One rotating-token file per company so different companies never overwrite each other. */
export const tokenFileFor = (realmId: string) => `.qbo-auth-${realmId}.json`;

interface TokenFile {
  refresh_token?: string;
  client?: string;
  /** Fingerprint of the QBO_REFRESH_TOKEN seed it grew from, or "oauth" if created by setup-qbo-auth. */
  seed?: string;
}

export async function readTokenFile(realmId: string): Promise<TokenFile | null> {
  try {
    return JSON.parse(await readFile(tokenFileFor(realmId), "utf8")) as TokenFile;
  } catch {
    return null;
  }
}

export async function writeTokenFile(realmId: string, clientId: string, refreshToken: string, seed: string): Promise<void> {
  await writeFile(
    tokenFileFor(realmId),
    JSON.stringify({ refresh_token: refreshToken, client: fingerprint(clientId), seed, updated_at: new Date().toISOString() }),
    "utf8"
  );
}
