-- Geschenkeliste – Datenbank, Stand Version 1.14 (Direkte Freundschaft)
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

-- Seit 1.7: Preis, Kategorie, Wichtigkeit, „Hab ich schon“
alter table public.wishes add column if not exists price numeric(9,2);
alter table public.wishes add column if not exists category text;
alter table public.wishes add column if not exists priority smallint not null default 2;
alter table public.wishes add column if not exists have_at timestamptz;  -- gesetzt = „Hab ich schon“
alter table public.wishes drop constraint if exists wishes_price_ok;
alter table public.wishes add constraint wishes_price_ok check (price is null or (price >= 0 and price <= 1000000));
alter table public.wishes drop constraint if exists wishes_category_ok;
alter table public.wishes add constraint wishes_category_ok check (category is null or category ~ '^[a-z]{2,20}$');
alter table public.wishes drop constraint if exists wishes_priority_ok;
alter table public.wishes add constraint wishes_priority_ok check (priority between 1 and 3);

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

-- Seit 1.14: direkte Freundschaft (ohne gemeinsame Gruppe). Eine Zeile pro Paar, a < b.
-- Anlegen und Beenden nur über die Funktionen im Block „Direkte Freundschaft“ am Ende.
create table if not exists public.friendships (
  a uuid not null references auth.users(id) on delete cascade,
  b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);
create index if not exists friendships_b_idx on public.friendships(b);

-- Seit 1.14: Wünsche für Freunde. all_friends = für alle direkten Freunde sichtbar,
-- sonst nur für die in wish_friends eingetragenen.
alter table public.wishes add column if not exists all_friends boolean not null default true;
create table if not exists public.wish_friends (
  wish_id uuid not null references public.wishes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (wish_id, user_id)
);
create index if not exists wish_friends_user_idx on public.wish_friends(user_id);

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

-- Seit 1.14: befreundet (direkt, ohne Gruppe)
create or replace function public.are_friends(x uuid, y uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select x is not null and y is not null and exists (
    select 1 from public.friendships where a = least(x, y) and b = greatest(x, y));
$$;

create or replace function public.is_friend(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.are_friends(auth.uid(), other);
$$;

-- Kenne ich die Person (gemeinsame Gruppe oder befreundet)?
create or replace function public.knows(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.shares_group(other) or public.is_friend(other);
$$;

-- Sieht u den Wunsch w (und ist nicht selbst die beschenkte Person)?
-- Über eine gemeinsame Gruppe (alle Gruppen oder freigegebene) oder als direkter Freund
-- (alle Freunde oder einzeln freigegeben). Seit 1.13, mit Freunden seit 1.14.
create or replace function public.wish_visible_to(w uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.wishes x
    where x.id = w and x.owner <> u and (
      exists (
        select 1 from public.members mo
        join public.members m on m.group_id = mo.group_id and m.user_id = u
        where mo.user_id = x.owner
          and (x.all_groups or exists (
            select 1 from public.wish_groups wg where wg.wish_id = x.id and wg.group_id = mo.group_id)))
      or (public.are_friends(x.owner, u)
          and (x.all_friends or exists (
            select 1 from public.wish_friends wf where wf.wish_id = x.id and wf.user_id = u)))));
$$;

create or replace function public.can_see_wish(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.wishes x where x.id = w and x.owner = auth.uid())
      or public.wish_visible_to(w, auth.uid());
$$;

-- Wessen Namen darf ich sehen? Gruppen, Freunde, offene Anfragen an mich und
-- Leute, mit denen ich ein gemeinsames Geschenk sehe (seit 1.14).
-- plpgsql, weil die Tabellen der späteren Blöcke beim ersten Ausführen noch fehlen.
create or replace function public.profile_visible(other uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then return false; end if;
  if other = me or public.knows(other) then return true; end if;
  if to_regclass('public.friend_requests') is not null and exists (
       select 1 from public.friend_requests r where r.from_user = other and r.to_user = me and r.declined_at is null) then
    return true;
  end if;
  if to_regclass('public.gift_shares') is not null and exists (
       select 1 from public.gift_pools p
       where (p.buyer = other or exists (select 1 from public.gift_shares s where s.wish_id = p.wish_id and s.user_id = other))
         and public.pool_visible_to(p.wish_id, me)) then
    return true;
  end if;
  return false;
end $$;

-- Seit 1.7: Wunsch ist noch offen (nicht „Hab ich schon“)
create or replace function public.wish_open(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.wishes where id = w and have_at is null);
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
  else
    -- Verlässt der Gründer die Gruppe, übernimmt das am längsten dabei gebliebene Mitglied (ab 1.6)
    update public.groups set created_by = (
        select user_id from public.members where group_id = p_group order by joined_at, user_id limit 1)
      where id = p_group and created_by = auth.uid();
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
  using (id = auth.uid() or public.profile_visible(id));
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

alter table public.wish_friends enable row level security;
alter table public.friendships enable row level security;

-- Freigabe für einzelne Freunde (1.14): Besitzer sieht alle, Freunde nur die eigene Zeile
drop policy if exists "freunde-freigabe lesen" on public.wish_friends;
drop policy if exists "freunde-freigabe anlegen" on public.wish_friends;
drop policy if exists "freunde-freigabe löschen" on public.wish_friends;
create policy "freunde-freigabe lesen" on public.wish_friends for select to authenticated
  using (public.is_wish_owner(wish_id) or user_id = auth.uid());
create policy "freunde-freigabe anlegen" on public.wish_friends for insert to authenticated
  with check (public.is_wish_owner(wish_id) and public.is_friend(user_id));
create policy "freunde-freigabe löschen" on public.wish_friends for delete to authenticated
  using (public.is_wish_owner(wish_id));

drop policy if exists "freundschaft lesen" on public.friendships;
create policy "freundschaft lesen" on public.friendships for select to authenticated
  using (a = auth.uid() or b = auth.uid());

drop policy if exists "reservierung lesen" on public.reservations;
drop policy if exists "reservierung anlegen" on public.reservations;
drop policy if exists "reservierung ändern" on public.reservations;
drop policy if exists "reservierung löschen" on public.reservations;
create policy "reservierung lesen" on public.reservations for select to authenticated
  using (public.can_see_wish(wish_id) and not public.is_wish_owner(wish_id));
create policy "reservierung anlegen" on public.reservations for insert to authenticated
  with check (user_id = auth.uid() and public.can_see_wish(wish_id) and not public.is_wish_owner(wish_id)
    and public.wish_open(wish_id));
create policy "reservierung ändern" on public.reservations for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_see_wish(wish_id) and not public.is_wish_owner(wish_id));
create policy "reservierung löschen" on public.reservations for delete to authenticated
  using (user_id = auth.uid());

-- ---------- Rechte ----------

revoke all on public.profiles, public.groups, public.members, public.wishes,
  public.wish_groups, public.reservations, public.wish_friends, public.friendships from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.groups, public.members, public.friendships to authenticated;
grant select, insert, update, delete on public.wishes, public.wish_groups, public.reservations to authenticated;
grant select, insert, delete on public.wish_friends to authenticated;

revoke execute on function public.are_friends(uuid, uuid), public.is_friend(uuid), public.knows(uuid),
  public.wish_visible_to(uuid, uuid), public.profile_visible(uuid) from public, anon;
grant execute on function public.is_friend(uuid), public.knows(uuid), public.profile_visible(uuid) to authenticated;
revoke execute on function public.are_friends(uuid, uuid), public.wish_visible_to(uuid, uuid) from authenticated;

revoke execute on function public.is_member(uuid), public.shares_group(uuid), public.is_wish_owner(uuid),
  public.can_see_wish(uuid), public.wish_open(uuid), public.new_code(), public.create_group(text), public.join_group(text),
  public.leave_group(uuid), public.rename_group(uuid, text) from public, anon;
grant execute on function public.is_member(uuid), public.shares_group(uuid), public.is_wish_owner(uuid),
  public.can_see_wish(uuid), public.wish_open(uuid), public.create_group(text), public.join_group(text),
  public.leave_group(uuid), public.rename_group(uuid, text) to authenticated;

-- =====================================================================
-- Konto ohne Mail (Version 1.5)
-- Anmeldung mit Benutzername + Passwort. Supabase braucht intern eine Mail-Adresse,
-- deshalb bekommt jedes Konto <benutzername>@nutzer.geschenkeliste.invalid.
-- Diese Adresse wird direkt als bestätigt gespeichert, es wird nie eine Mail verschickt.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- Benutzername pro Konto (nur für einen selbst lesbar)
create table if not exists public.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,23}$'),
  created_at timestamptz not null default now(),
  reset_at timestamptz,                              -- wann der Admin den Zugang zurückgesetzt hat
  reset_notice boolean not null default false        -- Hinweis beim nächsten Öffnen zeigen
);

-- Wiederherstellungscode, nur als Hash (für die App nicht lesbar)
create table if not exists public.recovery_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now()
);

-- Einmaliger Rücksetz-Code vom Admin, 24 Stunden gültig (für die App nicht lesbar)
create table if not exists public.reset_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Fehlversuche bei „Passwort vergessen“ (5 Fehler = 1 Stunde Sperre pro Benutzername)
create table if not exists public.login_attempts (
  username text primary key,
  fails int not null default 0,
  first_fail_at timestamptz not null default now(),
  locked_until timestamptz
);

-- Admins der App. Nur im SQL Editor befüllbar, z. B.:
--   insert into public.app_admins select user_id from public.accounts where username = 'konsti';
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ---------- interne Hilfen (nicht von der App aufrufbar) ----------

create or replace function public.random_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 31 Zeichen, ohne 0 O 1 I L
  c text := '';
  b int;
begin
  while char_length(c) < 16 loop
    b := get_byte(extensions.gen_random_bytes(1), 0);
    if b < 248 then c := c || substr(abc, 1 + b % 31, 1); end if;  -- 248 = 8 × 31, gleichverteilt
  end loop;
  return c;
end $$;

