-- 実装仕様書 5.6節「サプリメント」/ 6.5節「書き込み権限の例外」/ 9章。
--
-- docs/database/table-conventions.md 4節のテンプレートに従い、
-- 所有者条件に加えて必ず public.is_active_user() を要求する。
-- anon 向けのポリシーは作らない（匿名アクセスは既定拒否）。
--
-- ## テーブルごとの方針
--
-- | テーブル                      | authenticated に許す操作            | 実際の書き込み主体            |
-- | ----------------------------- | ---------------------------------- | ----------------------------- |
-- | supplement_products           | SELECT / INSERT / UPDATE（列限定） | 所有者本人（API 経由）        |
-- | supplement_schedules          | SELECT / INSERT / UPDATE / DELETE  | 所有者本人（API 経由）        |
-- | supplement_inventory_lots     | SELECT / INSERT / UPDATE / DELETE  | 所有者本人（API 経由）        |
-- | supplement_intake_logs        | **SELECT のみ**                    | 原子的RPC（SECURITY DEFINER） |
-- | supplement_inventory_movements| **SELECT のみ**                    | ロットのトリガー（DEFINER）   |
--
-- ### 商品を DELETE させない理由
--
-- 摂取予定・服用記録・在庫ロット・在庫の動きが (product_id, owner_id) の複合外部キーを
-- `on delete cascade` で張っている。商品を消すと、その商品の服用履歴と在庫の監査証跡が
-- 黙って全部消える。無効化は `archived_at` で行う（実装仕様書 5.3節・5.5節と同じ方針）。
-- `on delete cascade` そのものはアカウント削除（users の CASCADE）を成立させるために残す。
--
-- ### 服用記録・在庫の動きを直接書かせない理由（実装仕様書 9.2節）
--
-- 服用記録は「在庫をいくつ消費したか」を持ち、在庫の動きは「どのロットから
-- いくつ引いたか」を持つ。どちらもクライアントから直接書けると、
--
--   - 在庫を減らさずに「服用済み」の記録だけを作る
--   - 在庫を戻さずに「取消して復元した」証跡だけを作る
--   - 他人の…ではなく**自分の**在庫の整合性を壊す（残量と履歴が食い違う）
--
-- ということが起きる。実装仕様書 5.6節が「負在庫となる操作は原子的RPCが拒否する」と
-- 定める以上、**RPC を迂回する書き込み経路を残してはならない**。
-- これは睡眠・水分・体調で `is_default` を列レベル権限から外したのと同じ考え方
-- （migration 20260903000200）を、サプリメントで偽装されると困る列へ広げたもの。

-- ---------------------------------------------------------------------------
-- public.supplement_products
-- ---------------------------------------------------------------------------
alter table public.supplement_products enable row level security;

revoke all on table public.supplement_products from public;
revoke all on table public.supplement_products from anon;
revoke all on table public.supplement_products from authenticated;

grant select on table public.supplement_products to authenticated;

-- `name_normalized` は生成列なので列挙しない（そもそも書けない）。
-- row_version / created_at / updated_at は共通トリガーがサーバー側で決めるため
-- クライアントには渡さない（実装仕様書 6.4節）。
grant insert (
  owner_id, product_key, name, brand, category, form,
  default_amount, default_unit, amount_per_container, low_stock_threshold,
  ingredient_note, safety_note, url, archived_at, client_mutation_id
) on table public.supplement_products to authenticated;

-- `product_key` は stableKey。作成後に付け替えられると、その商品に紐づく
-- 過去の記録の意味が後から変わってしまうので UPDATE の列から外す。
grant update (
  name, brand, category, form,
  default_amount, default_unit, amount_per_container, low_stock_threshold,
  ingredient_note, safety_note, url, archived_at, client_mutation_id
) on table public.supplement_products to authenticated;

drop policy if exists supplement_products_select_own on public.supplement_products;
create policy supplement_products_select_own
on public.supplement_products
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists supplement_products_insert_own on public.supplement_products;
create policy supplement_products_insert_own
on public.supplement_products
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists supplement_products_update_own on public.supplement_products;
create policy supplement_products_update_own
on public.supplement_products
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy supplement_products_select_own on public.supplement_products is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';
comment on policy supplement_products_insert_own on public.supplement_products is
  '実装仕様書 5.6節: 自分の商品だけを作れる。product_key は作成時のみ設定でき、以後は列レベル権限で固定される。';

-- ---------------------------------------------------------------------------
-- public.supplement_schedules
-- ---------------------------------------------------------------------------
alter table public.supplement_schedules enable row level security;

revoke all on table public.supplement_schedules from public;
revoke all on table public.supplement_schedules from anon;
revoke all on table public.supplement_schedules from authenticated;

grant select, delete on table public.supplement_schedules to authenticated;

grant insert (
  owner_id, product_id, schedule_kind, time_of_day, timezone, weekdays,
  start_date, end_date, amount, unit, meal_relation, note, archived_at, client_mutation_id
) on table public.supplement_schedules to authenticated;

grant update (
  product_id, schedule_kind, time_of_day, timezone, weekdays,
  start_date, end_date, amount, unit, meal_relation, note, archived_at, client_mutation_id
) on table public.supplement_schedules to authenticated;

