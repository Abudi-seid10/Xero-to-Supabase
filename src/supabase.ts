import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "Missing SUPABASE_URL and a server key (SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY) in your .env file."
  );
}

function assertServerKey(key: string): void {
  if (key.startsWith("sb_publishable_")) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY contains a publishable key. Replace it with a Supabase Secret key " +
        "(sb_secret_...) or legacy service_role key; publishable and anon keys cannot write through RLS."
    );
  }

  // Legacy Supabase keys are JWTs. Check their role without logging any key material.
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: string };
      if (payload.role !== "service_role") {
        throw new Error(
          "SUPABASE_SERVICE_ROLE_KEY is not a legacy service_role key. Use a Supabase Secret key " +
            "(sb_secret_...) or the legacy service_role key from Settings > API Keys."
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SUPABASE_SERVICE_ROLE_KEY")) {
        throw error;
      }
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a valid server API key.");
    }
  }
}

assertServerKey(serviceRoleKey);

// Server-side client: secret/service-role keys bypass RLS. Never ship this
// key to a browser or mobile client.
export const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
});

/** Upsert rows in batches so a large first sync doesn't send one giant payload. */
export async function upsertInBatches<T extends Record<string, unknown>>(
  table: string,
  rows: T[],
  conflictColumn: string,
  batchSize = 500
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from(table)
      .upsert(batch as Record<string, unknown>[], { onConflict: conflictColumn });
    if (error) {
      throw new Error(
        `Supabase upsert failed for ${table} (batch starting at ${i}): ${error.message}`
      );
    }
  }
}
