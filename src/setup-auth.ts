/**
 * One-time interactive setup script. Run this locally to connect a Xero
 * organisation and save its refresh token in Supabase:
 *
 *   npm run setup-auth
 *
 * Xero redirects to the configured callback after consent. Rather than
 * running a local HTTP server, this script asks you to paste that redirect
 * URL back into the terminal. This works even
 * when a browser upgrades localhost HTTP requests to HTTPS.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import open from "open";
import { exchangeAuthCode, getConnections, saveAuth, saveTenants, verifyAuthTable } from "./xero.js";

const CLIENT_ID = process.env.XERO_CLIENT_ID;
const REDIRECT_URI = process.env.XERO_REDIRECT_URI ?? "http://localhost:5000/callback";

if (!CLIENT_ID) {
  throw new Error("Missing XERO_CLIENT_ID in .env");
}

// Read-only scopes only, per "only get data" requirement.
// Xero replaced the old broad "accounting.transactions.read" scope with
// granular per-resource scopes for any app created on or after 2 March 2026.
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access", // required to receive a refresh token
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.attachments.read", // download invoice/bill/credit note files for the Frappe export
].join(" ");

const state = randomBytes(16).toString("hex");
const configuredRedirect = new URL(REDIRECT_URI);

const authorizeUrl = new URL("https://login.xero.com/identity/connect/authorize");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", CLIENT_ID);
authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authorizeUrl.searchParams.set("scope", SCOPES);
authorizeUrl.searchParams.set("state", state);

function readCallback(value: string): { code: string; returnedState: string | null; error: string | null } {
  const pasted = value.trim();
  if (!pasted) {
    throw new Error("No redirect URL was entered.");
  }

  let callback: URL;
  try {
    callback = new URL(pasted);
  } catch {
    throw new Error("Paste the complete redirect URL from the browser address bar.");
  }

  // Chrome can locally upgrade http://localhost to https://localhost. The
  // query string remains intact, and Xero still expects the original HTTP URI
  // during the token exchange, so compare only the callback destination.
  if (
    callback.hostname !== configuredRedirect.hostname ||
    callback.port !== configuredRedirect.port ||
    callback.pathname !== configuredRedirect.pathname
  ) {
    throw new Error("The pasted URL does not match the callback host, port, and path in XERO_REDIRECT_URI.");
  }

  return {
    code: callback.searchParams.get("code") ?? "",
    returnedState: callback.searchParams.get("state"),
    error: callback.searchParams.get("error"),
  };
}

async function main() {
  await verifyAuthTable();

  console.log("Opening browser for Xero consent...\n");
  console.log("If it opens an error page after approval, copy its full address-bar URL and paste it here.");
  console.log(`Authorization URL: ${authorizeUrl}\n`);

  try {
    await open(authorizeUrl.toString());
  } catch (error) {
    console.warn("Could not open a browser automatically. Open the authorization URL above manually.");
    console.warn(error);
  }

  const readline = createInterface({ input, output });
  let pasted: string;
  try {
    pasted = await readline.question("After approving access, paste the redirect URL here: ");
  } finally {
    readline.close();
  }

  const { code, returnedState, error } = readCallback(pasted);
  if (error) {
    throw new Error(`Xero authorisation error: ${error}`);
  }
  if (!code) {
    throw new Error("The redirect URL did not contain an authorization code.");
  }
  if (returnedState !== null && returnedState !== state) {
    throw new Error("OAuth state did not match. Start setup again and use the newly opened authorization URL.");
  }
  if (returnedState === null) {
    throw new Error("The redirect URL did not contain OAuth state. Start setup again and paste the complete redirect URL.");
  }

  const tokens = await exchangeAuthCode(code, REDIRECT_URI);
  const connections = await getConnections(tokens.access_token);

  if (connections.length === 0) {
    throw new Error("No Xero organisations were authorised during consent.");
  }
  const { tenantId, tenantName } = connections[0];
  await saveAuth(tenantId, tenantName, tokens.refresh_token);
  await saveTenants(connections);

  console.log(`\nConnected ${connections.length} Xero organisation(s):`);
  for (const tenant of connections) {
    console.log(`- ${tenant.tenantName ?? "Unnamed organisation"} (${tenant.tenantId})`);
  }
  console.log("Refresh token and organisation list stored in Supabase. Setup complete.\n");
}

main().catch((error) => {
  console.error("\nSetup failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
