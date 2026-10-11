import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient, getServerUser } from "@/lib/supabase/server";

export async function getAdminUser(): Promise<User | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  // `getServerUser` maps a stale/dead session to `user: null` (clearing the
  // leftover cookies) so a revoked session reads as "not signed in" instead of
  // throwing on every render. Authorisation below is unchanged: a user must
  // still exist AND carry the `admin` role in `profiles`.
  const { user } = await getServerUser(supabase);
  if (!user) return null;
  const { data: profile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profileError || profile?.role !== "admin") return null;
  return user;
}

export async function requireAdminResponse() {
  const user = await getAdminUser();
  return user ? null : Response.json({ error: "Administrator access required" }, { status: 403 });
}