-- 実装仕様書 5.6節「サプリメント」/ 6.1節・6.2節・6.3節・6.4節。
--
-- 追加するテーブル（実装仕様書 6.1節「サプリメント」境界の全件）:
--   - public.supplement_products            : 商品
--   - public.supplement_schedules           : 摂取予定
--   - public.supplement_intake_logs         : 服用記録
--   - public.supplement_inventory_lots      : 在庫ロット
--   - public.supplement_inventory_movements : 在庫の動き（監査証跡・追記専用）
--
-- 前4つは docs/database/table-conventions.md の「所有者スコープの可変公開テーブル」
-- テンプレートに従い、`public.apply_owned_mutable_table_conventions()` で
-- row_version / client_mutation_id / 楽観ロックの共通パターンを取り付ける。
-- `supplement_inventory_movements` は追記専用なので対象外
-- （`audit_logs` / `*_mutation_log` と同じ扱い）。
--
-- 親子参照は (parent_id, owner_id) -> (id, owner_id) の複合外部キーにする（6.2節）。
--
-- ## 本 migration が設計段階で担保すること
--
-- ### 1. 負在庫を「絶対に起こらない」ようにする（実装仕様書 5.6節）
--
-- > 服用時は期限が近いロットから消費（FEFO）し、負在庫となる操作は原子的RPC
-- > （`record_supplement_intake` / `void_supplement_intake`）が拒否する。
--
-- RPC（migration 20260915000400）は所有者単位の `pg_advisory_xact_lock` で
-- 同時実行を直列化するが、**それだけに頼らない**。
-- `supplement_inventory_lots` に
--
--   check (remaining_quantity >= 0)
--   check (remaining_quantity <= quantity)
--
-- を置き、どの経路（RPC・API の直接更新・将来の別実装・psql）から書かれても
-- 負在庫とロット初期数量超えが成立しないようにする（実装仕様書 9.2節
-- 「DB制約とRLSを最終防衛線とする」）。ロックは競合の**直列化**のためにあり、
-- 不変条件の保証は CHECK 制約の側にある。
--
-- ### 2. 409 のあとに対象行を必ず特定できるようにする（Phase 3b / 4-1a の教訓）
--
-- 対象特定の第一手段は**主キー `id` による直接取得**（docs/api/supplements.md 1.8節）。
-- `id` は行の生存期間中ずっと変わらないため、日時・種別といった「更新で変わりうる値」
-- に依存しない。本 migration はそれに加えて、`id` をまだ持っていない
-- 新規作成の重複競合のために、各テーブルへ識別用の一意制約を置く。
--
--   | テーブル                  | 対象特定に使う一意制約                                  |
--   | ------------------------- | ------------------------------------------------------- |
--   | supplement_products       | (owner_id, product_key) / (owner_id, name_normalized)   |
--   | supplement_schedules      | (owner_id, product_id, schedule_kind, start_date, 時刻) |
--   | supplement_intake_logs    | (owner_id, idempotency_key)                             |
--   | supplement_inventory_lots | (owner_id, product_id, lot_code)（lot_code 指定時のみ） |
--
-- ### 3. 服用記録の偽装を防ぐ（実装仕様書 9.2節）
--
-- `supplement_intake_logs` は authenticated へ **SELECT しか与えない**。
-- 在庫消費量・状態・取消日時をクライアントから直接書けると、
-- 「在庫を減らさずに服用済みにする」「在庫を戻さずに取消済みにする」といった
-- 偽装で在庫の整合性が壊れる。書き手は原子的RPCだけ（migration 20260915000200 / 000400）。
-- `supplement_inventory_movements` も同じ理由で SELECT のみ、書き手はトリガーだけ。
-- 睡眠・水分・体調の `is_default` 偽装防止（migration 20260903000100）と同じ考え方を、
-- サプリメントで偽装されると困る列へ適用したもの。

-- ---------------------------------------------------------------------------
-- 値の定義域（実装仕様書 5.6節）
--
-- 列挙はすべて DB 側の関数へ集め、CHECK 制約から呼ぶ。TypeScript 側の
-- `src/features/supplements/units.ts` と1対1に対応させ、
-- 契約テスト（tests/db/supplements.test.ts）で一致を確認する。
-- ---------------------------------------------------------------------------

