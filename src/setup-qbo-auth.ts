/**
 * Interactive QuickBooks Online OAuth setup. Connects one company and stores its
 * rotating refresh token in .qbo-auth-<companyId>.json (git-ignored):
 *
 *   npm run setup-qbo-auth                          # company for the settings in .env
 *   npm run setup-qbo-auth -- --env-file .env.qbo2  # another company; its ID is saved into that file
 *
 * Needs QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_ENVIRONMENT. The redirect URI defaults to the
 * Intuit OAuth Playground's, which every Intuit app already accepts; set QBO_REDIRECT_URI only
 * if you registered your own. After you approve, the browser lands on that page: copy its full
 * address-bar URL (it contains the code and company ID) and paste it here. Paste it promptly:
 * the code expires in about 5 minutes, and do not click anything on the Playground page.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import open from "open";
import { API_BASE, ENV_FILE, TOKEN_URL, basicAuth, requireEnv, tokenFileFor, writeTokenFile } from "./qbo-env.js";

const CLIENT_ID = requireEnv("QBO_CLIENT_ID");
const CLIENT_SECRET = requireEnv("QBO_CLIENT_SECRET");
const REDIRECT_URI = process.env.QBO_REDIRECT_URI || "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl";

const state = randomBytes(16).toString("hex");
const authorizeUrl = new URL("https://appcenter.intuit.com/connect/oauth2");
authorizeUrl.searchParams.set("client_id", CLIENT_ID);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("scope", "com.intuit.quickbooks.accounting"); // read access is enough; we only issue GETs
authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authorizeUrl.searchParams.set("state", state);

function readCallback(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Paste the complete URL from the browser address bar.");
  }
  const p = url.searchParams;
  if (p.get("error")) throw new Error(`QuickBooks authorisation error: ${p.get("error")}`);
  const code = p.get("code");
  const realmId = p.get("realmId");
  if (!code || !realmId) throw new Error("That URL has no code/realmId. Paste the address after approving, not the earlier one.");
  if (p.get("state") !== state) throw new Error("OAuth state did not match. Start setup again and use the newly opened link.");
  return { code, realmId };
}

/** Save the (non-secret) company ID into the env file so later exports pick the right company. */
async function saveRealmId(file: string, realmId: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    /* new file */
  }
  const line = `QBO_REALM_ID=${realmId}`;
  text = /^QBO_REALM_ID=.*$/m.test(text) ? text.replace(/^QBO_REALM_ID=.*$/m, line) : text + (text && !text.endsWith("\n") ? "\n" : "") + line + "\n";
  await writeFile(file, text, "utf8");
}

async function main() {
  console.log(`QuickBooks environment: ${process.env.QBO_ENVIRONMENT === "sandbox" ? "sandbox" : "production"}`);
  console.log("Opening QuickBooks consent. Sign in, pick the company, and approve.\n");
  console.log(`Authorization URL:\n${authorizeUrl}\n`);
  try {
    await open(authorizeUrl.toString());
  } catch {
    console.warn("Could not open a browser automatically. Open the URL above manually.");
  }

  const rl = createInterface({ input, output });
  let pasted: string;
  try {
    pasted = await rl.question("After approving, paste the full URL from the address bar: ");
  } finally {
    rl.close();
  }
  const { code, realmId } = readCallback(pasted);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  if (!res.ok) {
    throw new Error(
      `Token exchange failed (${res.status}): ${await res.text()}. The code may have expired or been used already ` +
        `(did you click anything on the Playground page?), or QBO_CLIENT_ID/SECRET belong to a different environment.`
    );
  }
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  await writeTokenFile(realmId, CLIENT_ID, tokens.refresh_token, "oauth");

  // Confirm the connection, and show which company this is, before declaring success.
  const info = await fetch(`${API_BASE}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
  });
  const name = info.ok
    ? ((await info.json()) as { CompanyInfo?: { CompanyName?: string } }).CompanyInfo?.CompanyName
    : undefined;
  if (!info.ok) {
    console.warn(`\nTokens saved, but a test call failed (${info.status}). Check QBO_ENVIRONMENT matches these keys.`);
  }

  console.log(`\nConnected: ${name ?? "(company name unavailable)"} — company ID ${realmId}`);
  console.log(`Refresh token stored in ${tokenFileFor(realmId)}.`);
  if (ENV_FILE) {
    await saveRealmId(ENV_FILE, realmId);
    console.log(`QBO_REALM_ID=${realmId} written to ${ENV_FILE}.`);
    console.log(`Export with: npm run export:qbo -- --env-file ${ENV_FILE} --out "<folder>"`);
  } else {
    console.log(`Set QBO_REALM_ID=${realmId} in .env, then: npm run export:qbo -- --out "<folder>"`);
  }
}

main().catch((error) => {
  console.error("\nSetup failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
