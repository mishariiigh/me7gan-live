-- Stable keys for Excel fixture imports.
--
-- Purpose
-- -------
-- Re-importing the same spreadsheet must update existing fixtures rather than
-- create duplicates. A fixture ID (ML-YYYYMMDD-NNNN) is generated from the date
-- and cannot be supplied by an import, so a separate table records which
-- external key produced which match.
--
-- Matching strategy, in order:
--   1. If the sheet provides a stable key (an explicit column such as
--      "Match ID" / "Fixture ID" / "المعرف"), it is stored here and matched
--      exactly on later imports.
--   2. Otherwise a natural key is derived from
--      date + competition + normalised home team + normalised away team.
--
-- Limitation of (2), documented deliberately: the natural key cannot tell two
-- genuinely different meetings apart if they share a date, competition and both
-- team names. Because the key includes the *date*, a rescheduled fixture (same
-- teams, different day) will insert a new row rather than update the old one.
-- That is the safe direction — it never destroys an existing record, and the
-- admin can delete the stale row in the console.
--
-- This table never touches `public.matches` or `public.fixture_streams`.
-- Broadcaster / stream links live in `fixture_streams`, keyed by the match's
-- `fixture_id`, and are never written by the import path.

create table if not exists public.fixture_import_keys (
  id uuid primary key default gen_random_uuid(),
  -- The natural or provided key, unique across all imports.
  source_key text not null unique,
  -- Where the key came from, so a bad mapping can be traced back.
  source_kind text not null check (source_kind in ('provided', 'natural')),
  -- The match this key resolved to.
  fixture_id text not null
    check (fixture_id ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fixture_import_keys_fixture_idx
  on public.fixture_import_keys (fixture_id);

alter table public.fixture_import_keys enable row level security;

-- Imports are an admin-only concern. Unlike fixtures, there is no public read:
-- nothing in the visitor-facing site needs to see import bookkeeping.
drop policy if exists "admins manage fixture import keys" on public.fixture_import_keys;
create policy "admins manage fixture import keys"
  on public.fixture_import_keys for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.fixture_import_keys to authenticated;
