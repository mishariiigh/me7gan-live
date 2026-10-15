import type { Metadata, Viewport } from "next";
import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import AnalyticsBeacon from "@/components/analytics-beacon";
import { LocaleProvider } from "@/components/locale-provider";
import SiteHeader from "@/components/site-header";
import { BRAND } from "@/lib/brand";
import "./globals.css";
import "./platform.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      "https://me7gan-live.vercel.app"
  ),
  title: {
    default: `${BRAND.ar} | ${BRAND.en}`,
    template: `%s | ${BRAND.ar}`,
  },
  description:
    "محقان لايف منصة لمتابعة مباريات كرة القدم وجدولها والبثوث المتاحة لكل مباراة.",
  applicationName: BRAND.ar,
  icons: {
    icon: [
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [
      { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  openGraph: {
    type: "website",
    siteName: `${BRAND.ar} · ${BRAND.en}`,
    locale: "ar_SA",
    title: `${BRAND.ar} | ${BRAND.en}`,
    description: "جدول مباريات كرة القدم والبثوث المتاحة لكل مباراة.",
    images: [
      {
        url: "/icon-512.png",
        width: 512,
        height: 512,
        alt: `${BRAND.ar} — ${BRAND.en}`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${BRAND.ar} | ${BRAND.en}`,
    description: "جدول مباريات كرة القدم والبثوث المتاحة لكل مباراة.",
    images: ["/icon-512.png"],
  },
  alternates: { canonical: "/" },
  other: {
    "google-adsense-account": "ca-pub-1543283177172409",
  },
};

/** Browser UI color, matched to the light brand canvas. */
export const viewport: Viewport = {
  themeColor: "#f8fbff",
  colorScheme: "light",
};

/** Google AdSense publisher ID. */
const ADSENSE_CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT ?? "";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl" className="min-h-full">
      <body className="min-h-full antialiased">
        {/* Google AdSense */}
        {ADSENSE_CLIENT && (
          <Script
            id="adsbygoogle-loader"
            async
            strategy="afterInteractive"
            crossOrigin="anonymous"
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
          />
        )}

        {/* Monetag advertising zone */}
        <Script
          id="monetag-advertising"
          src="https://quge5.com/88/tag.min.js"
          data-zone="296298"
          async
          data-cfasync="false"
          strategy="afterInteractive"
        />

        <LocaleProvider>
          <AnalyticsBeacon />
          <a className="sr-only" href="#main-content">
            تخط إلى المحتوى الرئيسي
          </a>
          <SiteHeader />
          {children}

          <footer className="site-footer">
            <div className="page-width footer-inner">
              <div className="footer-brand">
                <Image
                  className="footer-logo"
                  src={BRAND.logo}
                  alt={`${BRAND.ar} — ${BRAND.en}`}
                  width={BRAND.logoWidth}
                  height={BRAND.logoHeight}
                  sizes="112px"
                />
                <strong>{BRAND.ar}</strong>
                <span>منصة لمتابعة المباريات والبثوث المتاحة.</span>
              </div>

              <nav className="footer-nav" aria-label="روابط التذييل">
                <Link href="/">الرئيسية</Link>
                <Link href="/upcoming">المباريات</Link>
                <Link href="/live">مباشر الآن</Link>
              </nav>

              <span className="footer-meta" dir="ltr">
                © 2026 {BRAND.en}
              </span>
            </div>
          </footer>
        </LocaleProvider>
      </body>
    </html>
  );
}
