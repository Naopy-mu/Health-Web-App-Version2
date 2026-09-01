-- 実装仕様書 5.3節「身体測定」/ 6.1節・6.2節・6.3節・6.4節。
--
-- 追加するテーブル（実装仕様書 6.1節「身体測定」境界のうち Phase 3a の範囲）:
--   - public.body_measurement_types  : 測定種別（既定10種 + カスタム）
--   - public.body_measurements       : 測定記録
--   - public.body_measurement_goals  : 測定目標
--
-- いずれも docs/database/table-conventions.md の「所有者スコープの可変公開テーブル」
-- テンプレートに従い、`public.apply_owned_mutable_table_conventions()` で
-- row_version / client_mutation_id / 楽観ロックの共通パターンを取り付ける。
-- 親子参照は (parent_id, owner_id) -> (id, owner_id) の複合外部キーにする（6.2節）。
--
-- `progress_photos`（6.1節）は本フェーズの範囲外。測定記録の写真は
-- `body_measurements.photo_reference` で参照のみを持つ。

-- ---------------------------------------------------------------------------
-- 単位と単位制約（実装仕様書 5.3節）
--
-- > 単位: `kg` / `lb` / `cm` / `inch` / `percent` / `index` / `custom`。項目種別に応じた
-- > 単位制約（体重は kg|lb、体脂肪率は %、BMIは無次元のため `index`、
-- > 周囲・長さは cm|inch）を持つ。**BMIを`percent`として扱わない**
-- > （BMIは割合ではないため、`%`表示は誤表示になる）。
--
-- 単位制約の識別子は次の5つ。DB・API・フロントで同じ語を使う。
--   mass    -> kg | lb
--   percent -> percent
--   index   -> index    （無次元。BMI）
--   length  -> cm | inch
--   custom  -> custom
-- ---------------------------------------------------------------------------
create or replace function public.body_measurement_unit_is_allowed(
  unit_constraint text,
  unit text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case unit_constraint
    when 'mass'    then unit in ('kg', 'lb')
    when 'percent' then unit = 'percent'
    when 'index'   then unit = 'index'
    when 'length'  then unit in ('cm', 'inch')
    when 'custom'  then unit = 'custom'
    else false
  end;
$$;

comment on function public.body_measurement_unit_is_allowed(text, text) is
  '実装仕様書 5.3節: 単位制約（mass/percent/index/length/custom）に対して単位が許されるか。';

revoke all on function public.body_measurement_unit_is_allowed(text, text) from public, anon, authenticated;
grant execute on function public.body_measurement_unit_is_allowed(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 既定の測定種別カタログ（実装仕様書 5.3節）
--
-- > 既定項目: 体重、体脂肪率、BMI、ウエスト、へそ周り、骨盤周り、ヒップ、
-- > 太もも、ふくらはぎ、肩幅。
--
-- `seed_default_body_measurement_types()` の投入元であり、
-- 「is_default を名乗れるキー」の単一の真実でもある。
-- ---------------------------------------------------------------------------
create or replace function public.default_body_measurement_types()
returns table (
  measurement_key text,
  display_name    text,
  unit_constraint text,
  default_unit    text,
  sort_order      integer
)
language sql
immutable
set search_path = ''
as $$
  select
    catalog.measurement_key::text,
    catalog.display_name::text,
    catalog.unit_constraint::text,
    catalog.default_unit::text,
    catalog.sort_order::integer
  from (
    values
      ('weight',              '体重',       'mass',    'kg',      10),
      ('body_fat_percentage', '体脂肪率',   'percent', 'percent', 20),
      -- BMI は無次元（実装仕様書 5.3節）。percent にすると %表示の誤表示になる。
      ('bmi',                 'BMI',        'index',   'index',   30),
      ('waist',               'ウエスト',   'length',  'cm',      40),
      ('navel_girth',         'へそ周り',   'length',  'cm',      50),
      ('pelvis_girth',        '骨盤周り',   'length',  'cm',      60),
      ('hip',                 'ヒップ',     'length',  'cm',      70),
      ('thigh',               '太もも',     'length',  'cm',      80),
      ('calf',                'ふくらはぎ', 'length',  'cm',      90),
      ('shoulder_width',      '肩幅',       'length',  'cm',     100)
  ) as catalog (measurement_key, display_name, unit_constraint, default_unit, sort_order);
$$;

comment on function public.default_body_measurement_types() is
  '実装仕様書 5.3節: 既定10種別のカタログ。seed_default_body_measurement_types() の投入元であり、is_default を許すキーの単一の真実。';

revoke all on function public.default_body_measurement_types() from public, anon, authenticated;
grant execute on function public.default_body_measurement_types() to authenticated;

-- ---------------------------------------------------------------------------
-- public.body_measurement_types
--   - 所有者ごとに種別を持つ（既定10種は seed RPC が所有者の行として投入する）。
--   - カスタム項目キーは実装仕様書 5.3節の `^[a-z][a-z0-9_]{1,49}$`。
--   - 削除は用意せず `archived_at` で無効化する（既定種別はアーカイブ不可）。
-- ---------------------------------------------------------------------------
create table if not exists public.body_measurement_types (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  measurement_key    text not null,
  display_name       text not null,
  unit_constraint    text not null,
  default_unit       text not null,
  is_default         boolean not null default false,
  sort_order         integer not null default 1000,
  archived_at        timestamptz,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint body_measurement_types_id_owner_id_key unique (id, owner_id),
  -- 所有者ごとに項目キーは一意（既定投入の再実行を冪等にする土台でもある）。
  constraint body_measurement_types_owner_key_key unique (owner_id, measurement_key),
  constraint body_measurement_types_key_format
    check (measurement_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  constraint body_measurement_types_display_name_length
    check (char_length(display_name) between 1 and 100),
  constraint body_measurement_types_unit_constraint_allowed
    check (unit_constraint in ('mass', 'percent', 'index', 'length', 'custom')),
  constraint body_measurement_types_default_unit_matches
    check (public.body_measurement_unit_is_allowed(unit_constraint, default_unit)),
  constraint body_measurement_types_sort_order_range
    check (sort_order between 0 and 100000),
  -- 実装仕様書 5.3節・5.4節の方針: 既定種別はアーカイブ不可。
  constraint body_measurement_types_default_not_archived
    check (not (is_default and archived_at is not null))
);

comment on table public.body_measurement_types is
  '実装仕様書 5.3節: 測定種別。既定10種は seed_default_body_measurement_types() が所有者ごとに投入する。';
comment on column public.body_measurement_types.unit_constraint is
  '実装仕様書 5.3節: mass(kg|lb) / percent(percent) / index(index) / length(cm|inch) / custom(custom)。';
comment on column public.body_measurement_types.is_default is
  '既定カタログ由来の種別。true にできるのは default_body_measurement_types() に載るキーだけ（トリガーで強制）。';

create index if not exists body_measurement_types_owner_sort_idx
  on public.body_measurement_types (owner_id, sort_order, measurement_key);

-- ---------------------------------------------------------------------------
-- public.body_measurements
--   - 記録項目（実装仕様書 5.3節）: 日時、値（0超1000以下）、単位、メモ（500字）、
--     測定条件、測定部位、写真参照。
--   - 値と単位は入力のまま保存し（6.3節）、集計用の正規化値を生成列で併せ持つ。
--   - 同一の所有者・種別・日時の重複登録は一意制約で防ぐ（5.3節）。
-- ---------------------------------------------------------------------------
create table if not exists public.body_measurements (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references public.users (id) on delete cascade,
  type_id               uuid not null,
  measured_at           timestamptz not null,
  value                 numeric(10, 3) not null,
  unit                  text not null,
  note                  text,
  measurement_condition text,
  body_site             text,
  photo_reference       text,
  -- 実装仕様書 6.3節「集計用の正規化値を併せて持つ」。単位だけで決まるため生成列にする。
  normalized_value numeric(14, 6) generated always as (
    case unit
      when 'kg'      then value
      when 'lb'      then value * 0.45359237
      when 'cm'      then value
      when 'inch'    then value * 2.54
      when 'percent' then value
      when 'index'   then value
      else null
    end
  ) stored,
  normalized_unit text generated always as (
    case unit
      when 'kg'      then 'kg'
      when 'lb'      then 'kg'
      when 'cm'      then 'cm'
      when 'inch'    then 'cm'
      when 'percent' then 'percent'
      when 'index'   then 'index'
      else null
    end
  ) stored,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint body_measurements_id_owner_id_key unique (id, owner_id),
  -- 実装仕様書 6.2節: 他利用者の種別へ記録を接続できないようにする複合外部キー。
  constraint body_measurements_type_fkey
    foreign key (type_id, owner_id)
    references public.body_measurement_types (id, owner_id) on delete cascade,
  -- 実装仕様書 5.3節「同一の所有者・種別・日時の重複登録はDBの一意制約で防ぐ」。
  constraint body_measurements_owner_type_measured_at_key
    unique (owner_id, type_id, measured_at),
  constraint body_measurements_value_range check (value > 0 and value <= 1000),
  constraint body_measurements_unit_allowed
    check (unit in ('kg', 'lb', 'cm', 'inch', 'percent', 'index', 'custom')),
  constraint body_measurements_note_length check (note is null or char_length(note) <= 500),
  constraint body_measurements_condition_length
    check (measurement_condition is null or char_length(measurement_condition) between 1 and 200),
  constraint body_measurements_body_site_length
    check (body_site is null or char_length(body_site) between 1 and 100),
  -- 実装仕様書 5.3節: 写真参照は HTTPS URL または
  -- `storage://health-images/<uuid>/...` 形式のみ許可する。
  -- `<uuid>` は実装仕様書 6.6節のオブジェクトパス規則の先頭セグメント（= 所有者）に
  -- あたるため、所有者本人のパスだけを受け入れる（他人のオブジェクトを指せない）。
  constraint body_measurements_photo_reference_shape check (
    photo_reference is null
    or (
      char_length(photo_reference) <= 2048
      and (
        photo_reference ~ '^https://[A-Za-z0-9._~%-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&''()*+,;=:@/-]*)?(\?[A-Za-z0-9._~%!$&''()*+,;=:@/?-]*)?$'
        or photo_reference ~ (
          '^storage://health-images/' || owner_id::text || '/[A-Za-z0-9._~%-]+(/[A-Za-z0-9._~%-]+)*$'
        )
      )
    )
  )
);

comment on table public.body_measurements is
  '実装仕様書 5.3節: 身体測定の記録。値・単位は入力のまま保存し、集計用の正規化値を生成列で持つ（6.3節）。';
comment on column public.body_measurements.normalized_value is
  '実装仕様書 6.3節: 集計用の正規化値。mass -> kg、length -> cm、percent -> percent、index -> index、custom -> null。';
comment on column public.body_measurements.photo_reference is
  '実装仕様書 5.3節: HTTPS URL または storage://health-images/<owner uuid>/... のみ。公開URLは保存しない（6.6節）。';

-- 実装仕様書 6.2節「よく使う時系列検索は (owner_id, timestamp) の複合インデックス」。
create index if not exists body_measurements_owner_measured_at_idx
  on public.body_measurements (owner_id, measured_at desc);
create index if not exists body_measurements_owner_type_measured_at_idx
  on public.body_measurements (owner_id, type_id, measured_at desc);

-- ---------------------------------------------------------------------------
-- public.body_measurement_goals
--   - 種別ごとの目標値（グラフの目標線）。
--   - 未達成の目標は種別ごとに1件だけ（部分一意インデックス）。
-- ---------------------------------------------------------------------------
create table if not exists public.body_measurement_goals (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  type_id            uuid not null,
  target_value       numeric(10, 3) not null,
  unit               text not null,
  start_value        numeric(10, 3),
  target_date        date,
  note               text,
  achieved_at        timestamptz,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint body_measurement_goals_id_owner_id_key unique (id, owner_id),
  constraint body_measurement_goals_type_fkey
    foreign key (type_id, owner_id)
    references public.body_measurement_types (id, owner_id) on delete cascade,
  constraint body_measurement_goals_target_value_range
    check (target_value > 0 and target_value <= 1000),
  constraint body_measurement_goals_start_value_range
    check (start_value is null or (start_value > 0 and start_value <= 1000)),
  constraint body_measurement_goals_unit_allowed
    check (unit in ('kg', 'lb', 'cm', 'inch', 'percent', 'index', 'custom')),
  constraint body_measurement_goals_note_length check (note is null or char_length(note) <= 500)
);

comment on table public.body_measurement_goals is
  '実装仕様書 5.3節: 測定目標。グラフの目標線に使う。未達成の目標は種別ごとに1件。';

-- 未達成（achieved_at is null）の目標は種別ごとに1件だけ。
create unique index if not exists body_measurement_goals_owner_type_active_key
  on public.body_measurement_goals (owner_id, type_id)
  where achieved_at is null;

create index if not exists body_measurement_goals_owner_target_date_idx
  on public.body_measurement_goals (owner_id, target_date);

-- ---------------------------------------------------------------------------
-- 種別と単位・アーカイブ状態の整合（実装仕様書 5.3節）。
--
-- 単位制約とアーカイブ日時は別テーブル（body_measurement_types）にあるため
-- CHECK では書けない。値の妥当性の最終防衛線
-- （9.2節「DB制約とRLSを最終防衛線とする」）として、
-- 記録・目標の双方に共通のトリガーを取り付ける。
--
-- > アーカイブ済み種別に対する新規の測定記録・目標登録は拒否する。（5.3節）
--
-- 拒否するのは**新規登録（INSERT）**だけ。アーカイブ前に記録した行の訂正
-- （UPDATE）まで塞ぐと、過去データを直せなくなるため。
-- ---------------------------------------------------------------------------
create or replace function public.tg_body_measurement_unit_matches_type()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  constraint_kind text;
  type_archived_at timestamptz;
begin
  select t.unit_constraint, t.archived_at
    into constraint_kind, type_archived_at
  from public.body_measurement_types t
  where t.id = new.type_id
    and t.owner_id = new.owner_id;

  if constraint_kind is null then
    raise exception 'measurement type not found for owner on %', tg_table_name
      using errcode = '23503';
  end if;

  if tg_op = 'INSERT' and type_archived_at is not null then
    raise exception 'measurement type is archived; cannot add new rows to % ', tg_table_name
      using errcode = '23514';
  end if;

  if not public.body_measurement_unit_is_allowed(constraint_kind, new.unit) then
    raise exception 'unit "%" is not allowed for unit_constraint "%" on %',
      new.unit, constraint_kind, tg_table_name
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.tg_body_measurement_unit_matches_type() is
  '実装仕様書 5.3節: 記録・目標の単位が測定種別の単位制約に合うこと、アーカイブ済み種別へ新規登録しないことをDB側で最終確認する。';

revoke all on function public.tg_body_measurement_unit_matches_type() from public, anon, authenticated;

drop trigger if exists body_measurements_unit_matches_type on public.body_measurements;
create trigger body_measurements_unit_matches_type
before insert or update of type_id, unit on public.body_measurements
for each row
execute function public.tg_body_measurement_unit_matches_type();

drop trigger if exists body_measurement_goals_unit_matches_type on public.body_measurement_goals;
create trigger body_measurement_goals_unit_matches_type
before insert or update of type_id, unit on public.body_measurement_goals
for each row
execute function public.tg_body_measurement_unit_matches_type();

-- ---------------------------------------------------------------------------
-- 既定種別（is_default）の保護（実装仕様書 5.3節）。
--
-- > 既定種別（`is_default=true`）の作成・変更は、`seed_default_body_measurement_types`
-- > RPC等のサーバー側処理に限定し、`authenticated`ロールから直接`is_default=true`の
-- > 行をINSERT/UPDATEできないようにする（既定カタログの偽装・改ざん防止）。
--
-- 三重に塞ぐ。
--   1. 列レベル権限: authenticated へ is_default の INSERT/UPDATE 権限を与えない
--      （migration 20260827000600）。
--   2. このトリガー: seed RPC の実行中以外は is_default の作成・変更を拒否する。
--   3. カタログ判定: is_default を名乗れるのは既定カタログのキーだけ。逆に、
--      既定カタログのキーはカスタム種別（is_default=false）が名乗れない。
--      これが無いと「先に custom の `weight` を作る → seed が読み飛ばす」で
--      既定種別になりすませてしまう。
--
-- クライアントが supabase-js で直接書いても成立させないため、API ではなく
-- DB 側に置く（9.2節「DB制約とRLSを最終防衛線とする」）。
-- ---------------------------------------------------------------------------

-- seed RPC の実行中かどうかの目印は GUC `app.body_measurement_seed`。RPC が
-- `set_config(..., is_local => true)` で立て、トランザクション終了とともに消える。
-- PostgREST 経由のクライアントは任意の GUC を設定できないため、
-- authenticated からは立てられない。
-- 判定を別関数へ切り出すと、SECURITY INVOKER のトリガーから呼ぶために
-- authenticated へ EXECUTE を配る必要が出るため、トリガー内に直接置く。
create or replace function public.tg_body_measurement_type_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  seeding boolean := coalesce(
    pg_catalog.current_setting('app.body_measurement_seed', true),
    'off'
  ) = 'on';
  in_catalog boolean := exists (
    select 1
    from public.default_body_measurement_types() d
    where d.measurement_key = new.measurement_key
  );
begin
  -- 既定種別（is_default = true）の行は seed RPC 以外から一切 UPDATE させない。
  --
  -- 実装仕様書 5.3節は「既定種別の**作成・変更**をサーバー側処理に限定する」と定める。
  -- 列レベル権限（migration 20260827000600）が塞げるのは `is_default` /
  -- `measurement_key` / `unit_constraint` だけで、authenticated は依然として
  -- `display_name` / `default_unit` / `sort_order` / `archived_at` /
  -- `client_mutation_id` の UPDATE 権限を持つ。これらはカスタム種別の編集に必要な
  -- 権限だが、既定種別の行へ向けると
  -- `{"display_name":"spoofed label","default_unit":"lb","sort_order":999}` のような
  -- 既定カタログの改ざんが成立してしまう（BMI・グラフのラベル／単位の偽装）。
  -- 列単位では「どの行か」を表現できないため、行の判定はここで行う。
  --
  -- 個別の列については先に的確な文言を返し（「キーを書き換えようとした」等）、
  -- 最後に UPDATE そのものを 42501 で拒否する。INSERT 側の
  -- 「seed RPC 以外から is_default を作れない」と同じ設計
  -- （トランザクションローカル GUC 以外からの変更は拒否）。
  -- seed RPC はカタログの正本なので、この不変条件から外す（正規化できる）。
  if tg_op = 'UPDATE' and old.is_default and not seeding then
    if new.is_default is distinct from old.is_default then
      raise exception 'column "is_default" is immutable on default measurement types'
        using errcode = '23514';
    end if;

    if new.measurement_key is distinct from old.measurement_key then
      raise exception 'column "measurement_key" is immutable on default measurement types'
        using errcode = '23514';
    end if;

    if new.unit_constraint is distinct from old.unit_constraint then
      raise exception 'column "unit_constraint" is immutable on default measurement types'
        using errcode = '23514';
    end if;

    if new.archived_at is not null then
      raise exception 'default measurement types cannot be archived'
        using errcode = '23514';
    end if;

    -- 上記に当てはまらない列（display_name / default_unit / sort_order /
    -- client_mutation_id など）の変更も、既定カタログの正本を崩すため拒否する。
    -- 既定種別を書き換えられるのは public.seed_default_body_measurement_types() だけ。
    raise exception
      'default measurement types can only be modified by public.seed_default_body_measurement_types()'
      using errcode = '42501';
  end if;

  if new.is_default and not in_catalog then
    raise exception 'is_default is reserved for the default measurement catalog'
      using errcode = '23514';
  end if;

  -- 既定カタログのキーは既定種別専用。カスタム種別が名乗ると既定種別の偽装になる。
  if not new.is_default and in_catalog then
    raise exception 'measurement_key "%" is reserved for the default measurement catalog',
      new.measurement_key
      using errcode = '23514';
  end if;

  -- is_default の作成・変更は seed RPC からのみ。
  if not seeding then
    if tg_op = 'INSERT' and new.is_default then
      raise exception
        'is_default measurement types can only be created by public.seed_default_body_measurement_types()'
        using errcode = '42501';
    end if;

    if tg_op = 'UPDATE' and new.is_default is distinct from old.is_default then
      raise exception
        'column "is_default" can only be changed by public.seed_default_body_measurement_types()'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_body_measurement_type_guard() is
  '実装仕様書 5.3節: is_default の作成・変更を seed RPC に限定し、既定カタログのキーとフラグの偽装を防ぐ。';

revoke all on function public.tg_body_measurement_type_guard() from public, anon, authenticated;

drop trigger if exists body_measurement_types_guard on public.body_measurement_types;
create trigger body_measurement_types_guard
before insert or update on public.body_measurement_types
for each row
execute function public.tg_body_measurement_type_guard();

-- ---------------------------------------------------------------------------
-- 共通パターン（実装仕様書 6.4節）を取り付ける。
-- docs/database/table-conventions.md 1.1節のとおり、テーブル定義の直後に1行ずつ呼ぶ。
-- ---------------------------------------------------------------------------
select public.apply_owned_mutable_table_conventions('public.body_measurement_types'::regclass);
select public.apply_owned_mutable_table_conventions('public.body_measurements'::regclass);
select public.apply_owned_mutable_table_conventions('public.body_measurement_goals'::regclass);
