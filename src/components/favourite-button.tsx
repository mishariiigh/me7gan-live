"use client";

import { Star } from "lucide-react";
import { useLocale } from "@/components/locale-provider";

/**
 * Toggles a team in the visitor's favourites.
 *
 * Rendered as a real `<button>` with `aria-pressed`, so assistive technology
 * announces the state rather than just the icon. `stopPropagation` and
 * `preventDefault` keep the click from activating the surrounding match-card
 * link, which would otherwise navigate to the fixture.
 *
 * `ready` is false until `localStorage` has been read on the client. Until then
 * the control renders in its default (unselected) state, which is what the
 * server rendered too — no hydration mismatch.
 */
export default function FavouriteButton({
  teamName,
  active,
  onToggle,
  className = "",
}: {
  teamName: string;
  active: boolean;
  onToggle: (teamName: string) => void;
  className?: string;
}) {
  const { locale } = useLocale();
  const isArabic = locale === "ar";
  const label = active
    ? isArabic ? `إزالة ${teamName} من المفضلة` : `Remove ${teamName} from favourites`
    : isArabic ? `إضافة ${teamName} إلى المفضلة` : `Add ${teamName} to favourites`;

  return (
    <button
      type="button"
      className={`favourite-toggle ${active ? "active" : ""} ${className}`.trim()}
      aria-pressed={active}
      aria-label={label}
      title={label}
      // Keep the surrounding card link from firing.
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(teamName);
      }}
      // The click is a no-op while storage is still being read on the first
      // render, which is momentary and preferable to a disabled control that
      // screen readers would skip.
    >
      <Star size={14} aria-hidden="true" fill={active ? "currentColor" : "none"} />
    </button>
  );
}
