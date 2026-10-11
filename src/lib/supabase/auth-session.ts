import { clearAuthCookiesAtScopes, isChunkLike, stringFromBase64URL } from "@supabase/ssr";
import type { GetAllCookies, SetAllCookies } from "@supabase/ssr";

/**
 * Handling for *stale* Supabase sessions.
 *
 * ## Why this exists
 *
 * Supabase's SSR client stores the session (access + refresh token) in cookies.
 * A refresh token can die independently of the browser: the session may have
 * been revoked, already rotated and used by another tab, or issued by a
 * previous deployment whose cookie scope/`storageKey` has since changed. In
 * those cases the stored refresh token is permanently invalid and the auth
 * server answers with:
 *
 *   AuthApiError: Invalid Refresh Token: Refresh Token Not Found
 *   code: refresh_token_not_found
 *
 * This is an *expected* end state, not a fault: the user is simply signed out.
 * The problem is what happens next. `auth-js` removes the session from storage
 * when the access token has genuinely expired, but for a **Server Component**
 * the `setAll` cookie write is a no-op (Next.js forbids writing cookies during
 * render). So the dead cookie survives in the browser and every subsequent
 * request repeats the same failure — the error repeats on every render.
 *
 * ## The fix
 *
 * Detect the specific dead-session codes, then clear the auth cookies using
 * `clearAuthCookiesAtScopes` — the mechanism `@supabase/ssr` itself ships for
 * removing stale cookies. Clearing happens wherever a cookie write is actually
 * permitted (the middleware/proxy, which can set `Set-Cookie` on the response).
 * Valid sessions are untouched: only these exact codes are treated as
 * "session is dead", and anything else is left alone and still reported.
 */

/**
 * Auth error codes that mean the *session is gone* and the cookies are stale —
 * as opposed to a transient network problem or a genuine application error.
 *
 * Mirrors auth-js's own classification: it lists `refresh_token_not_found`,
 * `refresh_token_already_used` and `session_expired` as "a dead refresh token
 * (e.g. stale SSR cookies)" rather than an application error.
 *
 * @see https://github.com/supabase/auth-js — GoTrueClient refresh handling
 */
const DEAD_SESSION_CODES = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_expired",
  "session_not_found",
]);

/**
 * Message fragments that identify a dead refresh token.
 *
 * The *code* alone is not enough. Which code a dead refresh token produces
 * depends on the project's API version: a server that advertises the
 * `2024-01-01` version lets auth-js read `data.code` (`refresh_token_not_found`),
 * while older ones fall through to `data.error_code` and report
 * `validation_failed` for the very same condition.
 *
 * The message, by contrast, is stable — the GoTrue server answers a dead token
 * with "Invalid Refresh Token: Refresh Token Not Found" (or "...Already Used" /
 * "...Session Expired"), which auth-js copies verbatim into the error. Matching
 * it keeps the handling correct across projects and library versions.
 */
const DEAD_SESSION_MESSAGE = /invalid refresh token|refresh token not found|refresh token is not valid|refresh token.*already used|refresh token.*expired/i;

/**
 * Structural shape of an auth error. Declared structurally so this module does
 * not depend on a specific `@supabase/supabase-js` version's error class, and
 * so callers can pass the `{ code, message, name, status }` they already hold.
 */
export type AuthFailure = {
  name?: string;
  code?: string;
  message?: string;
  status?: number;
};

/**
 * Whether a failed auth call means "this session is dead, the cookies are
 * stale". Only these are handled silently; everything else is a real error and
 * must keep surfacing.
 *
 * `session_not_found` and the missing-session error are included because they
 * describe the same end state (there is no usable session), and clearing the
 * leftover cookies is equally correct for them.
 */
export function isDeadSessionError(error: AuthFailure | null | undefined): boolean {
  if (!error) return false;
  // `AuthSessionMissingError` has no code; it means "no session in storage".
  if (error.name === "AuthSessionMissingError") return true;
  if (error.code && DEAD_SESSION_CODES.has(error.code)) return true;
  // Match the message as well: a dead refresh token can surface as
  // `validation_failed` depending on the project's API version (see above).
  if (error.message && DEAD_SESSION_MESSAGE.test(error.message)) return true;
  return false;
}

/**
 * Whether an error is an expected, already-explained authentication outcome.
 *
 * Used only to decide *log level*. An expected dead session is still surfaced
 * while it is being handled (at `warn`, once), so it is never swallowed
 * silently — it just stops being reported as an application error on every
 * render.
 */
export function isExpectedAuthError(error: AuthFailure | null | undefined): boolean {
  return isDeadSessionError(error);
}

