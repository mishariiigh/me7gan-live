import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import {
  authStorageKey,
  clearStaleAuthCookies,
  isDeadSessionError,
  logDeadSessionOnce,
  storedSessionExpired,
} from "@/lib/supabase/auth-session";

export async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const cookieStore = await cookies();

  // Hide a session whose access token has already expired from the client.
  //
  // This must happen BEFORE `createServerClient` runs. That call registers an
  // internal `onAuthStateChange` listener which eagerly reads the stored session
  // and refreshes it; when the refresh token is dead the library prints the raw
  // `AuthApiError` to the console from its own code. Building the client is
  // therefore enough to log the error — no `getUser()` call is required — which
  // is why guarding only the `getUser()` result (as this module previously did)
  // still left every public page emitting it.
  //
  // Presenting an empty cookie set means the client simply sees "no session" and
  // never attempts the doomed refresh. The check is local (decoding the cookie,
  // no network call) and only hides a *provably* expired session: anything
  // undecodable returns `null` and is passed through untouched, so a valid
  // session is never lost to a parsing guess.
  const all = cookieStore.getAll();
  const storageKey = authStorageKey(url);
  const expired = storedSessionExpired(all, storageKey) === true;
  const visibleCookies = expired
    ? all.filter((c) => c.name !== storageKey && !c.name.startsWith(`${storageKey}.`))
    : all;

  return createServerClient(url, key, {
    cookies: {
      getAll() { return visibleCookies; },
      setAll(cookiesToSet) {
        try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* Server Components cannot write cookies; route handlers can. */ }
      },
    },
  });
}

/**
 * Reads the signed-in user, treating a dead session as "signed out".
 *
 * A refresh token can die while its cookie lingers in the browser (a revoked
 * session, a refresh already rotated by another tab, or cookies from an earlier
 * deploy whose scope changed). The auth server then answers with
 * `refresh_token_not_found`:
 *
 *   AuthApiError: Invalid Refresh Token: Refresh Token Not Found
 *
 * auth-js drops the session from storage in that case, but during a Server
 * Component render the `setAll` cookie write above is a no-op — Next.js
 * forbids writing cookies while rendering. The dead cookie therefore survives,
 * and every later request repeats the identical failure.
 *
 * This is an expected end state, not a fault: the caller only wants to know
 * *whether* there is a valid user, and the answer is no. So a dead session is
 * returned as `user: null` and the cookies are cleared, rather than being
 * rethrown on every render.
 *
 * Every other error is returned untouched, so genuine failures keep surfacing.
 */
export async function getServerUser(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<{ user: User | null; error: unknown }> {
  if (!supabase) return { user: null, error: null };
  const { data: { user }, error } = await supabase.auth.getUser();
  if (isDeadSessionError(error)) {
    logDeadSessionOnce("auth", error?.code);
    await clearSupabaseCookiesOnce();
    return { user: null, error: null };
  }
  return { user, error };
}

/**
 * Removes the Supabase session cookies from the response.
 *
 * Best-effort: during a Server Component render Next.js makes `cookieStore.set`
 * a no-op, so the browser's copy survives until a route handler or the proxy can
 * issue the `Set-Cookie`. Route handlers can write, and those are the paths that
 * act on a session, so this is still worth attempting there.
 */
async function clearSupabaseCookiesOnce(): Promise<void> {
  const cookieStore = await cookies();
  await clearStaleAuthCookies({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* not writable during render — the proxy performs the clear */ }
      },
    },
  });
}