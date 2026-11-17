-- Geschenkeliste – Datenbank, Stand Version 1.5 (Konto ohne Mail)
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
