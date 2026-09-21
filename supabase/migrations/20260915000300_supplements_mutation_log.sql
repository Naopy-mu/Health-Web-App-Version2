-- 実装仕様書 5.6節 / 6.4節 / 8.1節。身体測定の `body_measurement_mutation_log`
-- （migration 20260827000800）、睡眠・水分・体調の `wellness_mutation_log`
-- （migration 20260903000400）と同じ設計をサプリメントへ広げる。
--
-- ## 何のための migration か
--
-- 冪等キーの記録を「行の**現在値**」（`<table>.client_mutation_id`）だけで持つと、
-- 同じ行を続けて更新したときに前回のキーが上書きされ、**過去のキーでの再送**が
-- 「未適用」に見えてしまう。
--
--   1. cmid=A で更新 → 行は row_version=2、client_mutation_id=A
--   2. cmid=B で更新 → 行は row_version=3、client_mutation_id=B（A は消える）
--   3. cmid=A で再送 → A は行に無いので「未適用」と判断し、
--      row_version=2 の楽観ロックで UPDATE → 0件 → 409
--
-- 3 は**同一内容の再送**であって競合ではない。実装仕様書 5.3節の
-- 「同一 client_mutation_id の再送は競合状態でも必ず同一の成功応答を返す」は
-- 全機能に共通の契約なので、サプリメントでも同じ守り方をする。
--
-- ## 直し方（採用した設計）
--
-- 冪等キーを**履歴**として持つ。ミューテーションが適用されるたびに
-- 「client_mutation_id → 適用直後の行のスナップショット」を追記専用の
-- `public.supplement_mutation_log` へ記録し、API は更新の前に必ずここを参照する。
-- 追記は DB トリガーが行うので、ミューテーションと同一トランザクションで確定する
-- （「行は更新されたが記録が残らなかった」が原理的に起きない）。
--
-- ## 服用記録の2種類の冪等キー（docs/api/supplements.md 1.6節）
--
-- `supplement_intake_logs` は2つのキーを持つ。役割が違うので両方要る。
--
--   - `idempotency_key`（8〜200文字のテキスト。実装仕様書 5.6節が服用記録へ固有に要求）
--     「この1回の服用」を所有者ごとに一意にする**業務キー**。同じ服用が
--     二重に記録されて在庫が二重に減るのを防ぐ。`record_supplement_intake` は
--     まずこのキーで既存の記録を引き、あれば在庫に触れずそのまま返す。
--   - `client_mutation_id`（UUID。実装仕様書 6.4節・8.1節の共通パターン）
--     オフラインキューの再送キー。取消（void）は同じ服用記録の**別の**
--     ミューテーションなので、記録時と取消時で別の UUID を持つ。
--     本ログがその両方の世代を保持し、どちらのキーの再送でも当時の応答を返せる。

-- ---------------------------------------------------------------------------
-- public.supplement_mutation_log
-- ---------------------------------------------------------------------------
create table if not exists public.supplement_mutation_log (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  -- 対象テーブル名（トリガーの tg_table_name）。冪等キーの一意性は
  -- 各テーブルの (owner_id, client_mutation_id) と同じ粒度で閉じる。
  resource           text not null,
  client_mutation_id uuid not null,
  entity_id          uuid not null,
  operation          text not null,
  -- 適用直後の行（生成列を含む）。再送はこれをそのまま返す。
  snapshot           jsonb not null,
  created_at         timestamptz not null default now(),
  constraint supplement_mutation_log_resource_allowed
    check (
      resource in (
        'supplement_products',
        'supplement_schedules',
        'supplement_inventory_lots',
        'supplement_intake_logs'
      )
    ),
  constraint supplement_mutation_log_operation_allowed
    check (operation in ('insert', 'update')),
  -- 冪等キーの引き当て先。所有者ごと・テーブルごとに1件
  -- （別利用者・別テーブルとは衝突しない）。
  constraint supplement_mutation_log_owner_resource_mutation_key
    unique (owner_id, resource, client_mutation_id)
);

comment on table public.supplement_mutation_log is
  '実装仕様書 5.6節・6.4節: client_mutation_id ごとの適用結果スナップショット。何世代前の再送でも同一の成功応答を返すための履歴。追記専用。';
comment on column public.supplement_mutation_log.resource is
  'スナップショット元のテーブル名。冪等キーの一意性はテーブルごとに閉じる。';