create or replace function public.norm_code(p text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

create or replace function public.set_recovery_code(p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  c text := public.random_code();
begin
  insert into public.recovery_codes (user_id, code_hash)
    values (p_user, extensions.crypt(c, extensions.gen_salt('bf', 8)))
    on conflict (user_id) do update set code_hash = excluded.code_hash, created_at = now();
  return c;
end $$;

create or replace function public.set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_password is null or char_length(p_password) < 8 then raise exception 'Passwort zu kurz'; end if;
  if octet_length(p_password) > 72 then raise exception 'Passwort zu lang'; end if;
  update auth.users
    set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now()
    where id = p_user;
end $$;

-- ---------- Aktionen der App ----------

-- Konto sichern: Benutzername + Passwort festlegen. Gibt den Wiederherstellungscode zurück (nur dieses eine Mal).
create or replace function public.secure_account(p_username text, p_password text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  n text := lower(btrim(coalesce(p_username, '')));
  mail text;
begin
  if u is null then raise exception 'Nicht angemeldet'; end if;
  if exists (select 1 from public.accounts where user_id = u) then raise exception 'Konto schon gesichert'; end if;
  if n !~ '^[a-z0-9][a-z0-9._-]{2,23}$' then raise exception 'Benutzername ungültig'; end if;
  if exists (select 1 from public.accounts where username = n) then raise exception 'Benutzername vergeben'; end if;
  perform public.set_password(u, p_password);
  mail := n || '@nutzer.geschenkeliste.invalid';
  update auth.users set
      email = mail,
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      is_anonymous = false,
      raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"provider": "email", "providers": ["email"]}'::jsonb,
      updated_at = now()
    where id = u;
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    values (u::text, u, jsonb_build_object('sub', u::text, 'email', mail, 'email_verified', true), 'email', now(), now())
    on conflict (provider_id, provider) do update set identity_data = excluded.identity_data, updated_at = now();
  insert into public.accounts (user_id, username) values (u, n);
  return public.set_recovery_code(u);
end $$;

-- Neuen Wiederherstellungscode erzeugen (alter wird ungültig)
create or replace function public.new_recovery_code() returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts where user_id = auth.uid()) then raise exception 'Konto nicht gesichert'; end if;
  return public.set_recovery_code(auth.uid());
end $$;

-- Passwort vergessen: Benutzername + Code (Wiederherstellungs- oder Rücksetz-Code) + neues Passwort.
-- Auch ohne Anmeldung aufrufbar. Liefert {ok, code} oder {ok:false, error, left|until}.
-- Gibt Fehler als Ergebnis zurück statt mit raise, damit der Fehlerzähler gespeichert bleibt.
create or replace function public.recover_account(p_username text, p_code text, p_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n text := lower(btrim(coalesce(p_username, '')));
  c text := public.norm_code(p_code);
  u uuid;
  lock_ts timestamptz;
  f int;
  via_reset boolean := false;
  ok boolean := false;
begin
  if n = '' or char_length(n) > 24 then return jsonb_build_object('ok', false, 'error', 'falsch', 'left', 5); end if;
  if p_password is null or char_length(p_password) < 8 then return jsonb_build_object('ok', false, 'error', 'passwort'); end if;
  if octet_length(p_password) > 72 then return jsonb_build_object('ok', false, 'error', 'passwort_lang'); end if;

  delete from public.login_attempts
    where first_fail_at < now() - interval '1 day' and (locked_until is null or locked_until < now());
  insert into public.login_attempts (username) values (n) on conflict (username) do nothing;
  select locked_until into lock_ts from public.login_attempts where username = n for update;
  if lock_ts > now() then return jsonb_build_object('ok', false, 'error', 'gesperrt', 'until', lock_ts); end if;

  select user_id into u from public.accounts where username = n;
  if u is not null and c <> '' then
    ok := exists (select 1 from public.recovery_codes r where r.user_id = u and r.code_hash = extensions.crypt(c, r.code_hash));
    if not ok then
      via_reset := exists (select 1 from public.reset_codes r
        where r.user_id = u and r.expires_at > now() and r.code_hash = extensions.crypt(c, r.code_hash));
      ok := via_reset;
    end if;
  end if;

  if not ok then
    update public.login_attempts set
        fails = case when fails = 0 or first_fail_at < now() - interval '1 hour' then 1 else fails + 1 end,
        first_fail_at = case when fails = 0 or first_fail_at < now() - interval '1 hour' then now() else first_fail_at end,
        locked_until = null
      where username = n returning fails into f;
    if f >= 5 then
      update public.login_attempts set fails = 0, locked_until = now() + interval '1 hour'
        where username = n returning locked_until into lock_ts;
      return jsonb_build_object('ok', false, 'error', 'gesperrt', 'until', lock_ts);
    end if;
    return jsonb_build_object('ok', false, 'error', 'falsch', 'left', 5 - f);
  end if;

  delete from public.login_attempts where username = n;
  perform public.set_password(u, p_password);
  delete from public.reset_codes where user_id = u;
  if via_reset then
    update public.accounts set reset_at = now(), reset_notice = true where user_id = u;
  end if;
  return jsonb_build_object('ok', true, 'code', public.set_recovery_code(u));
end $$;

create or replace function public.dismiss_reset_notice() returns void
language sql security definer set search_path = '' as $$
  update public.accounts set reset_notice = false where user_id = auth.uid();
$$;

-- ---------- Verwaltung (nur Admins) ----------

create or replace function public.is_app_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

create or replace function public.admin_find_users(p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q text := '%' || replace(replace(replace(lower(btrim(coalesce(p_query, ''))), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  if not public.is_app_admin() then raise exception 'Keine Berechtigung'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', a.user_id, 'username', a.username, 'name', coalesce(p.name, ''),
      'reset_open', exists (select 1 from public.reset_codes r where r.user_id = a.user_id and r.expires_at > now()))
      order by a.username)
    from (select * from public.accounts a0
          left join public.profiles p0 on p0.id = a0.user_id
          where a0.username like q or lower(coalesce(p0.name, '')) like q
          order by a0.username limit 30) x
    join public.accounts a on a.user_id = x.user_id
    left join public.profiles p on p.id = a.user_id), '[]'::jsonb);
end $$;

-- Erzeugt einen einmaligen Rücksetz-Code (24 h). Die Person wählt damit unter „Passwort vergessen“ selbst ein neues Passwort.
create or replace function public.admin_reset(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n text;
  c text := public.random_code();
  exp timestamptz := now() + interval '24 hours';
begin
  if not public.is_app_admin() then raise exception 'Keine Berechtigung'; end if;
  select username into n from public.accounts where user_id = p_user;
  if n is null then raise exception 'Kein gesichertes Konto'; end if;
  insert into public.reset_codes (user_id, code_hash, expires_at, created_by)
    values (p_user, extensions.crypt(c, extensions.gen_salt('bf', 8)), exp, auth.uid())
    on conflict (user_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      created_by = excluded.created_by, created_at = now();
  delete from public.login_attempts where username = n;  -- Sperre aufheben
  return jsonb_build_object('code', c, 'expires_at', exp, 'username', n);
end $$;

-- ---------- Zugriffsregeln ----------

alter table public.accounts enable row level security;
alter table public.recovery_codes enable row level security;
alter table public.reset_codes enable row level security;
alter table public.login_attempts enable row level security;
alter table public.app_admins enable row level security;

drop policy if exists "eigenes konto lesen" on public.accounts;
create policy "eigenes konto lesen" on public.accounts for select to authenticated
  using (user_id = auth.uid());
-- recovery_codes, reset_codes, login_attempts, app_admins: absichtlich keine Regeln = kein Zugriff für die App

revoke all on public.accounts, public.recovery_codes, public.reset_codes, public.login_attempts, public.app_admins
  from anon, authenticated;
grant select on public.accounts to authenticated;

revoke execute on function public.random_code(), public.norm_code(text), public.set_recovery_code(uuid),
  public.set_password(uuid, text), public.secure_account(text, text), public.new_recovery_code(),
  public.recover_account(text, text, text), public.dismiss_reset_notice(), public.is_app_admin(),
  public.admin_find_users(text), public.admin_reset(uuid) from public, anon, authenticated;
grant execute on function public.secure_account(text, text), public.new_recovery_code(),
  public.dismiss_reset_notice(), public.is_app_admin(), public.admin_find_users(text),
  public.admin_reset(uuid) to authenticated;
grant execute on function public.recover_account(text, text, text) to anon, authenticated;

-- =====================================================================
-- Wichteln (Version 1.6)
-- Nur wer die Gruppe gegründet hat, legt fest, wer mitmacht und wer wen nicht ziehen darf,
-- und startet die Auslosung. Jeder sieht nur, wen er selbst gezogen hat, auch der Gründer.
-- =====================================================================

-- Wer nicht mitmacht (Standard: alle Mitglieder machen mit)
create table if not exists public.wichtel_out (
  group_id uuid not null,
  user_id uuid not null,
  primary key (group_id, user_id),
  foreign key (group_id, user_id) references public.members(group_id, user_id) on delete cascade
);

-- Paare, die sich nicht gegenseitig ziehen dürfen (gilt in beide Richtungen, a < b)
create table if not exists public.wichtel_exclusions (
  group_id uuid not null,
  a uuid not null,
  b uuid not null,
  created_at timestamptz not null default now(),
  primary key (group_id, a, b),
  check (a < b),
  foreign key (group_id, a) references public.members(group_id, user_id) on delete cascade,
  foreign key (group_id, b) references public.members(group_id, user_id) on delete cascade
);

-- Letzte Auslosung pro Gruppe (für alle Mitglieder sichtbar, ohne Zuteilungen)
create table if not exists public.wichtel_draws (
  group_id uuid primary key references public.groups(id) on delete cascade,
  drawn_at timestamptz not null default now(),
  participants uuid[] not null
);

-- Zuteilungen: jeder sieht nur die eigene Zeile
create table if not exists public.wichtel_pairs (
  group_id uuid not null,
  giver uuid not null,
  receiver uuid not null,
  primary key (group_id, giver),
  unique (group_id, receiver),
  check (giver <> receiver),
  foreign key (group_id, giver) references public.members(group_id, user_id) on delete cascade,
  foreign key (group_id, receiver) references public.members(group_id, user_id) on delete cascade
);

-- ---------- Hilfen ----------

create or replace function public.is_group_owner(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.groups where id = g and created_by = auth.uid())
     and public.is_member(g);
$$;

-- Sucht eine Zuteilung. Nimmt immer zuerst die Person mit den wenigsten Möglichkeiten,
-- probiert deren Möglichkeiten in zufälliger Reihenfolge und geht bei einer Sackgasse zurück.
-- Liefert [geber1, empfänger1, geber2, empfänger2, …] oder null, wenn es keine Zuteilung gibt.
create or replace function public.wichtel_solve(p_givers uuid[], p_avail uuid[], p_excl text[]) returns uuid[]
language plpgsql volatile set search_path = '' as $$
declare
  g uuid;
  best uuid;
  best_n int := 2147483647;
  n int;
  r uuid;
  sub uuid[];
  steps int := coalesce(nullif(current_setting('wichtel.steps', true), '')::int, 0) + 1;
begin
  if coalesce(cardinality(p_givers), 0) = 0 then return '{}'::uuid[]; end if;
  perform set_config('wichtel.steps', steps::text, true);
  if steps > 50000 then raise exception 'Keine Auslosung möglich'; end if;
  foreach g in array p_givers loop
    select count(*) into n from unnest(p_avail) x where x <> g and not ((g::text || x::text) = any(p_excl));
    if n < best_n then best := g; best_n := n; end if;
    exit when n = 0;
  end loop;
  if best_n = 0 then return null; end if;
  for r in select x from unnest(p_avail) x
           where x <> best and not ((best::text || x::text) = any(p_excl)) order by random() loop
    sub := public.wichtel_solve(array_remove(p_givers, best), array_remove(p_avail, r), p_excl);
    if sub is not null then return array[best, r] || sub; end if;
  end loop;
  return null;
end $$;

-- ---------- Aktionen der App (nur Gründer) ----------

create or replace function public.wichtel_set_participant(p_group uuid, p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_group_owner(p_group) then raise exception 'Nur der Gründer'; end if;
  if not exists (select 1 from public.members where group_id = p_group and user_id = p_user) then
    raise exception 'Kein Mitglied';
  end if;
  if p_on then
    delete from public.wichtel_out where group_id = p_group and user_id = p_user;
  else
    insert into public.wichtel_out (group_id, user_id) values (p_group, p_user) on conflict do nothing;
  end if;
end $$;

create or replace function public.wichtel_set_exclusion(p_group uuid, p_a uuid, p_b uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_group_owner(p_group) then raise exception 'Nur der Gründer'; end if;
  if p_a is null or p_b is null or p_a = p_b then raise exception 'Zwei verschiedene Personen wählen'; end if;
  if p_on then
    if (select count(*) from public.members where group_id = p_group and user_id in (p_a, p_b)) <> 2 then
      raise exception 'Kein Mitglied';
    end if;
    if (select count(*) from public.wichtel_exclusions where group_id = p_group) >= 200 then
      raise exception 'Zu viele Ausschlüsse';
    end if;
    insert into public.wichtel_exclusions (group_id, a, b)
      values (p_group, least(p_a, p_b), greatest(p_a, p_b)) on conflict do nothing;
  else
    delete from public.wichtel_exclusions
      where group_id = p_group and a = least(p_a, p_b) and b = greatest(p_a, p_b);
  end if;
end $$;

-- Lost aus (auch erneut: alle bisherigen Zuteilungen werden ersetzt).
create or replace function public.wichtel_draw(p_group uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  parts uuid[];
  excl text[];
  res uuid[];
  n int;
  ts timestamptz := now();
begin
  if not public.is_group_owner(p_group) then raise exception 'Nur der Gründer'; end if;
  perform 1 from public.groups where id = p_group for update;  -- gleichzeitiges Auslosen verhindern
  select array_agg(m.user_id order by random()) into parts
    from public.members m
    where m.group_id = p_group
      and not exists (select 1 from public.wichtel_out o where o.group_id = p_group and o.user_id = m.user_id);
  n := coalesce(cardinality(parts), 0);
  if n < 3 then raise exception 'Zu wenige Teilnehmer'; end if;
  if n > 60 then raise exception 'Zu viele Teilnehmer'; end if;
  excl := array(
    select e.a::text || e.b::text from public.wichtel_exclusions e where e.group_id = p_group
    union all
    select e.b::text || e.a::text from public.wichtel_exclusions e where e.group_id = p_group);
  perform set_config('wichtel.steps', '0', true);
  res := public.wichtel_solve(parts, parts, excl);
  if res is null then raise exception 'Keine Auslosung möglich'; end if;
  delete from public.wichtel_pairs where group_id = p_group;
  insert into public.wichtel_pairs (group_id, giver, receiver)
    select p_group, res[i], res[i + 1] from generate_series(1, cardinality(res), 2) as i;
  insert into public.wichtel_draws (group_id, drawn_at, participants) values (p_group, ts, parts)
    on conflict (group_id) do update set drawn_at = excluded.drawn_at, participants = excluded.participants;
  return jsonb_build_object('drawn_at', ts, 'count', n);
end $$;

-- Auslosung aufheben
create or replace function public.wichtel_cancel(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_group_owner(p_group) then raise exception 'Nur der Gründer'; end if;
  delete from public.wichtel_pairs where group_id = p_group;
  delete from public.wichtel_draws where group_id = p_group;
end $$;

-- ---------- Zugriffsregeln ----------

alter table public.wichtel_out enable row level security;
alter table public.wichtel_exclusions enable row level security;
alter table public.wichtel_draws enable row level security;
alter table public.wichtel_pairs enable row level security;

drop policy if exists "wichteln teilnahme lesen" on public.wichtel_out;
create policy "wichteln teilnahme lesen" on public.wichtel_out for select to authenticated
  using (public.is_member(group_id));
drop policy if exists "wichteln ausschlüsse lesen" on public.wichtel_exclusions;
create policy "wichteln ausschlüsse lesen" on public.wichtel_exclusions for select to authenticated
  using (public.is_group_owner(group_id));
drop policy if exists "wichteln auslosung lesen" on public.wichtel_draws;
create policy "wichteln auslosung lesen" on public.wichtel_draws for select to authenticated
  using (public.is_member(group_id));
drop policy if exists "wichteln eigene zuteilung lesen" on public.wichtel_pairs;
create policy "wichteln eigene zuteilung lesen" on public.wichtel_pairs for select to authenticated
  using (giver = auth.uid());

revoke all on public.wichtel_out, public.wichtel_exclusions, public.wichtel_draws, public.wichtel_pairs
  from anon, authenticated;
grant select on public.wichtel_out, public.wichtel_exclusions, public.wichtel_draws, public.wichtel_pairs
  to authenticated;

revoke execute on function public.is_group_owner(uuid), public.wichtel_solve(uuid[], uuid[], text[]),
  public.wichtel_set_participant(uuid, uuid, boolean), public.wichtel_set_exclusion(uuid, uuid, uuid, boolean),
  public.wichtel_draw(uuid), public.wichtel_cancel(uuid) from public, anon, authenticated;
grant execute on function public.is_group_owner(uuid), public.wichtel_set_participant(uuid, uuid, boolean),
  public.wichtel_set_exclusion(uuid, uuid, uuid, boolean), public.wichtel_draw(uuid),
  public.wichtel_cancel(uuid) to authenticated;

-- =====================================================================
-- Benachrichtigungen (Version 1.9)
-- Web Push: Jedes Gerät meldet ein Push-Abo an. Die Datenbank legt Nachrichten in den
-- Ausgang (push_outbox) und weckt die Edge Function „push“, die sie verschlüsselt verschickt.
-- Wer was bekommt, entscheidet nur die Datenbank. Reservierungen und Wichtel-Zuteilungen
-- gehen nie an die beschenkte Person, Wichtel-Nachrichten nennen keine Namen.
-- =====================================================================

-- Zum Wecken der Edge Function (pg_net) und für die Erinnerung (pg_cron). Bei Supabase vorhanden.
do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then raise notice 'pg_net nicht verfügbar: %', sqlerrm; end $$;
do $$ begin
  create extension if not exists pg_cron with schema pg_catalog;
exception when others then raise notice 'pg_cron nicht verfügbar: %', sqlerrm; end $$;

-- Push-Abos der Geräte (für die App nicht lesbar, nur über die Funktionen unten)
create table if not exists public.push_subs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fails int not null default 0
);
create index if not exists push_subs_user_idx on public.push_subs(user_id);

-- Was man bekommen möchte (ohne Zeile: alles)
create table if not exists public.push_prefs (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  wish boolean not null default true,     -- neuer Wunsch in meinen Gruppen
  member boolean not null default true,   -- jemand ist beigetreten
  draw boolean not null default true,     -- Wichteln ausgelost
  remind boolean not null default true,   -- Erinnerung vor Heiligabend
  have boolean not null default true      -- „Hab ich schon“ bei etwas, das ich reserviert habe
);
alter table public.push_prefs add column if not exists pool boolean not null default true;  -- gemeinsam schenken (1.13)
alter table public.push_prefs add column if not exists friend boolean not null default true;  -- Freundschaftsanfragen (1.14)

-- Schlüssel und Adresse der Edge Function (eine Zeile, legt der Admin in der App an; für die App nicht lesbar)
create table if not exists public.push_config (
  id int primary key default 1 check (id = 1),
  vapid_public text not null,
  vapid_private text not null,
  subject text not null,
  function_url text not null,
  api_key text,
  created_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_error text
);

-- Ausgang: eine Zeile pro Person und Ereignis (doppelte werden verworfen)
create table if not exists public.push_outbox (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  ref text not null,
  tag text not null,
  group_id uuid,
  actor uuid,
  wish_id uuid,
  extra text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (user_id, kind, ref)
);
-- seit 1.13: Art „pool“ (gemeinsam schenken) und info (Angaben, die beim Versand nicht mehr da sein könnten)
alter table public.push_outbox add column if not exists info jsonb;
alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('wish', 'member', 'draw', 'have', 'remind', 'test', 'pool', 'friend', 'bday'));
create index if not exists push_outbox_pending_idx on public.push_outbox(id) where sent_at is null;
create index if not exists push_outbox_tag_idx on public.push_outbox(user_id, tag, created_at);

-- ---------- interne Hilfen ----------

-- Hat die Person ein Gerät angemeldet und will diese Art Nachricht?
create or replace function public.push_wants(u uuid, k text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.push_subs s where s.user_id = u)
     and coalesce((select case k when 'wish' then p.wish when 'member' then p.member when 'draw' then p.draw
                                 when 'remind' then p.remind when 'have' then p.have when 'pool' then p.pool
                                 when 'friend' then p.friend else true end
                   from public.push_prefs p where p.user_id = u), true);
$$;

create or replace function public.push_name(u uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif((select name from public.profiles where id = u), ''), 'Jemand');
$$;

-- Name, wie v die Person u sieht: eigener Spitzname, sonst Anzeigename (1.14)
create or replace function public.push_name(u uuid, v uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare n text;
begin
  if to_regclass('public.nicknames') is not null then
    execute 'select nick from public.nicknames where owner = $1 and user_id = $2' into n using v, u;
  end if;
  return coalesce(n, public.push_name(u));
end $$;

-- „A, B und C“ bzw. „A, B, C und 2 weitere“
create or replace function public.push_list(a text[]) returns text
language sql immutable set search_path = '' as $$
  select case
    when coalesce(cardinality(a), 0) = 0 then ''
    when cardinality(a) = 1 then a[1]
    when cardinality(a) <= 3 then array_to_string(a[1:cardinality(a) - 1], ', ') || ' und ' || a[cardinality(a)]
    else array_to_string(a[1:3], ', ') || ' und ' || (cardinality(a) - 3) || ' weitere'
  end;
$$;

-- Weckt die Edge Function (über pg_net, nach dem Speichern). Fehler hier verhindern nie die eigentliche Aktion.
create or replace function public.push_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.push_config;
begin
  select * into c from public.push_config where id = 1;
  if not found or to_regnamespace('net') is null then return; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 20000)'
    using c.function_url, '{}'::jsonb,
          jsonb_build_object('Content-Type', 'application/json', 'apikey', coalesce(c.api_key, ''));
exception when others then
  raise notice 'push_kick: %', sqlerrm;
end $$;

-- ---------- Auslöser: wer bekommt was ----------

-- Neuer Wunsch (für alle Gruppen sichtbar) und „Hab ich schon“
create or replace function public.push_on_wish() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.have_at is null and new.all_groups and new.created_at > now() - interval '1 hour'
     and (tg_op = 'INSERT' or not old.all_groups) then
    insert into public.push_outbox (user_id, kind, ref, tag, group_id, actor, wish_id)
      select distinct on (m.user_id) m.user_id, 'wish', new.id::text, 'wish-' || new.owner, m.group_id, new.owner, new.id
      from public.members mo
      join public.members m on m.group_id = mo.group_id
      where mo.user_id = new.owner and m.user_id <> new.owner and public.push_wants(m.user_id, 'wish')
      order by m.user_id, m.joined_at
      on conflict do nothing;
  end if;
  -- direkte Freunde (1.14), wenn für alle Freunde sichtbar
  if new.have_at is null and new.all_friends and new.created_at > now() - interval '1 hour'
     and (tg_op = 'INSERT' or not old.all_friends) then
    insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id)
      select case when f.a = new.owner then f.b else f.a end, 'wish', new.id::text, 'wish-' || new.owner, new.owner, new.id
      from public.friendships f
      where (f.a = new.owner or f.b = new.owner)
        and public.push_wants(case when f.a = new.owner then f.b else f.a end, 'wish')
      on conflict do nothing;
  end if;
  -- nur an die Person, die reserviert hat (nie an den Wünschenden)
  if tg_op = 'UPDATE' and old.have_at is null and new.have_at is not null then
    insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id)
      select r.user_id, 'have', new.id::text, 'have-' || new.id, new.owner, new.id
      from public.reservations r
      where r.wish_id = new.id and r.user_id <> new.owner and public.push_wants(r.user_id, 'have')
      on conflict do nothing;
    -- und an alle, die beim gemeinsamen Geschenk mitmachen (1.13; Tabelle gibt es erst weiter unten)
    if to_regclass('public.gift_shares') is not null then
      execute 'insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id)
        select s.user_id, ''have'', $1::text, ''have-'' || $1, $2, $1
        from public.gift_shares s where s.wish_id = $1 and s.user_id <> $2 and public.push_wants(s.user_id, ''have'')
        on conflict do nothing' using new.id, new.owner;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists push_wish on public.wishes;
create trigger push_wish after insert or update of all_groups, all_friends, have_at on public.wishes
  for each row execute function public.push_on_wish();

-- Neuer Wunsch, der nur für ausgewählte Gruppen freigegeben ist
create or replace function public.push_on_wish_group() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.push_outbox (user_id, kind, ref, tag, group_id, actor, wish_id)
    select m.user_id, 'wish', w.id::text, 'wish-' || w.owner, new.group_id, w.owner, w.id
    from public.wishes w
    join public.members m on m.group_id = new.group_id
    where w.id = new.wish_id and not w.all_groups and w.have_at is null
      and w.created_at > now() - interval '1 hour'
      and m.user_id <> w.owner
      and exists (select 1 from public.members mo where mo.group_id = new.group_id and mo.user_id = w.owner)
      and public.push_wants(m.user_id, 'wish')
    on conflict do nothing;
  return null;
end $$;
drop trigger if exists push_wish_group on public.wish_groups;
create trigger push_wish_group after insert on public.wish_groups
  for each row execute function public.push_on_wish_group();

-- Neuer Wunsch, der nur für einzelne Freunde freigegeben ist (1.14)
create or replace function public.push_on_wish_friend() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id)
    select new.user_id, 'wish', w.id::text, 'wish-' || w.owner, w.owner, w.id
    from public.wishes w
    where w.id = new.wish_id and not w.all_friends and w.have_at is null
      and w.created_at > now() - interval '1 hour'
      and public.are_friends(w.owner, new.user_id)
      and public.push_wants(new.user_id, 'wish')
    on conflict do nothing;
  return null;
end $$;
drop trigger if exists push_wish_friend on public.wish_friends;
create trigger push_wish_friend after insert on public.wish_friends
  for each row execute function public.push_on_wish_friend();

-- Jemand ist einer Gruppe beigetreten
create or replace function public.push_on_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.push_outbox (user_id, kind, ref, tag, group_id, actor)
    select m.user_id, 'member', new.group_id || ':' || new.user_id, 'member-' || new.group_id, new.group_id, new.user_id
    from public.members m
    where m.group_id = new.group_id and m.user_id <> new.user_id and public.push_wants(m.user_id, 'member')
    on conflict do nothing;
  return null;
end $$;
drop trigger if exists push_member on public.members;
create trigger push_member after insert on public.members
  for each row execute function public.push_on_member();

-- Wichteln ausgelost (an alle Teilnehmer außer dem, der auslost; ohne Namen)
create or replace function public.push_on_draw() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.push_outbox (user_id, kind, ref, tag, group_id, extra)
    select u, 'draw', new.group_id || ':' || new.drawn_at, 'draw-' || new.group_id, new.group_id,
           case when tg_op = 'UPDATE' then 'neu' end
    from unnest(new.participants) as u
    where u is distinct from auth.uid() and public.push_wants(u, 'draw')
    on conflict do nothing;
  return null;
end $$;
drop trigger if exists push_draw on public.wichtel_draws;
create trigger push_draw after insert or update of drawn_at on public.wichtel_draws
  for each row execute function public.push_on_draw();

-- Nach jedem Eintrag im Ausgang die Edge Function wecken
create or replace function public.push_after_queue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from n) then perform public.push_kick(); end if;
  return null;
end $$;
drop trigger if exists push_queue on public.push_outbox;
create trigger push_queue after insert on public.push_outbox
  referencing new table as n for each statement execute function public.push_after_queue();

-- ---------- Zeitplan (pg_cron) ----------

-- Jede Minute (seit 1.13.1, vorher alle 5): Liegengebliebenes verschicken (z. B. gebündelte Wünsche)
create or replace function public.push_tick() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.push_outbox where sent_at is null) then perform public.push_kick(); end if;
end $$;

-- Täglich 17 Uhr UTC: Erinnerung 14, 7 und 1 Tag vor Heiligabend (an alle in mindestens einer Gruppe)
create or replace function public.push_daily(p_today date default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  today date := coalesce(p_today, (now() at time zone 'Europe/Berlin')::date);
  d int := make_date(extract(year from today)::int, 12, 24) - today;
  n int := 0;
  k int := 0;
begin
  -- Gemeinsam schenken (1.13): Frist gestern abgelaufen, zu wenige dabei → an den Käufer
  if to_regclass('public.gift_pools') is not null then
    execute 'select public.pool_due($1)' into k using today;
  end if;
  -- Seit 1.15: Erinnerungen für alle Anlässe der Gruppen und für Geburtstage
  if to_regprocedure('public.occasion_due(date)') is not null then
    execute 'select public.occasion_due($1)' into n using today;
    return coalesce(n, 0) + coalesce(k, 0);
  end if;
  if d not in (14, 7, 1) then return coalesce(k, 0); end if;
  insert into public.push_outbox (user_id, kind, ref, tag, extra)
    select distinct m.u, 'remind', extract(year from today)::int || '-' || d, 'remind', d::text
    from (select user_id as u from public.members
          union select a from public.friendships union select b from public.friendships) m
    where public.push_wants(m.u, 'remind')
    on conflict do nothing;
  get diagnostics n = row_count;
  return n + coalesce(k, 0);
end $$;

do $$ begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('geschenkeliste-push', '* * * * *', 'select public.push_tick()');
    perform cron.schedule('geschenkeliste-erinnerung', '0 17 * * *', 'select public.push_daily()');
  end if;
exception when others then raise notice 'Zeitplan nicht angelegt: %', sqlerrm; end $$;

-- ---------- Für die Edge Function (nur mit Secret Key) ----------

-- Text einer Nachricht für eine Person und ein Thema, zum Zeitpunkt des Versands (null = nichts mehr zu sagen)
create or replace function public.push_message(p_user uuid, p_tag text, p_kind text, p_delta int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  titles text[];
  n int;
  gid uuid;
  who uuid;
  wid uuid;
  ex text;
  gname text;
  k int;
begin
  if p_kind = 'wish' then
    select array_agg(w.title order by o.id), count(*), (array_agg(o.group_id order by o.id desc))[1], (array_agg(o.actor))[1]
      into titles, n, gid, who
      from public.push_outbox o
      join public.wishes w on w.id = o.wish_id
      where o.user_id = p_user and o.tag = p_tag and o.kind = 'wish' and o.sent_at is not null
        and o.created_at > now() - interval '1 hour' and w.have_at is null
        and public.wish_visible_to(w.id, p_user);
    if coalesce(n, 0) = 0 then return null; end if;
    -- Gruppe nur, wenn beide noch drin sind und der Wunsch dort sichtbar ist, sonst die Liste der Person (1.14)
    if gid is null or not exists (select 1 from public.members m where m.group_id = gid and m.user_id = p_user)
       or not exists (select 1 from public.members m where m.group_id = gid and m.user_id = who) then
      gid := null;
    end if;
    return jsonb_build_object('kind', 'wish', 'tag', p_tag, 'badge', p_delta,
      'title', case when n = 1 then 'Neuer Wunsch von ' || public.push_name(who, p_user)
                    else public.push_name(who, p_user) || ' hat ' || n || ' neue Wünsche' end,
      'body', public.push_list(titles),
      'url', case when gid is null then '#/p/' || who else '#/g/' || gid || '/p/' || who end);
  elsif p_kind = 'member' then
    select array_agg(public.push_name(o.actor, p_user) order by o.id), count(*), (array_agg(o.group_id))[1]
      into titles, n, gid
      from public.push_outbox o
      where o.user_id = p_user and o.tag = p_tag and o.kind = 'member' and o.sent_at is not null
        and o.created_at > now() - interval '1 hour'
        and exists (select 1 from public.members m where m.group_id = o.group_id and m.user_id = o.actor)
        and exists (select 1 from public.members m where m.group_id = o.group_id and m.user_id = p_user);
    if coalesce(n, 0) = 0 then return null; end if;
    select name into gname from public.groups where id = gid;
    return jsonb_build_object('kind', 'member', 'tag', p_tag, 'badge', p_delta,
      'title', case when n = 1 then titles[1] || ' ist dabei' else n || ' Neue in ' || gname end,
      'body', case when n = 1 then 'Neu in der Gruppe ' || gname else public.push_list(titles) end,
      'url', '#/g/' || gid);
  elsif p_kind = 'draw' then
    select o.group_id, o.extra into gid, ex
      from public.push_outbox o
      where o.user_id = p_user and o.tag = p_tag and o.kind = 'draw' and o.sent_at is not null
      order by o.id desc limit 1;
    if not exists (select 1 from public.wichtel_pairs p where p.group_id = gid and p.giver = p_user) then return null; end if;
    select name into gname from public.groups where id = gid;
    return jsonb_build_object('kind', 'draw', 'tag', p_tag, 'badge', 1,
      'title', 'Wichteln in ' || gname,
      'body', case when ex = 'neu' then 'Es wurde neu ausgelost. Schau nach, wen du jetzt beschenkst.'
                   else 'Es wurde ausgelost. Schau nach, wen du beschenkst.' end,
      'url', '#/g/' || gid || '/wichteln');
  elsif p_kind = 'have' then
    select o.wish_id into wid from public.push_outbox o
      where o.user_id = p_user and o.tag = p_tag and o.kind = 'have' order by o.id desc limit 1;
    select w.title, w.owner, r.status, r.user_id into ex, who, gname, gid
      from public.wishes w join public.reservations r on r.wish_id = w.id
      where w.id = wid and w.have_at is not null
        and (r.user_id = p_user or public.pool_member(w.id, p_user));
    if ex is null then return null; end if;
    if gid <> p_user then
      return jsonb_build_object('kind', 'have', 'tag', p_tag, 'badge', 0,
        'title', public.push_name(who, p_user) || ' hat „' || ex || '“ schon',
        'body', 'Ihr wolltet es gemeinsam schenken. Sprich dich mit ' || public.push_name(gid, p_user) || ' ab.',
        'url', '#/gemeinsam/' || wid);
    end if;
    return jsonb_build_object('kind', 'have', 'tag', p_tag, 'badge', 0,
      'title', public.push_name(who, p_user) || ' hat „' || ex || '“ schon',
      'body', case when gname = 'gekauft' then 'Du hast es schon gekauft. Vielleicht lässt es sich umtauschen.'
                   else 'Gib die Reservierung frei, falls du es noch nicht gekauft hast.' end,
      'url', '#/');
  elsif p_kind = 'remind' then
    select o.extra::int, o.group_id into k, gid from public.push_outbox o
      where o.user_id = p_user and o.tag = p_tag and o.kind = 'remind' order by o.id desc limit 1;
    -- Seit 1.15: Anlass einer Gruppe (ohne Gruppe = Heiligabend)
    gname := null;
    if gid is not null then
      if not exists (select 1 from public.members m where m.group_id = gid and m.user_id = p_user) then return null; end if;
      execute 'select case when occ_kind = ''sonstiges'' then occ_name
                           when occ_kind = ''geburtstag'' then coalesce(occ_name, ''Geburtstag '' || name) end
               from public.groups where id = $1' into gname using gid;
      if gname is null then return null; end if;
    end if;
    select count(*) into n from public.reservations r join public.wishes w on w.id = r.wish_id
      where r.user_id = p_user and r.status = 'reserviert' and w.have_at is null;
    return jsonb_build_object('kind', 'remind', 'tag', p_tag, 'badge', 0,
      'title', case when gname is not null then (case when k = 1 then 'Morgen: ' else 'Noch ' || k || ' Tage: ' end) || gname
                    when k = 1 then 'Morgen ist Heiligabend' else 'Noch ' || k || ' Tage bis Heiligabend' end,
      'body', case
        when n = 1 then 'Ein reserviertes Geschenk ist noch nicht besorgt.'
        when n > 1 then n || ' reservierte Geschenke sind noch nicht besorgt.'
        when not exists (select 1 from public.wishes w where w.owner = p_user and w.have_at is null)
          then 'Deine Wunschliste ist noch leer. Trag ein, worüber du dich freuen würdest.'
        else 'Schau nach, ob deine Wunschliste vollständig ist.' end,
      'url', case when gid is not null then '#/g/' || gid else '#/' end);
  elsif p_kind = 'pool' then
    return public.pool_message(p_user, p_tag, p_delta);
  elsif p_kind = 'friend' then
    return public.friend_message(p_user, p_tag, p_delta);
  elsif p_kind = 'bday' then
    return public.bday_message(p_user, p_tag);
  elsif p_kind = 'test' then
    return jsonb_build_object('kind', 'test', 'tag', p_tag, 'badge', 0,
      'title', 'Benachrichtigungen sind eingeschaltet',
      'body', 'So sieht eine Nachricht der Geschenkeliste aus.',
      'url', '#/konto');
  end if;
  return null;
end $$;

-- Holt fällige Nachrichten (markiert sie als verschickt) samt Schlüssel und Geräten.
-- Pro Person und Thema höchstens eine Nachricht alle 2 Minuten, der Rest kommt gebündelt hinterher.
create or replace function public.push_claim(p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.push_config;
  ids bigint[];
  items jsonb := '[]'::jsonb;
  g record;
  msg jsonb;
  subs jsonb;
begin
  select * into c from public.push_config where id = 1;
  if not found then return jsonb_build_object('config', null, 'items', '[]'::jsonb); end if;
  update public.push_config set last_run_at = now() where id = 1;
  delete from public.push_outbox where sent_at < now() - interval '7 days';

  with due as (
    select o.id from public.push_outbox o
    where o.sent_at is null
      and not exists (select 1 from public.push_outbox x
                      where x.user_id = o.user_id and x.tag = o.tag and x.sent_at > now() - interval '2 minutes')
    order by o.id limit greatest(1, least(coalesce(p_limit, 100), 500))
    for update skip locked),
  upd as (update public.push_outbox o set sent_at = now() from due where o.id = due.id returning o.id)
  select array_agg(id) into ids from upd;
  if ids is null then return jsonb_build_object('config', null, 'items', '[]'::jsonb); end if;

  for g in select user_id, tag, min(kind) as kind, count(*)::int as delta
           from public.push_outbox where id = any(ids) group by user_id, tag loop
    msg := public.push_message(g.user_id, g.tag, g.kind, g.delta);
    continue when msg is null;
    select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
      into subs from public.push_subs s where s.user_id = g.user_id;
    continue when subs is null;
    items := items || jsonb_build_object('message', msg, 'subs', subs);
  end loop;

  return jsonb_build_object(
    'config', jsonb_build_object('public', c.vapid_public, 'private', c.vapid_private, 'subject', c.subject),
    'items', items);
end $$;

-- Ergebnis des Versands: [{id, status}]. 404/410 = Abo abgelaufen → löschen; nach 5 Fehlern ebenfalls.
create or replace function public.push_report(p_results jsonb, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  st int;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    st := coalesce((r->>'status')::int, 0);
    if st between 200 and 299 then
      update public.push_subs set last_ok_at = now(), fails = 0 where id = (r->>'id')::uuid;
    elsif st in (404, 410) then
      delete from public.push_subs where id = (r->>'id')::uuid;
    else
      update public.push_subs set fails = fails + 1 where id = (r->>'id')::uuid;
      delete from public.push_subs where id = (r->>'id')::uuid and fails >= 5;
    end if;
  end loop;
  update public.push_config set last_error = left(p_error, 500) where id = 1 and p_error is distinct from last_error;
end $$;

-- ---------- Aktionen der App ----------

-- Öffentlicher Schlüssel zum Anmelden eines Geräts (null = noch nicht eingerichtet)
create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = '' as $$
  select vapid_public from public.push_config where id = 1;
$$;

-- Gerät anmelden (ein Gerät gehört immer nur zum zuletzt angemeldeten Konto)
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if p_endpoint is null or char_length(p_endpoint) > 1000 or p_endpoint !~
     '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
  then raise exception 'Push-Adresse ungültig'; end if;
  insert into public.push_subs (user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth)
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
      fails = 0, created_at = case when push_subs.user_id = excluded.user_id then push_subs.created_at else now() end;
  -- höchstens 10 Geräte pro Konto
  delete from public.push_subs where id in (
    select id from public.push_subs where user_id = auth.uid() order by created_at desc offset 10);
end $$;

create or replace function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subs where endpoint = p_endpoint and user_id = auth.uid();
$$;

-- Testnachricht an die eigenen Geräte (höchstens eine pro Minute)
create or replace function public.push_test() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.push_subs where user_id = auth.uid()) then raise exception 'Kein Gerät angemeldet'; end if;
  if not exists (select 1 from public.push_config where id = 1) then raise exception 'Push nicht eingerichtet'; end if;
  insert into public.push_outbox (user_id, kind, ref, tag)
    values (auth.uid(), 'test', to_char(now(), 'YYYYMMDDHH24MI'), 'test') on conflict do nothing;
end $$;

-- Verwaltung: Schlüssel speichern (neue Schlüssel = alle Geräte melden sich beim nächsten Öffnen neu an)
create or replace function public.push_setup(p_public text, p_private text, p_subject text, p_url text, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_app_admin() then raise exception 'Keine Berechtigung'; end if;
  if p_public !~ '^[A-Za-z0-9_-]{87}$' or p_private !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'Schlüssel ungültig'; end if;
  if p_url !~ '^https://[^/]+/functions/v1/[a-z0-9_-]+$' then raise exception 'Adresse ungültig'; end if;
  if p_subject !~ '^(https://|mailto:)' then raise exception 'Absender ungültig'; end if;
  if exists (select 1 from public.push_config where id = 1 and vapid_public <> p_public) then
    delete from public.push_subs where true;  -- Supabase verbietet DELETE ohne WHERE (1.13.1)
  end if;
  insert into public.push_config (id, vapid_public, vapid_private, subject, function_url, api_key)
    values (1, p_public, p_private, p_subject, p_url, p_key)
    on conflict (id) do update set vapid_public = excluded.vapid_public, vapid_private = excluded.vapid_private,
      subject = excluded.subject, function_url = excluded.function_url, api_key = excluded.api_key,
      created_at = case when push_config.vapid_public = excluded.vapid_public then push_config.created_at else now() end,
      last_error = null;
end $$;

-- Verwaltung: Stand der Einrichtung
create or replace function public.push_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.push_config;
begin
  if not public.is_app_admin() then raise exception 'Keine Berechtigung'; end if;
  select * into c from public.push_config where id = 1;
  return jsonb_build_object(
    'configured', found,
    'since', c.created_at,
    'last_run_at', c.last_run_at,
    'last_error', c.last_error,
    'net', to_regnamespace('net') is not null,
    'cron', to_regnamespace('cron') is not null,
    'devices', (select count(*) from public.push_subs),
    'people', (select count(distinct user_id) from public.push_subs),
    'pending', (select count(*) from public.push_outbox where sent_at is null),
    'sent_day', (select count(*) from public.push_outbox where sent_at > now() - interval '1 day'));
end $$;

-- ---------- Zugriffsregeln ----------

alter table public.push_subs enable row level security;
alter table public.push_prefs enable row level security;
alter table public.push_config enable row level security;
alter table public.push_outbox enable row level security;

drop policy if exists "eigene einstellungen lesen" on public.push_prefs;
drop policy if exists "eigene einstellungen anlegen" on public.push_prefs;
drop policy if exists "eigene einstellungen ändern" on public.push_prefs;
create policy "eigene einstellungen lesen" on public.push_prefs for select to authenticated
  using (user_id = auth.uid());
create policy "eigene einstellungen anlegen" on public.push_prefs for insert to authenticated
  with check (user_id = auth.uid());
create policy "eigene einstellungen ändern" on public.push_prefs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- push_subs, push_config, push_outbox: absichtlich keine Regeln = kein direkter Zugriff für die App

revoke all on public.push_subs, public.push_prefs, public.push_config, public.push_outbox from anon, authenticated;
grant select, insert, update on public.push_prefs to authenticated;

revoke execute on function public.push_wants(uuid, text), public.push_name(uuid), public.push_list(text[]),
  public.push_kick(), public.push_on_wish(), public.push_on_wish_group(), public.push_on_wish_friend(), public.push_name(uuid, uuid), public.push_on_member(), public.push_on_draw(),
  public.push_after_queue(), public.push_tick(), public.push_daily(date), public.push_message(uuid, text, text, int),
  public.push_claim(int), public.push_report(jsonb, text), public.push_public_key(),
  public.push_subscribe(text, text, text), public.push_unsubscribe(text), public.push_test(),
  public.push_setup(text, text, text, text, text), public.push_status() from public, anon, authenticated;
grant execute on function public.push_public_key(), public.push_subscribe(text, text, text),
  public.push_unsubscribe(text), public.push_test(), public.push_setup(text, text, text, text, text),
  public.push_status() to authenticated;
do $$ begin
  grant execute on function public.push_claim(int), public.push_report(jsonb, text) to service_role;
exception when undefined_object then raise notice 'Rolle service_role fehlt (nur in Tests)'; end $$;

-- =====================================================================
-- Private Ideenliste (Version 1.11)
-- Geschenkideen für andere. Nur wer sie angelegt hat, sieht sie, niemand sonst
-- (auch nicht die Person selbst, Gruppen-Gründer oder Admins).
-- Eine Person ist entweder jemand aus den eigenen Gruppen (linked_user) oder
-- ein frei angelegter Name für Leute ohne App. Der Name bleibt als Rückfall.
-- =====================================================================

create table if not exists public.idea_people (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  linked_user uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (linked_user is null or linked_user <> owner)
);
create unique index if not exists idea_people_link_idx on public.idea_people(owner, linked_user);
create index if not exists idea_people_owner_idx on public.idea_people(owner);

create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person uuid not null references public.idea_people(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  url text check (url is null or (char_length(url) <= 1000 and url ~* '^https?://')),
  note text check (note is null or char_length(note) <= 1000),
  price numeric(9,2) check (price is null or (price >= 0 and price <= 1000000)),
  category text check (category is null or category ~ '^[a-z]{2,20}$'),
  done_at timestamptz,   -- gesetzt = besorgt
  created_at timestamptz not null default now()
);
create index if not exists ideas_owner_idx on public.ideas(owner);
create index if not exists ideas_person_idx on public.ideas(person);

-- ---------- Prüfungen ----------

-- Verknüpfen nur mit Leuten aus den eigenen Gruppen (beim Anlegen oder Ändern der Verknüpfung),
-- höchstens 200 Personen pro Konto
create or replace function public.idea_people_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.owner <> old.owner then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if new.linked_user is not null and (tg_op = 'INSERT' or new.linked_user is distinct from old.linked_user)
     and not public.knows(new.linked_user) then
    raise exception 'Diese Person ist in keiner deiner Gruppen' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.idea_people where owner = new.owner) >= 200 then
    raise exception 'Höchstens 200 Personen' using errcode = '54000';
  end if;
  return new;
end $$;
drop trigger if exists idea_people_check on public.idea_people;
create trigger idea_people_check before insert or update on public.idea_people
  for each row execute function public.idea_people_check();

-- Ideen nur für eigene Personen, höchstens 1000 pro Konto
create or replace function public.ideas_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'UPDATE' and new.owner <> old.owner)
     or not exists (select 1 from public.idea_people p where p.id = new.person and p.owner = new.owner) then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.ideas where owner = new.owner) >= 1000 then
    raise exception 'Höchstens 1000 Ideen' using errcode = '54000';
  end if;
  return new;
end $$;
drop trigger if exists ideas_check on public.ideas;
create trigger ideas_check before insert or update on public.ideas
  for each row execute function public.ideas_check();

-- ---------- Aktionen der App ----------

-- Selbst angelegte Person mit einem Konto verknüpfen. Gibt es für dieses Konto schon
-- eine Person, wandern deren Ideen mit und der doppelte Eintrag verschwindet.
create or replace function public.idea_link(p_person uuid, p_user uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare v_other uuid;
begin
  if not exists (select 1 from public.idea_people where id = p_person and owner = auth.uid()) then
    raise exception 'Nicht gefunden' using errcode = 'P0002';
  end if;
  if p_user is null then
    update public.idea_people set linked_user = null where id = p_person;
    return;
  end if;
  if not public.knows(p_user) or p_user = auth.uid() then
    raise exception 'Diese Person ist in keiner deiner Gruppen' using errcode = '42501';
  end if;
  select id into v_other from public.idea_people
    where owner = auth.uid() and linked_user = p_user and id <> p_person;
  if v_other is not null then
    update public.ideas set person = p_person where person = v_other;
    delete from public.idea_people where id = v_other;
  end if;
  update public.idea_people set linked_user = p_user where id = p_person;
end $$;

-- ---------- Zugriffsregeln ----------

alter table public.idea_people enable row level security;
alter table public.ideas enable row level security;

drop policy if exists "ideen-personen lesen" on public.idea_people;
drop policy if exists "ideen-person anlegen" on public.idea_people;
drop policy if exists "ideen-person ändern" on public.idea_people;
drop policy if exists "ideen-person löschen" on public.idea_people;
create policy "ideen-personen lesen" on public.idea_people for select to authenticated
  using (owner = auth.uid());
create policy "ideen-person anlegen" on public.idea_people for insert to authenticated
  with check (owner = auth.uid());
create policy "ideen-person ändern" on public.idea_people for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "ideen-person löschen" on public.idea_people for delete to authenticated
  using (owner = auth.uid());

drop policy if exists "ideen lesen" on public.ideas;
drop policy if exists "idee anlegen" on public.ideas;
drop policy if exists "idee ändern" on public.ideas;
drop policy if exists "idee löschen" on public.ideas;
create policy "ideen lesen" on public.ideas for select to authenticated
  using (owner = auth.uid());
create policy "idee anlegen" on public.ideas for insert to authenticated
  with check (owner = auth.uid());
create policy "idee ändern" on public.ideas for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "idee löschen" on public.ideas for delete to authenticated
  using (owner = auth.uid());

revoke all on public.idea_people, public.ideas from anon, authenticated;
grant select, insert, update, delete on public.idea_people, public.ideas to authenticated;

revoke execute on function public.idea_people_check(), public.ideas_check(), public.idea_link(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.idea_link(uuid, uuid) to authenticated;

-- =====================================================================
-- Steckbrief (Version 1.12)
-- Größen, Lieblingsdinge, „Lieber nicht“, „Das freut mich immer“ und „Diese oder jene“.
-- Schlüssel immer „abschnitt.feld“, z. B. sizes.shoe, nope.allergy, either.surprise.
-- Standard: alle aus den eigenen Gruppen sehen ihn. Pro Steckbrief (item 'all'),
-- Abschnitt (z. B. 'sizes') oder Feld (z. B. 'sizes.ring') lassen sich Leute oder
-- Gruppen ausschließen („except“) oder nur bestimmte zulassen („only“).
-- Andere lesen nie die Tabelle selbst, sondern nur gefiltert über card_list().
-- =====================================================================

create table if not exists public.profile_cards (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}',
  stamps jsonb not null default '{}',   -- pro Feld: zuletzt geändert (ISO-Zeit)
  updated_at timestamptz not null default now()
);

create table if not exists public.profile_card_vis (
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item text not null check (item ~ '^(all|[a-z]{2,10}(\.[a-z_]{2,20})?)$'),
  mode text not null check (mode in ('only', 'except')),
  users uuid[] not null default '{}' check (cardinality(users) <= 200),
  groups uuid[] not null default '{}' check (cardinality(groups) <= 200),
  primary key (owner, item)
);

-- ---------- Prüfungen ----------

-- Inhalt: Objekt mit Schlüsseln „abschnitt.feld“; Werte Text (bis 400 Zeichen)
-- oder Liste mit höchstens 30 Texten (je bis 40 Zeichen); insgesamt höchstens 8 KB
create or replace function public.profile_cards_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare e record; x jsonb;
begin
  if tg_op = 'UPDATE' and new.user_id <> old.user_id then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if jsonb_typeof(new.data) <> 'object' or jsonb_typeof(new.stamps) <> 'object'
     or octet_length(new.data::text) > 8000 or octet_length(new.stamps::text) > 8000 then
    raise exception 'Steckbrief ungültig' using errcode = '22023';
  end if;
  for e in select key, value from jsonb_each(new.data) loop
    if e.key !~ '^[a-z]{2,10}\.[a-z_]{2,20}$' then
      raise exception 'Steckbrief ungültig' using errcode = '22023';
    end if;
    if jsonb_typeof(e.value) = 'string' then
      if char_length(e.value #>> '{}') > 400 then raise exception 'Text zu lang' using errcode = '22023'; end if;
    elsif jsonb_typeof(e.value) = 'array' then
      if jsonb_array_length(e.value) > 30 then raise exception 'Zu viele Einträge' using errcode = '22023'; end if;
      for x in select value from jsonb_array_elements(e.value) loop
        if jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') not between 1 and 40 then
          raise exception 'Steckbrief ungültig' using errcode = '22023';
        end if;
      end loop;
    else
      raise exception 'Steckbrief ungültig' using errcode = '22023';
    end if;
  end loop;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profile_cards_check on public.profile_cards;
create trigger profile_cards_check before insert or update on public.profile_cards
  for each row execute function public.profile_cards_check();

-- Höchstens 100 Sichtbarkeits-Regeln pro Konto, Besitzer nicht änderbar
create or replace function public.profile_card_vis_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.owner <> old.owner then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.profile_card_vis where owner = new.owner) >= 100 then
    raise exception 'Höchstens 100 Regeln' using errcode = '54000';
  end if;
  return new;
end $$;
drop trigger if exists profile_card_vis_check on public.profile_card_vis;
create trigger profile_card_vis_check before insert or update on public.profile_card_vis
  for each row execute function public.profile_card_vis_check();

-- ---------- Sichtbarkeit ----------

-- Darf v diesen Teil (item) des Steckbriefs von o sehen? Ohne Regel: ja.
-- only:   v steht in users oder ist in einer der Gruppen (in der auch o ist)
-- except: v steht nicht in users und teilt mit o mindestens eine nicht ausgeschlossene Gruppe
--         oder ist direkt mit o befreundet (seit 1.14)
create or replace function public.card_allowed(o uuid, v uuid, it text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case r.mode
      when 'only' then v = any(r.users) or exists (
        select 1 from public.members a join public.members b on b.group_id = a.group_id
        where a.user_id = o and b.user_id = v and a.group_id = any(r.groups))
      else not (v = any(r.users)) and (public.are_friends(o, v) or exists (
        select 1 from public.members a join public.members b on b.group_id = a.group_id
        where a.user_id = o and b.user_id = v and not (a.group_id = any(r.groups))))
    end
    from public.profile_card_vis r where r.owner = o and r.item = it), true);
$$;

-- Alle Steckbriefe, die ich sehen darf: {uid: {d: {feld: wert}, s: {feld: zeit}}}.
-- Ausgeblendete Felder fehlen einfach (niemand erfährt, dass es sie gibt).
create or replace function public.card_list() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.user_id, jsonb_build_object('d', f.d, 's', f.s)), '{}'::jsonb)
  from public.profile_cards c
  cross join lateral (
    select jsonb_object_agg(e.key, e.value) as d,
           jsonb_object_agg(e.key, coalesce(c.stamps -> e.key, 'null'::jsonb)) as s
    from jsonb_each(c.data) e
    where public.card_allowed(c.user_id, auth.uid(), split_part(e.key, '.', 1))
      and public.card_allowed(c.user_id, auth.uid(), e.key)) f
  where auth.uid() is not null and c.user_id <> auth.uid()
    and public.knows(c.user_id)
    and public.card_allowed(c.user_id, auth.uid(), 'all')
    and f.d is not null;
