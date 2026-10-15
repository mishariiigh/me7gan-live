import type { Metadata } from "next";
import AdminAnalyticsPanel from "@/components/admin-analytics-panel";
import AdminMatchManager from "@/components/admin-match-manager";
import AuthForm from "@/components/auth-form";
import { getAdminUser } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "إدارة المباريات", robots: { index: false, follow: false } };

export default async function AdminHome() {
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!configured) return <AuthForm />;
  if (!(await getAdminUser())) return <AuthForm />;
  return (
    <>
      <AdminAnalyticsPanel />
      <AdminMatchManager />
    </>
  );
}