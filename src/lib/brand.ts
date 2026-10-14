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
   * `logo1.png` is the source artwork, but its visible lockup is a ~1.8:1
   * wordmark centred inside a padded square. `me7gan-logo.png` is that same
   * artwork cropped to its content, so it stays legible at header size instead
   * of being scaled down into a mostly-empty square.
   */
  logo: "/me7gan-logo.png",
  /**
   * Intrinsic pixel size of the logo file, used so `next/image` reserves the
   * correct box (no layout shift) and preserves the aspect ratio.
   *
   * The mark is a wide wordmark — 320 x 175 ≈ 1.83:1 — NOT square, so the
   * rendered box must stay proportional or the artwork will be stretched.
   *
   * The source is deliberately small: the logo renders at ≤80px wide, so a
   * 320px master is crisp even on 3x displays while keeping `next/image` from
   * offering a multi-thousand-pixel candidate for a 36px-tall image.
   */
  logoWidth: 320,
  logoHeight: 175,
  /**
   * Compact icon-only mark (ball + speed streaks + LIVE badge, no wordmark).
   * Square, on the light canvas, and legible down to favicon size where the
   * full wordmark would be an unreadable smudge.
   */
  icon: "/me7gan-live-icon.png",
  /** Intrinsic size of the icon mark (square). */
  iconWidth: 925,
  iconHeight: 390,
  /** Uniform height the header/footer render the wordmark at. */
  logoSize: 40,
} as const;
