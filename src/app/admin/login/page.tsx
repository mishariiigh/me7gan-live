import type { Metadata } from "next";
import AuthForm from "@/components/auth-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "دخول الإدارة", robots: { index: false, follow: false } };

/**
 * Admin sign-in page.
 *
 * This route previously redirected straight to `/admin`. That was harmless while
 * `/admin` rendered the sign-in form itself, but it becomes an infinite loop now
 * that `proxy.ts` sends an unauthenticated visitor here: `/admin` ->
 * `/admin/login` -> `/admin` -> ... The form is therefore rendered here, which
 * is where the proxy expects a session to be established.
 *
 * A visitor who already holds a session never reaches this page: the proxy
 * redirects them on to the console.
 */
export default function AdminLoginPage() {
  return <AuthForm />;
}