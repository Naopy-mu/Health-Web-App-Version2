-- 実装仕様書 6.1節「ID・プロフィール」/ 6.2節「ID・所有権の規則」。
--
-- 本フェーズで作成する実データは public.users と public.user_profiles のみ。
-- 機能テーブル（身体測定・運動・食事など）は後続フェーズで追加する。

-- ---------------------------------------------------------------------------
-- 利用者状態（実装仕様書 5.1節）。active 以外は全APIが 403 ACCOUNT_INACTIVE。
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'user_status'
  ) then
    create type public.user_status as enum (
      'active',
      'suspended',
      'health_data_erasure_pending',
      'deletion_pending'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.users
--   - id は auth.users.id を参照する。
--   - owner_id = id をCHECK制約で固定する（実装仕様書 6.2節）。
--   - (id, owner_id) 候補キーが、全子テーブルの複合外部キーの参照先になる。
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id                 uuid primary key references auth.users (id) on delete cascade,
  owner_id           uuid not null,
  status             public.user_status not null default 'active',
  locale             text not null default 'ja',
  timezone           text not null default 'Asia/Tokyo',
  last_seen_at       timestamptz,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint users_owner_id_matches_id check (owner_id = id),
  constraint users_id_owner_id_key unique (id, owner_id),
  -- IANA タイムゾーン名の形（実在性は Zod と RPC 側で検証する。実装仕様書 5.2節）。
  constraint users_timezone_format check (timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'),
  -- BCP 47 の言語タグの形。
  constraint users_locale_format check (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
);

comment on table public.users is
  '実装仕様書 6.2節: auth.users と 1:1 の利用者行。owner_id = id を固定し、全公開テーブルの所有者参照先となる。';
comment on column public.users.status is
  '実装仕様書 5.1節: active 以外は public.is_active_user() が false を返し、全RLSポリシーから排除される。';

-- ---------------------------------------------------------------------------
-- public.user_profiles
--   - users と同一UUID。(id, owner_id) -> public.users (id, owner_id) の
--     複合外部キーで、他利用者の users 行へ接続できないようにする（6.2節）。
--   - 5.2節の候補プロフィールは settings.confirmed_profile へ確認後にのみ保存する。
-- ---------------------------------------------------------------------------
create table if not exists public.user_profiles (
  id                     uuid primary key,
  owner_id               uuid not null,
  display_name           text,
  unit_system            text not null default 'metric',
  onboarding_completed_at timestamptz,
  settings               jsonb not null default '{}'::jsonb,
  client_mutation_id     uuid,
  row_version            bigint not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint user_profiles_owner_id_matches_id check (owner_id = id),
  constraint user_profiles_id_owner_id_key unique (id, owner_id),
  constraint user_profiles_owner_fkey
    foreign key (id, owner_id) references public.users (id, owner_id) on delete cascade,
  constraint user_profiles_unit_system_allowed check (unit_system in ('metric', 'imperial')),
  constraint user_profiles_display_name_length check (display_name is null or char_length(display_name) between 1 and 100),
  constraint user_profiles_settings_is_object check (jsonb_typeof(settings) = 'object')
);

comment on table public.user_profiles is
  '実装仕様書 5.2節 / 6.2節: users と同一UUIDのプロフィール行。確認済みの候補プロフィールは settings.confirmed_profile に保持する。';

-- 実装仕様書 6.4節の共通パターンを取り付ける。
select public.apply_owned_mutable_table_conventions('public.users'::regclass);
select public.apply_owned_mutable_table_conventions('public.user_profiles'::regclass);

-- ---------------------------------------------------------------------------
-- public.is_active_user()（実装仕様書 6.5節）
--   - 全公開テーブルのRLSポリシーが所有者条件に加えて要求する。
--   - SECURITY DEFINER にすることで public.users 自身のポリシー評価が再帰しない。
-- ---------------------------------------------------------------------------
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    where u.id = (select auth.uid())
      and u.status = 'active'::public.user_status
  );
$$;

comment on function public.is_active_user() is
  '実装仕様書 6.5節: 呼び出し元の users.status が active のときのみ true。suspended / health_data_erasure_pending / deletion_pending を全操作から排除する。';

revoke all on function public.is_active_user() from public, anon, authenticated;
grant execute on function public.is_active_user() to authenticated;

-- ---------------------------------------------------------------------------
-- auth.users への AFTER INSERT トリガー（実装仕様書 6.2節）。
-- SECURITY DEFINER SET search_path = '' で public.users と public.user_profiles を
-- 同一UUIDで作成する。
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, owner_id)
  values (new.id, new.id)
  on conflict (id) do nothing;

  insert into public.user_profiles (id, owner_id)
  values (new.id, new.id)
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  '実装仕様書 6.2節: auth.users の作成に合わせて public.users と public.user_profiles を同一UUIDで作成する。';

-- トリガー専用。どのクライアントロールからも直接呼ばせない。
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_auth_user();
