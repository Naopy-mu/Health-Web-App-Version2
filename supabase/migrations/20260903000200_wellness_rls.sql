-- 実装仕様書 5.5節「睡眠・水分・体調」/ 6.5節「書き込み権限の例外」/ 9章。
--
-- docs/database/table-conventions.md 4節のテンプレートに従い、
-- 所有者条件に加えて必ず public.is_active_user() を要求する。
-- anon 向けのポリシーは作らない（匿名アクセスは既定拒否）。
--
-- 8テーブルとも 6.5節の「server-only」例外表には載らないため、所有者本人の
-- CRUD を許可する。ただし種別カタログ（beverage_types / symptom_types）だけは
-- 身体測定の body_measurement_types と同じ扱いにする。
--
--   - DELETE を許可しない
--     水分記録・体調症状は (type_id, owner_id) の複合外部キーを
--     `on delete cascade` で張っている。種別を消すとその種別の記録が黙って消える。
--     無効化は `archived_at` で行う（既定種別はアーカイブ自体も不可）。
--     `on delete cascade` そのものはアカウント削除（users の CASCADE）を
--     成立させるために必要なので残す。
--   - INSERT / UPDATE を**列レベル**で与える
--     テーブル全体の権限を与えると `is_default => true` を含む行を直接作れてしまい、
--     既定カタログを偽装できる（実装仕様書 5.5節・9.2節）。

-- ---------------------------------------------------------------------------
-- public.beverage_types
-- ---------------------------------------------------------------------------
alter table public.beverage_types enable row level security;

revoke all on table public.beverage_types from public;
revoke all on table public.beverage_types from anon;
revoke all on table public.beverage_types from authenticated;

grant select on table public.beverage_types to authenticated;

-- is_default を列挙から外すと、authenticated からの INSERT はこの列に触れられず、
-- 列の既定値 `false` が必ず入る。true を書けるのは SECURITY DEFINER の
-- seed_default_beverage_types() だけ（migration 20260903000300）。
-- row_version / created_at / updated_at は共通トリガーがサーバー側で決めるため、
-- クライアントには渡さない（実装仕様書 6.4節）。
grant insert (
  owner_id, beverage_key, display_name, default_unit, default_amount,
  contains_caffeine, contains_alcohol, sort_order, client_mutation_id
) on table public.beverage_types to authenticated;

-- 更新できるのは表示名・既定値・並び順・アーカイブ日時と冪等キーのみ。
-- beverage_key / is_default は列レベル権限で除外する。
grant update (
  display_name, default_unit, default_amount, contains_caffeine, contains_alcohol,
  sort_order, archived_at, client_mutation_id
) on table public.beverage_types to authenticated;

drop policy if exists beverage_types_select_own on public.beverage_types;
create policy beverage_types_select_own
on public.beverage_types
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists beverage_types_insert_own on public.beverage_types;
create policy beverage_types_insert_own
on public.beverage_types
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists beverage_types_update_own on public.beverage_types;
create policy beverage_types_update_own
on public.beverage_types
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy beverage_types_select_own on public.beverage_types is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';
comment on policy beverage_types_insert_own on public.beverage_types is
  '実装仕様書 5.5節: 自分の種別だけを作れる。is_default は列レベル権限で除外され、seed RPC 以外からは false のまま。';

-- ---------------------------------------------------------------------------
-- public.symptom_types
-- ---------------------------------------------------------------------------
alter table public.symptom_types enable row level security;

revoke all on table public.symptom_types from public;
revoke all on table public.symptom_types from anon;
revoke all on table public.symptom_types from authenticated;

grant select on table public.symptom_types to authenticated;

grant insert (owner_id, symptom_key, display_name, sort_order, client_mutation_id)
  on table public.symptom_types to authenticated;

grant update (display_name, sort_order, archived_at, client_mutation_id)
  on table public.symptom_types to authenticated;

drop policy if exists symptom_types_select_own on public.symptom_types;
create policy symptom_types_select_own
on public.symptom_types
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists symptom_types_insert_own on public.symptom_types;
create policy symptom_types_insert_own
on public.symptom_types
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists symptom_types_update_own on public.symptom_types;
create policy symptom_types_update_own
on public.symptom_types
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy symptom_types_select_own on public.symptom_types is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.sleep_entries
-- ---------------------------------------------------------------------------
alter table public.sleep_entries enable row level security;

revoke all on table public.sleep_entries from public;
revoke all on table public.sleep_entries from anon;
revoke all on table public.sleep_entries from authenticated;

grant select, insert, update, delete on table public.sleep_entries to authenticated;

drop policy if exists sleep_entries_select_own on public.sleep_entries;
create policy sleep_entries_select_own
on public.sleep_entries
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists sleep_entries_insert_own on public.sleep_entries;
create policy sleep_entries_insert_own
on public.sleep_entries
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists sleep_entries_update_own on public.sleep_entries;
create policy sleep_entries_update_own
on public.sleep_entries
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists sleep_entries_delete_own on public.sleep_entries;
create policy sleep_entries_delete_own
on public.sleep_entries
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy sleep_entries_select_own on public.sleep_entries is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.sleep_goals
-- ---------------------------------------------------------------------------
alter table public.sleep_goals enable row level security;