/**
 * Cookies interface shared by server clients and the middleware. Matches
 * `@supabase/ssr`'s `GetAllCookies` / `SetAllCookies` exactly so the same
 * object can be handed to `createServerClient` and to
 * `clearAuthCookiesAtScopes`.
 */
export type AuthCookies = {
  getAll: GetAllCookies;
  setAll: SetAllCookies;
};

/**
 * Supabase's default session storage key is `sb-<project-ref>-auth-token`,
 * where the project ref is the first label of the project URL host.
 *
 * @example https://abcdefgh.supabase.co -> sb-abcdefgh-auth-token
 */
export function authStorageKey(supabaseUrl: string): string {
  try {
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
    return `sb-${projectRef}-auth-token`;
  } catch {
    return "supabase.auth.token";
  }
}

/**
 * Whether the stored session's access token has expired.
 *
 * Decodes the SSR session cookie (base64url-encoded JSON, possibly split across
 * `…-auth-token.0`, `.1` chunks) using the library's own decoding helpers, and
 * compares `expires_at` to now. No network call, no token is logged.
 *
 * Returns `null` when there is nothing decodable to judge — a missing cookie, a
 * different encoding, or corrupt chunks. In that case the caller must fall back
 * to the normal path so a valid session is never discarded on a parsing guess.
 */
export function storedSessionExpired(
  cookies: { name: string; value: string }[],
  storageKey: string,
  nowMs = Date.now(),
): boolean | null {
  // No cookie for this session means there is nothing to judge.
  if (!cookies.some((c) => isChunkLike(c.name, storageKey))) return null;
  try {
    const value = cookies.find((c) => c.name === storageKey)?.value;
    // The session is stored either in the base key or split into `.0`, `.1`…
    // chunks; reassemble exactly as the storage adapter does.
    let combined = value;
    if (!combined) {
      const parts: string[] = [];
      for (let i = 0; ; i += 1) {
        const chunk = cookies.find((c) => c.name === `${storageKey}.${i}`)?.value;
        if (!chunk) break;
        parts.push(chunk);
      }
      if (parts.length > 0) combined = parts.join("");
    }
    if (!combined) return null;
    let raw = combined;
    if (raw.startsWith("base64-")) {
      raw = stringFromBase64URL(raw.slice("base64-".length));
    }
    const session = JSON.parse(raw) as { expires_at?: number };
    if (typeof session?.expires_at !== "number") return null;
    return session.expires_at * 1000 <= nowMs;
  } catch {
    // An undecodable cookie is not a reason to log anyone out; let the normal
    // path handle it (auth-js treats a corrupt payload as absent itself).
    return null;
  }
}

const logged = new Set<string>();

/**
 * Logs a dead-session event **once per process** per code.
 *
 * The same stale cookie would otherwise be reported on every render, flooding
 * the logs with a single expected condition. Never includes token material —
 * only the non-sensitive error code and message.
 */
export function logDeadSessionOnce(scope: string, code: string | undefined): void {
  const key = `${scope}:${code ?? "unknown"}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.warn(
    `[${scope}] stale Supabase session cookies detected (${code ?? "no code"}); ` +
      "clearing them so the visitor can sign in again. This is expected and logged once.",
  );
}

/**
 * Clears the Supabase auth cookies that belong to a dead session.
 *
 * Uses `clearAuthCookiesAtScopes`, the supported `@supabase/ssr` helper, so the
 * exact chunk naming (`sb-<ref>-auth-token`, `.0`, `.1`, …) and the PKCE
 * verifier slots are handled by the library rather than guessed at here.
 *
 * Safe to call from any context that can write cookies (middleware / route
 * handlers). In a Server Component the underlying `setAll` is a no-op and the
 * call simply resolves — the middleware is what actually performs the clear.
 *
 * Returns whether a clear was attempted for a usable URL.
 */
export async function clearStaleAuthCookies(input: {
  supabaseUrl: string;
  cookies: AuthCookies;
}): Promise<boolean> {
  const { supabaseUrl, cookies } = input;
  if (!supabaseUrl) return false;
  try {
    await clearAuthCookiesAtScopes({
      ...cookies,
      storageKey: authStorageKey(supabaseUrl),
      // The current, host-only scope. This is where the SSR client writes the
      // session; clearing it removes the stale generation entirely.
      scopes: [{}],
    });
    return true;
  } catch (error) {
    // A failure to clear is not fatal: the request still resolves as
    // unauthenticated, and the next request retries. Never rethrow here — it
    // would turn "signed out" into a 500.
    console.warn("[auth] failed to clear stale Supabase cookies", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