$$;

-- ---------- Aktionen der App ----------

-- Ein Feld setzen (leer, null oder [] = entfernen). Merkt sich, wann es geändert wurde.
create or replace function public.card_put(p_key text, p_val jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare v_del boolean := p_val is null or p_val = 'null'::jsonb or p_val = '""'::jsonb or p_val = '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet' using errcode = '42501'; end if;
  insert into public.profile_cards (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  update public.profile_cards set
    data = case when v_del then data - p_key else data || jsonb_build_object(p_key, p_val) end,
    stamps = case when v_del then stamps - p_key else stamps || jsonb_build_object(p_key, now()) end
  where user_id = auth.uid();
end $$;

-- ---------- Zugriffsregeln ----------

alter table public.profile_cards enable row level security;
alter table public.profile_card_vis enable row level security;

drop policy if exists "steckbrief lesen" on public.profile_cards;
drop policy if exists "steckbrief anlegen" on public.profile_cards;
drop policy if exists "steckbrief ändern" on public.profile_cards;
drop policy if exists "steckbrief löschen" on public.profile_cards;
create policy "steckbrief lesen" on public.profile_cards for select to authenticated
  using (user_id = auth.uid());
create policy "steckbrief anlegen" on public.profile_cards for insert to authenticated
  with check (user_id = auth.uid());
create policy "steckbrief ändern" on public.profile_cards for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "steckbrief löschen" on public.profile_cards for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "sichtbarkeit lesen" on public.profile_card_vis;
drop policy if exists "sichtbarkeit anlegen" on public.profile_card_vis;
drop policy if exists "sichtbarkeit ändern" on public.profile_card_vis;
drop policy if exists "sichtbarkeit löschen" on public.profile_card_vis;
create policy "sichtbarkeit lesen" on public.profile_card_vis for select to authenticated
  using (owner = auth.uid());
create policy "sichtbarkeit anlegen" on public.profile_card_vis for insert to authenticated
  with check (owner = auth.uid());
create policy "sichtbarkeit ändern" on public.profile_card_vis for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "sichtbarkeit löschen" on public.profile_card_vis for delete to authenticated
  using (owner = auth.uid());

revoke all on public.profile_cards, public.profile_card_vis from anon, authenticated;
grant select, insert, update, delete on public.profile_cards, public.profile_card_vis to authenticated;

revoke execute on function public.profile_cards_check(), public.profile_card_vis_check(),
  public.card_allowed(uuid, uuid, text), public.card_list(), public.card_put(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.card_list(), public.card_put(text, jsonb) to authenticated;

-- =====================================================================
-- Gemeinsam schenken (Version 1.13)
-- Mehrere legen für einen Wunsch zusammen. Wer startet, reserviert den Wunsch und kauft
-- (die Rolle lässt sich an jemanden abgeben, der mitmacht). Die beschenkte Person sieht nichts davon.
-- Aufteilung: equal = gleich, budget = jeder nennt einen Höchstbetrag, custom = jeder seinen Betrag.
-- Betrag leer = flexibel (bei budget ohne Grenze, bei custom teilen sich alle Flexiblen den Rest).
-- Optional Mindestzahl und Frist: Danach entscheidet der Käufer (trotzdem, verlängern, absagen).
-- Ändern nur über die Funktionen unten, lesen dürfen nur Eingeladene und Beteiligte.
-- =====================================================================

create table if not exists public.gift_pools (
  wish_id uuid primary key references public.reservations(wish_id) on delete cascade,
  buyer uuid not null references auth.users(id) on delete cascade,   -- kauft und streckt vor (= Reservierung)
  created_by uuid references auth.users(id) on delete set null,
  total numeric(9,2) not null check (total > 0 and total <= 1000000),
  split text not null default 'equal' check (split in ('equal', 'budget', 'custom')),
  open boolean not null default true,          -- true: alle, die den Wunsch sehen; false: nur invited
  invited uuid[] not null default '{}' check (cardinality(invited) <= 60),
  min_people smallint check (min_people is null or min_people between 2 and 30),
  deadline date,
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists gift_pools_buyer_idx on public.gift_pools(buyer);

create table if not exists public.gift_shares (
  wish_id uuid not null references public.gift_pools(wish_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(9,2) check (amount is null or (amount > 0 and amount <= 1000000)),
  paid_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (wish_id, user_id)
);
create index if not exists gift_shares_user_idx on public.gift_shares(user_id);

-- ---------- Hilfen ----------

-- wish_visible_to(w, u) steht seit 1.14 oben bei den Hilfsfunktionen (mit Freunden)

create or replace function public.pool_member(w uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.gift_shares where wish_id = w and user_id = u);
$$;

-- Darf u das gemeinsame Geschenk sehen? Nur wer den Wunsch sieht und gefragt ist (offen, eingeladen, dabei, Käufer)
create or replace function public.pool_visible_to(w uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.gift_pools p
    where p.wish_id = w and public.wish_visible_to(w, u)
      and (p.open or p.buyer = u or u = any(p.invited) or public.pool_member(w, u)));
$$;

create or replace function public.pool_visible(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.pool_visible_to(w, auth.uid());
$$;

-- Wer gefragt wird: offen = alle, die den Wunsch sehen; sonst nur die Eingeladenen (die ihn auch sehen)
create or replace function public.pool_audience(w uuid, p_open boolean, p_invited uuid[]) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.u from (
    select m.user_id as u
    from public.wishes x
    join public.members mo on mo.user_id = x.owner
    join public.members m on m.group_id = mo.group_id
    where x.id = w
    union
    select case when f.a = x.owner then f.b else f.a end
    from public.wishes x
    join public.friendships f on f.a = x.owner or f.b = x.owner
    where x.id = w) c
  where public.wish_visible_to(w, c.u)
    and (p_open or c.u = any(coalesce(p_invited, '{}')));
$$;

create or replace function public.pool_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Europe/Berlin')::date;
$$;

-- Eingeladene bereinigen und prüfen (ohne Doppelte, ohne mich und die beschenkte Person)
create or replace function public.pool_clean_invited(w uuid, p uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  res uuid[];
begin
  select coalesce(array_agg(distinct u), '{}') into res from unnest(coalesce(p, '{}')) u
    where u is not null and u <> auth.uid();
  if cardinality(res) > 60 then raise exception 'Zu viele Eingeladene' using errcode = '54000'; end if;
  if exists (select 1 from unnest(res) u where not public.wish_visible_to(w, u)) then
    raise exception 'Person sieht den Wunsch nicht' using errcode = '22023';
  end if;
  return res;
end $$;

create or replace function public.pool_check(p_split text, p_min int, p_deadline date, p_open boolean, p_invited uuid[]) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_split is null or p_split not in ('equal', 'budget', 'custom') then raise exception 'Aufteilung ungültig' using errcode = '22023'; end if;
  if p_min is not null and p_min <> 0 and p_min not between 2 and 30 then raise exception 'Mindestzahl ungültig' using errcode = '22023'; end if;
  if p_deadline is not null and (p_deadline < public.pool_today() or p_deadline > public.pool_today() + 366) then
    raise exception 'Frist ungültig' using errcode = '22023';
  end if;
  if p_open is false and cardinality(coalesce(p_invited, '{}')) = 0 then raise exception 'Niemand ausgewählt' using errcode = '22023'; end if;
end $$;

-- ---------- Aktionen der App ----------

-- Starten: reserviert den Wunsch (oder übernimmt die eigene Reservierung) und macht selbst mit
create or replace function public.pool_start(p_wish uuid, p_total numeric, p_split text, p_amount numeric,
  p_open boolean, p_invited uuid[], p_min int, p_deadline date, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  holder uuid;
  inv uuid[];
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet' using errcode = '42501'; end if;
  if not public.wish_visible_to(p_wish, auth.uid()) then raise exception 'Keine Berechtigung' using errcode = '42501'; end if;
  if not public.wish_open(p_wish) then raise exception 'Hat die Person schon' using errcode = '22023'; end if;
  if exists (select 1 from public.gift_pools where wish_id = p_wish) then raise exception 'Läuft schon' using errcode = '23505'; end if;
  if (select count(*) from public.gift_pools where buyer = auth.uid()) >= 50 then raise exception 'Zu viele gemeinsame Geschenke' using errcode = '54000'; end if;
  inv := public.pool_clean_invited(p_wish, p_invited);
  perform public.pool_check(p_split, p_min, p_deadline, p_open, inv);
  select user_id into holder from public.reservations where wish_id = p_wish for update;
  if holder is not null and holder <> auth.uid() then raise exception 'Schon reserviert' using errcode = '23505'; end if;
  if holder is null then insert into public.reservations (wish_id, user_id) values (p_wish, auth.uid()); end if;
  insert into public.gift_pools (wish_id, buyer, created_by, total, split, open, invited, min_people, deadline, note)
    values (p_wish, auth.uid(), auth.uid(), p_total, p_split, coalesce(p_open, true), inv,
            nullif(p_min, 0), p_deadline, nullif(btrim(coalesce(p_note, '')), ''));
  insert into public.gift_shares (wish_id, user_id, amount) values (p_wish, auth.uid(), p_amount);
end $$;

-- Ändern (nur der Käufer): Betrag, Aufteilung, wer gefragt ist, Mindestzahl, Frist, Notiz
create or replace function public.pool_update(p_wish uuid, p_total numeric, p_split text,
  p_open boolean, p_invited uuid[], p_min int, p_deadline date, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  inv uuid[];
  old_deadline date;
begin
  select deadline into old_deadline from public.gift_pools where wish_id = p_wish and buyer = auth.uid();
  if not found then raise exception 'Keine Berechtigung' using errcode = '42501'; end if;
  inv := public.pool_clean_invited(p_wish, p_invited);
  -- eine schon abgelaufene Frist darf stehen bleiben
  perform public.pool_check(p_split, p_min, case when p_deadline = old_deadline then null else p_deadline end, p_open, inv);
  update public.gift_pools set total = p_total, split = p_split, open = coalesce(p_open, true), invited = inv,
    min_people = nullif(p_min, 0), deadline = p_deadline, note = nullif(btrim(coalesce(p_note, '')), '')
  where wish_id = p_wish;
end $$;

-- Mitmachen oder eigenen Betrag ändern (Betrag leer = flexibel)
create or replace function public.pool_join(p_wish uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.gift_pools;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet' using errcode = '42501'; end if;
  select * into p from public.gift_pools where wish_id = p_wish;
  if not found or not public.pool_visible(p_wish) then raise exception 'Keine Berechtigung' using errcode = '42501'; end if;
  if public.pool_member(p_wish, auth.uid()) then
    update public.gift_shares set amount = p_amount where wish_id = p_wish and user_id = auth.uid();
    return;
  end if;
  if p.deadline is not null and p.deadline < public.pool_today() then raise exception 'Frist abgelaufen' using errcode = '22023'; end if;
  if (select count(*) from public.gift_shares where wish_id = p_wish) >= 30 then raise exception 'Gemeinsam voll' using errcode = '54000'; end if;
  insert into public.gift_shares (wish_id, user_id, amount) values (p_wish, auth.uid(), p_amount);
end $$;

create or replace function public.pool_leave(p_wish uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.gift_pools where wish_id = p_wish and buyer = auth.uid()) then
    raise exception 'Käufer kann nicht austreten' using errcode = '22023';
  end if;
  delete from public.gift_shares where wish_id = p_wish and user_id = auth.uid();
end $$;

-- „Bezahlt“ abhaken: für sich selbst oder als Käufer für alle
create or replace function public.pool_paid(p_wish uuid, p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (p_user = auth.uid() or exists (select 1 from public.gift_pools where wish_id = p_wish and buyer = auth.uid())) then
    raise exception 'Keine Berechtigung' using errcode = '42501';
  end if;
  update public.gift_shares set paid_at = case when p_on then coalesce(paid_at, now()) end
    where wish_id = p_wish and user_id = p_user;
  if not found then raise exception 'Keine Berechtigung' using errcode = '42501'; end if;
end $$;

-- Käufer-Rolle abgeben (an jemanden, der mitmacht); die Reservierung wandert mit
create or replace function public.pool_handover(p_wish uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.gift_pools where wish_id = p_wish and buyer = auth.uid()) then
    raise exception 'Keine Berechtigung' using errcode = '42501';
  end if;
  if p_user = auth.uid() or not public.pool_member(p_wish, p_user) or not public.wish_visible_to(p_wish, p_user) then
    raise exception 'Macht nicht mit' using errcode = '22023';
  end if;
  update public.reservations set user_id = p_user where wish_id = p_wish;
  update public.gift_pools set buyer = p_user where wish_id = p_wish;
end $$;

-- Absagen (nur der Käufer): Reservierung weg, Wunsch wieder frei
create or replace function public.pool_cancel(p_wish uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.gift_pools where wish_id = p_wish and buyer = auth.uid()) then
    raise exception 'Keine Berechtigung' using errcode = '42501';
  end if;
  delete from public.reservations where wish_id = p_wish;
end $$;

-- ---------- Benachrichtigungen ----------

-- Gefragt werden (beim Start, beim Öffnen für alle, für neu Eingeladene)
create or replace function public.push_on_pool() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.open is not distinct from old.open and new.invited is not distinct from old.invited then
    return null;
  end if;
  insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id, extra)
    select u, 'pool', new.wish_id || ':ask:' || floor(extract(epoch from new.created_at)), 'pool-ask-' || new.wish_id,
           new.buyer, new.wish_id, 'ask'
    from public.pool_audience(new.wish_id, new.open, new.invited) u
    where u <> new.buyer and not public.pool_member(new.wish_id, u)
      and (tg_op = 'INSERT' or u not in (select public.pool_audience(old.wish_id, old.open, old.invited)))
      and public.push_wants(u, 'pool')
    on conflict do nothing;
  return null;
end $$;
drop trigger if exists push_pool on public.gift_pools;
create trigger push_pool after insert or update of open, invited on public.gift_pools
  for each row execute function public.push_on_pool();

-- Jemand macht mit → an den Käufer (gebündelt)
create or replace function public.push_on_share() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id, extra)
    select p.buyer, 'pool', new.wish_id || ':join:' || new.user_id || ':' || floor(extract(epoch from p.created_at)),
           'pool-join-' || new.wish_id, new.user_id, new.wish_id, 'join'
    from public.gift_pools p
    where p.wish_id = new.wish_id and p.buyer <> new.user_id and public.push_wants(p.buyer, 'pool')
    on conflict do nothing;
  return null;
end $$;
drop trigger if exists push_share on public.gift_shares;
create trigger push_share after insert on public.gift_shares
  for each row execute function public.push_on_share();

-- Gekauft (an alle, die mitmachen) und Käufer gewechselt (an den neuen)
create or replace function public.push_on_pool_res() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'gekauft' and old.status is distinct from 'gekauft' then
    insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id, extra)
      select s.user_id, 'pool', new.wish_id || ':bought:' || floor(extract(epoch from p.created_at)),
             'pool-bought-' || new.wish_id, new.user_id, new.wish_id, 'bought'
      from public.gift_pools p join public.gift_shares s on s.wish_id = p.wish_id
      where p.wish_id = new.wish_id and s.user_id <> new.user_id and public.push_wants(s.user_id, 'pool')
      on conflict do nothing;
  end if;
  if new.user_id is distinct from old.user_id then
    insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id, extra)
      select new.user_id, 'pool', new.wish_id || ':buyer:' || new.user_id || ':' || floor(extract(epoch from now())),
             'pool-buyer-' || new.wish_id, old.user_id, new.wish_id, 'buyer'
      from public.gift_pools p
      where p.wish_id = new.wish_id and public.push_wants(new.user_id, 'pool')
      on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists push_pool_res on public.reservations;
create trigger push_pool_res after update of status, user_id on public.reservations
  for each row execute function public.push_on_pool_res();

-- Abgesagt (oder der Wunsch ist weg) → an alle, die mitmachen, außer wer es auslöst.
-- Titel und Namen werden jetzt gemerkt, weil Wunsch und Gemeinschaft beim Versand nicht mehr da sind.
create or replace function public.push_on_pool_end() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  info jsonb;
begin
  select jsonb_build_object('t', w.title, 'o', public.push_name(w.owner), 'b', public.push_name(old.buyer))
    into info from public.wishes w where w.id = old.wish_id;
  insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id, extra, info)
    select s.user_id, 'pool', old.wish_id || ':cancel:' || floor(extract(epoch from old.created_at)),
           'pool-cancel-' || old.wish_id, auth.uid(), old.wish_id, case when info is null then 'gone' else 'cancel' end, info
    from public.gift_shares s
    where s.wish_id = old.wish_id and s.user_id is distinct from auth.uid() and public.push_wants(s.user_id, 'pool')
    on conflict do nothing;
  return old;
end $$;
drop trigger if exists push_pool_end on public.gift_pools;
create trigger push_pool_end before delete on public.gift_pools
  for each row execute function public.push_on_pool_end();

-- Täglich (aus push_daily): Frist gestern abgelaufen und zu wenige dabei → an den Käufer
create or replace function public.pool_due(p_today date) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  insert into public.push_outbox (user_id, kind, ref, tag, wish_id, extra)
    select p.buyer, 'pool', p.wish_id || ':due:' || p.deadline, 'pool-due-' || p.wish_id, p.wish_id, 'due'
    from public.gift_pools p
    where p.deadline = p_today - 1 and p.min_people is not null
      and (select count(*) from public.gift_shares s where s.wish_id = p.wish_id) < p.min_people
      and public.push_wants(p.buyer, 'pool')
    on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Text zum Zeitpunkt des Versands (null = nichts mehr zu sagen)
create or replace function public.pool_message(p_user uuid, p_tag text, p_delta int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o public.push_outbox;
  p public.gift_pools;
  t text;
  owner uuid;
  n int;
  names text[];
  url text;
begin
  select * into o from public.push_outbox x
    where x.user_id = p_user and x.tag = p_tag and x.kind = 'pool' order by x.id desc limit 1;
  if not found then return null; end if;
  if o.extra in ('cancel', 'gone') then
    return jsonb_build_object('kind', 'pool', 'tag', p_tag, 'badge', 0,
      'title', 'Gemeinsames Geschenk abgesagt',
      'body', case when o.extra = 'gone' then 'Der Wunsch steht nicht mehr auf der Liste.'
                   else '„' || (o.info ->> 't') || '“ für ' || (o.info ->> 'o') || '. Abgesagt von ' || (o.info ->> 'b') || '.' end,
      'url', '#/');
  end if;
  select * into p from public.gift_pools where wish_id = o.wish_id;
  if not found or not public.pool_visible_to(o.wish_id, p_user) then return null; end if;
  select w.title, w.owner into t, owner from public.wishes w where w.id = o.wish_id;
  select count(*) into n from public.gift_shares where wish_id = o.wish_id;
  url := '#/gemeinsam/' || o.wish_id;
  if o.extra = 'ask' then
    if public.pool_member(o.wish_id, p_user) then return null; end if;
    return jsonb_build_object('kind', 'pool', 'tag', p_tag, 'badge', 1,
      'title', public.push_name(p.buyer, p_user) || ' fragt, ob du mitmachst',
      'body', '„' || t || '“ gemeinsam für ' || public.push_name(owner, p_user) || ' schenken',
      'url', url);
  elsif o.extra = 'join' then
    if p.buyer <> p_user then return null; end if;
    select array_agg(public.push_name(x.actor, p_user) order by x.id) into names
      from public.push_outbox x
      where x.user_id = p_user and x.tag = p_tag and x.sent_at is not null and x.created_at > now() - interval '1 hour'
        and public.pool_member(o.wish_id, x.actor);
    if coalesce(cardinality(names), 0) = 0 then return null; end if;
    return jsonb_build_object('kind', 'pool', 'tag', p_tag, 'badge', 0,
      'title', case when cardinality(names) = 1 then names[1] || ' macht mit' else public.push_list(names) || ' machen mit' end,
      'body', '„' || t || '“ für ' || public.push_name(owner, p_user) || ' · ' || n || ' dabei',
      'url', url);
  elsif o.extra = 'bought' then
    if not public.pool_member(o.wish_id, p_user) or p.buyer = p_user then return null; end if;
    return jsonb_build_object('kind', 'pool', 'tag', p_tag, 'badge', 0,
      'title', public.push_name(p.buyer, p_user) || ' hat „' || t || '“ gekauft',
      'body', 'Gemeinsames Geschenk für ' || public.push_name(owner, p_user) || '. Denk an deinen Anteil.',
      'url', url);
  elsif o.extra = 'buyer' then
    if p.buyer <> p_user then return null; end if;
    return jsonb_build_object('kind', 'pool', 'tag', p_tag, 'badge', 0,
      'title', 'Du kaufst jetzt „' || t || '“',
      'body', public.push_name(o.actor, p_user) || ' hat dir das gemeinsame Geschenk für ' || public.push_name(owner, p_user) || ' übergeben.',
      'url', url);
  elsif o.extra = 'due' then
    if p.buyer <> p_user or p.min_people is null or n >= p.min_people then return null; end if;
    return jsonb_build_object('kind', 'pool', 'tag', p_tag, 'badge', 0,
      'title', 'Frist für „' || t || '“ ist um',
      'body', n || ' von ' || p.min_people || ' dabei. Entscheide, wie es weitergeht.',
      'url', url);
  end if;
  return null;
end $$;

-- ---------- Zugriffsregeln ----------

alter table public.gift_pools enable row level security;
alter table public.gift_shares enable row level security;

drop policy if exists "gemeinsam lesen" on public.gift_pools;
drop policy if exists "anteile lesen" on public.gift_shares;
create policy "gemeinsam lesen" on public.gift_pools for select to authenticated
  using (public.pool_visible(wish_id));
create policy "anteile lesen" on public.gift_shares for select to authenticated
  using (public.pool_visible(wish_id));
-- Schreiben nur über die Funktionen oben

revoke all on public.gift_pools, public.gift_shares from anon, authenticated;
grant select on public.gift_pools, public.gift_shares to authenticated;

revoke execute on function public.wish_visible_to(uuid, uuid), public.pool_member(uuid, uuid),
  public.pool_visible_to(uuid, uuid), public.pool_visible(uuid), public.pool_audience(uuid, boolean, uuid[]),
  public.pool_today(), public.pool_clean_invited(uuid, uuid[]), public.pool_check(text, int, date, boolean, uuid[]),
  public.pool_start(uuid, numeric, text, numeric, boolean, uuid[], int, date, text),
  public.pool_update(uuid, numeric, text, boolean, uuid[], int, date, text),
  public.pool_join(uuid, numeric), public.pool_leave(uuid), public.pool_paid(uuid, uuid, boolean),
  public.pool_handover(uuid, uuid), public.pool_cancel(uuid),
  public.push_on_pool(), public.push_on_share(), public.push_on_pool_res(), public.push_on_pool_end(),
  public.pool_due(date), public.pool_message(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.pool_visible(uuid),
  public.pool_start(uuid, numeric, text, numeric, boolean, uuid[], int, date, text),
  public.pool_update(uuid, numeric, text, boolean, uuid[], int, date, text),
  public.pool_join(uuid, numeric), public.pool_leave(uuid), public.pool_paid(uuid, uuid, boolean),
  public.pool_handover(uuid, uuid), public.pool_cancel(uuid) to authenticated;

-- =====================================================================
-- Konto löschen (Version 1.13.1)
-- Löscht das eigene Konto mit allem, was daran hängt (Wünsche, Reservierungen,
-- Ideen, Steckbrief, Geräte). Vorher werden alle Gruppen verlassen, damit
-- gegründete Gruppen an das nächste Mitglied gehen statt mitgelöscht zu werden.
-- Die letzte Person mit Verwaltungsrechten kann sich nicht löschen.
-- =====================================================================

create or replace function public.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  g uuid;
  uname text;
begin
  if uid is null then raise exception 'Nicht angemeldet'; end if;
  if exists (select 1 from public.app_admins where user_id = uid)
     and not exists (select 1 from public.app_admins where user_id <> uid) then
    raise exception 'Du verwaltest die App als Einzige. Trag erst eine andere Person als Admin ein.';
  end if;
  for g in select group_id from public.members where user_id = uid loop
    perform public.leave_group(g);
  end loop;
  -- Gruppen ohne Mitgliedschaft (sollte es nicht geben): übergeben oder löschen
  update public.groups gr set created_by = (
      select m.user_id from public.members m where m.group_id = gr.id order by m.joined_at, m.user_id limit 1)
    where gr.created_by = uid and exists (select 1 from public.members m where m.group_id = gr.id);
  delete from public.groups where created_by = uid;
  select username into uname from public.accounts where user_id = uid;
  if uname is not null then delete from public.login_attempts where username = uname; end if;
  delete from public.push_outbox where actor = uid and sent_at is null;
  delete from auth.users where id = uid;
end $$;

revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- =====================================================================
-- Direkte Freundschaft (Version 1.14)
-- Befreundet sein ohne gemeinsame Gruppe. Zwei Wege:
--  1. Persönlicher Freundes-Link (Code): Wer ihn öffnet und bestätigt, ist sofort befreundet.
--     Der Code lässt sich jederzeit neu erzeugen, der alte gilt dann nicht mehr.
--  2. Anfrage per exaktem Benutzernamen (oder an jemanden, den man schon kennt), die
--     angenommen werden muss. Keine Suche: Ob es einen Benutzernamen gibt, erfährt niemand,
--     eine Anfrage an einen unbekannten Namen „wartet“ einfach. Abgelehnte Anfragen sieht der
--     Absender weiter als wartend.
-- Freunde sehen sich gegenseitig (Name, Wünsche nach Freigabe, Steckbrief nach Regeln).
-- Dazu Spitznamen: eigene Bezeichnung für andere, nur für mich sichtbar.
-- Tabellen friendships und wish_friends stehen oben (werden für die Sichtbarkeit gebraucht).
-- =====================================================================

create table if not exists public.friend_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references auth.users(id) on delete cascade,
  to_user uuid references auth.users(id) on delete cascade,      -- null = Benutzername gibt es nicht
  to_name text check (to_name is null or char_length(to_name) <= 24),  -- eingegebener Benutzername
  created_at timestamptz not null default now(),
  declined_at timestamptz,
  check (to_user is not null or to_name is not null),
  check (to_user is distinct from from_user)
);
create unique index if not exists friend_requests_uniq on public.friend_requests
  (from_user, coalesce(to_name, ''), coalesce(to_user, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists friend_requests_to_idx on public.friend_requests(to_user);

create table if not exists public.nicknames (
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nick text not null check (char_length(btrim(nick)) between 1 and 40),
  created_at timestamptz not null default now(),
  primary key (owner, user_id),
  check (owner <> user_id)
);

-- ---------- Prüfungen ----------

-- Spitznamen nur für Leute, die ich sehe; höchstens 500
create or replace function public.nicknames_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.owner <> old.owner or new.user_id <> old.user_id) then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if not public.profile_visible(new.user_id) then
      raise exception 'Diese Person kennst du nicht' using errcode = '42501';
    end if;
    if (select count(*) from public.nicknames where owner = new.owner) >= 500 then
      raise exception 'Höchstens 500 Spitznamen' using errcode = '54000';
    end if;
  end if;
  new.nick := btrim(new.nick);
  return new;
end $$;
drop trigger if exists nicknames_check on public.nicknames;
create trigger nicknames_check before insert or update on public.nicknames
  for each row execute function public.nicknames_check();

-- ---------- interne Hilfen ----------

-- Befreunden (beide Richtungen, Anfragen zwischen beiden fallen weg). true = neu befreundet.
create or replace function public.friend_make(x uuid, y uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if x is null or y is null or x = y then raise exception 'Das bist du' using errcode = '22023'; end if;
  delete from public.friend_requests
    where (from_user = x and to_user = y) or (from_user = y and to_user = x);
  if public.are_friends(x, y) then return false; end if;
  if (select count(*) from public.friendships where a = x or b = x) >= 500
     or (select count(*) from public.friendships where a = y or b = y) >= 500 then
    raise exception 'Zu viele Freunde' using errcode = '54000';
  end if;
  insert into public.friendships (a, b) values (least(x, y), greatest(x, y)) on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Benachrichtigung „ihr seid befreundet“ an u (actor = die andere Person)
create or replace function public.friend_notify_ok(u uuid, actor uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.push_outbox (user_id, kind, ref, tag, actor)
    select u, 'friend', 'ok:' || actor, 'friend-ok-' || actor, actor
    where public.push_wants(u, 'friend')
    on conflict (user_id, kind, ref) do update set sent_at = null, created_at = now()
      where public.push_outbox.sent_at < now() - interval '1 day';
$$;

-- ---------- Aktionen der App ----------

-- Eigener Freundes-Code (legt ihn beim ersten Mal an; p_new = neuen erzeugen, alter gilt nicht mehr)
create or replace function public.friend_code(p_new boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare c text;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if not coalesce(p_new, false) then
    select code into c from public.friend_codes where user_id = auth.uid();
    if c is not null then return c; end if;
  end if;
  loop
    c := left(public.random_code(), 12);
    exit when not exists (select 1 from public.friend_codes where code = c);
  end loop;
  insert into public.friend_codes (user_id, code) values (auth.uid(), c)
    on conflict (user_id) do update set code = excluded.code, created_at = now();
  return c;
end $$;

-- Wem gehört der Code? (für die Bestätigungsseite) null = gibt es nicht
create or replace function public.friend_peek(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select user_id into u from public.friend_codes where code = public.norm_code(p_code);
  if u is null then return null; end if;
  return jsonb_build_object('user', u, 'name', coalesce(nullif((select name from public.profiles where id = u), ''), 'Jemand'),
    'self', u = auth.uid(), 'friends', public.are_friends(u, auth.uid()));
end $$;

-- Freundes-Link bestätigen: sofort befreundet
create or replace function public.friend_accept_code(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select user_id into u from public.friend_codes where code = public.norm_code(p_code);
  if u is null then raise exception 'Freundes-Code nicht gefunden' using errcode = 'P0002'; end if;
  if u = auth.uid() then raise exception 'Das bist du' using errcode = '22023'; end if;
  if public.friend_make(u, auth.uid()) then perform public.friend_notify_ok(u, auth.uid()); end if;
  return u;
end $$;

-- Anfrage stellen (gemeinsamer Teil). Ergebnis: 'sent', 'friends' (schon befreundet), 'accepted' (Gegenanfrage lag vor)
create or replace function public.friend_ask(p_to uuid, p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  rid uuid;
begin
  if p_to = me then raise exception 'Das bist du' using errcode = '22023'; end if;
  if p_to is not null and public.are_friends(me, p_to) then return 'friends'; end if;
  -- Hat die Person mich schon gefragt (und nicht abgelehnt)? Dann gleich befreundet.
  if p_to is not null and exists (select 1 from public.friend_requests
       where from_user = p_to and to_user = me and declined_at is null) then
    perform public.friend_make(me, p_to);
    perform public.friend_notify_ok(p_to, me);
    return 'accepted';
  end if;
  if exists (select 1 from public.friend_requests where from_user = me
       and coalesce(to_name, '') = coalesce(p_name, '') and to_user is not distinct from p_to) then
    return 'sent';
  end if;
  if (select count(*) from public.friend_requests where from_user = me and created_at > now() - interval '1 day') >= 20
     or (select count(*) from public.friend_requests where from_user = me) >= 100 then
    raise exception 'Zu viele Anfragen' using errcode = '54000';
  end if;
  insert into public.friend_requests (from_user, to_user, to_name) values (me, p_to, p_name) returning id into rid;
  if p_to is not null and public.push_wants(p_to, 'friend') then
    insert into public.push_outbox (user_id, kind, ref, tag, actor)
      values (p_to, 'friend', 'req:' || rid, 'friend-req', me) on conflict do nothing;
  end if;
  return 'sent';
end $$;

-- Anfrage per Benutzername (genau, ohne Suche; verrät nicht, ob es ihn gibt)
create or replace function public.friend_request(p_username text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  n text := lower(btrim(regexp_replace(coalesce(p_username, ''), '^@', '')));
  u uuid;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if n !~ '^[a-z0-9][a-z0-9._-]{2,23}$' then raise exception 'Benutzername ungültig' using errcode = '22023'; end if;
  select user_id into u from public.accounts where username = n;
  return public.friend_ask(u, n);
end $$;

-- Anfrage an jemanden, den ich schon sehe (z. B. aus einer Gruppe)
create or replace function public.friend_request_user(p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if p_user is null or not public.profile_visible(p_user) then raise exception 'Keine Berechtigung' using errcode = '42501'; end if;
  return public.friend_ask(p_user, null);
end $$;

-- Anfrage annehmen oder ablehnen (nur wer gefragt wurde)
create or replace function public.friend_answer(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.friend_requests;
begin
  select * into r from public.friend_requests where id = p_id and to_user = auth.uid();
  if not found then raise exception 'Anfrage nicht gefunden' using errcode = 'P0002'; end if;
  if p_accept then
    if public.friend_make(r.from_user, auth.uid()) then perform public.friend_notify_ok(r.from_user, auth.uid()); end if;
  else
    update public.friend_requests set declined_at = now() where id = p_id;
  end if;
end $$;

-- Eigene Anfrage zurückziehen
create or replace function public.friend_withdraw(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.friend_requests where id = p_id and from_user = auth.uid();
$$;

-- Freundschaft beenden: auch die Einzel-Freigaben von Wünschen in beide Richtungen fallen weg
create or replace function public.friend_remove(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Nicht angemeldet'; end if;
  delete from public.friendships where a = least(me, p_user) and b = greatest(me, p_user);
  delete from public.wish_friends wf using public.wishes w
    where wf.wish_id = w.id and ((w.owner = me and wf.user_id = p_user) or (w.owner = p_user and wf.user_id = me));
  delete from public.friend_requests
    where (from_user = me and to_user = p_user) or (from_user = p_user and to_user = me);
end $$;

-- Offene Anfragen: an mich (mit Absender) und von mir (Benutzername bzw. Person, die ich schon kannte)
create or replace function public.friend_requests_list() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'in', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'user', r.from_user, 'at', r.created_at) order by r.created_at desc)
      from public.friend_requests r where r.to_user = auth.uid() and r.declined_at is null), '[]'::jsonb),
    'out', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.to_name,
        'user', case when r.to_name is null then r.to_user end, 'at', r.created_at) order by r.created_at desc)
      from public.friend_requests r where r.from_user = auth.uid()), '[]'::jsonb));
$$;

-- Text der Benachrichtigung (beim Versand)
create or replace function public.friend_message(p_user uuid, p_tag text, p_delta int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  names text[];
  n int;
  who uuid;
begin
  if p_tag = 'friend-req' then
    select array_agg(public.push_name(o.actor, p_user) order by o.id), count(*)
      into names, n
      from public.push_outbox o
      where o.user_id = p_user and o.tag = p_tag and o.kind = 'friend' and o.sent_at is not null
        and o.created_at > now() - interval '1 hour'
        and exists (select 1 from public.friend_requests r
                    where r.from_user = o.actor and r.to_user = p_user and r.declined_at is null);
    if coalesce(n, 0) = 0 then return null; end if;
    return jsonb_build_object('kind', 'friend', 'tag', p_tag, 'badge', p_delta,
      'title', case when n = 1 then 'Freundschaftsanfrage' else n || ' Freundschaftsanfragen' end,
      'body', case when n = 1 then names[1] || ' möchte mit dir befreundet sein.' else public.push_list(names) end,
      'url', '#/freunde');
  end if;
  select o.actor into who from public.push_outbox o
    where o.user_id = p_user and o.tag = p_tag and o.kind = 'friend' order by o.id desc limit 1;
  if who is null or not public.are_friends(who, p_user) then return null; end if;
  return jsonb_build_object('kind', 'friend', 'tag', p_tag, 'badge', 0,
    'title', 'Neu befreundet: ' || public.push_name(who, p_user),
    'body', 'Ihr seht jetzt gegenseitig eure Wünsche.',
    'url', '#/f/u:' || who);
end $$;

-- Wen ich bei einem gemeinsamen Geschenk fragen kann: Leute, die ich kenne und die den Wunsch auch sehen
-- (auch Freunde der beschenkten Person aus meinen Gruppen, die ich selbst nicht über die Gruppe sehe)
create or replace function public.pool_candidates(p_wish uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(u), '{}')
  from public.pool_audience(p_wish, true, null) u
  where public.wish_visible_to(p_wish, auth.uid()) and u <> auth.uid() and public.knows(u);
$$;

-- ---------- Zugriffsregeln ----------

alter table public.friend_codes enable row level security;
alter table public.friend_requests enable row level security;
alter table public.nicknames enable row level security;

drop policy if exists "eigener freundes-code" on public.friend_codes;
create policy "eigener freundes-code" on public.friend_codes for select to authenticated
  using (user_id = auth.uid());
-- friend_requests: absichtlich keine Regeln, nur über friend_requests_list()

drop policy if exists "spitznamen lesen" on public.nicknames;
drop policy if exists "spitzname anlegen" on public.nicknames;
drop policy if exists "spitzname ändern" on public.nicknames;
drop policy if exists "spitzname löschen" on public.nicknames;
create policy "spitznamen lesen" on public.nicknames for select to authenticated
  using (owner = auth.uid());
create policy "spitzname anlegen" on public.nicknames for insert to authenticated
  with check (owner = auth.uid());
create policy "spitzname ändern" on public.nicknames for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "spitzname löschen" on public.nicknames for delete to authenticated
  using (owner = auth.uid());

revoke all on public.friend_codes, public.friend_requests, public.nicknames from anon, authenticated;
grant select on public.friend_codes to authenticated;
grant select, insert, update, delete on public.nicknames to authenticated;

revoke execute on function public.nicknames_check(), public.friend_make(uuid, uuid), public.friend_notify_ok(uuid, uuid),
  public.friend_code(boolean), public.friend_peek(text), public.friend_accept_code(text), public.friend_ask(uuid, text),
  public.friend_request(text), public.friend_request_user(uuid), public.friend_answer(uuid, boolean),
  public.friend_withdraw(uuid), public.friend_remove(uuid), public.friend_requests_list(),
  public.friend_message(uuid, text, int), public.pool_candidates(uuid) from public, anon, authenticated;
grant execute on function public.friend_code(boolean), public.friend_peek(text), public.friend_accept_code(text),
  public.friend_request(text), public.friend_request_user(uuid), public.friend_answer(uuid, boolean),
  public.friend_withdraw(uuid), public.friend_remove(uuid), public.friend_requests_list(),
  public.pool_candidates(uuid) to authenticated;

-- =====================================================================
-- Anlässe und Geburtstage (Version 1.15, Paket 9a)
-- Anlass pro Gruppe (Weihnachten, Geburtstag, Sonstiges), Geburtstag unter Konto,
-- eigene Schenklisten (nur für mich), Erinnerungen für alle Anlässe statt nur Heiligabend.
-- =====================================================================

-- Anlass einer Gruppe. weihnachten: 24.12., jedes Jahr. geburtstag: Tag und Monat aus occ_date, jedes Jahr,
-- Name freiwillig. sonstiges: eigener Name, einmaliges Datum. Ohne Art: kein Anlass.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'groups' and column_name = 'occ_kind') then
    alter table public.groups add column occ_kind text, add column occ_name text, add column occ_date date;
    -- Bisher waren alle Gruppen Weihnachtsgruppen
    update public.groups set occ_kind = 'weihnachten';
  end if;
end $$;
alter table public.groups drop constraint if exists groups_occ_check;
alter table public.groups add constraint groups_occ_check check (
  (occ_kind is null and occ_name is null and occ_date is null)
  or (occ_kind = 'weihnachten' and occ_name is null and occ_date is null)
  or (occ_kind = 'geburtstag' and occ_date is not null and (occ_name is null or char_length(occ_name) between 1 and 40))
  or (occ_kind = 'sonstiges' and occ_date is not null and char_length(occ_name) between 1 and 40));

-- Geburtstag (Jahr freiwillig). Sehen dürfen ihn alle, die mich kennen (Gruppen, Freunde).
create table if not exists public.birthdays (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  month smallint not null check (month between 1 and 12),
  day smallint not null check (day between 1 and case when month = 2 then 29 when month in (4, 6, 9, 11) then 30 else 31 end),
  year smallint check (year between 1900 and 2100),
  updated_at timestamptz not null default now()
);

-- Schenkliste: wem ich zu einem Anlass etwas schenke, mit Haken. Personen aus der Ideenliste.
create table if not exists public.gift_lists (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  occ_date date,
  created_at timestamptz not null default now()
);
create index if not exists gift_lists_owner_idx on public.gift_lists(owner);

create table if not exists public.gift_list_people (
  list_id uuid not null references public.gift_lists(id) on delete cascade,
  person uuid not null references public.idea_people(id) on delete cascade,
  done_at timestamptz,
  added_at timestamptz not null default now(),
  primary key (list_id, person)
);
create index if not exists gift_list_people_person_idx on public.gift_list_people(person);

-- ---------- Hilfen ----------

-- Nächster Jahrestag ab p_today (29.2. in Nicht-Schaltjahren am 28.2.)
create or replace function public.next_yearly(p_month int, p_day int, p_today date) returns date
language plpgsql immutable set search_path = '' as $$
declare
  y int;
  d date;
begin
  for i in 0..1 loop
    y := extract(year from p_today)::int + i;
    d := make_date(y, p_month, case when p_month = 2 and p_day = 29
                                     and not (y % 4 = 0 and (y % 100 <> 0 or y % 400 = 0)) then 28 else p_day end);
    if d >= p_today then return d; end if;
  end loop;
  return d;
end $$;

-- Nächster Termin eines Gruppen-Anlasses (null = vorbei oder keiner)
create or replace function public.occ_next(p_kind text, p_date date, p_today date) returns date
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'weihnachten' then public.next_yearly(12, 24, p_today)
    when 'geburtstag' then public.next_yearly(extract(month from p_date)::int, extract(day from p_date)::int, p_today)
    when 'sonstiges' then case when p_date >= p_today then p_date end
  end;
$$;

-- ---------- Prüfungen ----------

create or replace function public.gift_lists_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.owner <> old.owner then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.gift_lists where owner = new.owner) >= 50 then
    raise exception 'Höchstens 50 Schenklisten' using errcode = '54000';
  end if;
  return new;
end $$;
drop trigger if exists gift_lists_check on public.gift_lists;
create trigger gift_lists_check before insert or update on public.gift_lists
  for each row execute function public.gift_lists_check();

-- Nur eigene Personen in eigene Listen, höchstens 200 pro Liste
create or replace function public.gift_list_people_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.list_id <> old.list_id or new.person <> old.person) then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if not exists (select 1 from public.gift_lists l where l.id = new.list_id and l.owner = auth.uid())
     or not exists (select 1 from public.idea_people p where p.id = new.person and p.owner = auth.uid()) then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.gift_list_people where list_id = new.list_id) >= 200 then
    raise exception 'Höchstens 200 Personen pro Liste' using errcode = '54000';
  end if;
  return new;
end $$;
drop trigger if exists gift_list_people_check on public.gift_list_people;
create trigger gift_list_people_check before insert or update on public.gift_list_people
  for each row execute function public.gift_list_people_check();

-- ---------- Aktionen der App ----------

-- Anlass der Gruppe setzen (jedes Mitglied, wie Umbenennen). p_kind leer = kein Anlass.
create or replace function public.set_group_occasion(p_group uuid, p_kind text, p_name text, p_date date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_member(p_group) then raise exception 'Kein Mitglied'; end if;
  p_name := nullif(btrim(coalesce(p_name, '')), '');
  p_kind := nullif(p_kind, '');
  if p_kind is null then
    update public.groups set occ_kind = null, occ_name = null, occ_date = null where id = p_group;
    return;
  end if;
  if p_kind not in ('weihnachten', 'geburtstag', 'sonstiges') then raise exception 'Anlass ungültig'; end if;
  if p_kind = 'weihnachten' then
    p_name := null; p_date := null;
  elsif p_date is null then
    raise exception 'Bitte ein Datum angeben';
  elsif p_kind = 'sonstiges' and p_name is null then
    raise exception 'Bitte einen Namen für den Anlass angeben';
  end if;
  if char_length(p_name) > 40 then raise exception 'Name zu lang'; end if;
  if p_kind = 'sonstiges' and p_date < (now() at time zone 'Europe/Berlin')::date then
    raise exception 'Das Datum liegt in der Vergangenheit';
  end if;
  update public.groups set occ_kind = p_kind, occ_name = p_name, occ_date = p_date where id = p_group;
end $$;

-- ---------- Benachrichtigungen ----------

-- Täglich aus push_daily: Gruppen-Anlässe 14, 7 und 1 Tag vorher, Geburtstage 7 Tage vorher und am Tag.
-- Weihnachten kommt nur einmal, auch wenn man in mehreren Weihnachtsgruppen ist.
create or replace function public.occasion_due(p_today date) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  k int;
begin
  insert into public.push_outbox (user_id, kind, ref, tag, group_id, extra)
    select m.user_id, 'remind',
           case when g.occ_kind = 'weihnachten' then 'xmas:' else 'g:' || g.id || ':' end || g.nx || ':' || (g.nx - p_today),
           case when g.occ_kind = 'weihnachten' then 'remind' else 'remind-' || g.id end,
           case when g.occ_kind = 'weihnachten' then null else g.id end,
           (g.nx - p_today)::text
    from (select id, occ_kind, public.occ_next(occ_kind, occ_date, p_today) as nx
          from public.groups where occ_kind is not null) g
    join public.members m on m.group_id = g.id
    where g.nx - p_today in (14, 7, 1) and public.push_wants(m.user_id, 'remind')
    on conflict do nothing;
  get diagnostics k = row_count;
  n := n + k;
  insert into public.push_outbox (user_id, kind, ref, tag, actor, extra)
    select r.u, 'bday', 'b:' || b.user_id || ':' || b.nx || ':' || (b.nx - p_today), 'bday-' || b.user_id,
           b.user_id, (b.nx - p_today)::text
    from (select user_id, public.next_yearly(month, day, p_today) as nx from public.birthdays) b
    cross join lateral (
      select m2.user_id as u from public.members m1 join public.members m2 on m2.group_id = m1.group_id
        where m1.user_id = b.user_id
      union
      select case when f.a = b.user_id then f.b else f.a end from public.friendships f
        where b.user_id in (f.a, f.b)) r
    where b.nx - p_today in (7, 0) and r.u <> b.user_id and public.push_wants(r.u, 'remind')
    on conflict do nothing;
  get diagnostics k = row_count;
  return n + k;
end $$;

-- Text der Geburtstags-Erinnerung (beim Versand, mit Spitzname)
create or replace function public.bday_message(p_user uuid, p_tag text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  who uuid;
  k int;
  b public.birthdays;
  nx date;
  age int;
  nm text;
begin
  select o.actor, o.extra::int into who, k from public.push_outbox o
    where o.user_id = p_user and o.tag = p_tag and o.kind = 'bday' order by o.id desc limit 1;
  select * into b from public.birthdays where user_id = who;
  if not found then return null; end if;
  if not (public.are_friends(who, p_user) or exists (
      select 1 from public.members m1 join public.members m2 on m2.group_id = m1.group_id
      where m1.user_id = who and m2.user_id = p_user)) then
    return null;
  end if;
  nx := public.next_yearly(b.month, b.day, (now() at time zone 'Europe/Berlin')::date);
  age := case when b.year is not null then extract(year from nx)::int - b.year end;
  nm := public.push_name(who, p_user);
  return jsonb_build_object('kind', 'bday', 'tag', p_tag, 'badge', 0,
    'title', case when k = 0 then nm || ' hat heute Geburtstag' else nm || ' hat in ' || k || ' Tagen Geburtstag' end,
    'body', case
      when k = 0 and age is not null then nm || ' wird heute ' || age || '.'
      when k = 0 then 'Zeit zum Gratulieren.'
      when age is not null then nm || ' wird am ' || to_char(nx, 'FMDD.FMMM.') || ' ' || age || '. Schau in die Wunschliste.'
      else 'Am ' || to_char(nx, 'FMDD.FMMM.') || '. Schau in die Wunschliste.' end,
    'url', '#/p/' || who);
end $$;

-- ---------- Zugriffsregeln ----------

alter table public.birthdays enable row level security;
alter table public.gift_lists enable row level security;
alter table public.gift_list_people enable row level security;

drop policy if exists "geburtstage lesen" on public.birthdays;
drop policy if exists "geburtstag anlegen" on public.birthdays;
drop policy if exists "geburtstag ändern" on public.birthdays;
drop policy if exists "geburtstag löschen" on public.birthdays;
create policy "geburtstage lesen" on public.birthdays for select to authenticated
  using (user_id = auth.uid() or public.knows(user_id));
create policy "geburtstag anlegen" on public.birthdays for insert to authenticated
  with check (user_id = auth.uid());
create policy "geburtstag ändern" on public.birthdays for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "geburtstag löschen" on public.birthdays for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "schenklisten" on public.gift_lists;
create policy "schenklisten" on public.gift_lists for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "schenklisten personen" on public.gift_list_people;
create policy "schenklisten personen" on public.gift_list_people for all to authenticated
  using (exists (select 1 from public.gift_lists l where l.id = list_id and l.owner = auth.uid()))
  with check (exists (select 1 from public.gift_lists l where l.id = list_id and l.owner = auth.uid()));

revoke all on public.birthdays, public.gift_lists, public.gift_list_people from anon, authenticated;
grant select, insert, update, delete on public.birthdays, public.gift_lists, public.gift_list_people to authenticated;

revoke execute on function public.gift_lists_check(), public.gift_list_people_check(),
  public.set_group_occasion(uuid, text, text, date), public.occasion_due(date), public.bday_message(uuid, text),
  public.next_yearly(int, int, date), public.occ_next(text, date, date) from public, anon, authenticated;
grant execute on function public.set_group_occasion(uuid, text, text, date) to authenticated;