comment on column public.supplement_mutation_log.snapshot is
  '適用直後の行（to_jsonb）。再送では現在の行ではなくこれを返す（版番号を進めないため）。';

-- 記録の掃除（保持期間）は実装仕様書 8.1節のキューTTL（30日）に合わせて
-- 後続フェーズで入れる。所有者の削除時は users への CASCADE で消える。
create index if not exists supplement_mutation_log_owner_created_idx
  on public.supplement_mutation_log (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 追記トリガー
--
-- SECURITY DEFINER にする。authenticated へ本テーブルの INSERT 権限を渡さずに
-- 追記できるため、利用者が「適用していない結果」を偽造できない
-- （偽造できると、再送の応答としてでっち上げた行を引かせられる）。
-- ---------------------------------------------------------------------------
create or replace function public.tg_supplement_record_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 冪等キーの無いミューテーションは記録しない。
  if new.client_mutation_id is null then
    return null;
  end if;

  -- 同じキーで複数回 UPDATE が走る経路（例: 取消 RPC が同じ cmid で再実行される）
  -- でも「最初の適用結果」を残す。再送は当時の応答を返す操作であり、
  -- あとから進んだ版番号で上書きしてはならない。
  insert into public.supplement_mutation_log (
    owner_id, resource, client_mutation_id, entity_id, operation, snapshot
  )
  values (
    new.owner_id,
    tg_table_name,
    new.client_mutation_id,
    new.id,
    pg_catalog.lower(tg_op),
    pg_catalog.to_jsonb(new)
  )
  on conflict (owner_id, resource, client_mutation_id) do nothing;

  return null;
end;
$$;

comment on function public.tg_supplement_record_mutation() is
  '実装仕様書 5.6節・6.4節: client_mutation_id 付きのミューテーションを、適用直後の行ごと supplement_mutation_log へ追記する。';

revoke all on function public.tg_supplement_record_mutation() from public, anon, authenticated;

-- AFTER にする。BEFORE では生成列（name_normalized）と共通トリガーが決める
-- row_version / updated_at が NEW に入っていない。
drop trigger if exists supplement_products_record_mutation on public.supplement_products;
create trigger supplement_products_record_mutation
after insert or update on public.supplement_products
for each row
execute function public.tg_supplement_record_mutation();

drop trigger if exists supplement_schedules_record_mutation on public.supplement_schedules;
create trigger supplement_schedules_record_mutation
after insert or update on public.supplement_schedules
for each row
execute function public.tg_supplement_record_mutation();

drop trigger if exists supplement_inventory_lots_record_mutation
  on public.supplement_inventory_lots;
create trigger supplement_inventory_lots_record_mutation
after insert or update on public.supplement_inventory_lots
for each row
execute function public.tg_supplement_record_mutation();

drop trigger if exists supplement_intake_logs_record_mutation on public.supplement_intake_logs;
create trigger supplement_intake_logs_record_mutation
after insert or update on public.supplement_intake_logs
for each row
execute function public.tg_supplement_record_mutation();

-- `supplement_inventory_movements` にはトリガーを取り付けない。在庫の動きは
-- ロットの更新に伴って作られる従属データで、独自の冪等キーを持たない。
-- 再送の引き当ては親（ロット・服用記録）の冪等キーで行う。

-- ---------------------------------------------------------------------------
-- RLS（実装仕様書 6.5節 / 9章）
--
-- 読み取りだけを所有者本人へ許す。INSERT / UPDATE / DELETE は誰にも渡さない
-- （書き手は上の SECURITY DEFINER トリガーだけ）。追記専用の記録を
-- 利用者が書き換えられると、再送の応答をすり替えられてしまう。
-- ---------------------------------------------------------------------------
alter table public.supplement_mutation_log enable row level security;

revoke all on table public.supplement_mutation_log from public;
revoke all on table public.supplement_mutation_log from anon;
revoke all on table public.supplement_mutation_log from authenticated;

grant select on table public.supplement_mutation_log to authenticated;

drop policy if exists supplement_mutation_log_select_own on public.supplement_mutation_log;
create policy supplement_mutation_log_select_own
on public.supplement_mutation_log
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy supplement_mutation_log_select_own on public.supplement_mutation_log is
  '実装仕様書 6.5節: 所有者本人かつ active のときだけ、自分の冪等キーの適用結果を引ける。書き込み権限は誰にも与えない。';
