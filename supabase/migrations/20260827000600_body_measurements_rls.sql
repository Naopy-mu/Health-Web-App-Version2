-- 実装仕様書 5.3節「身体測定」/ 6.5節「書き込み権限の例外」/ 9章。
--
-- docs/database/table-conventions.md 4節のテンプレートに従い、
-- 所有者条件に加えて必ず public.is_active_user() を要求する。
-- anon 向けのポリシーは作らない（匿名アクセスは既定拒否）。
--
-- 3テーブルとも 6.5節の「server-only」例外表には載らないため、所有者本人の
-- CRUD を許可する。ただし body_measurement_types だけは DELETE を許可しない
-- （下記の理由）。

-- ---------------------------------------------------------------------------
-- public.body_measurement_types
--
-- DELETE を許可しない理由:
--   body_measurements / body_measurement_goals は (type_id, owner_id) の
--   複合外部キーを `on delete cascade` で張っている。種別を消すと、その種別の
--   記録と目標が黙って消える。利用者操作としては破壊的すぎるため、
--   無効化は `archived_at` で行う（既定種別はアーカイブ自体も不可）。
--   `on delete cascade` そのものはアカウント削除（users の CASCADE）を
--   成立させるために必要なので残す。
-- ---------------------------------------------------------------------------
alter table public.body_measurement_types enable row level security;

revoke all on table public.body_measurement_types from public;
revoke all on table public.body_measurement_types from anon;
revoke all on table public.body_measurement_types from authenticated;

grant select, insert on table public.body_measurement_types to authenticated;
-- 更新できるのは表示名・既定単位・並び順・アーカイブ日時と冪等キーのみ。
-- measurement_key / unit_constraint / is_default は列レベル権限で除外する。
grant update (display_name, default_unit, sort_order, archived_at, client_mutation_id)
  on table public.body_measurement_types to authenticated;

drop policy if exists body_measurement_types_select_own on public.body_measurement_types;
create policy body_measurement_types_select_own
on public.body_measurement_types
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists body_measurement_types_insert_own on public.body_measurement_types;
create policy body_measurement_types_insert_own
on public.body_measurement_types
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists body_measurement_types_update_own on public.body_measurement_types;
create policy body_measurement_types_update_own
on public.body_measurement_types
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy body_measurement_types_select_own on public.body_measurement_types is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.body_measurements
-- ---------------------------------------------------------------------------
alter table public.body_measurements enable row level security;

revoke all on table public.body_measurements from public;
revoke all on table public.body_measurements from anon;
revoke all on table public.body_measurements from authenticated;

grant select, insert, update, delete on table public.body_measurements to authenticated;

drop policy if exists body_measurements_select_own on public.body_measurements;
create policy body_measurements_select_own
on public.body_measurements
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists body_measurements_insert_own on public.body_measurements;
create policy body_measurements_insert_own
on public.body_measurements
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists body_measurements_update_own on public.body_measurements;
create policy body_measurements_update_own
on public.body_measurements
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists body_measurements_delete_own on public.body_measurements;
create policy body_measurements_delete_own
on public.body_measurements
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy body_measurements_select_own on public.body_measurements is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.body_measurement_goals
-- ---------------------------------------------------------------------------
alter table public.body_measurement_goals enable row level security;

revoke all on table public.body_measurement_goals from public;
revoke all on table public.body_measurement_goals from anon;
revoke all on table public.body_measurement_goals from authenticated;

grant select, insert, update, delete on table public.body_measurement_goals to authenticated;

drop policy if exists body_measurement_goals_select_own on public.body_measurement_goals;
create policy body_measurement_goals_select_own
on public.body_measurement_goals
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists body_measurement_goals_insert_own on public.body_measurement_goals;
create policy body_measurement_goals_insert_own
on public.body_measurement_goals
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists body_measurement_goals_update_own on public.body_measurement_goals;
create policy body_measurement_goals_update_own
on public.body_measurement_goals
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists body_measurement_goals_delete_own on public.body_measurement_goals;
create policy body_measurement_goals_delete_own
on public.body_measurement_goals
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy body_measurement_goals_select_own on public.body_measurement_goals is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';
