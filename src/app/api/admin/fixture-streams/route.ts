import { checkAdminRequest, logSupabaseError, recordAdminAudit } from "@/lib/api";
import { createSupabaseServerClient, getServerUser } from "@/lib/supabase/server";
import { revalidateMatch } from "@/lib/sports/revalidate";
import { fixtureStreamDeleteInput, fixtureStreamInput, fixtureStreamUpdateInput } from "@/lib/validation";

const privateHeaders = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  const access = await checkAdminRequest(request, "admin-fixture-streams-read");
  if (access.response) return access.response;
  const client = await createSupabaseServerClient();
  if (!client) return Response.json({ error: "Database is not configured." }, { status: 503 });

  const { data, error } = await client.from("fixture_streams").select("*")
    .order("fixture_id", { ascending: true })
    .order("priority", { ascending: false })
    .range(0, 199);
  if (error) {
    logSupabaseError("admin/fixture-streams:list", error);
    return Response.json({ error: "Could not load fixture streams." }, { status: 500 });
  }
  return Response.json({ data }, { headers: privateHeaders });
}

export async function POST(request: Request) {
  const access = await checkAdminRequest(request, "admin-fixture-streams-write", 30);
  if (access.response) return access.response;
  const parsed = fixtureStreamInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid fixture stream configuration.", details: parsed.error.flatten() }, { status: 400 });

  const client = await createSupabaseServerClient();
  if (!client) return Response.json({ error: "Database is not configured." }, { status: 503 });
  // See matches/route.ts: a dead session reads as signed out and its stale
  // cookies are cleared, rather than erroring on every request.
  const { user } = await getServerUser(client);
  if (!user) return Response.json({ error: "Administrator session expired." }, { status: 401 });

  const { data, error } = await client.from("fixture_streams")
    .insert({ ...parsed.data, created_by: user.id })
    .select("*")
    .single();
  if (error) {
    logSupabaseError("admin/fixture-streams:create", error, {
      fixture_id: parsed.data.fixture_id,
      stream_type: parsed.data.stream_type,
      stream_url: parsed.data.stream_url,
      provider_name: parsed.data.provider_name,
      priority: parsed.data.priority,
      active: parsed.data.active,
    });
    return Response.json({ error: "Could not save fixture stream." }, { status: 400 });
  }
  await recordAdminAudit("create", "fixture_stream", data.id, { fixture_id: data.fixture_id, provider: data.provider_name, stream_type: data.stream_type });
  // A new broadcaster link changes what appears on the public match page and can
  // change whether a fixture counts as "on air", so the public cache is dropped.
  revalidateMatch(parsed.data.fixture_id);
  return Response.json({ data }, { status: 201, headers: privateHeaders });
}

export async function PATCH(request: Request) {
  const access = await checkAdminRequest(request, "admin-fixture-streams-write", 30);
  if (access.response) return access.response;
  const parsed = fixtureStreamUpdateInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid fixture stream update." }, { status: 400 });

  const client = await createSupabaseServerClient();
  if (!client) return Response.json({ error: "Database is not configured." }, { status: 503 });
  const { id, ...updates } = parsed.data;
  const { data, error } = await client.from("fixture_streams")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    // The real PostgREST error is logged here. Without this the only signal was
    // the generic message below, which hid constraint and RLS failures.
    logSupabaseError("admin/fixture-streams:update", error, {
      id,
      // The attempted values, so the failed write can be reproduced.
      attempted_stream_type: updates.stream_type ?? "(unchanged)",
      attempted_stream_url: updates.stream_url ?? "(unchanged)",
      attempted_fixture_id: updates.fixture_id ?? "(unchanged)",
      attempted_provider_name: updates.provider_name ?? "(unchanged)",
      attempted_priority: updates.priority ?? "(unchanged)",
      attempted_active: updates.active ?? "(unchanged)",
      update_keys: Object.keys(updates),
    });
    return Response.json({ error: "Could not update fixture stream." }, { status: 400 });
  }
  if (!data) return Response.json({ error: "Fixture stream not found." }, { status: 404 });
  await recordAdminAudit("update", "fixture_stream", id, updates);
  revalidateMatch(data.fixture_id);
  return Response.json({ data }, { headers: privateHeaders });
}

export async function DELETE(request: Request) {
  const access = await checkAdminRequest(request, "admin-fixture-streams-write", 30);
  if (access.response) return access.response;
  const parsed = fixtureStreamDeleteInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid fixture stream ID." }, { status: 400 });

  const client = await createSupabaseServerClient();
  if (!client) return Response.json({ error: "Database is not configured." }, { status: 503 });
  const { data, error } = await client
    .from("fixture_streams")
    .delete()
    .eq("id", parsed.data.id)
    // `fixture_id` is selected so the affected match page can be invalidated
    // after the delete; without it we would not know which page to refresh.
    .select("id, fixture_id")
    .maybeSingle();
  if (error) {
    logSupabaseError("admin/fixture-streams:delete", error, { id: parsed.data.id });
    return Response.json({ error: "Could not delete fixture stream." }, { status: 400 });
  }
  if (!data) return Response.json({ error: "Fixture stream not found." }, { status: 404 });
  await recordAdminAudit("delete", "fixture_stream", data.id);
  revalidateMatch((data as { fixture_id: string }).fixture_id);
  return Response.json({ success: true }, { headers: privateHeaders });
}