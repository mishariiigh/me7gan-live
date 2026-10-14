import { getAdminUser } from "@/lib/auth/require-admin";

/**
 * Reports whether the current visitor is an authenticated administrator.
 *
 * This exists so the home page can offer inline link controls **without
 * becoming a dynamic page**. The home page is statically generated and cached;
 * asking it to check the session during render would opt it out of caching for
 * every visitor. Instead a small client component calls this endpoint after
 * mount, so the cached HTML stays identical for everyone and the answer is
 * fetched per visitor.
 *
 * Security note: this only reports a boolean. It grants nothing. Every actual
 * mutation is authorised independently by `checkAdminRequest()` on
 * `/api/admin/fixture-streams`, so a forged response here would still not let a
 * visitor write anything — the UI merely decides whether to draw a button.
 *
 * The response is marked `no-store` so a CDN can never cache "isAdmin: true"
 * and serve it to the next visitor.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAdminUser();

  return Response.json(
    {
      isAdmin: Boolean(user),
      // The email is only ever returned for a verified admin, and only so the
      // inline editor can show who is signed in. Never a token or an id.
      email: user?.email ?? null,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}