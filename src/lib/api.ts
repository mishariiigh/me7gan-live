import { checkRateLimit } from "@/lib/rate-limit";
import { requireAdminResponse } from "@/lib/auth/require-admin";

export async function checkRequestLimit(request: Request, namespace: string, limit = 30) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const identity = request.headers.get("x-real-ip") ?? forwarded ?? "unknown";
  const result = await checkRateLimit(identity, namespace, limit);
  if (result.success) return null;
  return Response.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)).toString() } });
}

export async function checkAdminRequest(request: Request, namespace: string, limit = 60) {
  const limited = await checkRequestLimit(request, namespace, limit);
  if (limited) return { response: limited, user: null };
  const denied = await requireAdminResponse();
  if (denied) return { response: denied, user: null };
  return { response: null, user: null };
}

export async function recordAdminAudit(action: string, entityType: string, entityId?: string, metadata: Record<string, unknown> = {}) {
  const { createSupabaseServerClient, getServerUser } = await import("@/lib/supabase/server");
  const client = await createSupabaseServerClient();
  if (!client) return;
  // An audit row is best-effort; a stale session must not surface as an error.
  const { user } = await getServerUser(client);
  if (!user) return;
  await client.from("audit_logs").insert({ actor_id: user.id, action, entity_type: entityType, entity_id: entityId ?? null, metadata });
}

/**
 * Shape of a Supabase/PostgREST error. Declared structurally so this helper does
 * not depend on a specific client version.
 */
export type SupabaseFailure = {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

/**
 * Logs the real database error behind a failed admin write.
 *
 * PostgREST reports constraint violations, RLS denials and permission errors as
 * a structured error with `code`, `message`, `details` and `hint`. Dropping those
 * fields (as the admin routes previously did) leaves only a generic message and
 * makes the actual cause impossible to diagnose from the logs.
 *
 * `context` carries the attempted values so a failing write can be reproduced.
 */
export function logSupabaseError(scope: string, error: SupabaseFailure, context: Record<string, unknown> = {}) {
  const code = error.code ?? "(no code)";
  console.error(`[${scope}] Supabase error`, {
    code,
    message: error.message ?? "(no message)",
    details: error.details ?? null,
    hint: error.hint ?? null,
    // Map common PostgREST codes to a plain-language reading of the failure.
    interpretation: interpretPostgrestCode(code),
    context,
  });
}

/** Turns a PostgREST error code into a short human-readable explanation. */
function interpretPostgrestCode(code: string) {
  switch (code) {
    case "23514":
      return "check constraint violated (a column value is outside its allowed set, e.g. an unrecognised stream_type)";
    case "23503":
      return "foreign key violated (referenced row does not exist)";
    case "23505":
      return "unique constraint violated (a row with this key already exists)";
    case "23502":
      return "not-null constraint violated (a required column was omitted)";
    case "42501":
      return "insufficient privilege / RLS policy denied the write";
    case "42P01":
      return "table does not exist (migration not applied?)";
    case "42703":
      return "column does not exist (schema drift between code and database)";
    case "PGRST116":
      return "no row returned (the WHERE clause matched nothing)";
    case "PGRST204":
      return "column not found in the exposed schema (schema cache may be stale)";
    default:
      return code.startsWith("PGRST") ? "PostgREST request error" : "database error";
  }
}