revoke all on table public.sleep_goals from public;
revoke all on table public.sleep_goals from anon;
revoke all on table public.sleep_goals from authenticated;

grant select, insert, update, delete on table public.sleep_goals to authenticated;

drop policy if exists sleep_goals_select_own on public.sleep_goals;
create policy sleep_goals_select_own
on public.sleep_goals
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists sleep_goals_insert_own on public.sleep_goals;
create policy sleep_goals_insert_own
on public.sleep_goals
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists sleep_goals_update_own on public.sleep_goals;
create policy sleep_goals_update_own
on public.sleep_goals
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists sleep_goals_delete_own on public.sleep_goals;
create policy sleep_goals_delete_own
on public.sleep_goals
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy sleep_goals_select_own on public.sleep_goals is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.hydration_entries
-- ---------------------------------------------------------------------------
alter table public.hydration_entries enable row level security;

revoke all on table public.hydration_entries from public;
revoke all on table public.hydration_entries from anon;
revoke all on table public.hydration_entries from authenticated;

grant select, insert, update, delete on table public.hydration_entries to authenticated;

drop policy if exists hydration_entries_select_own on public.hydration_entries;
create policy hydration_entries_select_own
on public.hydration_entries
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists hydration_entries_insert_own on public.hydration_entries;
create policy hydration_entries_insert_own
on public.hydration_entries
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists hydration_entries_update_own on public.hydration_entries;
create policy hydration_entries_update_own
on public.hydration_entries
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists hydration_entries_delete_own on public.hydration_entries;
create policy hydration_entries_delete_own
on public.hydration_entries
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy hydration_entries_select_own on public.hydration_entries is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.hydration_goals
-- ---------------------------------------------------------------------------
alter table public.hydration_goals enable row level security;

revoke all on table public.hydration_goals from public;
revoke all on table public.hydration_goals from anon;
revoke all on table public.hydration_goals from authenticated;

grant select, insert, update, delete on table public.hydration_goals to authenticated;

drop policy if exists hydration_goals_select_own on public.hydration_goals;
create policy hydration_goals_select_own
on public.hydration_goals
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists hydration_goals_insert_own on public.hydration_goals;
create policy hydration_goals_insert_own
on public.hydration_goals
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists hydration_goals_update_own on public.hydration_goals;
create policy hydration_goals_update_own
on public.hydration_goals
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists hydration_goals_delete_own on public.hydration_goals;
create policy hydration_goals_delete_own
on public.hydration_goals
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy hydration_goals_select_own on public.hydration_goals is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.condition_entries
-- ---------------------------------------------------------------------------
alter table public.condition_entries enable row level security;

revoke all on table public.condition_entries from public;
revoke all on table public.condition_entries from anon;
revoke all on table public.condition_entries from authenticated;

grant select, insert, update, delete on table public.condition_entries to authenticated;

drop policy if exists condition_entries_select_own on public.condition_entries;
create policy condition_entries_select_own
on public.condition_entries
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists condition_entries_insert_own on public.condition_entries;
create policy condition_entries_insert_own
on public.condition_entries
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists condition_entries_update_own on public.condition_entries;
create policy condition_entries_update_own
on public.condition_entries
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists condition_entries_delete_own on public.condition_entries;
create policy condition_entries_delete_own
on public.condition_entries
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy condition_entries_select_own on public.condition_entries is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.condition_entry_symptoms
--
-- 症状リンクは体調記録の保存に伴って**全置換**される（API の
-- replace_condition_entry_symptoms RPC）。置換のために DELETE も許可する。
-- ---------------------------------------------------------------------------
alter table public.condition_entry_symptoms enable row level security;

revoke all on table public.condition_entry_symptoms from public;
revoke all on table public.condition_entry_symptoms from anon;
revoke all on table public.condition_entry_symptoms from authenticated;

grant select, insert, update, delete on table public.condition_entry_symptoms to authenticated;

drop policy if exists condition_entry_symptoms_select_own on public.condition_entry_symptoms;
create policy condition_entry_symptoms_select_own
on public.condition_entry_symptoms
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists condition_entry_symptoms_insert_own on public.condition_entry_symptoms;
create policy condition_entry_symptoms_insert_own
on public.condition_entry_symptoms
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists condition_entry_symptoms_update_own on public.condition_entry_symptoms;
create policy condition_entry_symptoms_update_own
on public.condition_entry_symptoms
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists condition_entry_symptoms_delete_own on public.condition_entry_symptoms;
create policy condition_entry_symptoms_delete_own
on public.condition_entry_symptoms
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy condition_entry_symptoms_select_own on public.condition_entry_symptoms is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';
