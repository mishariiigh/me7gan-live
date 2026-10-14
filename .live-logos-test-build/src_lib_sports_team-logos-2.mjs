import { createSupabaseServerClient } from "data:text/javascript,let c=globalThis.__FAKE_DB__;export async function createSupabaseServerClient(){return c?c():null}export function createPublicSupabaseClient(){return c?c():null}";
import { candidateKeys, normaliseTeamKey } from "file:///Users/M10/Desktop/developer/LiveStreamWebsite/.live-logos-test-build/src_lib_sports_team-identity-2.mjs";
/** Bucket created in migration 001; crests live under the `team-logos/` prefix. */
export const TEAM_LOGO_BUCKET = "event-media";
export const TEAM_LOGO_PREFIX = "team-logos";
/** Accepted image types and the size ceiling, enforced server-side. */
export const ALLOWED_LOGO_TYPES = new Map([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["image/avif", "avif"],
]);
export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB
export async function loadTeamLogoIndex(client) {
    const supabase = client ?? (await createSupabaseServerClient());
    if (!supabase)
        return new Map();
    const { data, error } = await supabase
        .from("teams")
        .select("team_key, logo_url")
        .not("logo_url", "is", null)
        .range(0, 1999);
    // A missing table (migration not applied) must not break the public site: a
    // match simply renders without a crest, exactly as it did before.
    if (error || !data)
        return new Map();
    return new Map(data
        .filter((row) => row.logo_url)
        .map((row) => [row.team_key, row.logo_url]));
}
/** Looks up a club's logo by any spelling of its name. */
export function lookupTeamLogo(index, teamName) {
    for (const key of candidateKeys(teamName)) {
        const found = index.get(key);
        if (found)
            return found;
    }
    return null;
}
/**
 * Overlays stored team logos onto a match's team fields.
 *
 * Precedence is deliberate:
 *  1. A logo saved against the club (the durable, reusable one).
 *  2. The logo already on the match row (set manually, or from an older match).
 *
 * A stored club logo therefore wins, which is what makes "replace the logo and
 * every fixture updates" true. A blank is never written over an existing value.
 */
export function applyTeamLogos(match, index) {
    if (index.size === 0)
        return match;
    const homeLogo = lookupTeamLogo(index, match.home.name) ?? match.home.logo;
    const awayLogo = lookupTeamLogo(index, match.away.name) ?? match.away.logo;
    if (homeLogo === match.home.logo && awayLogo === match.away.logo)
        return match;
    return {
        ...match,
        home: { ...match.home, logo: homeLogo },
        away: { ...match.away, logo: awayLogo },
    };
}
/** Resolves a stored club's logo for a raw team name, at import time. */
export async function resolveTeamLogo(client, teamName) {
    const keys = candidateKeys(teamName);
    if (keys.length === 0)
        return null;
    const { data, error } = await client
        .from("teams")
        .select("team_key, logo_url")
        .in("team_key", keys)
        .not("logo_url", "is", null)
        .limit(1);
    if (error || !data || data.length === 0)
        return null;
    return data[0].logo_url;
}
/**
 * Records or updates a club's logo.
 *
 * Creates the team when it is new, and registers the supplied spelling as an
 * alias so future imports resolve to the same club. An existing logo is only
 * replaced when a new one is actually supplied — never blanked.
 */
export async function saveTeamLogo(client, input) {
    const name = input.teamName.trim();
    const key = normaliseTeamKey(name);
    if (!key)
        return { team: null, error: "Team name is required." };
    // Find an existing club by any spelling, so "Barcelona" updates FC Barcelona
    // rather than creating a second club with the same badge.
    const keys = candidateKeys(name);
    const { data: existing, error: findError } = await client
        .from("teams")
        .select("id, team_key, name, logo_url")
        .in("team_key", keys)
        .limit(1);
    if (findError)
        return { team: null, error: "Could not look up the team." };
    const found = existing?.[0] ?? null;
    if (!found) {
        const { data: created, error: createError } = await client
            .from("teams")
            .insert({
            team_key: key,
            name,
            logo_url: input.logoUrl ?? null,
            created_by: input.createdBy ?? null,
        })
            .select("id, team_key, name, logo_url")
            .single();
        if (createError || !created)
            return { team: null, error: "Could not create the team." };
        await recordAliases(client, created.id, [name, input.aliasFrom]);
        return { team: created, error: null };
    }
    // Only touch logo_url when a new URL is genuinely supplied.
    const patch = { updated_at: new Date().toISOString() };
    if (input.logoUrl)
        patch.logo_url = input.logoUrl;
    const { data: updated, error: updateError } = await client
        .from("teams")
        .update(patch)
        .eq("id", found.id)
        .select("id, team_key, name, logo_url")
        .single();
    if (updateError || !updated)
        return { team: null, error: "Could not update the team." };
    await recordAliases(client, found.id, [name, input.aliasFrom]);
    return { team: updated, error: null };
}
/** Registers spellings as aliases of a team. Failures are non-fatal. */
async function recordAliases(client, teamId, names) {
    const rows = [];
    for (const name of names) {
        if (!name)
            continue;
        for (const key of candidateKeys(name)) {
            // Skip the canonical key itself: it already identifies the team.
            rows.push({ team_id: teamId, alias_key: key });
        }
    }
    if (rows.length === 0)
        return;
    const unique = new Map(rows.map((row) => [row.alias_key, row]));
    const { error } = await client
        .from("team_aliases")
        // Aliases are shared across teams, so an existing row for the same spelling
        // is left alone rather than moved to another club.
        .upsert([...unique.values()], { onConflict: "alias_key", ignoreDuplicates: true });
    if (error) {
        console.error("[team-logos] alias upsert failed", { code: error.code, message: error.message });
    }
}
