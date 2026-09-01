-- 実装仕様書 5.3節「同一`client_mutation_id`による再送（同時多重送信を含む）は、
-- 競合状態でも必ず同一の成功応答（idempotent replay）を返す」/ 6.4節 / 8.1節。
--
-- ## 何を直すための migration か
--
-- 冪等キーの記録を「行の**現在値**」（`<table>.client_mutation_id`）だけで持つと、
-- 同じ行を続けて更新したときに前回のキーが上書きされ、**過去のキーでの再送**が
-- 「未適用」に見えてしまう。実際には次の順で契約が破れる。
--
--   1. cmid=A で更新 → 行は row_version=2、client_mutation_id=A
--   2. cmid=B で更新 → 行は row_version=3、client_mutation_id=B（A は消える）
--   3. cmid=A で再送 → A は行に無いので「未適用」と判断し、
--      row_version=2 の楽観ロックで UPDATE → 0件 → 409
--
-- 3 は**同一内容の再送**であって競合ではない。実装仕様書 5.3節が
-- 「409 は実際に異なる内容での競合時のみ」と定めているため、これは契約違反にあたる。
--
-- ## 直し方（採用した設計）
--
-- 冪等キーを**履歴**として持つ。ミューテーションが適用されるたびに
-- 「client_mutation_id → 適用直後の行のスナップショット」を追記専用の
-- `public.body_measurement_mutation_log` へ記録し、API は更新の前に必ず
-- ここを参照する。行の現在値ではなく履歴を引くため、**何世代前のキーでも**
-- 同一の成功応答を返せる。
--
-- 追記は**DBトリガー**が行う（API からの2回書きではない）。ミューテーションと
-- 同一トランザクションで確定するため、「行は更新されたが記録が残らなかった」
-- という食い違いが原理的に起きない。supabase-js から直接書かれた場合も同じく記録される。
--
-- スナップショットは `to_jsonb(new)`、すなわち**適用直後の行そのもの**。再送には
-- 現在の行ではなくこれを返す。再送は「あのときの応答をもう一度受け取る」操作であり、
-- その後に別のミューテーションが進めた版番号を返してはならないため
-- （実装仕様書 8.1節のオフラインキューは、応答の row_version を次の基準版として使う）。
--
-- 実装仕様書 8.1節の `offline_sync_operation_results` は、これと同じ役割を
-- 全エンティティ横断で担う後続フェーズのテーブル。身体測定の Phase 3a では
-- 本テーブルがその役割を持つ。
--
-- 追記専用テーブルなので、`apply_owned_mutable_table_conventions()` の
-- 可変テーブル・パターン（row_version / 楽観ロック）は適用しない
-- （docs/database/table-conventions.md「`audit_logs` のような追記専用テーブルは
-- 本パターンの対象外」）。

-- ---------------------------------------------------------------------------
-- public.body_measurement_mutation_log
-- ---------------------------------------------------------------------------
create table if not exists public.body_measurement_mutation_log (
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
  constraint body_measurement_mutation_log_resource_allowed
    check (
      resource in (
        'body_measurement_types',
        'body_measurements',
        'body_measurement_goals'
      )
    ),
  constraint body_measurement_mutation_log_operation_allowed
    check (operation in ('insert', 'update')),
  -- 冪等キーの引き当て先。所有者ごと・テーブルごとに1件（別利用者・別テーブルとは衝突しない）。
  constraint body_measurement_mutation_log_owner_resource_mutation_key
    unique (owner_id, resource, client_mutation_id)
);

comment on table public.body_measurement_mutation_log is
  '実装仕様書 5.3節・6.4節: client_mutation_id ごとの適用結果スナップショット。何世代前の再送でも同一の成功応答を返すための履歴。追記専用。';
comment on column public.body_measurement_mutation_log.resource is
  'スナップショット元のテーブル名。冪等キーの一意性はテーブルごとに閉じる。';
comment on column public.body_measurement_mutation_log.snapshot is
  '適用直後の行（to_jsonb）。再送では現在の行ではなくこれを返す（版番号を進めないため）。';

-- 記録の掃除（保持期間）は実装仕様書 8.1節のキューTTL（30日）に合わせて
-- 後続フェーズで入れる。所有者の削除時は users への CASCADE で消える。
create index if not exists body_measurement_mutation_log_owner_created_idx
  on public.body_measurement_mutation_log (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 追記トリガー
--
-- SECURITY DEFINER にする。authenticated へ本テーブルの INSERT 権限を渡さずに
-- 追記できるため、利用者が「適用していない結果」を偽造できない
-- （偽造できると、再送の応答としてでっち上げた行を引かせられる）。
-- ---------------------------------------------------------------------------
create or replace function public.tg_body_measurement_record_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 冪等キーの無いミューテーション（seed RPC の正規化など）は記録しない。
  if new.client_mutation_id is null then
    return null;
  end if;

  insert into public.body_measurement_mutation_log (
    owner_id, resource, client_mutation_id, entity_id, operation, snapshot
  )
  values (
    new.owner_id,
    tg_table_name,
    new.client_mutation_id,
    new.id,
    pg_catalog.lower(tg_op),
    pg_catalog.to_jsonb(new)
  );

  return null;
end;
$$;

comment on function public.tg_body_measurement_record_mutation() is
  '実装仕様書 5.3節・6.4節: client_mutation_id 付きのミューテーションを、適用直後の行ごと body_measurement_mutation_log へ追記する。';

revoke all on function public.tg_body_measurement_record_mutation() from public, anon, authenticated;

-- AFTER にする。BEFORE では生成列（normalized_value / normalized_unit）と
-- 共通トリガーが決める row_version / updated_at が NEW に入っていない。
drop trigger if exists body_measurement_types_record_mutation on public.body_measurement_types;
create trigger body_measurement_types_record_mutation
after insert or update on public.body_measurement_types
for each row
execute function public.tg_body_measurement_record_mutation();

drop trigger if exists body_measurements_record_mutation on public.body_measurements;
create trigger body_measurements_record_mutation
after insert or update on public.body_measurements
for each row
execute function public.tg_body_measurement_record_mutation();

drop trigger if exists body_measurement_goals_record_mutation on public.body_measurement_goals;
create trigger body_measurement_goals_record_mutation
after insert or update on public.body_measurement_goals
for each row
execute function public.tg_body_measurement_record_mutation();

-- ---------------------------------------------------------------------------
-- RLS（実装仕様書 6.5節 / 9章）
--
-- 読み取りだけを所有者本人へ許す。INSERT / UPDATE / DELETE は誰にも渡さない
-- （書き手は上の SECURITY DEFINER トリガーだけ）。追記専用の記録を
-- 利用者が書き換えられると、再送の応答をすり替えられてしまう。
-- ---------------------------------------------------------------------------
alter table public.body_measurement_mutation_log enable row level security;

revoke all on table public.body_measurement_mutation_log from public;
revoke all on table public.body_measurement_mutation_log from anon;
revoke all on table public.body_measurement_mutation_log from authenticated;

grant select on table public.body_measurement_mutation_log to authenticated;

drop policy if exists body_measurement_mutation_log_select_own on public.body_measurement_mutation_log;
create policy body_measurement_mutation_log_select_own
on public.body_measurement_mutation_log
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy body_measurement_mutation_log_select_own on public.body_measurement_mutation_log is
  '実装仕様書 6.5節: 所有者本人かつ active のときだけ、自分の冪等キーの適用結果を引ける。書き込み権限は誰にも与えない。';
