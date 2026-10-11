"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, Home, Menu, Radio, X } from "lucide-react";
import { useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { BRAND } from "@/lib/brand";

/**
 * Premium RTL-aware header.
 *
 * Desktop: brand · primary nav · language + admin actions.
 * Mobile: brand · menu toggle, with a collapsible nav panel below.
 */
export default function SiteHeader() {
  const { locale, toggleLocale } = useLocale();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const nav = [
    { href: "/", label: locale === "ar" ? "الرئيسية" : "Home", icon: Home },
    { href: "/upcoming", label: locale === "ar" ? "المباريات" : "Matches", icon: CalendarDays },
    { href: "/live", label: locale === "ar" ? "مباشر الآن" : "Live", icon: Radio },
  ];

  return (
    <header className="site-header">
      <div className="page-width header-inner">
        <Link href="/" className="brand" aria-label={`${BRAND.ar} — الرئيسية`}>
          <Image
            className="brand-logo"
            src={BRAND.logo}
            alt={`${BRAND.ar} — ${BRAND.en}`}
            width={BRAND.logoWidth}
            height={BRAND.logoHeight}
            // Rendered at `BRAND.logoSize` px tall; the intrinsic ratio (1.83:1)
            // then makes it ~74px wide. The hint keeps next/image from serving
            // the full-resolution source into the header.
            sizes="80px"
            priority
          />
        </Link>

        <nav className="main-nav" aria-label={locale === "ar" ? "التنقل الرئيسي" : "Main navigation"}>
          {nav.map(({ href, label, icon: Icon }) => (
            <Link className={pathname === href ? "nav-link active" : "nav-link"} href={href} key={href}>
              <Icon size={16} aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="header-actions">
          <button
            className="header-action"
            type="button"
            onClick={toggleLocale}
            aria-label={locale === "ar" ? "التبديل إلى الإنجليزية" : "Switch to Arabic"}
          >
            <span className="header-action-label">{locale === "ar" ? "EN" : "عربي"}</span>
          </button>
          <button
            className="header-action menu-toggle"
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? "إغلاق القائمة" : "فتح القائمة"}
          >
            {menuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav className="mobile-nav" id="mobile-nav" aria-label={locale === "ar" ? "قائمة الجوال" : "Mobile navigation"}>
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              className={pathname === href ? "nav-link active" : "nav-link"}
              href={href}
              key={href}
              onClick={() => setMenuOpen(false)}
            >
              <Icon size={17} aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}