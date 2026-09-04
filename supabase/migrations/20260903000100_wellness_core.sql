-- 実装仕様書 5.5節「睡眠・水分・体調」/ 6.1節・6.2節・6.3節・6.4節。
--
-- 追加するテーブル（実装仕様書 6.1節「睡眠・水分・体調」境界の全件）:
--   - public.beverage_types            : 飲み物の種別（既定10種 + カスタム）
--   - public.symptom_types             : 症状の種別（既定13種 + カスタム30件まで）
--   - public.sleep_entries             : 睡眠記録
--   - public.sleep_goals               : 睡眠の目標
--   - public.hydration_entries         : 水分記録
--   - public.hydration_goals           : 水分の目標
--   - public.condition_entries         : 体調記録
--   - public.condition_entry_symptoms  : 体調記録に紐づく症状（子テーブル）
--
-- いずれも docs/database/table-conventions.md の「所有者スコープの可変公開テーブル」
-- テンプレートに従い、`public.apply_owned_mutable_table_conventions()` で
-- row_version / client_mutation_id / 楽観ロックの共通パターンを取り付ける。
-- 親子参照は (parent_id, owner_id) -> (id, owner_id) の複合外部キーにする（6.2節）。
--
-- ## 409 からの復帰を設計段階で担保する（Phase 3b の教訓）
--
-- Phase 3b（身体測定フロントエンド）では、楽観ロックの 409 を受けたあとに
-- 「limit 付きの一覧を取り直すだけ」では対象行を見失う事象が繰り返し見つかった。
-- 一覧の何ページ目に対象があるか分からないためで、**対象を1件に絞り込める
-- 検索条件がスキーマ側に無いと、フロントは最新の row_version を取得できない**。
--
-- そこで本 migration は、全テーブルへ「所有者 + 記録日時（+ 種別）」の
-- 一意制約を最初から入れる。API の GET はこの組み合わせを絞り込み条件として
-- 公開するので、409 のあとは必ず1件に到達できる（docs/api/wellness.md 1.7節）。
--
--   | テーブル                 | 対象特定に使う一意制約                     |
--   | ------------------------ | ------------------------------------------ |
--   | sleep_entries            | (owner_id, sleep_kind, sleep_at)           |
--   | hydration_entries        | (owner_id, beverage_type_id, recorded_at)  |
--   | condition_entries        | (owner_id, recorded_at)                    |
--   | sleep_goals              | (owner_id, start_date)                     |
--   | hydration_goals          | (owner_id, start_date)                     |
--   | beverage_types           | (owner_id, beverage_key)                   |
--   | symptom_types            | (owner_id, symptom_key)                    |
--   | condition_entry_symptoms | (entry_id, symptom_type_id)                |
--
-- これらは同時に「同一の所有者・記録日時・種別の重複登録」を防ぐ制約でもある
-- （実装仕様書 5.3節が身体測定へ課しているのと同じ考え方を 5.5節へ広げる）。

-- ---------------------------------------------------------------------------
-- 共通の値検査ヘルパー
--
-- CHECK 制約の中では副問い合わせを書けないため、配列の検査は IMMUTABLE 関数に
-- 切り出して CHECK から呼ぶ。
-- ---------------------------------------------------------------------------

