import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Privacy-conscious visitor analytics primitives.
 *
 * Design constraints (see migration 011 for the storage side):
 *   * No IP address, name, email or fingerprint is ever persisted.
 *   * A visitor is identified only by a hash that ROTATES EVERY DAY, so the
 *     same person cannot be correlated across days from the stored data.
 *   * "Today" is the Asia/Riyadh calendar day, matching the site's existing
 *     match-day convention, so the dashboard's day boundary is unambiguous.
 *
 * These helpers are pure so they can be unit-tested without a database.
 */

/** The site's canonical day boundary. Matches the match-schedule convention. */
export const ANALYTICS_TIME_ZONE = "Asia/Riyadh";

/**
 * A stable, offset-free "YYYY-MM-DD" for the given instant in the analytics
 * timezone.
 *
 * `en-CA` is used because its short date format is already ISO-shaped
 * (`2026-10-14`), avoiding manual month/day assembly. `sv-SE` would work
 * identically; either is a well-known trick for a timezone-correct ISO date.
 */
export function analyticsDay(now: Date = new Date(), timeZone: string = ANALYTICS_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Derives the daily pseudonymous visitor id.
 *
 * The digest covers the day, the user-agent and a server-side secret salt. The
 * day is part of the input precisely so the identifier is not stable across
 * days. The salt means the hash cannot be recomputed by anyone who obtains a
 * copy of the table but not the server environment.
 *
 * `salt` falls back to a fixed development value so local runs work without
 * configuration; production must set `ANALYTICS_SALT` (documented in
 * `.env.example`). A missing production salt degrades privacy, not stability.
 */
export function visitorHash(parts: {
  day: string;
  userAgent: string;
  ip: string;
  salt?: string;
}): string {
  const salt = parts.salt ?? process.env.ANALYTICS_SALT ?? "me7gan-dev-salt";
  return createHash("sha256")
    .update(`${parts.day}|${parts.userAgent}|${parts.ip}|${salt}`)
    .digest("hex");
}

/**
 * Constant-time comparison for short identifiers.
 *
 * Used by tests and by any future admin-only verification path so that a
 * comparison cannot be timed to recover a value. Lengths are compared first
 * (not secret-dependent) because `timingSafeEqual` throws on a length mismatch.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Coarse bot / automated-client detection.
 *
 * This is a *reduction* filter, not a guarantee. It catches the well-known
 * crawlers and obvious scripted clients that would otherwise inflate the
 * numbers, while staying conservative: a false positive silently undercounts
 * a real visitor, so the patterns are limited to unambiguous bot markers.
 *
 * Limitations are reported in the admin UI rather than hidden — see the note
 * rendered under the statistics.
 */
const BOT_PATTERN =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|showyoubot|outbrain|pinterest|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|googlebot|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|pingdom|uptimerobot|curl|wget|python-requests|axios|go-http-client|java\/|okhttp|libwww|scrapy/i;

export function looksLikeBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true; // No UA at all: treat as non-human.
  return BOT_PATTERN.test(userAgent);
}

/**
 * Normalises a request path for storage: drops the query string and any hash,
 * collapses a trailing slash, and caps the length so a hostile client cannot
 * write an unbounded string.
 */
export function normalizePath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) return "/";
  // Only the path portion — never the query string, which could carry tokens.
  const withoutQuery = rawPath.split(/[?#]/)[0] || "/";
  const collapsed = withoutQuery.replace(/\/+$/, "") || "/";
  return collapsed.slice(0, 300);
}