-- > カテゴリ（ビタミン、ミネラル、プロテイン、アミノ酸、食物繊維、
-- > プロバイオティクス、植物性、その他）（実装仕様書 5.6節）
create or replace function public.supplement_category_is_allowed(category text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select category in (
    'vitamin', 'mineral', 'protein', 'amino_acid', 'fiber', 'probiotic', 'botanical', 'other'
  );
$$;

comment on function public.supplement_category_is_allowed(text) is
  '実装仕様書 5.6節: サプリメント商品のカテゴリ8種。';

revoke all on function public.supplement_category_is_allowed(text) from public, anon, authenticated;
grant execute on function public.supplement_category_is_allowed(text) to authenticated;

-- > 剤形（錠剤、カプセル、粉末、液体、グミ、顆粒、その他）（実装仕様書 5.6節）
create or replace function public.supplement_form_is_allowed(form text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select form in ('tablet', 'capsule', 'powder', 'liquid', 'gummy', 'granule', 'other');
$$;

comment on function public.supplement_form_is_allowed(text) is
  '実装仕様書 5.6節: サプリメント商品の剤形7種。';

revoke all on function public.supplement_form_is_allowed(text) from public, anon, authenticated;
grant execute on function public.supplement_form_is_allowed(text) to authenticated;

-- 量の単位（実装仕様書 5.6節「既定量と単位」）。
-- 在庫はこの単位で数える（商品の `default_unit` が在庫単位を兼ねる。下の
-- `tg_supplement_lot_guard()` がロットの単位を商品の単位へ揃える）。
create or replace function public.supplement_unit_is_allowed(unit text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select unit in (
    'tablet', 'capsule', 'gummy', 'sachet', 'scoop', 'drop', 'piece', 'g', 'mg', 'mcg', 'ml'
  );
$$;

comment on function public.supplement_unit_is_allowed(text) is
  '実装仕様書 5.6節: サプリメントの量の単位11種。在庫ロットの数量もこの単位で数える。';

revoke all on function public.supplement_unit_is_allowed(text) from public, anon, authenticated;
grant execute on function public.supplement_unit_is_allowed(text) to authenticated;

-- > 単発／毎日／週次／必要時（実装仕様書 5.6節）
create or replace function public.supplement_schedule_kind_is_allowed(kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select kind in ('once', 'daily', 'weekly', 'as_needed');
$$;

comment on function public.supplement_schedule_kind_is_allowed(text) is
  '実装仕様書 5.6節: 摂取予定の種別4種（単発／毎日／週次／必要時）。';

revoke all on function public.supplement_schedule_kind_is_allowed(text)
  from public, anon, authenticated;
grant execute on function public.supplement_schedule_kind_is_allowed(text) to authenticated;

-- > 食事との関係（指定なし／食前／食中／食後／表示に従う）（実装仕様書 5.6節）
create or replace function public.supplement_meal_relation_is_allowed(relation text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select relation in ('unspecified', 'before_meal', 'with_meal', 'after_meal', 'as_labeled');
$$;

comment on function public.supplement_meal_relation_is_allowed(text) is
  '実装仕様書 5.6節: 摂取予定の食事との関係5種。';

revoke all on function public.supplement_meal_relation_is_allowed(text)
  from public, anon, authenticated;
grant execute on function public.supplement_meal_relation_is_allowed(text) to authenticated;

-- > 状態（服用／スキップ／取消／必要時）（実装仕様書 5.6節）
create or replace function public.supplement_intake_status_is_allowed(status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select status in ('taken', 'skipped', 'voided', 'as_needed');
$$;

comment on function public.supplement_intake_status_is_allowed(text) is
  '実装仕様書 5.6節: 服用記録の状態4種。voided へ遷移できるのは void_supplement_intake RPC だけ。';

revoke all on function public.supplement_intake_status_is_allowed(text)
  from public, anon, authenticated;
grant execute on function public.supplement_intake_status_is_allowed(text) to authenticated;

-- 在庫の動きの種別（監査証跡）。
create or replace function public.supplement_movement_kind_is_allowed(kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select kind in ('purchase', 'intake_consume', 'intake_void_restore', 'adjustment');
$$;

comment on function public.supplement_movement_kind_is_allowed(text) is
  '実装仕様書 5.6節: 在庫の動きの種別。purchase=ロット登録、intake_consume=FEFO消費、intake_void_restore=取消による復元、adjustment=手動調整。';

revoke all on function public.supplement_movement_kind_is_allowed(text)
  from public, anon, authenticated;
grant execute on function public.supplement_movement_kind_is_allowed(text) to authenticated;

-- 対象曜日（実装仕様書 5.6節「週次は曜日必須」）。0=日曜 〜 6=土曜。
-- 睡眠・水分・体調の `wellness_weekdays_are_valid()` と同じ規則
-- （空集合を許さず、範囲内、重複なし）。
create or replace function public.supplement_weekdays_are_valid(days smallint[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select days is not null
     and pg_catalog.cardinality(days) between 1 and 7
     and coalesce(
           (select pg_catalog.bool_and(day between 0 and 6)
              from pg_catalog.unnest(days) as day),
           false
         )
     and pg_catalog.cardinality(days) = (
           select pg_catalog.count(distinct day) from pg_catalog.unnest(days) as day
         );
$$;

comment on function public.supplement_weekdays_are_valid(smallint[]) is
  '実装仕様書 5.6節: 週次予定の対象曜日（0=日〜6=土）。1〜7件・範囲内・重複なしを要求する。';

revoke all on function public.supplement_weekdays_are_valid(smallint[])
  from public, anon, authenticated;
grant execute on function public.supplement_weekdays_are_valid(smallint[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 名称の正規化（実装仕様書 5.6節「名称正規化またはstableKeyの重複を禁止する」）
--
-- NFKC 正規化 → 空白の畳み込み → 前後の空白除去 → 小文字化 の順で行う。
-- NFKC を**先に**かけるのは、全角空白 U+3000 や全角英数を先に半角へ寄せないと
-- 「ビタミンＣ」と「ビタミンC」、「Vitamin　C」と「Vitamin C」が別物に
-- 見えてしまうため。
--
-- 生成列から呼ぶので IMMUTABLE でなければならない。使っている
-- `normalize` / `regexp_replace` / `btrim` / `lower` はいずれも IMMUTABLE。
-- 空白クラスは `[[:space:]]` を使う（PostgreSQL の ARE で確実に効く）。
-- ---------------------------------------------------------------------------
create or replace function public.supplement_normalized_name(name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.lower(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        -- `normalize(text, NFKC)` は専用の文法で、スキーマ修飾すると NFKC が
        -- 列名として解釈されてしまうため修飾しない（pg_catalog は search_path が
        -- 空でも常に暗黙に含まれるので、解決先は曖昧にならない）。
        normalize(name, NFKC),
        '[[:space:]]+', ' ', 'g'
      )
    )
  );
$$;

comment on function public.supplement_normalized_name(text) is
  '実装仕様書 5.6節: 商品名の正規化（NFKC → 空白畳み込み → trim → 小文字化）。重複禁止の判定キー。';

revoke all on function public.supplement_normalized_name(text) from public, anon, authenticated;
grant execute on function public.supplement_normalized_name(text) to authenticated;

-- ---------------------------------------------------------------------------
-- public.supplement_products（実装仕様書 5.6節）
--
-- > 名称、ブランド、カテゴリ（…）、剤形（…）、既定量と単位、容器あたり量、
-- > 低在庫しきい値、成分メモ、安全上の注意、HTTPS URL。
-- > 名称正規化またはstableKeyの重複を禁止する。
--
-- `product_key` が stableKey。身体測定・睡眠の種別キーと同じ
-- `^[a-z][a-z0-9_]{1,49}$` を使う（利用者が付け替えられない安定識別子）。
-- 削除は用意せず `archived_at` で無効化する（過去の服用記録・在庫を守るため）。
-- ---------------------------------------------------------------------------
create table if not exists public.supplement_products (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references public.users (id) on delete cascade,
  product_key          text not null,
  name                 text not null,
  -- 重複禁止の判定キー。生成列にして「保存された名称」と必ず一致させる
  -- （アプリ側で正規化を忘れても破れない）。
  name_normalized      text generated always as (public.supplement_normalized_name(name)) stored,
  brand                text,
  category             text not null,
  form                 text not null,
  -- 既定量と単位。`default_unit` は在庫単位も兼ねる（本ファイル冒頭の注記）。
  default_amount       numeric(14, 4),
  default_unit         text not null,
  -- 容器あたり量（1本・1袋に入っている量。`default_unit` で数える）。
  amount_per_container numeric(14, 4),
  -- 低在庫しきい値。残量合計がこれ以下になったら画面で警告する。
  low_stock_threshold  numeric(14, 4),
  ingredient_note      text,
  safety_note          text,
  url                  text,
  archived_at          timestamptz,
  client_mutation_id   uuid,
  row_version          bigint not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint supplement_products_id_owner_id_key unique (id, owner_id),
  -- 409 後の対象特定と重複登録防止を兼ねる（実装仕様書 5.6節の重複禁止）。
  constraint supplement_products_owner_key_key unique (owner_id, product_key),
  constraint supplement_products_owner_name_key unique (owner_id, name_normalized),
  constraint supplement_products_key_format check (product_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  constraint supplement_products_name_length check (char_length(name) between 1 and 200),
  -- 正規化して空になる名称（空白のみ）は重複判定が成り立たないので拒否する。
  constraint supplement_products_name_not_blank
    check (char_length(public.supplement_normalized_name(name)) > 0),
  constraint supplement_products_brand_length
    check (brand is null or char_length(brand) between 1 and 100),
  constraint supplement_products_category_allowed
    check (public.supplement_category_is_allowed(category)),
  constraint supplement_products_form_allowed check (public.supplement_form_is_allowed(form)),
  constraint supplement_products_default_unit_allowed
    check (public.supplement_unit_is_allowed(default_unit)),
  constraint supplement_products_default_amount_range
    check (default_amount is null or (default_amount > 0 and default_amount <= 100000)),
  constraint supplement_products_amount_per_container_range
    check (
      amount_per_container is null
      or (amount_per_container > 0 and amount_per_container <= 1000000)
    ),
  constraint supplement_products_low_stock_threshold_range
    check (low_stock_threshold is null or (low_stock_threshold >= 0 and low_stock_threshold <= 1000000)),
  constraint supplement_products_ingredient_note_length
    check (ingredient_note is null or char_length(ingredient_note) between 1 and 2000),
  constraint supplement_products_safety_note_length
    check (safety_note is null or char_length(safety_note) between 1 and 2000),
  -- 実装仕様書 5.6節「HTTPS URL」。http:// や javascript: を保存させない。
  constraint supplement_products_url_https
    check (url is null or (url ~ '^https://[^[:space:]]+$' and char_length(url) <= 2048))
);

comment on table public.supplement_products is
  '実装仕様書 5.6節: サプリメント商品。名称の正規化値（name_normalized）と stableKey（product_key）の重複を所有者ごとに禁止する。';
comment on column public.supplement_products.product_key is
  'stableKey。利用者が付け替えられない安定識別子。作成後は変更できない（列レベル権限で UPDATE を許さない）。';
comment on column public.supplement_products.name_normalized is
  '実装仕様書 5.6節: NFKC・空白畳み込み・小文字化した名称。重複禁止の判定キー（生成列）。';
comment on column public.supplement_products.default_unit is
  '既定量の単位。在庫ロットの数量単位も必ずこれに揃う（tg_supplement_lot_guard が強制）。';

-- 一覧は正規化名順。アーカイブ済みも含めて引ける（過去の記録のラベル解決に要る）。
create index if not exists supplement_products_owner_name_idx
  on public.supplement_products (owner_id, name_normalized);

-- ---------------------------------------------------------------------------
-- public.supplement_schedules（実装仕様書 5.6節）
--
-- > 単発／毎日／週次／必要時、時刻（HH:MM）、タイムゾーン、曜日、開始日・終了日、
-- > 量・単位、食事との関係（指定なし／食前／食中／食後／表示に従う）。
-- > 終了日は開始日以降、週次は曜日必須。
--
-- 時刻は `time` + タイムゾーン（IANA 名）で持つ（実装仕様書 6.3節）。
-- 「必要時（as_needed）」は発生時刻を持たないので `time_of_day` は NULL。
-- ---------------------------------------------------------------------------
create table if not exists public.supplement_schedules (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  product_id         uuid not null,
  schedule_kind      text not null,
  time_of_day        time,
  timezone           text not null default 'Asia/Tokyo',
  weekdays           smallint[],
  start_date         date not null,
  end_date           date,
  amount             numeric(14, 4) not null,
  unit               text not null,
  meal_relation      text not null default 'unspecified',
  note               text,
  archived_at        timestamptz,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint supplement_schedules_id_owner_id_key unique (id, owner_id),
  -- 6.2節: 他利用者の商品へ予定を接続できないようにする複合外部キー。
  constraint supplement_schedules_product_fkey
    foreign key (product_id, owner_id)
    references public.supplement_products (id, owner_id) on delete cascade,
  constraint supplement_schedules_kind_allowed
    check (public.supplement_schedule_kind_is_allowed(schedule_kind)),
  constraint supplement_schedules_unit_allowed check (public.supplement_unit_is_allowed(unit)),
  constraint supplement_schedules_meal_relation_allowed
    check (public.supplement_meal_relation_is_allowed(meal_relation)),
  constraint supplement_schedules_amount_range check (amount > 0 and amount <= 100000),
  constraint supplement_schedules_timezone_format
    check (
      timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
      and char_length(timezone) <= 64
    ),
  constraint supplement_schedules_note_length
    check (note is null or char_length(note) between 1 and 500),
  -- 実装仕様書 5.6節「終了日は開始日以降」。
  constraint supplement_schedules_end_after_start
    check (end_date is null or end_date >= start_date),
  -- 実装仕様書 5.6節「週次は曜日必須」。週次以外は曜日を持たない
  -- （持てると「毎日なのに曜日指定がある」という解釈不能な行が作れてしまう）。
  constraint supplement_schedules_weekdays_for_weekly
    check (
      case schedule_kind
        when 'weekly' then public.supplement_weekdays_are_valid(weekdays)
        else weekdays is null
      end
    ),
  -- 単発・毎日・週次は発生時刻を持ち、必要時は持たない。
  constraint supplement_schedules_time_for_kind
    check (
      case schedule_kind
        when 'as_needed' then time_of_day is null
        else time_of_day is not null
      end
    ),
  -- 単発は1日で完結する（終了日を持つなら開始日と同じ日）。
  constraint supplement_schedules_once_single_day
    check (schedule_kind <> 'once' or end_date is null or end_date = start_date)
);

comment on table public.supplement_schedules is
  '実装仕様書 5.6節: サプリメントの摂取予定。単発／毎日／週次／必要時。終了日は開始日以降、週次は曜日必須。';
comment on column public.supplement_schedules.time_of_day is
  '発生時刻（ローカル時刻）。timezone と組で解釈する（実装仕様書 6.3節）。必要時（as_needed）は NULL。';

-- 409 後の対象特定（`id` をまだ持っていない新規作成の重複競合用）。
-- `time_of_day` が NULL になる as_needed も1件へ絞れるよう coalesce で畳む。
create unique index if not exists supplement_schedules_owner_identity_key
  on public.supplement_schedules (
    owner_id, product_id, schedule_kind, start_date, coalesce(time_of_day, time '00:00')
  );

create index if not exists supplement_schedules_owner_start_idx
  on public.supplement_schedules (owner_id, start_date desc);

-- ---------------------------------------------------------------------------
-- public.supplement_inventory_lots（実装仕様書 5.6節）
--
-- > ロット単位で数量、購入日、開封日、使用期限、残量を管理。
--
-- **負在庫を絶対に許さない不変条件をここで宣言する**（本ファイル冒頭の注記）。
--   - remaining_quantity >= 0        : 負在庫の禁止
--   - remaining_quantity <= quantity : ロットに入っていた以上の量は戻せない
--
-- 削除は API から許す（打ち間違えたロットの取り消し）。ただし服用に使われた
-- ロットは `tg_supplement_lot_before_delete()` が拒否する（監査証跡を守るため）。
-- ---------------------------------------------------------------------------
create table if not exists public.supplement_inventory_lots (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  product_id         uuid not null,
  -- 利用者が付けるロット表示名（任意）。指定したときだけ商品内で一意。
  lot_code           text,
  -- 入荷時の数量と、いま残っている量。単位は商品の default_unit に揃う。
  quantity           numeric(14, 4) not null,
  remaining_quantity numeric(14, 4) not null,
  unit               text not null,
  purchased_on       date,
  opened_on          date,
  expires_on         date,
  note               text,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint supplement_inventory_lots_id_owner_id_key unique (id, owner_id),
  constraint supplement_inventory_lots_product_fkey
    foreign key (product_id, owner_id)
    references public.supplement_products (id, owner_id) on delete cascade,
  constraint supplement_inventory_lots_unit_allowed
    check (public.supplement_unit_is_allowed(unit)),
  constraint supplement_inventory_lots_quantity_range
    check (quantity > 0 and quantity <= 1000000),
  -- 負在庫の禁止（実装仕様書 5.6節）。RPC のロックとは独立した最終防衛線。
  constraint supplement_inventory_lots_remaining_not_negative check (remaining_quantity >= 0),
  constraint supplement_inventory_lots_remaining_within_quantity
    check (remaining_quantity <= quantity),
  constraint supplement_inventory_lots_lot_code_length
    check (lot_code is null or char_length(lot_code) between 1 and 50),
  constraint supplement_inventory_lots_note_length
    check (note is null or char_length(note) between 1 and 500),
  constraint supplement_inventory_lots_opened_after_purchase
    check (opened_on is null or purchased_on is null or opened_on >= purchased_on),
  constraint supplement_inventory_lots_expires_after_purchase
    check (expires_on is null or purchased_on is null or expires_on >= purchased_on)
);

comment on table public.supplement_inventory_lots is
  '実装仕様書 5.6節: サプリメントの在庫ロット。remaining_quantity の 0 以上・quantity 以下を CHECK 制約で保証し、負在庫を原理的に起こさせない。';
comment on column public.supplement_inventory_lots.remaining_quantity is
  '残量。FEFO 消費（record_supplement_intake）と取消復元（void_supplement_intake）が更新する。0未満・quantity超は CHECK 制約が拒否する。';
comment on column public.supplement_inventory_lots.lot_code is
  'ロットの表示名（任意）。指定した場合は商品内で一意（409 後の対象特定に使える）。';

-- 指定したときだけ一意（NULL 同士は衝突しない部分一意インデックス）。
create unique index if not exists supplement_inventory_lots_owner_code_key
  on public.supplement_inventory_lots (owner_id, product_id, lot_code)
  where lot_code is not null;

-- 実装仕様書 6.2節「期限検索は (owner_id, expiry) の複合インデックス」。
create index if not exists supplement_inventory_lots_owner_expires_idx
  on public.supplement_inventory_lots (owner_id, expires_on);

-- FEFO の並び順（商品ごとに期限が近い順）を読むための索引。
create index if not exists supplement_inventory_lots_fefo_idx
  on public.supplement_inventory_lots (owner_id, product_id, expires_on, created_at, id);

-- ---------------------------------------------------------------------------
-- public.supplement_intake_logs（実装仕様書 5.6節）
--
-- > 状態（服用／スキップ／取消／必要時）、予定発生日時、記録日時、量、在庫消費量、
-- > **冪等キー（8〜200文字）**。取消（void）に対応する。
--
-- 冪等キーが2種類あることに注意（docs/api/supplements.md 1.6節）。
--   - `idempotency_key`（本列。8〜200文字のテキスト）
--     実装仕様書 5.6節が服用記録に固有で求めるキー。「この1回の服用」を
--     所有者ごとに一意にし、同じ服用が二重に在庫を減らすのを防ぐ。
--   - `client_mutation_id`（共通テンプレートの UUID 列）
--     実装仕様書 6.4節・8.1節のオフライン再送キー。適用結果は
--     `supplement_mutation_log`（migration 20260915000300）へ履歴として残り、
--     何世代前の再送でも同じ応答を返せる。
--
-- 書き込みは原子的RPCだけ（本ファイル冒頭 3.）。authenticated には SELECT しか
-- 与えない（migration 20260915000200）。
-- ---------------------------------------------------------------------------
create table if not exists public.supplement_intake_logs (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  product_id         uuid not null,
  -- どの予定に対する記録か。予定外の服用（必要時）では NULL。
  schedule_id        uuid,
  status             text not null,
  -- 予定発生日時（実装仕様書 5.6節）。予定外の服用では NULL。
  scheduled_for      timestamptz,
  recorded_at        timestamptz not null,
  timezone           text not null default 'Asia/Tokyo',
  amount             numeric(14, 4) not null,
  unit               text not null,
  -- 在庫消費量（実装仕様書 5.6節）。FEFO で実際にロットから引いた合計。
  -- 取消しても**記録当時の消費量として残す**（在庫は movements の復元行で戻る）。
  consumed_quantity  numeric(14, 4) not null default 0,
  idempotency_key    text not null,
  voided_at          timestamptz,
  void_reason        text,
  note               text,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint supplement_intake_logs_id_owner_id_key unique (id, owner_id),
  constraint supplement_intake_logs_product_fkey
    foreign key (product_id, owner_id)
    references public.supplement_products (id, owner_id) on delete cascade,
  -- 予定を消しても服用の事実は残す（予定参照だけを外す）。
  constraint supplement_intake_logs_schedule_fkey
    foreign key (schedule_id, owner_id)
    references public.supplement_schedules (id, owner_id) on delete set null (schedule_id),
  -- 実装仕様書 5.6節「冪等キー（8〜200文字）」。所有者ごとに一意。
  constraint supplement_intake_logs_owner_idempotency_key unique (owner_id, idempotency_key),
  constraint supplement_intake_logs_idempotency_key_length
    check (char_length(idempotency_key) between 8 and 200),
  constraint supplement_intake_logs_status_allowed
    check (public.supplement_intake_status_is_allowed(status)),
  constraint supplement_intake_logs_unit_allowed check (public.supplement_unit_is_allowed(unit)),
  constraint supplement_intake_logs_amount_range check (amount >= 0 and amount <= 100000),
  constraint supplement_intake_logs_consumed_not_negative
    check (consumed_quantity >= 0 and consumed_quantity <= 1000000),
  -- スキップは在庫を減らさない（実装仕様書 5.6節）。
  constraint supplement_intake_logs_skipped_consumes_nothing
    check (status <> 'skipped' or consumed_quantity = 0),
  -- 取消日時は取消状態のときだけ立つ（どちらか片方だけの行を作らせない）。
  constraint supplement_intake_logs_voided_at_matches_status
    check ((status = 'voided') = (voided_at is not null)),
  constraint supplement_intake_logs_void_reason_length
    check (void_reason is null or char_length(void_reason) between 1 and 200),
  constraint supplement_intake_logs_note_length
    check (note is null or char_length(note) between 1 and 500),
  constraint supplement_intake_logs_timezone_format
    check (
      timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
      and char_length(timezone) <= 64
    )
);

comment on table public.supplement_intake_logs is
  '実装仕様書 5.6節: サプリメントの服用記録。書き込みは record_supplement_intake / void_supplement_intake RPC だけ（authenticated は SELECT のみ）。';
comment on column public.supplement_intake_logs.idempotency_key is
  '実装仕様書 5.6節「冪等キー（8〜200文字）」。所有者ごとに一意。同じ服用の二重記録＝二重の在庫消費を防ぐ。';
comment on column public.supplement_intake_logs.consumed_quantity is
  'FEFO で実際にロットから引いた合計。取消後もこの値は残す（復元は supplement_inventory_movements の intake_void_restore 行が表す）。';

create index if not exists supplement_intake_logs_owner_recorded_idx
  on public.supplement_intake_logs (owner_id, recorded_at desc);

create index if not exists supplement_intake_logs_owner_product_idx
  on public.supplement_intake_logs (owner_id, product_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- public.supplement_inventory_movements（実装仕様書 5.6節「在庫の動き」）
--
-- 追記専用の監査証跡。`audit_logs` / `*_mutation_log` と同じ扱いで、
-- `apply_owned_mutable_table_conventions()`（row_version / 楽観ロック）は
-- 適用しない。書き手は下の SECURITY DEFINER トリガーだけ。
--
-- 取消の復元（void_supplement_intake）は**この表を読んで**「どのロットから
-- いくつ引いたか」を復元する。だから記録は必ずロット単位に分かれている
-- （1回の服用が3ロットにまたがったら3行になる）。
-- ---------------------------------------------------------------------------
create table if not exists public.supplement_inventory_movements (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.users (id) on delete cascade,
  product_id     uuid not null,
  lot_id         uuid not null,
  -- どの服用記録に伴う動きか。手動調整・ロット登録では NULL。
  intake_log_id  uuid,
  movement_kind  text not null,
  -- 増減量。消費は負、復元・購入は正。単位はロット（＝商品）の単位。
  quantity_delta numeric(14, 4) not null,
  unit           text not null,
  occurred_at    timestamptz not null default now(),
  note           text,
  created_at     timestamptz not null default now(),
  constraint supplement_inventory_movements_id_owner_id_key unique (id, owner_id),
  constraint supplement_inventory_movements_product_fkey
    foreign key (product_id, owner_id)
    references public.supplement_products (id, owner_id) on delete cascade,
  constraint supplement_inventory_movements_lot_fkey
    foreign key (lot_id, owner_id)
    references public.supplement_inventory_lots (id, owner_id) on delete cascade,
  constraint supplement_inventory_movements_intake_fkey
    foreign key (intake_log_id, owner_id)
    references public.supplement_intake_logs (id, owner_id) on delete cascade,
  constraint supplement_inventory_movements_kind_allowed
    check (public.supplement_movement_kind_is_allowed(movement_kind)),
  constraint supplement_inventory_movements_unit_allowed
    check (public.supplement_unit_is_allowed(unit)),
  constraint supplement_inventory_movements_delta_not_zero check (quantity_delta <> 0),
  constraint supplement_inventory_movements_note_length
    check (note is null or char_length(note) between 1 and 200)
);

comment on table public.supplement_inventory_movements is
  '実装仕様書 5.6節: 在庫の動きの監査証跡（追記専用）。void_supplement_intake はここを読んで「どのロットからいくつ引いたか」を正確に復元する。';
comment on column public.supplement_inventory_movements.quantity_delta is
  '残量の増減。FEFO 消費は負、取消復元・ロット登録は正。ロット単位に1行ずつ記録する。';

create index if not exists supplement_inventory_movements_owner_occurred_idx
  on public.supplement_inventory_movements (owner_id, occurred_at desc);

-- 取消の復元が引く索引（1件の服用記録に対する消費行をロット単位で集める）。
create index if not exists supplement_inventory_movements_intake_idx
  on public.supplement_inventory_movements (owner_id, intake_log_id, movement_kind);

-- ---------------------------------------------------------------------------
-- 在庫ロットのガード（実装仕様書 5.6節 / 9.2節）
--
--   - 商品が所有者スコープに実在すること（複合外部キーと二重になるが、
--     ここで拒否したほうが呼び出し側へ意味のあるコードを返せる）
--   - **ロットの単位は必ず商品の既定単位**。ここが揃っていないと
--     FEFO が「mg のロットから tablet を引く」ような無意味な消費をしてしまう。
--     別テーブルの値なので CHECK では書けず、トリガーに置く。
--   - アーカイブ済み商品への新規ロット登録は拒否（5.3節・5.5節と同じ方針）。
--     既存ロットの訂正（UPDATE）は妨げない。
-- ---------------------------------------------------------------------------
create or replace function public.tg_supplement_lot_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  product public.supplement_products;
begin
  select p.* into product
  from public.supplement_products p
  where p.id = new.product_id
    and p.owner_id = new.owner_id;

  if not found then
    raise exception 'supplement product not found for owner' using errcode = '23503';
  end if;

  if new.unit is distinct from product.default_unit then
    raise exception
      'the inventory lot unit must match the supplement product default unit'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and product.archived_at is not null then
    raise exception 'the supplement product is archived; cannot add new inventory lots'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.tg_supplement_lot_guard() is
  '実装仕様書 5.6節: 在庫ロットの単位を商品の既定単位へ揃え、アーカイブ済み商品への新規ロット登録を拒否する。';

revoke all on function public.tg_supplement_lot_guard() from public, anon, authenticated;

drop trigger if exists supplement_inventory_lots_guard on public.supplement_inventory_lots;
create trigger supplement_inventory_lots_guard
before insert or update on public.supplement_inventory_lots
for each row
execute function public.tg_supplement_lot_guard();

-- ---------------------------------------------------------------------------
-- ロットの削除の制限（実装仕様書 5.6節の監査証跡）
--
-- 打ち間違えたロットは消せてよい。ただし**服用に使われたロット**を消すと、
-- 「どのロットからいくつ引いたか」の記録（movements）も CASCADE で消え、
-- 取消（void_supplement_intake）が正しい復元先を失う。
-- 服用に紐づく動きが1件でもあれば拒否する。
-- ---------------------------------------------------------------------------
create or replace function public.tg_supplement_lot_before_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.supplement_inventory_movements m
    where m.lot_id = old.id
      and m.owner_id = old.owner_id
      and m.intake_log_id is not null
  ) then
    raise exception 'the inventory lot has been used by a recorded intake and cannot be deleted'
      using errcode = '23514';
  end if;

  return old;
end;
$$;

comment on function public.tg_supplement_lot_before_delete() is
  '実装仕様書 5.6節: 服用に使われた在庫ロットの削除を拒否する（取消時の復元先と監査証跡を守るため）。';

revoke all on function public.tg_supplement_lot_before_delete() from public, anon, authenticated;

drop trigger if exists supplement_inventory_lots_before_delete on public.supplement_inventory_lots;
create trigger supplement_inventory_lots_before_delete
before delete on public.supplement_inventory_lots
for each row
execute function public.tg_supplement_lot_before_delete();

-- ---------------------------------------------------------------------------
-- 在庫の動きの記録（監査証跡の唯一の書き手）
--
-- 残量が変わる経路はどれもロット行の INSERT / UPDATE なので、**記録もここ1か所**に
-- 集める。API が別途書く設計にすると「残量は動いたが記録が残らない」食い違いが
-- 起こりうるが、同一トランザクションのトリガーならそれが原理的に起きない
-- （`*_mutation_log` と同じ考え方）。
--
-- 動きの種別は、原子的RPC が張る GUC から決める。RPC が張っていなければ
-- 利用者の手動調整（adjustment）。GUC は `set_config(..., is_local => true)` で
-- 張られるのでトランザクション終了時に必ず消える。
--
-- SECURITY DEFINER。authenticated へ movements の INSERT 権限を渡さずに追記できる
-- （渡すと、在庫を動かさずに「復元した」証跡だけを偽造できてしまう）。
-- ---------------------------------------------------------------------------
create or replace function public.tg_supplement_record_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  delta     numeric;
  kind      text;
  intake_id uuid;
begin
  if tg_op = 'INSERT' then
    delta := new.remaining_quantity;
    kind  := 'purchase';
  else
    delta := new.remaining_quantity - old.remaining_quantity;
    kind  := coalesce(
      nullif(pg_catalog.current_setting('app.supplement_movement_kind', true), ''),
      'adjustment'
    );
  end if;

  -- 残量が動かない更新（メモの訂正など）は在庫の動きではない。
  -- 残量 0 で登録されたロット（空の容器を先に登録した場合など）も同じ。
  if delta = 0 then
    return null;
  end if;

  intake_id := nullif(
    pg_catalog.current_setting('app.supplement_intake_log_id', true), ''
  )::uuid;

  insert into public.supplement_inventory_movements (
    owner_id, product_id, lot_id, intake_log_id, movement_kind, quantity_delta, unit
  )
  values (
    new.owner_id, new.product_id, new.id,
    case when kind in ('intake_consume', 'intake_void_restore') then intake_id end,
    kind, delta, new.unit
  );

  return null;
end;
$$;

comment on function public.tg_supplement_record_movement() is
  '実装仕様書 5.6節: 在庫ロットの残量が動くたびに supplement_inventory_movements へ追記する唯一の書き手。種別は原子的RPC が張る GUC から決まる。';

revoke all on function public.tg_supplement_record_movement() from public, anon, authenticated;

-- AFTER にする。BEFORE では共通トリガーが決める row_version / updated_at や
-- 既定値が NEW に入りきっていない。
drop trigger if exists supplement_inventory_lots_record_movement on public.supplement_inventory_lots;
create trigger supplement_inventory_lots_record_movement
after insert or update of remaining_quantity on public.supplement_inventory_lots
for each row
execute function public.tg_supplement_record_movement();

-- ---------------------------------------------------------------------------
-- 摂取予定のガード（アーカイブ済み商品への新規予定を拒否する）。
-- 在庫ロットと同じ方針（5.3節・5.5節を 5.6節へ適用）。
-- ---------------------------------------------------------------------------
create or replace function public.tg_supplement_schedule_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  product_archived_at timestamptz;
begin
  select p.archived_at into product_archived_at
  from public.supplement_products p
  where p.id = new.product_id
    and p.owner_id = new.owner_id;

  if not found then
    raise exception 'supplement product not found for owner' using errcode = '23503';
  end if;

  if tg_op = 'INSERT' and product_archived_at is not null then
    raise exception 'the supplement product is archived; cannot add new schedules'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.tg_supplement_schedule_guard() is
  '実装仕様書 5.6節: アーカイブ済み商品への新規の摂取予定を拒否する。既存予定の訂正は妨げない。';

revoke all on function public.tg_supplement_schedule_guard() from public, anon, authenticated;

drop trigger if exists supplement_schedules_guard on public.supplement_schedules;
create trigger supplement_schedules_guard
before insert or update of product_id on public.supplement_schedules
for each row
execute function public.tg_supplement_schedule_guard();

-- ---------------------------------------------------------------------------
-- 共通パターン（実装仕様書 6.4節）を取り付ける。
-- docs/database/table-conventions.md 1.1節のとおり、テーブル定義のあとに1行ずつ呼ぶ。
-- `supplement_inventory_movements` は追記専用なので対象外。
-- ---------------------------------------------------------------------------
select public.apply_owned_mutable_table_conventions('public.supplement_products'::regclass);
select public.apply_owned_mutable_table_conventions('public.supplement_schedules'::regclass);
select public.apply_owned_mutable_table_conventions('public.supplement_inventory_lots'::regclass);
select public.apply_owned_mutable_table_conventions('public.supplement_intake_logs'::regclass);
