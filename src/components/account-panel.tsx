"use client";

import { useRouter } from "next/navigation";
import { LogOut, UserRound } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function AccountPanel({ email }: { email: string | null }) {
  const router = useRouter();

  async function signOut() {
    const client = createSupabaseBrowserClient();
    await client?.auth.signOut();
    router.replace("/admin");
    router.refresh();
  }

  return (
    <main className="account-page page-width">
      <span className="eyebrow">ME7GAN-LIVE / ACCOUNT</span>
      <div className="account-summary"><span className="account-avatar"><UserRound size={23} /></span><div><h1>{email ? "حسابك" : "أهلاً بك"}</h1><p>{email ?? "سجّل الدخول للوصول إلى حسابك."}</p></div></div>
      <div className="account-row"><span>الفعاليات المحفوظة</span><strong>يمكنك حفظ فعالياتك بعد تسجيل الدخول</strong></div>
      {email ? <button className="secondary-action" onClick={signOut}><LogOut size={16} />تسجيل الخروج</button> : null}
    </main>
  );
}