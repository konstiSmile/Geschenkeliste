-- Nachbau der Supabase-Grundlagen für lokale Tests (nicht in Supabase ausführen)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema auth;
create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant usage on schema extensions to anon, authenticated;
create table auth.users (
  id uuid primary key,
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  is_anonymous boolean not null default false,
  raw_app_meta_data jsonb default '{}'::jsonb,
  updated_at timestamptz
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  created_at timestamptz,
  updated_at timestamptz,
  unique (provider_id, provider)
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
-- ab 1.9: Rolle der Edge Function und Attrappe von pg_net (merkt sich nur die Aufrufe)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema net;
create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, at timestamptz default now());
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;
