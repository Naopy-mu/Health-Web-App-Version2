-- 実装仕様書 6.5節「書き込み権限の例外（server-only）」/ 9章「セキュリティ要件」。
--
-- 方針:
--   - 既定を拒否にする。anon と PUBLIC からは全権限を剥奪する。
--   - authenticated には所有者条件 + public.is_active_user() を要求する。
--   - users の書き込みは「ロケール／タイムゾーン／最終利用日時」に限定し、
--     それ以外（status 遷移など）は Auth連携サーバー（service_role）が行う。
--   - service_role はブラウザへ渡さない前提。ブラウザの公開キーが名乗る
--     anon / authenticated からは service_role へ昇格できない。

-- ---------------------------------------------------------------------------
-- public.users
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;

revoke all on table public.users from public;
revoke all on table public.users from anon;
revoke all on table public.users from authenticated;

grant select on table public.users to authenticated;
-- 実装仕様書 6.5節: authenticated に許可するのはロケール／タイムゾーン／
-- 最終利用日時のUPDATEのみ。列レベル権限で SET 対象そのものを制限する。
grant update (locale, timezone, last_seen_at) on table public.users to authenticated;

drop policy if exists users_select_own on public.users;
create policy users_select_own
on public.users
for select
to authenticated
using (id = (select auth.uid()) and public.is_active_user());

drop policy if exists users_update_own_preferences on public.users;
create policy users_update_own_preferences
on public.users
for update
to authenticated
using (id = (select auth.uid()) and public.is_active_user())
with check (id = (select auth.uid()) and public.is_active_user());

-- INSERT / DELETE のポリシーは作らない（既定拒否）。
-- 作成は on_auth_user_created、削除は auth.users の CASCADE が行う。

comment on policy users_select_own on public.users is
  '実装仕様書 6.5節: 自分の users 行のみ、かつ status = active のときだけ参照できる。';
comment on policy users_update_own_preferences on public.users is
  '実装仕様書 6.5節: 列レベル権限で locale / timezone / last_seen_at のみ更新できる。status 遷移は Auth連携サーバー経由。';

-- ---------------------------------------------------------------------------
-- public.user_profiles
--   6.5節の例外表に載らないため、所有者スコープの参照・更新を許可する。
--   行の作成は on_auth_user_created、削除は users の CASCADE が担うため、
--   INSERT / DELETE は authenticated へ許可しない。
-- ---------------------------------------------------------------------------
alter table public.user_profiles enable row level security;

revoke all on table public.user_profiles from public;
revoke all on table public.user_profiles from anon;
revoke all on table public.user_profiles from authenticated;

grant select on table public.user_profiles to authenticated;
grant update (display_name, unit_system, onboarding_completed_at, settings, client_mutation_id)
  on table public.user_profiles to authenticated;

drop policy if exists user_profiles_select_own on public.user_profiles;
create policy user_profiles_select_own
on public.user_profiles
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists user_profiles_update_own on public.user_profiles;
create policy user_profiles_update_own
on public.user_profiles
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy user_profiles_select_own on public.user_profiles is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';
comment on policy user_profiles_update_own on public.user_profiles is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ更新できる。id / owner_id / created_at は共通トリガーが拒否する。';
