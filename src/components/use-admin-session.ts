"use client";

import { useEffect, useState } from "react";

/**
 * Whether the current visitor is a signed-in administrator.
 *
 * The check is made by the server (`/api/admin/session`), which resolves the
 * Supabase session and reads `profiles.role`. Nothing is read from
 * `localStorage` and no client-side flag is trusted — a visitor cannot make
 * these controls appear by editing browser storage.
 *
 * The hook starts as `false` and only ever turns true after the server confirms
 * it, so the controls are never briefly shown to a regular visitor. Server HTML
 * and the first client render agree on "not an admin", which avoids a hydration
 * mismatch on the cached home page.
 *
 * This is a *presentation* concern only. Every write is authorised again on the
 * server by `checkAdminRequest()`, so the hook being wrong in either direction
 * cannot grant access.
 */
export type AdminSession = {
  /** True only once the server has confirmed an admin session. */
  isAdmin: boolean;
  /** False until the check has completed, so the UI can avoid a flash. */
  ready: boolean;
};

export function useAdminSession(): AdminSession {
  const [state, setState] = useState<AdminSession>({ isAdmin: false, ready: false });

  useEffect(() => {
    // `AbortController` so a navigation away mid-request does not set state on
    // an unmounted component.
    const controller = new AbortController();

    fetch("/api/admin/session", {
      headers: { accept: "application/json" },
      // Always hit the server: the answer depends on the session cookie, and a
      // cached "false" would hide the controls from a real admin.
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return { isAdmin: false };
        return (await res.json()) as { isAdmin?: boolean };
      })
      .then((body) => setState({ isAdmin: Boolean(body.isAdmin), ready: true }))
      .catch((error: unknown) => {
        // An aborted request is expected on unmount, not a failure worth
        // reporting. Anything else simply means "not an admin" for the UI.
        if (error instanceof Error && error.name === "AbortError") return;
        setState({ isAdmin: false, ready: true });
      });

    return () => controller.abort();
  }, []);

  return state;
}