drop policy if exists supplement_schedules_select_own on public.supplement_schedules;
create policy supplement_schedules_select_own
on public.supplement_schedules
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists supplement_schedules_insert_own on public.supplement_schedules;
create policy supplement_schedules_insert_own
on public.supplement_schedules
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists supplement_schedules_update_own on public.supplement_schedules;
create policy supplement_schedules_update_own
on public.supplement_schedules
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists supplement_schedules_delete_own on public.supplement_schedules;
create policy supplement_schedules_delete_own
on public.supplement_schedules
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy supplement_schedules_select_own on public.supplement_schedules is
  '実装仕様書 6.5節: 所有者本人かつ active のときのみ参照できる。';

-- ---------------------------------------------------------------------------
-- public.supplement_inventory_lots
--
-- 残量（remaining_quantity）の UPDATE は許す。利用者が「こぼした」「数え直した」
-- といった手動調整を行える必要があるため。偽装にはならない（自分の在庫であり、
-- 変更は必ず supplement_inventory_movements へ adjustment として記録される）。
-- 0未満・初期数量超えは CHECK 制約が拒否する（migration 20260915000100）。
-- ---------------------------------------------------------------------------
alter table public.supplement_inventory_lots enable row level security;

revoke all on table public.supplement_inventory_lots from public;
revoke all on table public.supplement_inventory_lots from anon;
revoke all on table public.supplement_inventory_lots from authenticated;

grant select, delete on table public.supplement_inventory_lots to authenticated;

grant insert (
  owner_id, product_id, lot_code, quantity, remaining_quantity, unit,
  purchased_on, opened_on, expires_on, note, client_mutation_id
) on table public.supplement_inventory_lots to authenticated;

grant update (
  lot_code, quantity, remaining_quantity, unit,
  purchased_on, opened_on, expires_on, note, client_mutation_id
) on table public.supplement_inventory_lots to authenticated;

drop policy if exists supplement_inventory_lots_select_own on public.supplement_inventory_lots;
create policy supplement_inventory_lots_select_own
on public.supplement_inventory_lots
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists supplement_inventory_lots_insert_own on public.supplement_inventory_lots;
create policy supplement_inventory_lots_insert_own
on public.supplement_inventory_lots
for insert
to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists supplement_inventory_lots_update_own on public.supplement_inventory_lots;
create policy supplement_inventory_lots_update_own
on public.supplement_inventory_lots
for update
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

drop policy if exists supplement_inventory_lots_delete_own on public.supplement_inventory_lots;
create policy supplement_inventory_lots_delete_own
on public.supplement_inventory_lots
for delete
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy supplement_inventory_lots_update_own on public.supplement_inventory_lots is
  '実装仕様書 5.6節: 所有者本人が残量を手動調整できる。負在庫と初期数量超えは CHECK 制約が拒否し、変更は必ず在庫の動きへ記録される。';

-- ---------------------------------------------------------------------------
-- public.supplement_intake_logs（server-only 書き込み。実装仕様書 6.5節）
--
-- 参照だけを所有者本人へ許す。INSERT / UPDATE / DELETE は誰にも渡さない。
-- 書き手は SECURITY DEFINER の `record_supplement_intake()` /
-- `void_supplement_intake()`（migration 20260915000400）だけ。
--
-- DELETE も渡さない。実装仕様書 5.6節は服用記録に**取消（void）**を定めており、
-- 物理削除は定めていない。消せると在庫の動きの監査証跡が CASCADE で消え、
-- 「在庫は減ったままなのに、減らした理由が残っていない」状態を作れてしまう。
-- ---------------------------------------------------------------------------
alter table public.supplement_intake_logs enable row level security;

revoke all on table public.supplement_intake_logs from public;
revoke all on table public.supplement_intake_logs from anon;
revoke all on table public.supplement_intake_logs from authenticated;

grant select on table public.supplement_intake_logs to authenticated;

drop policy if exists supplement_intake_logs_select_own on public.supplement_intake_logs;
create policy supplement_intake_logs_select_own
on public.supplement_intake_logs
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy supplement_intake_logs_select_own on public.supplement_intake_logs is
  '実装仕様書 6.5節: 所有者本人かつ active のときだけ自分の服用記録を参照できる。書き込み権限は誰にも与えない（原子的RPCのみ）。';

-- ---------------------------------------------------------------------------
-- public.supplement_inventory_movements（追記専用。実装仕様書 6.5節）
--
-- 参照だけを所有者本人へ許す。書き手は
-- `tg_supplement_record_movement()`（SECURITY DEFINER トリガー）だけ。
-- ---------------------------------------------------------------------------
alter table public.supplement_inventory_movements enable row level security;

revoke all on table public.supplement_inventory_movements from public;
revoke all on table public.supplement_inventory_movements from anon;
revoke all on table public.supplement_inventory_movements from authenticated;

grant select on table public.supplement_inventory_movements to authenticated;

drop policy if exists supplement_inventory_movements_select_own
  on public.supplement_inventory_movements;
create policy supplement_inventory_movements_select_own
on public.supplement_inventory_movements
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy supplement_inventory_movements_select_own
  on public.supplement_inventory_movements is
  '実装仕様書 6.5節: 所有者本人かつ active のときだけ自分の在庫の動きを参照できる。書き込み権限は誰にも与えない（トリガーのみ）。';
