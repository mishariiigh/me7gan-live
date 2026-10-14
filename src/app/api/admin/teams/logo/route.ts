import { checkAdminRequest, logSupabaseError, recordAdminAudit } from "@/lib/api";
import { createSupabaseServerClient, getServerUser } from "@/lib/supabase/server";
import { normaliseTeamKey } from "@/lib/sports/team-identity";
import { revalidateFixtureData } from "@/lib/sports/revalidate";
import {
  ALLOWED_LOGO_TYPES,
  MAX_LOGO_BYTES,
  TEAM_LOGO_BUCKET,
  TEAM_LOGO_PREFIX,
  loadTeamLogoIndex,
  saveTeamLogo,
} from "@/lib/sports/team-logos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = { "cache-control": "private, no-store" };

/**
 * Saves a club logo once, so every fixture involving that club uses it.
 *
 * The uploaded file goes to the existing public `event-media` bucket under a
 * `team-logos/` prefix. The bucket's policies already restrict writes to
 * administrators, and this handler additionally requires an admin session
 * before touching Storage or the database.
 *
 * Only the team's own row is written. No `matches` or `fixture_streams` record
 * is read or modified, so kickoff times, scores, streams and broadcaster links
 * are untouched by a logo change.
 */
export async function POST(request: Request) {
  const access = await checkAdminRequest(request, "admin-team-logo", 20);
  if (access.response) return access.response;

  const client = await createSupabaseServerClient();
  if (!client) return Response.json({ error: "Database is not configured." }, { status: 503 });
  // See matches/route.ts: a dead session reads as signed out and its stale
  // cookies are cleared, rather than erroring on every request.
  const { user } = await getServerUser(client);
  if (!user) return Response.json({ error: "Administrator session expired." }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected a file upload." }, { status: 400 });
  }

  const teamName = typeof form.get("teamName") === "string" ? String(form.get("teamName")).trim() : "";
  if (!teamName) {
    return Response.json({ error: "اسم الفريق مطلوب (Team name is required)." }, { status: 400 });
  }
  if (!normaliseTeamKey(teamName)) {
    return Response.json({ error: "اسم فريق غير صالح (Invalid team name)." }, { status: 400 });
  }

  const file = form.get("file");
  const removeLogo = form.get("remove") === "true";

  // Removing a logo is an explicit, separate action. It is never implied by an
  // import or an empty field, so a logo cannot be lost by accident.
  if (removeLogo) {
    const { team, error } = await saveTeamLogo(client, {
      teamName,
      logoUrl: null,
      createdBy: user.id,
    });
    // saveTeamLogo only writes logo_url when a URL is supplied, so the explicit
    // removal is applied here.
    if (!error && team) {
      const { error: clearError } = await client
        .from("teams")
        .update({ logo_url: null, updated_at: new Date().toISOString() })
        .eq("id", team.id);
      if (clearError) {
        logSupabaseError("admin/teams/logo:clear", clearError, { team: team.team_key });
        return Response.json({ error: "تعذر إزالة الشعار (Could not remove the logo)." }, { status: 400 });
      }
    }
    if (error) return Response.json({ error }, { status: 400 });
    await recordAdminAudit("delete", "team_logo", team?.team_key, { team: teamName });
    revalidateFixtureData();
    return Response.json({ data: { teamName, logoUrl: null } }, { headers: privateHeaders });
  }

  if (!(file instanceof File)) {
    return Response.json({ error: "اختر ملف صورة (Choose an image file)." }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: "الملف فارغ (The file is empty)." }, { status: 400 });
  }
  if (file.size > MAX_LOGO_BYTES) {
    return Response.json(
      { error: `حجم الصورة يتجاوز ${Math.round(MAX_LOGO_BYTES / 1024 / 1024)} ميجابايت (Image is too large).` },
      { status: 413 },
    );
  }
  // Content type is validated against an allow-list; an SVG is deliberately not
  // accepted because it can carry script.
  const extension = ALLOWED_LOGO_TYPES.get(file.type);
  if (!extension) {
    return Response.json(
      { error: "صيغة الصورة غير مدعومة. استخدم PNG أو JPEG أو WebP أو AVIF (Unsupported image type)." },
      { status: 400 },
    );
  }

  // A stable, collision-free object name: the normalised club key plus a short
  // random suffix, so replacing a logo never overwrites another club's file and
  // the CDN does not serve a stale cached image at the same URL.
  const key = normaliseTeamKey(teamName);
  const objectPath = `${TEAM_LOGO_PREFIX}/${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  const bytes = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await client.storage
    .from(TEAM_LOGO_BUCKET)
    .upload(objectPath, bytes, { contentType: file.type, upsert: false });
  if (uploadError) {
    logSupabaseError("admin/teams/logo:upload", uploadError, { bucket: TEAM_LOGO_BUCKET, objectPath });
    return Response.json({ error: "تعذر رفع الصورة (Could not upload the image)." }, { status: 400 });
  }

  const { data: publicUrl } = client.storage.from(TEAM_LOGO_BUCKET).getPublicUrl(objectPath);
  const logoUrl = publicUrl.publicUrl;

  const { team, error } = await saveTeamLogo(client, {
    teamName,
    logoUrl,
    createdBy: user.id,
  });
  if (error || !team) {
    return Response.json({ error: error ?? "تعذر حفظ الشعار (Could not save the logo)." }, { status: 400 });
  }

  await recordAdminAudit("update", "team_logo", team.team_key, { team: team.name, logoUrl });
  // A club's crest is resolved onto every fixture at read time, so a single
  // upload changes many public pages at once.
  revalidateFixtureData();

  // The caller gets the refreshed index so the UI can show the effect without a
  // second round trip.
  const index = await loadTeamLogoIndex(client);
  return Response.json(
    {
      data: {
        team: { key: team.team_key, name: team.name, logoUrl: team.logo_url },
        // How many distinct clubs currently have a logo, for the admin summary.
        teamsWithLogos: index.size,
      },
    },
    { headers: privateHeaders },
  );
}

/** Lists clubs and their logos, for the admin panel. */
export async function GET(request: Request) {
  const access = await checkAdminRequest(request, "admin-team-logo-read");
  if (access.response) return access.response;
  const client = await createSupabaseServerClient();
  if (!client) return Response.json({ error: "Database is not configured." }, { status: 503 });

  const { data, error } = await client
    .from("teams")
    .select("id, team_key, name, logo_url, updated_at")
    .order("name", { ascending: true })
    .range(0, 499);
  if (error) {
    logSupabaseError("admin/teams/logo:list", error);
    return Response.json({ error: "Could not load teams." }, { status: 500 });
  }
  return Response.json({ data }, { headers: privateHeaders });
}