-- 自由記述の配列（体調記録の自由記述症状）。件数と各要素の長さを見る。
--
-- NULL 要素は明示的に拒否する。`bool_and(...)` は NULL を**無視する**集約なので、
-- `bool_and(char_length(item) between 1 and max_length)` だけで書くと
-- `ARRAY[NULL]` が「検査対象が1件も無い」ことになり true で通ってしまう。
-- API 応答スキーマ（`conditionEntrySchema.freeTextSymptoms`）は `string[]`
-- （NULL 非許容）なので、直接書き込み経路から NULL 要素が入ると GET が
-- 契約外のデータを返す。`not exists` で「駄目な要素が1つも無いこと」を要求する
-- 形に直し、NULL も長さ違反も同じ条件で弾く。
create or replace function public.wellness_text_array_is_valid(
  items text[],
  max_items integer,
  max_length integer
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select items is not null
     and coalesce(pg_catalog.cardinality(items), 0) <= max_items
     and not exists (
           select 1
           from pg_catalog.unnest(items) as item
           where item is null
              or pg_catalog.char_length(item) not between 1 and max_length
         );
$$;

comment on function public.wellness_text_array_is_valid(text[], integer, integer) is
  '実装仕様書 5.5節: 自由記述症状のような text[] 列の件数と各要素長を CHECK から検査する。';

revoke all on function public.wellness_text_array_is_valid(text[], integer, integer)
  from public, anon, authenticated;
grant execute on function public.wellness_text_array_is_valid(text[], integer, integer)
  to authenticated;

-- 対象曜日（実装仕様書 5.5節「目標: …対象曜日…」）。
-- 0=日曜 〜 6=土曜。空集合を許さず、重複も許さない。
create or replace function public.wellness_weekdays_are_valid(days smallint[])
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

comment on function public.wellness_weekdays_are_valid(smallint[]) is
  '実装仕様書 5.5節: 目標の対象曜日（0=日〜6=土）。1〜7件・範囲内・重複なしを要求する。';

revoke all on function public.wellness_weekdays_are_valid(smallint[]) from public, anon, authenticated;
grant execute on function public.wellness_weekdays_are_valid(smallint[]) to authenticated;

-- 水分の単位（実装仕様書 5.5節「単位（`ml` / `l` / `us_fl_oz`）」）。
create or replace function public.hydration_unit_is_allowed(unit text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select unit in ('ml', 'l', 'us_fl_oz');
$$;

comment on function public.hydration_unit_is_allowed(text) is
  '実装仕様書 5.5節: 水分の単位は ml / l / us_fl_oz のみ。';

revoke all on function public.hydration_unit_is_allowed(text) from public, anon, authenticated;
grant execute on function public.hydration_unit_is_allowed(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 既定カタログ（実装仕様書 5.5節）
--
-- `seed_default_beverage_types()` / `seed_default_symptom_types()`
-- （migration 20260903000300）の投入元であり、
-- 「is_default を名乗れるキー」の単一の真実でもある。
-- 身体測定の `default_body_measurement_types()`（migration 20260827000500）と
-- 同じ役割。
-- ---------------------------------------------------------------------------

-- > 既定の飲み物候補10種を提供し、任意の種別を追加できる。（実装仕様書 5.5節）
create or replace function public.default_beverage_types()
returns table (
  beverage_key      text,
  display_name      text,
  default_unit      text,
  default_amount    numeric,
  contains_caffeine boolean,
  contains_alcohol  boolean,
  sort_order        integer
)
language sql
immutable
set search_path = ''
as $$
  select
    catalog.beverage_key::text,
    catalog.display_name::text,
    catalog.default_unit::text,
    catalog.default_amount::numeric,
    catalog.contains_caffeine::boolean,
    catalog.contains_alcohol::boolean,
    catalog.sort_order::integer
  from (
    values
      ('water',        '水',               'ml', 200, false, false,  10),
      ('green_tea',    '緑茶',             'ml', 200, true,  false,  20),
      ('coffee',       'コーヒー',         'ml', 150, true,  false,  30),
      ('black_tea',    '紅茶',             'ml', 200, true,  false,  40),
      ('barley_tea',   '麦茶',             'ml', 200, false, false,  50),
      ('milk',         '牛乳',             'ml', 200, false, false,  60),
      ('juice',        'ジュース',         'ml', 200, false, false,  70),
      ('sports_drink', 'スポーツドリンク', 'ml', 500, false, false,  80),
      ('soup',         'スープ',           'ml', 150, false, false,  90),
      ('beer',         'ビール',           'ml', 350, false, true,  100)
  ) as catalog (
    beverage_key, display_name, default_unit, default_amount,
    contains_caffeine, contains_alcohol, sort_order
  );
$$;

comment on function public.default_beverage_types() is
  '実装仕様書 5.5節: 既定10種の飲み物カタログ。seed_default_beverage_types() の投入元。';

revoke all on function public.default_beverage_types() from public, anon, authenticated;
grant execute on function public.default_beverage_types() to authenticated;

-- > 症状（既定13種＋任意30件まで）（実装仕様書 5.5節）
create or replace function public.default_symptom_types()
returns table (
  symptom_key  text,
  display_name text,
  sort_order   integer
)
language sql
immutable
set search_path = ''
as $$
  select
    catalog.symptom_key::text,
    catalog.display_name::text,
    catalog.sort_order::integer
  from (
    values
      ('headache',     '頭痛',       10),
      ('stomachache',  '腹痛',       20),
      ('nausea',       '吐き気',     30),
      ('dizziness',    'めまい',     40),
      ('fever',        '発熱',       50),
      ('cough',        '咳',         60),
      ('runny_nose',   '鼻水',       70),
      ('sore_throat',  'のどの痛み', 80),
      ('fatigue',      '倦怠感',     90),
      ('joint_pain',   '関節痛',    100),
      ('muscle_pain',  '筋肉痛',    110),
      ('diarrhea',     '下痢',      120),
      ('constipation', '便秘',      130)
  ) as catalog (symptom_key, display_name, sort_order);
$$;

comment on function public.default_symptom_types() is
  '実装仕様書 5.5節: 既定13種の症状カタログ。seed_default_symptom_types() の投入元。';

revoke all on function public.default_symptom_types() from public, anon, authenticated;
grant execute on function public.default_symptom_types() to authenticated;

-- ---------------------------------------------------------------------------
-- public.beverage_types（実装仕様書 5.5節）
--   - 所有者ごとに種別を持つ（既定10種は seed RPC が所有者の行として投入する）。
--   - カスタム項目キーは身体測定と同じ `^[a-z][a-z0-9_]{1,49}$`。
--   - 削除は用意せず `archived_at` で無効化する（既定種別はアーカイブ不可）。
-- ---------------------------------------------------------------------------
create table if not exists public.beverage_types (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  beverage_key       text not null,
  display_name       text not null,
  default_unit       text not null,
  default_amount     numeric(10, 3),
  contains_caffeine  boolean not null default false,
  contains_alcohol   boolean not null default false,
  is_default         boolean not null default false,
  sort_order         integer not null default 1000,
  archived_at        timestamptz,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint beverage_types_id_owner_id_key unique (id, owner_id),
  -- 409 後の対象特定と重複登録防止を兼ねる（本ファイル冒頭の表）。
  constraint beverage_types_owner_key_key unique (owner_id, beverage_key),
  constraint beverage_types_key_format check (beverage_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  constraint beverage_types_display_name_length
    check (char_length(display_name) between 1 and 100),
  constraint beverage_types_default_unit_allowed
    check (public.hydration_unit_is_allowed(default_unit)),
  -- 実装仕様書 5.5節「量（0超10,000以下）」。既定量にも同じ範囲を課す。
  constraint beverage_types_default_amount_range
    check (default_amount is null or (default_amount > 0 and default_amount <= 10000)),
  constraint beverage_types_sort_order_range check (sort_order between 0 and 100000),
  constraint beverage_types_default_not_archived
    check (not (is_default and archived_at is not null))
);

comment on table public.beverage_types is
  '実装仕様書 5.5節: 飲み物の種別。既定10種は seed_default_beverage_types() が所有者ごとに投入する。';
comment on column public.beverage_types.is_default is
  '既定カタログ由来の種別。true にできるのは default_beverage_types() に載るキーだけ（トリガーで強制）。';

create index if not exists beverage_types_owner_sort_idx
  on public.beverage_types (owner_id, sort_order, beverage_key);

-- ---------------------------------------------------------------------------
-- public.symptom_types（実装仕様書 5.5節）
--   - 既定13種 + カスタム30件まで（カスタムの上限はトリガーで検査する）。
-- ---------------------------------------------------------------------------
create table if not exists public.symptom_types (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  symptom_key        text not null,
  display_name       text not null,
  is_default         boolean not null default false,
  sort_order         integer not null default 1000,
  archived_at        timestamptz,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint symptom_types_id_owner_id_key unique (id, owner_id),
  constraint symptom_types_owner_key_key unique (owner_id, symptom_key),
  constraint symptom_types_key_format check (symptom_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  constraint symptom_types_display_name_length
    check (char_length(display_name) between 1 and 100),
  constraint symptom_types_sort_order_range check (sort_order between 0 and 100000),
  constraint symptom_types_default_not_archived
    check (not (is_default and archived_at is not null))
);

comment on table public.symptom_types is
  '実装仕様書 5.5節: 症状の種別。既定13種 + カスタム30件まで。';

create index if not exists symptom_types_owner_sort_idx
  on public.symptom_types (owner_id, sort_order, symptom_key);

-- ---------------------------------------------------------------------------
-- public.sleep_entries（実装仕様書 5.5節）
--
-- > 種別（夜間／仮眠／その他）、就床・入眠・起床・離床の各日時、タイムゾーン、
-- > 中途覚醒回数（0〜30）、覚醒時間（0〜720分）、睡眠の質（1〜5）、
-- > 起床時の感覚（1〜5）、メモ。就床≦入眠＜起床≦離床の順序、24時間超や
-- > 覚醒時間が睡眠時間以上となる値を拒否する。睡眠時間は `起床-入眠-覚醒時間` で算出する。
--
-- 4つの日時はすべて必須にする。1つでも欠けると順序検証（就床≦入眠＜起床≦離床）が
-- 成立せず、24時間超の判定もできないため。仮眠のように就床＝入眠、起床＝離床の
-- 記録は同値を入れて表す（`<=` なので通る）。
-- ---------------------------------------------------------------------------
create table if not exists public.sleep_entries (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  sleep_kind         text not null,
  bed_at             timestamptz not null,
  sleep_at           timestamptz not null,
  wake_at            timestamptz not null,
  out_of_bed_at      timestamptz not null,
  timezone           text not null default 'Asia/Tokyo',
  awakenings_count   integer not null default 0,
  awake_minutes      integer not null default 0,
  quality            smallint,
  morning_feeling    smallint,
  note               text,
  -- 実装仕様書 5.5節「睡眠時間は `起床-入眠-覚醒時間` で算出する」。
  -- 入力値だけで決まるため生成列にする（6.3節の正規化値と同じ考え方）。
  sleep_minutes integer generated always as (
    floor(extract(epoch from (wake_at - sleep_at)) / 60)::integer - awake_minutes
  ) stored,
  -- 就床から離床までの拘束時間。睡眠効率（sleep_minutes / time_in_bed_minutes）の分母。
  time_in_bed_minutes integer generated always as (
    floor(extract(epoch from (out_of_bed_at - bed_at)) / 60)::integer
  ) stored,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint sleep_entries_id_owner_id_key unique (id, owner_id),
  -- 409 後の対象特定と重複登録防止を兼ねる（本ファイル冒頭の表）。
  constraint sleep_entries_owner_kind_sleep_at_key unique (owner_id, sleep_kind, sleep_at),
  constraint sleep_entries_kind_allowed check (sleep_kind in ('night', 'nap', 'other')),
  -- 就床 ≦ 入眠 ＜ 起床 ≦ 離床
  constraint sleep_entries_chronology
    check (bed_at <= sleep_at and sleep_at < wake_at and wake_at <= out_of_bed_at),
  -- 24時間超の拒否。就床から離床までの全体で見る（入眠〜起床はその内側）。
  constraint sleep_entries_within_24_hours
    check (out_of_bed_at - bed_at <= interval '24 hours'),
  constraint sleep_entries_awakenings_range check (awakenings_count between 0 and 30),
  constraint sleep_entries_awake_minutes_range check (awake_minutes between 0 and 720),
  -- 「覚醒時間が睡眠時間以上となる値を拒否する。睡眠時間は `起床-入眠-覚醒時間`」。
  --
  -- 比較の相手は入眠〜起床の総時間ではなく**睡眠時間**である点に注意する。
  -- 覚醒時間を a、入眠〜起床の総時間（分）を t とすると 睡眠時間 = t - a なので、
  -- 要求は a < t - a、すなわち 2a < t。
  -- （総時間と比べる `a < t` だと、例えば t=60・a=40 のように睡眠時間20分より
  -- 覚醒時間40分の方が長い記録が通ってしまう。）
  constraint sleep_entries_awake_shorter_than_sleep
    check (awake_minutes * 2 < extract(epoch from (wake_at - sleep_at)) / 60),
  constraint sleep_entries_quality_range check (quality is null or quality between 1 and 5),
  constraint sleep_entries_morning_feeling_range
    check (morning_feeling is null or morning_feeling between 1 and 5),
  constraint sleep_entries_note_length check (note is null or char_length(note) <= 500),
  -- 実装仕様書 6.3節: 表示タイムゾーンは IANA 名で保持する（users と同じ形）。
  constraint sleep_entries_timezone_format
    check (timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$')
);

comment on table public.sleep_entries is
  '実装仕様書 5.5節: 睡眠記録。就床≦入眠＜起床≦離床・24時間以内・覚醒時間<睡眠時間をDB側で強制する。';
comment on column public.sleep_entries.sleep_minutes is
  '実装仕様書 5.5節: 睡眠時間（分）= 起床 - 入眠 - 覚醒時間。生成列。';
comment on column public.sleep_entries.time_in_bed_minutes is
  '就床から離床までの分数。睡眠効率の分母に使う。生成列。';

-- 実装仕様書 6.2節「よく使う時系列検索は (owner_id, timestamp) の複合インデックス」。
create index if not exists sleep_entries_owner_sleep_at_idx
  on public.sleep_entries (owner_id, sleep_at desc);
create index if not exists sleep_entries_owner_kind_sleep_at_idx
  on public.sleep_entries (owner_id, sleep_kind, sleep_at desc);

-- ---------------------------------------------------------------------------
-- public.sleep_goals（実装仕様書 5.5節）
--
-- > 目標: 睡眠・水分の目標量、対象曜日、目標就床・起床時刻、開始日・終了日を
-- > 設定できる。
--
-- 期間の重なりを完全に禁じると「今日から新しい目標へ切り替える」操作が
-- 書けなくなるため、次の2つだけを制約にする。
--   - 開始日は所有者ごとに一意（同じ日から始まる目標を2つ持たない）
--   - 終了日の無い（＝現在有効な）目標は所有者ごとに1件
-- ---------------------------------------------------------------------------
create table if not exists public.sleep_goals (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references public.users (id) on delete cascade,
  target_sleep_minutes integer not null,
  weekdays             smallint[] not null default '{0,1,2,3,4,5,6}'::smallint[],
  target_bedtime       time,
  target_wake_time     time,
  timezone             text not null default 'Asia/Tokyo',
  start_date           date not null,
  end_date             date,
  note                 text,
  client_mutation_id   uuid,
  row_version          bigint not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint sleep_goals_id_owner_id_key unique (id, owner_id),
  -- 409 後の対象特定（本ファイル冒頭の表）。
  constraint sleep_goals_owner_start_date_key unique (owner_id, start_date),
  -- 目標量は1時間〜24時間の範囲。
  constraint sleep_goals_target_range check (target_sleep_minutes between 60 and 1440),
  constraint sleep_goals_weekdays_valid check (public.wellness_weekdays_are_valid(weekdays)),
  constraint sleep_goals_period check (end_date is null or end_date >= start_date),
  constraint sleep_goals_note_length check (note is null or char_length(note) <= 500),
  constraint sleep_goals_timezone_format
    check (timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$')
);

comment on table public.sleep_goals is
  '実装仕様書 5.5節: 睡眠の目標（目標量・対象曜日・目標就床/起床時刻・開始日/終了日）。';
comment on column public.sleep_goals.weekdays is
  '対象曜日。0=日曜〜6=土曜。1〜7件・重複なし（wellness_weekdays_are_valid）。';

-- 終了日の無い（現在有効な）目標は所有者ごとに1件だけ。
create unique index if not exists sleep_goals_owner_active_key
  on public.sleep_goals (owner_id)
  where end_date is null;

create index if not exists sleep_goals_owner_start_date_idx
  on public.sleep_goals (owner_id, start_date desc);

-- ---------------------------------------------------------------------------
-- public.hydration_entries（実装仕様書 5.5節）
--
-- > 記録日時、飲み物名、単位（`ml` / `l` / `us_fl_oz`）、量（0超10,000以下）、
-- > カフェイン有無、アルコール有無、メモ。集計用に `ml` 正規化値を保持する。
--
-- 「飲み物名」は `beverage_types` の表示名で表す。自由文字列ではなく種別参照に
-- するのは、(所有者, 種別, 記録日時) を一意にして 409 後の対象特定を成立させるため
-- （本ファイル冒頭の表）。任意の飲み物はカスタム種別を追加して表す（5.5節）。
-- ---------------------------------------------------------------------------
create table if not exists public.hydration_entries (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  beverage_type_id   uuid not null,
  recorded_at        timestamptz not null,
  unit               text not null,
  amount             numeric(10, 3) not null,
  contains_caffeine  boolean not null default false,
  contains_alcohol   boolean not null default false,
  note               text,
  -- 実装仕様書 5.5節「集計用に `ml` 正規化値を保持する」/ 6.3節。
  -- 1 l = 1000 ml、1 US fl oz = 29.5735295625 ml（米液量オンスの定義値）。
  amount_ml numeric(14, 6) generated always as (
    case unit
      when 'ml'       then amount
      when 'l'        then amount * 1000
      when 'us_fl_oz' then amount * 29.5735295625
      else null
    end
  ) stored,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint hydration_entries_id_owner_id_key unique (id, owner_id),
  -- 実装仕様書 6.2節: 他利用者の種別へ記録を接続できないようにする複合外部キー。
  constraint hydration_entries_beverage_type_fkey
    foreign key (beverage_type_id, owner_id)
    references public.beverage_types (id, owner_id) on delete cascade,
  -- 409 後の対象特定と重複登録防止を兼ねる（本ファイル冒頭の表）。
  constraint hydration_entries_owner_type_recorded_at_key
    unique (owner_id, beverage_type_id, recorded_at),
  constraint hydration_entries_unit_allowed check (public.hydration_unit_is_allowed(unit)),
  constraint hydration_entries_amount_range check (amount > 0 and amount <= 10000),
  constraint hydration_entries_note_length check (note is null or char_length(note) <= 500)
);

comment on table public.hydration_entries is
  '実装仕様書 5.5節: 水分記録。入力値・入力単位のまま保存し、集計用の ml 正規化値を生成列で持つ（6.3節）。';
comment on column public.hydration_entries.amount_ml is
  '実装仕様書 5.5節・6.3節: 集計用の ml 正規化値。l は ×1000、us_fl_oz は ×29.5735295625。';

create index if not exists hydration_entries_owner_recorded_at_idx
  on public.hydration_entries (owner_id, recorded_at desc);
create index if not exists hydration_entries_owner_type_recorded_at_idx
  on public.hydration_entries (owner_id, beverage_type_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- public.hydration_goals（実装仕様書 5.5節）
-- ---------------------------------------------------------------------------
create table if not exists public.hydration_goals (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  target_amount_ml   numeric(10, 3) not null,
  weekdays           smallint[] not null default '{0,1,2,3,4,5,6}'::smallint[],
  timezone           text not null default 'Asia/Tokyo',
  start_date         date not null,
  end_date           date,
  note               text,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint hydration_goals_id_owner_id_key unique (id, owner_id),
  constraint hydration_goals_owner_start_date_key unique (owner_id, start_date),
  -- 1日の目標量。記録1件の上限（10,000ml）より広く、非現実的な値は弾く。
  constraint hydration_goals_target_range
    check (target_amount_ml > 0 and target_amount_ml <= 20000),
  constraint hydration_goals_weekdays_valid check (public.wellness_weekdays_are_valid(weekdays)),
  constraint hydration_goals_period check (end_date is null or end_date >= start_date),
  constraint hydration_goals_note_length check (note is null or char_length(note) <= 500),
  constraint hydration_goals_timezone_format
    check (timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$')
);

comment on table public.hydration_goals is
  '実装仕様書 5.5節: 水分の目標（目標量・対象曜日・開始日/終了日）。';

create unique index if not exists hydration_goals_owner_active_key
  on public.hydration_goals (owner_id)
  where end_date is null;

create index if not exists hydration_goals_owner_start_date_idx
  on public.hydration_goals (owner_id, start_date desc);

-- ---------------------------------------------------------------------------
-- public.condition_entries（実装仕様書 5.5節）
--
-- > 総合・疲労・活力・ストレス・痛み・気分（各0〜10）、体温（30〜45℃）、
-- > 症状（既定13種＋任意30件まで）、自由記述症状（10件まで）、メモ。
-- ---------------------------------------------------------------------------
create table if not exists public.condition_entries (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  recorded_at        timestamptz not null,
  timezone           text not null default 'Asia/Tokyo',
  overall_score      smallint,
  fatigue_score      smallint,
  energy_score       smallint,
  stress_score       smallint,
  pain_score         smallint,
  mood_score         smallint,
  body_temperature_c numeric(4, 1),
  free_text_symptoms text[] not null default '{}'::text[],
  note               text,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint condition_entries_id_owner_id_key unique (id, owner_id),
  -- 409 後の対象特定と重複登録防止を兼ねる（本ファイル冒頭の表）。
  constraint condition_entries_owner_recorded_at_key unique (owner_id, recorded_at),
  constraint condition_entries_overall_range
    check (overall_score is null or overall_score between 0 and 10),
  constraint condition_entries_fatigue_range
    check (fatigue_score is null or fatigue_score between 0 and 10),
  constraint condition_entries_energy_range
    check (energy_score is null or energy_score between 0 and 10),
  constraint condition_entries_stress_range
    check (stress_score is null or stress_score between 0 and 10),
  constraint condition_entries_pain_range
    check (pain_score is null or pain_score between 0 and 10),
  constraint condition_entries_mood_range
    check (mood_score is null or mood_score between 0 and 10),
  -- 実装仕様書 5.5節「体温（30〜45℃）」。非医療（10章）なので値の判定はしない。
  constraint condition_entries_temperature_range
    check (body_temperature_c is null or (body_temperature_c >= 30 and body_temperature_c <= 45)),
  -- 実装仕様書 5.5節「自由記述症状（10件まで）」。
  constraint condition_entries_free_text_symptoms_valid
    check (public.wellness_text_array_is_valid(free_text_symptoms, 10, 100)),
  constraint condition_entries_note_length check (note is null or char_length(note) <= 500),
  constraint condition_entries_timezone_format
    check (timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$')
);

comment on table public.condition_entries is
  '実装仕様書 5.5節: 体調記録。各スコアは0〜10、体温は30〜45℃、自由記述症状は10件まで。';
comment on column public.condition_entries.free_text_symptoms is
  '実装仕様書 5.5節「自由記述症状（10件まで）」。種別として登録しない一過性の症状を書く。';

create index if not exists condition_entries_owner_recorded_at_idx
  on public.condition_entries (owner_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- public.condition_entry_symptoms（実装仕様書 5.5節・6.2節）
--
-- 体調記録と症状種別の関連。docs/database/table-conventions.md 2節の
-- 複合外部キー `(parent_id, owner_id) -> (id, owner_id)` を、親（体調記録）と
-- 参照先（症状種別）の**両方**へ張る。
--
-- 1件の体調記録に紐づけられる症状は最大43件（既定13種 + カスタム30件）。
-- カスタム症状種別そのものの上限（30件）は tg_wellness_reference_guard() で検査する。
-- ---------------------------------------------------------------------------
create table if not exists public.condition_entry_symptoms (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  entry_id           uuid not null,
  symptom_type_id    uuid not null,
  severity           smallint,
  note               text,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint condition_entry_symptoms_id_owner_id_key unique (id, owner_id),
  constraint condition_entry_symptoms_entry_fkey
    foreign key (entry_id, owner_id)
    references public.condition_entries (id, owner_id) on delete cascade,
  constraint condition_entry_symptoms_type_fkey
    foreign key (symptom_type_id, owner_id)
    references public.symptom_types (id, owner_id) on delete cascade,
  -- 同じ体調記録へ同じ症状を二重に紐づけない。
  constraint condition_entry_symptoms_entry_type_key unique (entry_id, symptom_type_id),
  constraint condition_entry_symptoms_severity_range
    check (severity is null or severity between 0 and 10),
  constraint condition_entry_symptoms_note_length
    check (note is null or char_length(note) <= 200)
);

comment on table public.condition_entry_symptoms is
  '実装仕様書 5.5節: 体調記録に紐づく症状。親（体調記録）と症状種別の双方へ複合外部キーを張る（6.2節）。';

create index if not exists condition_entry_symptoms_owner_entry_idx
  on public.condition_entry_symptoms (owner_id, entry_id);
create index if not exists condition_entry_symptoms_owner_type_idx
  on public.condition_entry_symptoms (owner_id, symptom_type_id);

-- ---------------------------------------------------------------------------
-- 種別カタログの保護（実装仕様書 5.5節。身体測定 5.3節と同じ方針）。
--
-- 既定種別（is_default = true）の作成・変更は seed RPC に限定する。
-- 三重に塞ぐのは身体測定（migration 20260827000500）と同じ。
--   1. 列レベル権限: authenticated へ is_default の INSERT/UPDATE 権限を与えない
--      （migration 20260903000200）。
--   2. このトリガー: seed RPC の実行中以外は is_default の作成・変更を拒否する。
--   3. カタログ判定: 既定カタログのキーはカスタム種別（is_default=false）が
--      名乗れない。これが無いと「先に custom の `water` を作る → seed が
--      読み飛ばす」で既定種別になりすませてしまう。
--
-- 目印の GUC は `app.wellness_seed`。seed RPC が set_config(..., is_local => true)
-- で立てるため、PostgREST 経由の authenticated からは立てられない。
-- ---------------------------------------------------------------------------
create or replace function public.tg_wellness_reference_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  seeding boolean := coalesce(
    pg_catalog.current_setting('app.wellness_seed', true),
    'off'
  ) = 'on';
  key_column text := case tg_table_name
    when 'beverage_types' then 'beverage_key'
    else 'symptom_key'
  end;
  new_key text := pg_catalog.to_jsonb(new) ->> key_column;
  old_key text := case when tg_op = 'UPDATE' then pg_catalog.to_jsonb(old) ->> key_column end;
  in_catalog boolean;
  custom_count integer;
begin
  if tg_table_name = 'beverage_types' then
    in_catalog := exists (
      select 1 from public.default_beverage_types() d where d.beverage_key = new_key
    );
  else
    in_catalog := exists (
      select 1 from public.default_symptom_types() d where d.symptom_key = new_key
    );
  end if;

  -- 既定種別の行は seed RPC 以外から一切 UPDATE させない。
  -- 列レベル権限では「どの行か」を表現できないため、行の判定はここで行う
  -- （表示名・既定量・並び順の書き換えによる既定カタログの偽装を防ぐ）。
  if tg_op = 'UPDATE' and old.is_default and not seeding then
    if new.is_default is distinct from old.is_default then
      raise exception 'column "is_default" is immutable on default % rows', tg_table_name
        using errcode = '23514';
    end if;

    if new_key is distinct from old_key then
      raise exception 'the catalog key is immutable on default % rows', tg_table_name
        using errcode = '23514';
    end if;

    if new.archived_at is not null then
      raise exception 'default % rows cannot be archived', tg_table_name
        using errcode = '23514';
    end if;

    raise exception
      'default % rows can only be modified by the wellness seed functions', tg_table_name
      using errcode = '42501';
  end if;

  if new.is_default and not in_catalog then
    raise exception 'is_default is reserved for the default wellness catalog'
      using errcode = '23514';
  end if;

  -- 既定カタログのキーは既定種別専用。カスタム種別が名乗ると既定種別の偽装になる。
  if not new.is_default and in_catalog then
    raise exception 'key "%" is reserved for the default wellness catalog', new_key
      using errcode = '23514';
  end if;

  if not seeding then
    if tg_op = 'INSERT' and new.is_default then
      raise exception 'is_default rows can only be created by the wellness seed functions'
        using errcode = '42501';
    end if;

    if tg_op = 'UPDATE' and new.is_default is distinct from old.is_default then
      raise exception 'column "is_default" can only be changed by the wellness seed functions'
        using errcode = '42501';
    end if;
  end if;

  -- 実装仕様書 5.5節「症状（既定13種＋任意30件まで）」。
  -- 既定カタログの13件とは別枠で、カスタム症状種別を30件までに抑える。
  --
  -- **アーカイブ済み（archived_at is not null）は数えない**。上限に達したときの
  -- 案内は「不要な症状をアーカイブしてからお試しください」（`errors.ts` の
  -- `wellnessTypeLimitReached`）であり、アーカイブ済みも数えていると案内どおりに
  -- 操作しても枠が空かず、利用者が詰んでしまう。
  --
  -- 検査するのは「有効なカスタム症状が1件増える瞬間」。INSERT だけを見ていると
  -- アーカイブ解除で上限を破れてしまう:
  --   30件作る → 1件アーカイブ（有効29件）→ 代替を1件作る（有効30件）
  --   → 最初の1件のアーカイブを解除（有効31件）
  -- そこで、アーカイブ解除（archived_at を NULL へ戻す UPDATE）も同じ検査を通す。
  -- 逆に、アーカイブ済みのまま入る／留まる行は有効件数を増やさないので数えない。
  if tg_table_name = 'symptom_types'
    and not new.is_default
    and new.archived_at is null
    and (tg_op = 'INSERT' or old.archived_at is not null)
  then
    select pg_catalog.count(*) into custom_count
    from public.symptom_types s
    where s.owner_id = new.owner_id
      and not s.is_default
      and s.archived_at is null
      -- BEFORE UPDATE の時点では自分自身がまだ「アーカイブ済み」で見えている。
      -- 数え漏らし・二重計上のどちらも起きないよう、対象行は明示的に除く。
      and s.id is distinct from new.id;

    if custom_count >= 30 then
      raise exception 'custom symptom types are limited to 30 per owner'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_wellness_reference_guard() is
  '実装仕様書 5.5節: 飲み物・症状の既定カタログを偽装・改ざんから守り、有効なカスタム症状種別を30件（アーカイブ済みを除く）までに抑える。上限は新規作成とアーカイブ解除の両方で検査する。';

revoke all on function public.tg_wellness_reference_guard() from public, anon, authenticated;

drop trigger if exists beverage_types_guard on public.beverage_types;
create trigger beverage_types_guard
before insert or update on public.beverage_types
for each row
execute function public.tg_wellness_reference_guard();

drop trigger if exists symptom_types_guard on public.symptom_types;
create trigger symptom_types_guard
before insert or update on public.symptom_types
for each row
execute function public.tg_wellness_reference_guard();

-- ---------------------------------------------------------------------------
-- アーカイブ済み種別への新規登録の拒否（実装仕様書 5.3節の方針を 5.5節へ適用）。
--
-- 種別のアーカイブ状態は別テーブルにあるため CHECK では書けない。値の妥当性の
-- 最終防衛線（9.2節「DB制約とRLSを最終防衛線とする」）としてトリガーに置く。
-- 拒否するのは**新規登録（INSERT）**だけで、既存行の訂正（UPDATE）は妨げない。
--
-- あわせて、1件の体調記録に紐づく症状の件数上限（43 = 既定13 + カスタム30）も
-- ここで検査する。
-- ---------------------------------------------------------------------------
create or replace function public.tg_wellness_entry_reference_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reference_archived_at timestamptz;
  linked_count integer;
begin
  if tg_table_name = 'hydration_entries' then
    select b.archived_at into reference_archived_at
    from public.beverage_types b
    where b.id = new.beverage_type_id
      and b.owner_id = new.owner_id;

    if not found then
      raise exception 'beverage type not found for owner' using errcode = '23503';
    end if;
  else
    select s.archived_at into reference_archived_at
    from public.symptom_types s
    where s.id = new.symptom_type_id
      and s.owner_id = new.owner_id;

    if not found then
      raise exception 'symptom type not found for owner' using errcode = '23503';
    end if;

    if tg_op = 'INSERT' then
      select pg_catalog.count(*) into linked_count
      from public.condition_entry_symptoms c
      where c.entry_id = new.entry_id;

      if linked_count >= 43 then
        raise exception 'a condition entry can link at most 43 symptoms'
          using errcode = '23514';
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' and reference_archived_at is not null then
    raise exception 'the referenced wellness type is archived; cannot add new rows to %',
      tg_table_name
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.tg_wellness_entry_reference_guard() is
  '実装仕様書 5.5節: アーカイブ済みの飲み物・症状種別への新規登録を拒否し、体調記録あたりの症状件数を43件までに抑える。';

revoke all on function public.tg_wellness_entry_reference_guard() from public, anon, authenticated;

drop trigger if exists hydration_entries_reference_guard on public.hydration_entries;
create trigger hydration_entries_reference_guard
before insert or update of beverage_type_id on public.hydration_entries
for each row
execute function public.tg_wellness_entry_reference_guard();

drop trigger if exists condition_entry_symptoms_reference_guard on public.condition_entry_symptoms;
create trigger condition_entry_symptoms_reference_guard
before insert or update of symptom_type_id on public.condition_entry_symptoms
for each row
execute function public.tg_wellness_entry_reference_guard();

-- ---------------------------------------------------------------------------
-- 共通パターン（実装仕様書 6.4節）を取り付ける。
-- docs/database/table-conventions.md 1.1節のとおり、テーブル定義のあとに1行ずつ呼ぶ。
-- ---------------------------------------------------------------------------
select public.apply_owned_mutable_table_conventions('public.beverage_types'::regclass);
select public.apply_owned_mutable_table_conventions('public.symptom_types'::regclass);
select public.apply_owned_mutable_table_conventions('public.sleep_entries'::regclass);
select public.apply_owned_mutable_table_conventions('public.sleep_goals'::regclass);
select public.apply_owned_mutable_table_conventions('public.hydration_entries'::regclass);
select public.apply_owned_mutable_table_conventions('public.hydration_goals'::regclass);
select public.apply_owned_mutable_table_conventions('public.condition_entries'::regclass);
select public.apply_owned_mutable_table_conventions('public.condition_entry_symptoms'::regclass);
