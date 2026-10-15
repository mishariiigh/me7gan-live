import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — SERVER ONLY.
 *
 * This key bypasses Row Level Security, so it must never reach the browser.
 * The name deliberately has no `NEXT_PUBLIC_` prefix and the module is only
 * imported from route handlers, which never ship to the client bundle.
 *
 * The single current consumer is analytics ingestion: `site_visits` has RLS
 * enabled with no public policies (see migration 011), so the service role is
 * the only role that can write a visit or read the aggregated counts. Public
 * pages keep using the anon-key clients in `server.ts`.
 *
 * Returns `null` when the key is absent so callers can fail closed (skip
 * recording / return "not configured") instead of throwing.
 */
export function createServiceSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
