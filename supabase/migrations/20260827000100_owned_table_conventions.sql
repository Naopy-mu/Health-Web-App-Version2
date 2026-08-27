-- 実装仕様書 6.4節「版番号・冪等性」の共通パターン。
--
-- 以降のフェーズで追加する「所有者スコープを持つ可変の公開テーブル」は、
-- すべて次の列パターンを持ち、本migrationが提供する共通関数で
-- 冪等性インデックスと共通トリガーを取り付ける。
--
--   create table public.<table> (
--     id                 uuid primary key default gen_random_uuid(),
--     owner_id           uuid not null references public.users (id) on delete cascade,
--     -- ... 機能固有の列 ...
--     client_mutation_id uuid,
--     row_version        bigint not null default 1,
--     created_at         timestamptz not null default now(),
--     updated_at         timestamptz not null default now(),
--     constraint <table>_id_owner_id_key unique (id, owner_id)
--   );
--   select public.apply_owned_mutable_table_conventions('public.<table>'::regclass);
--
-- 詳細な手順とテンプレートは docs/database/table-conventions.md を参照。

-- ---------------------------------------------------------------------------
-- INSERT: クライアント入力によらず row_version = 1 とサーバー時刻を強制する。
-- ---------------------------------------------------------------------------
create or replace function public.tg_owned_mutable_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.row_version := 1;
  new.created_at := pg_catalog.now();
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

comment on function public.tg_owned_mutable_before_insert() is
  '実装仕様書 6.4節: INSERT時に row_version=1 とサーバー時刻を強制する共通トリガー関数。';

-- ---------------------------------------------------------------------------
-- UPDATE: id / owner_id / created_at の変更を拒否し、row_version をサーバー側で
--         単調増加させる（楽観ロックの版番号をクライアントに委ねない）。
-- ---------------------------------------------------------------------------
create or replace function public.tg_owned_mutable_before_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'column "id" is immutable on %', tg_table_name
      using errcode = '23514';
  end if;

  if new.owner_id is distinct from old.owner_id then
    raise exception 'column "owner_id" is immutable on %', tg_table_name
      using errcode = '23514';
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'column "created_at" is immutable on %', tg_table_name
      using errcode = '23514';
  end if;

  new.row_version := old.row_version + 1;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

comment on function public.tg_owned_mutable_before_update() is
  '実装仕様書 6.4節: UPDATE時に id/owner_id/created_at の変更を拒否し、row_version を加算する共通トリガー関数。';

-- ---------------------------------------------------------------------------
-- 共通パターンの取り付け。列パターンと (id, owner_id) 候補キーの存在を検査し、
-- (owner_id, client_mutation_id) のNULL除外一意インデックスと
-- 共通トリガーを作成する。後続フェーズはテーブル定義の直後に1行呼ぶだけでよい。
-- ---------------------------------------------------------------------------
create or replace function public.apply_owned_mutable_table_conventions(target regclass)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_schema  text;
  target_name    text;
  required_column text;
  missing_columns text[] := '{}';
  index_name     text;
  insert_trigger text;
  update_trigger text;
begin
  select n.nspname, c.relname
    into target_schema, target_name
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.oid = target;

  foreach required_column in array array[
    'id', 'owner_id', 'client_mutation_id', 'row_version', 'created_at', 'updated_at'
  ]
  loop
    if not exists (
      select 1
      from pg_catalog.pg_attribute a
      where a.attrelid = target
        and a.attname = required_column
        and a.attnum > 0
        and not a.attisdropped
    ) then
      missing_columns := missing_columns || required_column;
    end if;
  end loop;

  if pg_catalog.array_length(missing_columns, 1) is not null then
    raise exception
      'table %.% is missing required owned-mutable columns: %',
      target_schema, target_name, pg_catalog.array_to_string(missing_columns, ', ')
      using errcode = '42703';
  end if;

  -- 複合外部キー (parent_id, owner_id) -> (id, owner_id) の参照先となる候補キー。
  if not exists (
    select 1
    from pg_catalog.pg_constraint con
    where con.conrelid = target
      and con.contype in ('p', 'u')
      and (
        select pg_catalog.array_agg(a.attname::text order by a.attname::text)
        from pg_catalog.pg_attribute a
        where a.attrelid = target
          and a.attnum = any (con.conkey)
      ) = array['id', 'owner_id']
  ) then
    raise exception
      'table %.% must declare a unique (id, owner_id) candidate key',
      target_schema, target_name
      using errcode = '42830';
  end if;

  index_name     := pg_catalog.left(target_name, 44) || '_owner_client_mutation_key';
  insert_trigger := pg_catalog.left(target_name, 40) || '_owned_before_insert';
  update_trigger := pg_catalog.left(target_name, 40) || '_owned_before_update';

  execute pg_catalog.format(
    'create unique index if not exists %I on %I.%I (owner_id, client_mutation_id) where client_mutation_id is not null',
    index_name, target_schema, target_name
  );

  execute pg_catalog.format('drop trigger if exists %I on %I.%I', insert_trigger, target_schema, target_name);
  execute pg_catalog.format(
    'create trigger %I before insert on %I.%I for each row execute function public.tg_owned_mutable_before_insert()',
    insert_trigger, target_schema, target_name
  );

  execute pg_catalog.format('drop trigger if exists %I on %I.%I', update_trigger, target_schema, target_name);
  execute pg_catalog.format(
    'create trigger %I before update on %I.%I for each row execute function public.tg_owned_mutable_before_update()',
    update_trigger, target_schema, target_name
  );
end;
$$;

comment on function public.apply_owned_mutable_table_conventions(regclass) is
  '実装仕様書 6.4節: 所有者スコープの可変公開テーブルへ冪等性インデックスと共通トリガーを取り付ける。';

-- Supabase は public スキーマの新規関数へ既定で EXECUTE を与えるため、明示的に剥奪する。
-- これらは migration とトリガーのための関数であり、クライアントロールから呼ぶものではない。
revoke all on function public.tg_owned_mutable_before_insert() from public, anon, authenticated;
revoke all on function public.tg_owned_mutable_before_update() from public, anon, authenticated;
revoke all on function public.apply_owned_mutable_table_conventions(regclass) from public, anon, authenticated;
