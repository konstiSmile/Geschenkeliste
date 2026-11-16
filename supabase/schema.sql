-- Geschenkeliste – Datenbank, Version 1
-- Im Supabase SQL Editor komplett einfügen und „Run“ drücken.
-- Das Skript darf mehrfach ausgeführt werden (bestehende Daten bleiben erhalten).

-- ---------- Tabellen ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '' check (char_length(name) <= 40),
  created_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  code text not null unique,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);

create table if not exists public.wishes (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  url text check (url is null or (char_length(url) <= 1000 and url ~* '^https?://')),
  note text check (note is null or char_length(note) <= 1000),
  all_groups boolean not null default true,  -- true = für alle eigenen Gruppen sichtbar
  created_at timestamptz not null default now()
);
create index if not exists wishes_owner_idx on public.wishes(owner);

-- Freigabe pro Gruppe (nur genutzt, wenn all_groups = false)
create table if not exists public.wish_groups (
  wish_id uuid not null references public.wishes(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  primary key (wish_id, group_id)
);

-- Reservierungen: nie sichtbar für den Wünschenden
create table if not exists public.reservations (
  wish_id uuid primary key references public.wishes(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status text not null default 'reserviert' check (status in ('reserviert', 'gekauft')),
  created_at timestamptz not null default now()
);

-- ---------- Hilfsfunktionen (umgehen die Regeln nur zum Prüfen) ----------

create or replace function public.is_member(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where group_id = g and user_id = auth.uid());
$$;

create or replace function public.shares_group(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members a
    join public.members b on b.group_id = a.group_id
    where a.user_id = auth.uid() and b.user_id = other);
$$;

create or replace function public.is_wish_owner(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.wishes where id = w and owner = auth.uid());
$$;

create or replace function public.can_see_wish(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.wishes x
    where x.id = w and (
      x.owner = auth.uid()
      or exists (
        select 1 from public.members mo
        join public.members me on me.group_id = mo.group_id and me.user_id = auth.uid()
        where mo.user_id = x.owner
          and (x.all_groups or exists (
            select 1 from public.wish_groups wg
            where wg.wish_id = x.id and wg.group_id = mo.group_id)))));
$$;

create or replace function public.new_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  abc constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea := uuid_send(gen_random_uuid());
  idx int[] := array[0, 1, 2, 3, 4, 5, 10, 11];
  c text := '';
  i int;
begin
  foreach i in array idx loop
    c := c || substr(abc, 1 + (get_byte(b, i) % 32), 1);
  end loop;
  return c;
end $$;

-- ---------- Aktionen der App ----------

create or replace function public.create_group(p_name text) returns public.groups
language plpgsql security definer set search_path = '' as $$
declare
  g public.groups;
  c text;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or char_length(p_name) > 40 then raise exception 'Gruppenname ungültig'; end if;
  if (select count(*) from public.groups where created_by = auth.uid()) >= 20 then
    raise exception 'Zu viele Gruppen';
  end if;
  loop
    c := public.new_code();
    exit when not exists (select 1 from public.groups where code = c);
  end loop;
  insert into public.groups (name, code, created_by) values (p_name, c, auth.uid()) returning * into g;
  insert into public.members (group_id, user_id) values (g.id, auth.uid());
  return g;
end $$;

create or replace function public.join_group(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select id into gid from public.groups
  where code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if gid is null then raise exception 'Code nicht gefunden'; end if;
  insert into public.members (group_id, user_id) values (gid, auth.uid()) on conflict do nothing;
  return gid;
end $$;

create or replace function public.leave_group(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  delete from public.wish_groups wg using public.wishes w
    where wg.wish_id = w.id and w.owner = auth.uid() and wg.group_id = p_group;
  delete from public.members where group_id = p_group and user_id = auth.uid();
  if not exists (select 1 from public.members where group_id = p_group) then
    delete from public.groups where id = p_group;
  end if;
end $$;

create or replace function public.rename_group(p_group uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_member(p_group) then raise exception 'Kein Mitglied'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or char_length(p_name) > 40 then raise exception 'Gruppenname ungültig'; end if;
  update public.groups set name = p_name where id = p_group;
end $$;

-- ---------- Zugriffsregeln (Row Level Security) ----------

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.wishes enable row level security;
alter table public.wish_groups enable row level security;
alter table public.reservations enable row level security;

drop policy if exists "profiles lesen" on public.profiles;
drop policy if exists "profil anlegen" on public.profiles;
drop policy if exists "profil ändern" on public.profiles;
create policy "profiles lesen" on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_group(id));
create policy "profil anlegen" on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy "profil ändern" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "gruppen lesen" on public.groups;
create policy "gruppen lesen" on public.groups for select to authenticated
  using (public.is_member(id));

drop policy if exists "mitglieder lesen" on public.members;
create policy "mitglieder lesen" on public.members for select to authenticated
  using (public.is_member(group_id));

drop policy if exists "wünsche lesen" on public.wishes;
drop policy if exists "wunsch anlegen" on public.wishes;
drop policy if exists "wunsch ändern" on public.wishes;
drop policy if exists "wunsch löschen" on public.wishes;
create policy "wünsche lesen" on public.wishes for select to authenticated
  using (owner = auth.uid() or public.can_see_wish(id));
create policy "wunsch anlegen" on public.wishes for insert to authenticated
  with check (owner = auth.uid());
create policy "wunsch ändern" on public.wishes for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "wunsch löschen" on public.wishes for delete to authenticated
  using (owner = auth.uid());

drop policy if exists "freigabe lesen" on public.wish_groups;
drop policy if exists "freigabe anlegen" on public.wish_groups;
drop policy if exists "freigabe löschen" on public.wish_groups;
create policy "freigabe lesen" on public.wish_groups for select to authenticated
  using (public.can_see_wish(wish_id));
create policy "freigabe anlegen" on public.wish_groups for insert to authenticated
  with check (public.is_wish_owner(wish_id) and public.is_member(group_id));
create policy "freigabe löschen" on public.wish_groups for delete to authenticated
  using (public.is_wish_owner(wish_id));

drop policy if exists "reservierung lesen" on public.reservations;
drop policy if exists "reservierung anlegen" on public.reservations;
drop policy if exists "reservierung ändern" on public.reservations;
drop policy if exists "reservierung löschen" on public.reservations;
create policy "reservierung lesen" on public.reservations for select to authenticated
  using (public.can_see_wish(wish_id) and not public.is_wish_owner(wish_id));
create policy "reservierung anlegen" on public.reservations for insert to authenticated
  with check (user_id = auth.uid() and public.can_see_wish(wish_id) and not public.is_wish_owner(wish_id));
create policy "reservierung ändern" on public.reservations for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_see_wish(wish_id) and not public.is_wish_owner(wish_id));
create policy "reservierung löschen" on public.reservations for delete to authenticated
  using (user_id = auth.uid());

-- ---------- Rechte ----------

revoke all on public.profiles, public.groups, public.members, public.wishes,
  public.wish_groups, public.reservations from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.groups, public.members to authenticated;
grant select, insert, update, delete on public.wishes, public.wish_groups, public.reservations to authenticated;

revoke execute on function public.is_member(uuid), public.shares_group(uuid), public.is_wish_owner(uuid),
  public.can_see_wish(uuid), public.new_code(), public.create_group(text), public.join_group(text),
  public.leave_group(uuid), public.rename_group(uuid, text) from public, anon;
grant execute on function public.is_member(uuid), public.shares_group(uuid), public.is_wish_owner(uuid),
  public.can_see_wish(uuid), public.create_group(text), public.join_group(text),
  public.leave_group(uuid), public.rename_group(uuid, text) to authenticated;
