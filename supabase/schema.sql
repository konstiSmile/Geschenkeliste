-- Geschenkeliste – Datenbank, Stand Version 1.9 (Benachrichtigungen)
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
  with check (user_id = auth.uid() and public.can_see_wish(wish_id) and not public.is_wish_owner(wish_id)
    and public.wish_open(wish_id));
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
  kind text not null check (kind in ('wish', 'member', 'draw', 'have', 'remind', 'test')),
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
create index if not exists push_outbox_pending_idx on public.push_outbox(id) where sent_at is null;
create index if not exists push_outbox_tag_idx on public.push_outbox(user_id, tag, created_at);

-- ---------- interne Hilfen ----------

-- Hat die Person ein Gerät angemeldet und will diese Art Nachricht?
create or replace function public.push_wants(u uuid, k text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.push_subs s where s.user_id = u)
     and coalesce((select case k when 'wish' then p.wish when 'member' then p.member when 'draw' then p.draw
                                 when 'remind' then p.remind when 'have' then p.have else true end
                   from public.push_prefs p where p.user_id = u), true);
$$;

create or replace function public.push_name(u uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif((select name from public.profiles where id = u), ''), 'Jemand');
$$;

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
  -- nur an die Person, die reserviert hat (nie an den Wünschenden)
  if tg_op = 'UPDATE' and old.have_at is null and new.have_at is not null then
    insert into public.push_outbox (user_id, kind, ref, tag, actor, wish_id)
      select r.user_id, 'have', new.id::text, 'have-' || new.id, new.owner, new.id
      from public.reservations r
      where r.wish_id = new.id and r.user_id <> new.owner and public.push_wants(r.user_id, 'have')
      on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists push_wish on public.wishes;
create trigger push_wish after insert or update of all_groups, have_at on public.wishes
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

-- Alle 5 Minuten: Liegengebliebenes verschicken (z. B. gebündelte Wünsche)
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
  n int;
begin
  if d not in (14, 7, 1) then return 0; end if;
  insert into public.push_outbox (user_id, kind, ref, tag, extra)
    select distinct m.user_id, 'remind', extract(year from today)::int || '-' || d, 'remind', d::text
    from public.members m
    where public.push_wants(m.user_id, 'remind')
    on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

do $$ begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('geschenkeliste-push', '*/5 * * * *', 'select public.push_tick()');
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
        and exists (select 1 from public.members m where m.group_id = o.group_id and m.user_id = p_user)
        and exists (select 1 from public.members m where m.group_id = o.group_id and m.user_id = w.owner)
        and (w.all_groups or exists (select 1 from public.wish_groups wg where wg.wish_id = w.id and wg.group_id = o.group_id));
    if coalesce(n, 0) = 0 then return null; end if;
    return jsonb_build_object('kind', 'wish', 'tag', p_tag, 'badge', p_delta,
      'title', case when n = 1 then 'Neuer Wunsch von ' || public.push_name(who)
                    else public.push_name(who) || ' hat ' || n || ' neue Wünsche' end,
      'body', public.push_list(titles),
      'url', '#/g/' || gid || '/p/' || who);
  elsif p_kind = 'member' then
    select array_agg(public.push_name(o.actor) order by o.id), count(*), (array_agg(o.group_id))[1]
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
    select w.title, w.owner, r.status into ex, who, gname
      from public.wishes w join public.reservations r on r.wish_id = w.id and r.user_id = p_user
      where w.id = wid and w.have_at is not null;
    if ex is null then return null; end if;
    return jsonb_build_object('kind', 'have', 'tag', p_tag, 'badge', 0,
      'title', public.push_name(who) || ' hat „' || ex || '“ schon',
      'body', case when gname = 'gekauft' then 'Du hast es schon gekauft. Vielleicht lässt es sich umtauschen.'
                   else 'Gib die Reservierung frei, falls du es noch nicht gekauft hast.' end,
      'url', '#/');
  elsif p_kind = 'remind' then
    select o.extra::int into k from public.push_outbox o
      where o.user_id = p_user and o.tag = p_tag and o.kind = 'remind' order by o.id desc limit 1;
    select count(*) into n from public.reservations r join public.wishes w on w.id = r.wish_id
      where r.user_id = p_user and r.status = 'reserviert' and w.have_at is null;
    return jsonb_build_object('kind', 'remind', 'tag', p_tag, 'badge', 0,
      'title', case when k = 1 then 'Morgen ist Heiligabend' else 'Noch ' || k || ' Tage bis Heiligabend' end,
      'body', case
        when n = 1 then 'Ein reserviertes Geschenk ist noch nicht besorgt.'
        when n > 1 then n || ' reservierte Geschenke sind noch nicht besorgt.'
        when not exists (select 1 from public.wishes w where w.owner = p_user and w.have_at is null)
          then 'Deine Wunschliste ist noch leer. Trag ein, worüber du dich freuen würdest.'
        else 'Schau nach, ob deine Wunschliste vollständig ist.' end,
      'url', '#/');
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
    delete from public.push_subs;
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
  public.push_kick(), public.push_on_wish(), public.push_on_wish_group(), public.push_on_member(), public.push_on_draw(),
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
