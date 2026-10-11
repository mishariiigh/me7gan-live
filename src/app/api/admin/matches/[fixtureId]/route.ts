import { checkAdminRequest, recordAdminAudit } from "@/lib/api";
import { createSupabaseServerClient, getServerUser } from "@/lib/supabase/server";
import { matchUpdateInput } from "@/lib/validation";
import { isCompetition } from "@/lib/sports/competitions";

const privateHeaders = { "cache-control": "private, no-store" };

type RouteContext = { params: Promise<{ fixtureId: string }> };

/** Updates a match. `?duplicate=1` clones it onto a new fixture ID instead. */
export async function PATCH(request: Request, context: RouteContext) {
  const access = await checkAdminRequest(request, "admin-matches-write", 30);
  if (access.response) return access.response;

  const { fixtureId } = await context.params;
  const duplicate = new URL(request.url).searchParams.get("duplicate") === "1";

  const parsed = matchUpdateInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid match update.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.competition !== undefined && !isCompetition(parsed.data.competition)) {
    return Response.json({ error: "Choose one of the supported competitions." }, { status: 400 });
  }

  const client = await createSupabaseServerClient();
  if (!client) return Response.json({ error: "Database is not configured." }, { status: 503 });
  // See matches/route.ts: a dead session reads as signed out and its stale
  // cookies are cleared, rather than erroring on every request.
  const { user } = await getServerUser(client);
  if (!user) return Response.json({ error: "Administrator session expired." }, { status: 401 });

  if (duplicate) {
    const { data: source, error: readError } = await client
      .from("matches")
      .select("*")
      .eq("fixture_id", fixtureId)
      .maybeSingle();
    if (readError || !source) return Response.json({ error: "Match not found." }, { status: 404 });

    const targetDate = parsed.data.match_date ?? source.match_date;
    const { data: newFixtureId, error: idError } = await client
      .rpc("generate_match_fixture_id", { target_date: targetDate });
    if (idError || !newFixtureId) {
      return Response.json({ error: "Could not generate a fixture ID." }, { status: 500 });
    }

    const { data, error } = await client
      .from("matches")
      .insert({
        ...parsed.data,
        fixture_id: newFixtureId,
        match_date: targetDate,
        kickoff_time: parsed.data.kickoff_time ?? source.kickoff_time,
        competition: parsed.data.competition ?? source.competition,
        home_team: parsed.data.home_team ?? source.home_team,
        away_team: parsed.data.away_team ?? source.away_team,
        home_team_logo: parsed.data.home_team_logo ?? source.home_team_logo,
        away_team_logo: parsed.data.away_team_logo ?? source.away_team_logo,
        published: parsed.data.published ?? false,
        created_by: user.id,
      })
      .select("*")
      .single();
    if (error) return Response.json({ error: "Could not duplicate the match." }, { status: 400 });

    await recordAdminAudit("duplicate", "match", data.fixture_id, { source_fixture_id: fixtureId });
    return Response.json({ data }, { status: 201, headers: privateHeaders });
  }

  const { data, error } = await client
    .from("matches")
    .update(parsed.data)
    .eq("fixture_id", fixtureId)
    .select("*")
    .maybeSingle();
  if (error) return Response.json({ error: "Could not update the match." }, { status: 400 });
  if (!data) return Response.json({ error: "Match not found." }, { status: 404 });

  await recordAdminAudit("update", "match", fixtureId, parsed.data);
  return Response.json({ data }, { headers: privateHeaders });
}

/** Deletes a match. Its stream sources are not reachable once it is gone. */
export async function DELETE(request: Request, context: RouteContext) {
  const access = await checkAdminRequest(request, "admin-matches-write", 30);
  if (access.response) return access.response;

  const { fixtureId } = await context.params;
  const client = await createSupabaseServerClient();
  if (!client) return Response.json({ error: "Database is not configured." }, { status: 503 });

  const { data, error } = await client
    .from("matches")
    .delete()
    .eq("fixture_id", fixtureId)
    .select("fixture_id")
    .maybeSingle();
  if (error) return Response.json({ error: "Could not delete the match." }, { status: 400 });
  if (!data) return Response.json({ error: "Match not found." }, { status: 404 });

  await recordAdminAudit("delete", "match", fixtureId);
  return Response.json({ success: true }, { headers: privateHeaders });
}