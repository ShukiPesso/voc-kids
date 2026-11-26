-- Voc Kids: family accounts, word libraries (folders), publishing requests, admin.
-- One auth user = one family. Kids are profiles inside the family (no logins of their own).

-- ---------- admins ----------
create table public.admins (
  user_id uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
create policy "admins: see self" on public.admins for select using (user_id = auth.uid());

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- The first family to call this becomes the admin. After that it always fails.
create or replace function public.claim_admin() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.admins) then return false; end if;
  insert into public.admins (user_id) values (auth.uid());
  return true;
end $$;

create or replace function public.admin_exists() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins);
$$;

-- ---------- libraries (word folders) ----------
create table public.libraries (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  author_name text not null default '' check (char_length(author_name) <= 60),
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  -- { sections: {key: title}, words: [{en, he, pos, section, forms?}] }
  content jsonb not null,
  -- where each word appears in songs (no lyric text): { songs: [...], hits: {wordId: [...]} }
  song_index jsonb not null default '{}'::jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'pending', 'public', 'rejected')),
  request_note text not null default '' check (char_length(request_note) <= 1000),
  review_note text not null default '' check (char_length(review_note) <= 1000),
  requested_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index libraries_owner_idx on public.libraries (owner);
create index libraries_visibility_idx on public.libraries (visibility);
alter table public.libraries enable row level security;

create policy "libraries: read own, public, or as admin" on public.libraries for select
  using (owner = auth.uid() or visibility = 'public' or public.is_admin());

create policy "libraries: create own (private or pending)" on public.libraries for insert
  with check (owner = auth.uid() and visibility in ('private', 'pending'));

-- Owners can edit their libraries but can never make them public themselves.
-- Editing a public library sends it back to private/pending (re-approval).
create policy "libraries: owner edits" on public.libraries for update
  using (owner = auth.uid())
  with check (owner = auth.uid() and visibility in ('private', 'pending'));

create policy "libraries: admin edits" on public.libraries for update
  using (public.is_admin()) with check (true);

create policy "libraries: owner deletes non-public" on public.libraries for delete
  using ((owner = auth.uid() and visibility <> 'public') or public.is_admin());

-- Keep review fields admin-only and timestamps honest.
create or replace function public.libraries_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.owner := old.owner;
    new.created_at := old.created_at;
    if not public.is_admin() then
      new.review_note := old.review_note;
      new.reviewed_at := old.reviewed_at;
    elsif new.visibility is distinct from old.visibility and new.visibility in ('public', 'rejected') then
      new.reviewed_at := now();
    end if;
    if new.visibility = 'pending' and old.visibility is distinct from 'pending' then
      new.requested_at := now();
    end if;
  else
    if not public.is_admin() then new.review_note := ''; new.reviewed_at := null; end if;
    if new.visibility = 'pending' then new.requested_at := now(); end if;
  end if;
  return new;
end $$;
create trigger libraries_guard before insert or update on public.libraries
  for each row execute function public.libraries_guard();

-- ---------- family data (synced between the family's devices) ----------
-- family_state: profiles list, shelf of folders. profile_state: one row per kid (points, progress, ...).
create table public.family_state (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.family_state enable row level security;
create policy "family_state: own" on public.family_state for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.profile_state (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  profile_id text not null check (char_length(profile_id) <= 40),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, profile_id)
);
alter table public.profile_state enable row level security;
create policy "profile_state: own" on public.profile_state for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- scan usage (written only by the scan-words function) ----------
create table public.scan_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  input_tokens int,
  output_tokens int
);
create index scan_log_user_time_idx on public.scan_log (user_id, created_at);
alter table public.scan_log enable row level security;
create policy "scan_log: read own" on public.scan_log for select using (user_id = auth.uid());
