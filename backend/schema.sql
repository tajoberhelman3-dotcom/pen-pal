-- Pen Pal database setup. Paste into Supabase → SQL Editor → Run. Safe to run again.

-- ---------- tables ----------
create table if not exists public.crews (
  code        text primary key check (code ~ '^[A-Z0-9]{6}$'),
  name        text not null check (char_length(name) between 1 and 30),
  created_by  uuid not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.members (
  crew       text not null references public.crews(code) on delete cascade,
  uid        uuid not null,
  name       text not null check (char_length(name) between 1 and 24),
  joined_at  timestamptz not null default now(),
  last_at    timestamptz,
  primary key (crew, uid)
);

create table if not exists public.hits (
  id        uuid primary key default gen_random_uuid(),
  crew      text not null references public.crews(code) on delete cascade,
  uid       uuid not null default auth.uid(),
  name      text not null check (char_length(name) between 1 and 24),
  pen       text not null check (char_length(pen) between 1 and 24),
  spot      text not null default '' check (char_length(spot) <= 40),
  photo     text check (char_length(photo) <= 400),
  at        timestamptz not null default now(),
  notified  boolean not null default false
);
create index if not exists hits_crew_at on public.hits (crew, at desc);

create table if not exists public.profiles (
  uid   uuid primary key default auth.uid(),
  name  text check (char_length(name) <= 24),
  crew  text,
  pens  text[] not null default '{}',
  pen   text check (char_length(pen) <= 24)
);

create table if not exists public.push_subs (
  endpoint    text primary key,
  uid         uuid not null default auth.uid(),
  crew        text,
  sub         jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists push_subs_crew on public.push_subs (crew);

alter table public.crews     enable row level security;
alter table public.members   enable row level security;
alter table public.hits      enable row level security;
alter table public.profiles  enable row level security;
alter table public.push_subs enable row level security;

-- ---------- helpers ----------
create or replace function public.is_member(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where crew = c and uid = auth.uid());
$$;

-- Start a crew: makes a fresh 6-character code and adds you as the first member.
create or replace function public.create_crew(crew_name text, member_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  c text;
  chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  i int;
  mname text := left(trim(coalesce(member_name, '')), 24);
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if mname = '' then raise exception 'name required'; end if;
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.crews where code = c);
  end loop;
  insert into public.crews (code, name, created_by)
    values (c, left(coalesce(nullif(trim(crew_name), ''), mname || '''s crew'), 30), auth.uid());
  insert into public.members (crew, uid, name) values (c, auth.uid(), mname);
  return c;
end $$;

-- Join a crew by code. Returns false if no crew has that code.
create or replace function public.join_crew(crew_code text, member_name text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  mname text := left(trim(coalesce(member_name, '')), 24);
  c text := upper(trim(coalesce(crew_code, '')));
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if mname = '' then raise exception 'name required'; end if;
  if not exists (select 1 from public.crews where code = c) then return false; end if;
  insert into public.members (crew, uid, name) values (c, auth.uid(), mname)
    on conflict (crew, uid) do update set name = excluded.name;
  return true;
end $$;

revoke execute on function public.create_crew(text, text) from public, anon;
revoke execute on function public.join_crew(text, text) from public, anon;
grant execute on function public.create_crew(text, text) to authenticated;
grant execute on function public.join_crew(text, text) to authenticated;
grant execute on function public.is_member(text) to authenticated;

-- Hits always get the real sender and server time.
create or replace function public.hits_before_insert() returns trigger
language plpgsql as $$
begin
  new.uid := auth.uid();
  new.at := now();
  new.notified := false;
  return new;
end $$;
drop trigger if exists hits_before_insert on public.hits;
create trigger hits_before_insert before insert on public.hits
  for each row execute function public.hits_before_insert();

-- Logging a hit marks you as "out" for your crew.
create or replace function public.hits_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.members set last_at = new.at, name = new.name
    where crew = new.crew and uid = new.uid;
  return null;
end $$;
drop trigger if exists hits_after_insert on public.hits;
create trigger hits_after_insert after insert on public.hits
  for each row execute function public.hits_after_insert();

-- ---------- access rules ----------
drop policy if exists "members see their crew" on public.crews;
create policy "members see their crew" on public.crews
  for select to authenticated using (public.is_member(code));

drop policy if exists "members see crewmates" on public.members;
create policy "members see crewmates" on public.members
  for select to authenticated using (public.is_member(crew));
drop policy if exists "leave crew" on public.members;
create policy "leave crew" on public.members
  for delete to authenticated using (uid = auth.uid());

drop policy if exists "members see hits" on public.hits;
create policy "members see hits" on public.hits
  for select to authenticated using (public.is_member(crew));
drop policy if exists "members post hits" on public.hits;
create policy "members post hits" on public.hits
  for insert to authenticated with check (uid = auth.uid() and public.is_member(crew));
drop policy if exists "delete own hits" on public.hits;
create policy "delete own hits" on public.hits
  for delete to authenticated using (uid = auth.uid());

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all to authenticated using (uid = auth.uid()) with check (uid = auth.uid());

drop policy if exists "own push subscriptions" on public.push_subs;
create policy "own push subscriptions" on public.push_subs
  for all to authenticated using (uid = auth.uid()) with check (uid = auth.uid());

-- ---------- live updates ----------
do $$
begin
  begin alter publication supabase_realtime add table public.hits;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.members; exception when duplicate_object then null; end;
end $$;

-- ---------- photo storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('photos', 'photos', true, 3145728, array['image/jpeg'])
  on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];

drop policy if exists "pen pal: members upload own photos" on storage.objects;
create policy "pen pal: members upload own photos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'photos'
    and public.is_member((storage.foldername(name))[1])
    and (storage.foldername(name))[2] = auth.uid()::text
  );
drop policy if exists "pen pal: delete own photos" on storage.objects;
create policy "pen pal: delete own photos" on storage.objects
  for delete to authenticated using (bucket_id = 'photos' and owner_id = auth.uid()::text);
