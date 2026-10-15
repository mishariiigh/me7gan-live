/**
 * Brand identity, in one place.
 *
 * Changing the site name should only require editing this file.
 * These are display strings only — no database table, Supabase object,
 * environment variable or API route is named after the brand.
 */
export const BRAND = {
  /** Primary visible brand, Arabic. */
  ar: "محقان لايف",
  /** English / latin brand. */
  en: "me7gan-live",
  /** Short mark used in the compact logo tile. */
  mark: "مح",
  /** Tagline shown under the brand in the footer. */
  tagline: "منصة لمتابعة المباريات والبثوث المتاحة.",
  /**
   * Brand logo, served from /public.
   *
   * `logo1.png` is the source artwork. `me7gan-logo.png` is that artwork
   * cropped to its content with an even margin, so it stays legible at header
   * size instead of being scaled down into a mostly-empty square.
   */
  logo: "/me7gan-logo.png",
  /**
   * Intrinsic pixel size of the logo file, used so `next/image` reserves the
   * correct box (no layout shift) and preserves the aspect ratio.
   *
   * The mark is a wide wordmark — 1096 x 618 ≈ 1.77:1 — NOT square, so the
   * rendered box must stay proportional or the artwork will be stretched.
   */
  logoWidth: 1096,
  logoHeight: 618,
  /**
   * Compact icon-only mark (ball + speed streaks + LIVE badge, no wordmark).
   * Square, on the light canvas, and legible down to favicon size where the
   * full wordmark would be an unreadable smudge.
   */
  icon: "/me7gan-live-icon.png",
  /**
   * Intrinsic size of the icon mark — a square 512 x 512 canvas with the mark
   * padded on the light background. The same artwork is mirrored to
   * `icon-192.png`, `icon-512.png`, `apple-icon.png` and the favicons.
   */
  iconWidth: 512,
  iconHeight: 512,
  /** Uniform height the header/footer render the wordmark at. */
  logoSize: 40,
} as const;
