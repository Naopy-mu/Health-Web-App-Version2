-- PGlite 上で Supabase 相当の前提だけを再現するテスト用シム。
--
-- これは migration ではない。supabase/migrations/ の SQL を素の PostgreSQL へ
-- 適用できるようにするため、Supabase プロジェクトが最初から持っている
-- ロール・スキーマ・auth ヘルパー・storage テーブル・既定権限を用意する。
-- 本番の Supabase では以下はすべてプラットフォーム側が提供する。

-- Supabase の組み込みロール。
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase は public スキーマの新規テーブルへ既定で全権限を付与する。
-- migration 側の revoke が実効を持つことを検証するため、同じ既定権限を再現する。
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth スキーマ
-- ---------------------------------------------------------------------------
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'role', '');
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- storage スキーマ（Storage API が管理する実テーブルの最小形）
-- ---------------------------------------------------------------------------
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id                 text primary key,
  name               text not null unique,
  owner              uuid,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table storage.objects (
  id             uuid primary key default gen_random_uuid(),
  bucket_id      text not null references storage.buckets (id),
  name           text not null,
  owner_id       uuid,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (bucket_id, name)
);

grant select, insert, update, delete on storage.buckets to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
