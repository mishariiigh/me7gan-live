import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  authStorageKey,
  clearStaleAuthCookies,
  isDeadSessionError,
  logDeadSessionOnce,
  storedSessionExpired,
} from "@/lib/supabase/auth-session";

/**
 * Admin gate and session refresh.
 *
 * This runs before any `/admin` request is handled. It serves two purposes:
 *
 *   1. Refresh the Supabase session cookie so a valid administrator is not
 *      signed out mid-session.
 *   2. Send an unauthenticated visitor to the admin login page instead of
 *      rendering the console.
 *
 * It is an *optimistic* check, deliberately: it confirms a session exists but
 * does not decide whether the user is an administrator, because that would mean
 * a database round trip on every admin request. Authorisation remains where it
 * belongs and is not weakened by this file:
 *
 *   - `/admin` pages call `getAdminUser()`, which checks `profiles.role`.
 *   - `/api/admin/*` handlers call `checkAdminRequest()`, backed by the
 *     `public.is_admin()` RLS policies. A direct API call is refused there even
 *     if this file were bypassed entirely.
 *
 * The admin URL is therefore not treated as a secret, and hiding its navigation
 * links is a cosmetic choice, not a security measure.
 */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const cookieWriter = {
    getAll() {
      return request.cookies.getAll();
    },
    setAll(
      cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[],
      headers?: Record<string, string>,
    ) {
      cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
      response = NextResponse.next({ request });
      cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      // The library hands back `Cache-Control: private, no-store` whenever it
      // writes auth cookies, so a refreshed session is never cached by a CDN or
      // reverse proxy and served to a different visitor. Dropping these headers
      // (as this file previously did) silently skips that protection.
      if (headers) {
        for (const [headerName, headerValue] of Object.entries(headers)) {
          response.headers.set(headerName, headerValue);
        }
      }
    },
  };

  // Pre-flight: if the stored session's access token has already expired, drop
  // it BEFORE creating the auth client. Creating the client registers an
  // internal `onAuthStateChange` listener that eagerly reads the session, tries
  // to refresh it, and — when that fails — prints the raw `AuthApiError` to the
  // console on *every* request. Removing the dead cookie first means the client
  // only ever sees "no session", which is silent.
  //
  // The check is purely local (decoding the cookie, no network call) and only
  // acts when the cookie is provably expired: an undecodable cookie returns
  // `null` and is left for the normal path, so a valid session is never lost to
  // a parsing guess.
  const storageKey = authStorageKey(url);
  if (storedSessionExpired(request.cookies.getAll(), storageKey) === true) {
    for (const cookie of request.cookies.getAll()) {
      if (cookie.name === storageKey || cookie.name.startsWith(`${storageKey}.`)) {
        request.cookies.delete(cookie.name);
        // Also emit an expiring Set-Cookie so the browser drops it.
        response.cookies.set(cookie.name, "", { path: "/", maxAge: 0, sameSite: "lax" });
      }
    }
  }

  const supabase = createServerClient(url, key, { cookies: cookieWriter });

  // `getUser()` validates the token with Supabase rather than trusting the
  // cookie, so a forged or expired session does not pass this check.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  // A dead refresh token (revoked session, one already rotated by another tab,
  // or cookies left over from an earlier deploy) makes every request fail the
  // same way. The user is simply signed out, so clear the stale cookies here —
  // middleware is the one place a `Set-Cookie` reliably reaches the browser for
  // a Server Component render — and continue as an unauthenticated visitor.
  //
  // Only this specific condition is handled: anything else keeps its existing
  // behaviour, so genuine auth failures are not silently swallowed.
  if (isDeadSessionError(authError)) {
    logDeadSessionOnce("proxy", authError?.code);
    await clearStaleAuthCookies({ supabaseUrl: url, cookies: cookieWriter });
  }

  // A cleared stale session must not be treated as signed in.
  const signedInUser = isDeadSessionError(authError) ? null : user;

  const { pathname, search } = request.nextUrl;
  const isLoginRoute = pathname === "/admin/login" || pathname.startsWith("/admin/login/");

  if (!signedInUser && !isLoginRoute) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/admin/login";
    loginUrl.search = "";
    // Remember where the visitor was heading, so signing in returns them there.
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    const redirect = NextResponse.redirect(loginUrl);
    // Carry over any refreshed cookies so the session is not lost on the way.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  // A signed-in visitor has no reason to remain on the login route.
  if (signedInUser && isLoginRoute) {
    const adminUrl = request.nextUrl.clone();
    adminUrl.pathname = "/admin";
    adminUrl.search = "";
    const redirect = NextResponse.redirect(adminUrl);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*"],
};