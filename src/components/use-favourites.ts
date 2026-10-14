"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { favouriteTeamId } from "@/lib/sports/match-filtering";

/**
 * Favourite teams, persisted in `localStorage`.
 *
 * Design notes:
 *
 * - **No server round trip and no account.** Favourites are a visitor
 *   convenience, not identity, so they are never sent to Supabase.
 * - **Read through `useSyncExternalStore`.** `localStorage` is an external
 *   store, and this hook subscribes to it properly: the server snapshot is a
 *   constant empty list, so the server HTML and the first client render agree
 *   and there is no hydration mismatch. Setting state in an effect would render
 *   twice and can cascade (which the lint rule correctly flags).
 * - **Stable identifiers.** Stored values are normalised team keys
 *   (`favouriteTeamId`), not display names, so renaming a club's display name
 *   keeps the favourite. If a club's canonical spelling changes such that its
 *   normalised key changes, the stored key simply stops matching and the team
 *   drops out of the favourites list — an outdated entry is inert, never fatal.
 * - **Bad data is survivable.** Anything that is not a JSON array of non-empty
 *   strings is treated as "no favourites".
 */
export const FAVOURITES_STORAGE_KEY = "me7gan-live:favourite-teams";

/** Custom event so a write in this tab notifies its own subscribers. */
const FAVOURITES_EVENT = "me7gan-live:favourites-changed";

/**
 * The server snapshot: a frozen empty array.
 *
 * A module-level constant (not a fresh literal) so its identity is stable,
 * which `useSyncExternalStore` requires to avoid an infinite render loop.
 */
const EMPTY: readonly string[] = Object.freeze([]);

/** Last raw value read, cached so the returned identity stays stable. */
let cachedRaw: string | null = null;
let cachedList: readonly string[] = EMPTY;

/** Reads and validates the stored favourites. Never throws. */
function readStored(): readonly string[] {
  if (typeof window === "undefined") return EMPTY;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(FAVOURITES_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies).
    return EMPTY;
  }

  // A stable reference for unchanged storage stops useSyncExternalStore from
  // re-rendering on every notification.
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;

  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    cachedList = Array.isArray(parsed)
      ? Object.freeze(
          parsed.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        )
      : EMPTY;
  } catch {
    // Corrupt JSON: treat as "no favourites" rather than throwing.
    cachedList = EMPTY;
  }
  return cachedList;
}

function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  // `storage` fires for other tabs, not this one, so the same-tab update is
  // dispatched explicitly by `writeStored`.
  window.addEventListener("storage", onChange);
  window.addEventListener(FAVOURITES_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(FAVOURITES_EVENT, onChange);
  };
}

function writeStored(ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable or full. Favourites then apply to this page
    // view only, which is a reasonable degradation.
  }
  window.dispatchEvent(new Event(FAVOURITES_EVENT));
}

export type FavouritesApi = {
  /** Normalised team ids. Empty on the server and during the first render. */
  favourites: Set<string>;
  isFavourite: (teamName: string) => boolean;
  toggleFavourite: (teamName: string) => void;
  clearFavourites: () => void;
};

export function useFavourites(): FavouritesApi {
  const ids = useSyncExternalStore(subscribe, readStored, () => EMPTY);

  const favouriteSet = useMemo(() => new Set(ids), [ids]);

  const toggleFavourite = useCallback((teamName: string) => {
    const id = favouriteTeamId(teamName);
    if (!id) return;
    const current = [...readStored()];
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    writeStored(next);
  }, []);

  const clearFavourites = useCallback(() => writeStored([]), []);

  const isFavourite = useCallback(
    (teamName: string) => favouriteSet.has(favouriteTeamId(teamName)),
    [favouriteSet],
  );

  return { favourites: favouriteSet, isFavourite, toggleFavourite, clearFavourites };
}
