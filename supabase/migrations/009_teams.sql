-- Persistent team identities and their logos.
--
-- Why a separate table
-- --------------------
-- Until now a team existed only as free text on `matches` (`home_team`,
-- `away_team`) with a logo URL copied onto every row. That means uploading a
-- club's badge once had no effect on any other fixture, and a CSV import had no
-- way to know which logo belonged to which name.
--
-- This table gives each club one durable identity:
--
--   * `team_key`  a normalised, accent- and punctuation-insensitive form of the
--                 canonical name (e.g. "fcbarcelona"), unique and stable.
--   * `name`      the canonical display name shown to visitors.
--   * `logo_url`  one logo per club, reused by every fixture that references it.
--
-- Name variations are handled by `team_aliases`, so "FC Barcelona",
-- "Barcelona" and "F.C. Barcelona" resolve to one club. Aliases are explicit
-- rather than fuzzy on purpose: guessing that two similar names are the same
-- club would silently merge distinct teams (e.g. "Manchester United" and
-- "Manchester City" must never collapse).
--
-- Nothing here touches `matches` or `fixture_streams`. Existing match rows keep
-- their own `home_team_logo` / `away_team_logo` columns; the application resolves
-- a team's logo at read time, so a single upload covers every past and future
-- fixture without rewriting history.

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  -- Normalised identity. Unique so one club cannot be created twice.
  team_key text not null unique
    check (length(btrim(team_key)) between 2 and 80),
  -- Canonical display name, as shown on the site.
  name text not null
    check (length(btrim(name)) between 1 and 120),
  -- Public URL of the club crest in Supabase Storage. Nullable: a team may be
  -- known before a logo exists, and an import must never blank a stored logo.
  logo_url text
    check (logo_url is null or logo_url ~ '^https://'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teams_team_key_idx on public.teams (team_key);

alter table public.teams enable row level security;

-- Team names and logos are public information: match cards show them to every
-- visitor, including anonymous ones.
drop policy if exists "teams are publicly readable" on public.teams;
create policy "teams are publicly readable"
  on public.teams for select to anon, authenticated
  using (true);

-- Only an administrator may create or change a team or its logo.
drop policy if exists "admins manage teams" on public.teams;
create policy "admins manage teams"
  on public.teams for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on public.teams to anon, authenticated;
grant insert, update, delete on public.teams to authenticated;

-- ── Aliases ─────────────────────────────────────────────────────────────────
-- Alternative spellings that must resolve to the same club. Kept in their own
-- table so a club can accumulate as many names as its sources use without
-- weakening the uniqueness of `teams.team_key`.

create table if not exists public.team_aliases (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  -- Normalised alias, unique across all teams: one alias cannot mean two clubs.
  alias_key text not null unique
    check (length(btrim(alias_key)) between 1 and 80),
  created_at timestamptz not null default now()
);

create index if not exists team_aliases_team_idx on public.team_aliases (team_id);

alter table public.team_aliases enable row level security;

drop policy if exists "team aliases are publicly readable" on public.team_aliases;
create policy "team aliases are publicly readable"
  on public.team_aliases for select to anon, authenticated
  using (true);

drop policy if exists "admins manage team aliases" on public.team_aliases;
create policy "admins manage team aliases"
  on public.team_aliases for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on public.team_aliases to anon, authenticated;
grant insert, update, delete on public.team_aliases to authenticated;

-- ── Storage ─────────────────────────────────────────────────────────────────
-- Reuses the existing public `event-media` bucket created in migration 001.
-- Team crests are stored under the `team-logos/` prefix; the bucket's existing
-- policies already allow public reads and administrator-only writes, so no new
-- bucket and no new policy are introduced.

comment on table public.teams is
  'Persistent team identities. One logo per club, resolved onto every fixture that uses the team.';
comment on table public.team_aliases is
  'Alternative spellings resolving to a team. Explicit, never fuzzy-guessed.';
