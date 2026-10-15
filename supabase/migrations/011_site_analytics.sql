-- Private, privacy-conscious visitor analytics for the admin dashboard.
--
-- NOT APPLIED AUTOMATICALLY. This file is written for review; it is not run by
-- the app. Apply it manually (Supabase SQL editor or `supabase db push`) when
-- you have approved it. Until it exists, the analytics endpoints fail safe:
-- `/api/analytics/collect` returns 503 and the website renders normally.
--
-- What is stored
-- --------------
-- One row per (visitor, day, path). A "visitor" is a *pseudonymous* daily hash:
--
--   sha256( YYYY-MM-DD-in-Asia/Riyadh || user-agent || secret-salt )
--
-- The raw inputs are never persisted. In particular NO IP address is stored —
-- the IP is used only in-memory, for the rate limiter and for the daily hash
-- input, and is discarded. The salt lives in the server environment
-- (`ANALYTICS_SALT`) so hashes cannot be recomputed from the table alone.
--
-- The hash rotates every Riyadh day, so a visitor is countable as "unique" per
-- day without being trackable across days. This is the standard approach
-- (Plausible/Umami use the same idea): it cannot distinguish two people who
-- share an identical IP *and* user-agent on the same day, and it cannot follow
-- anyone beyond a single day. Those limits are stated in the admin UI.
--
-- Counting rules enforced by the table shape
-- ------------------------------------------
--   * unique visitors today = count(distinct visitor_hash) where visited_on = today
--   * page views today      = count(*)                  where visited_on = today
--   * "online now"          = distinct visitor_hash with a `last_seen_at`
--                             inside the recent window
-- The unique index below is what makes "count a visitor only once per day"
-- true at the database level, independent of any application logic.

create table if not exists public.site_visits (
  id uuid primary key default gen_random_uuid(),
  -- Daily, rotating pseudonym. Never reversible to a person.
  visitor_hash text not null,
  -- The calendar day in Asia/Riyadh when the visit happened. Stored as a date
  -- so "today" is unambiguous and cheap to filter/index.
  visited_on date not null,
  -- Request path only (no query string), truncated for storage safety.
  path text not null default '/',
  -- Whether the request carried a valid administrator session. Admin traffic is
  -- excluded from visitor counts in the stats endpoint, but recorded so the
  -- exclusion is auditable rather than silent.
  is_admin boolean not null default false,
  -- First and most recent sighting of this visitor on this day. `last_seen_at`
  -- drives the "online now" figure.
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Number of page views by this visitor on this day, for this path.
  view_count integer not null default 1 check (view_count > 0)
);

-- One row per visitor per day per path. Re-visits UPDATE this row instead of
-- inserting a new one, which is what prevents refresh/navigation double-counts.
create unique index if not exists site_visits_unique_daily_visit
  on public.site_visits (visitor_hash, visited_on, path);

-- Serves the dashboard's "today" queries (visitors, page views, online).
create index if not exists site_visits_day_idx
  on public.site_visits (visited_on, last_seen_at desc);

-- Row Level Security
-- ------------------
-- Deny-by-default: no policy grants SELECT to `anon`, so a public visitor can
-- never read analytics — even with the anon key in hand. Writes happen only
-- from the server route handler, which uses the service-role key and therefore
-- bypasses RLS. Reads happen only from the admin-gated API, also server-side.
--
-- This means the browser never needs any analytics privilege at all.
alter table public.site_visits enable row level security;

-- Belt and braces: even if a future policy is added carelessly, revoke the
-- implicit grants from the public roles so the table stays admin-only.
revoke all on public.site_visits from anon, authenticated;

-- Ingestion RPC
-- -------------
-- The collect route calls this instead of doing read-then-write from the app.
-- Doing the increment in a single statement is what makes concurrent beacons
-- from the same visitor correct: a naive SELECT + INSERT/UPDATE would race and
-- either insert a duplicate row or lose an increment.
--
--   * `on conflict ... do update` targets the unique daily index, so a refresh
--     bumps `view_count` on the existing row rather than creating a second one.
--   * `last_seen_at = now()` on every call keeps the "online now" window fresh.
--   * `first_seen_at` is deliberately NOT updated, so it stays the true first
--     sighting of the visitor that day.
--
-- SECURITY DEFINER is required because the table has RLS with no policies and
-- the public roles have no grants. The function runs as its owner (postgres),
-- which bypasses RLS — so the *only* way to write a visit is through this
-- function, and its arguments are the only writable values. `search_path` is
-- pinned to prevent a caller from shadowing `public` objects.
create or replace function public.record_site_visit(
  p_visitor_hash text,
  p_visited_on date,
  p_path text,
  p_is_admin boolean default false
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.site_visits (visitor_hash, visited_on, path, is_admin)
  values (p_visitor_hash, p_visited_on, p_path, coalesce(p_is_admin, false))
  on conflict (visitor_hash, visited_on, path)
  do update set
    view_count = public.site_visits.view_count + 1,
    last_seen_at = now(),
    -- An admin flag only ever turns on; a later anonymous request from the same
    -- session must not clear it.
    is_admin = public.site_visits.is_admin or excluded.is_admin;
$$;

-- Execute is granted to nobody but the owner: only the service-role key (which
-- connects as the owner/authenticator) may call it. Revoke the default PUBLIC
-- execute so the anon and authenticated roles cannot increment counts.
revoke all on function public.record_site_visit(text, date, text, boolean) from public, anon, authenticated;
