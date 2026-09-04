-- 実装仕様書 5.5節 / 6.4節 / 8.1節。身体測定の
-- `body_measurement_mutation_log`（migration 20260827000800）と同じ設計を
-- 睡眠・水分・体調へ広げる。
--
-- ## 何のための migration か
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
-- 「同一 client_mutation_id の再送は競合状態でも必ず同一の成功応答を返す」
-- 「409 は実際に異なる内容での競合時のみ」と定めており、これは全機能に共通の
-- 契約なので、睡眠・水分・体調でも同じ守り方をする。
--
-- ## 直し方（採用した設計）
--
-- 冪等キーを**履歴**として持つ。ミューテーションが適用されるたびに
-- 「client_mutation_id → 適用直後の行のスナップショット」を追記専用の
-- `public.wellness_mutation_log` へ記録し、API は更新の前に必ずここを参照する。
-- 行の現在値ではなく履歴を引くため、**何世代前のキーでも**同一の成功応答を返せる。
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
-- 追記専用テーブルなので、`apply_owned_mutable_table_conventions()` の
-- 可変テーブル・パターン（row_version / 楽観ロック）は適用しない
-- （docs/database/table-conventions.md「`audit_logs` のような追記専用テーブルは
-- 本パターンの対象外」）。

-- ---------------------------------------------------------------------------
-- public.wellness_mutation_log
-- ---------------------------------------------------------------------------
create table if not exists public.wellness_mutation_log (
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
  constraint wellness_mutation_log_resource_allowed
    check (
      resource in (
        'beverage_types',
        'symptom_types',
        'sleep_entries',
        'sleep_goals',
        'hydration_entries',
        'hydration_goals',
        'condition_entries'
      )
    ),
  constraint wellness_mutation_log_operation_allowed
    check (operation in ('insert', 'update')),
  -- 冪等キーの引き当て先。所有者ごと・テーブルごとに1件
  -- （別利用者・別テーブルとは衝突しない）。
  constraint wellness_mutation_log_owner_resource_mutation_key
    unique (owner_id, resource, client_mutation_id)
);

comment on table public.wellness_mutation_log is
  '実装仕様書 5.5節・6.4節: client_mutation_id ごとの適用結果スナップショット。何世代前の再送でも同一の成功応答を返すための履歴。追記専用。';
comment on column public.wellness_mutation_log.resource is
  'スナップショット元のテーブル名。冪等キーの一意性はテーブルごとに閉じる。';
comment on column public.wellness_mutation_log.snapshot is
  '適用直後の行（to_jsonb）。再送では現在の行ではなくこれを返す（版番号を進めないため）。';

-- 記録の掃除（保持期間）は実装仕様書 8.1節のキューTTL（30日）に合わせて
-- 後続フェーズで入れる。所有者の削除時は users への CASCADE で消える。
create index if not exists wellness_mutation_log_owner_created_idx
  on public.wellness_mutation_log (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 追記トリガー
--
-- SECURITY DEFINER にする。authenticated へ本テーブルの INSERT 権限を渡さずに
-- 追記できるため、利用者が「適用していない結果」を偽造できない
-- （偽造できると、再送の応答としてでっち上げた行を引かせられる）。
-- ---------------------------------------------------------------------------
create or replace function public.tg_wellness_record_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 冪等キーの無いミューテーション（seed RPC の正規化、症状リンクの全置換など）は
  -- 記録しない。
  if new.client_mutation_id is null then
    return null;
  end if;

  insert into public.wellness_mutation_log (
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

comment on function public.tg_wellness_record_mutation() is
  '実装仕様書 5.5節・6.4節: client_mutation_id 付きのミューテーションを、適用直後の行ごと wellness_mutation_log へ追記する。';

revoke all on function public.tg_wellness_record_mutation() from public, anon, authenticated;

-- AFTER にする。BEFORE では生成列（sleep_minutes / amount_ml など）と
-- 共通トリガーが決める row_version / updated_at が NEW に入っていない。
drop trigger if exists beverage_types_record_mutation on public.beverage_types;
create trigger beverage_types_record_mutation
after insert or update on public.beverage_types
for each row
execute function public.tg_wellness_record_mutation();

drop trigger if exists symptom_types_record_mutation on public.symptom_types;
create trigger symptom_types_record_mutation
after insert or update on public.symptom_types
for each row
execute function public.tg_wellness_record_mutation();

drop trigger if exists sleep_entries_record_mutation on public.sleep_entries;
create trigger sleep_entries_record_mutation
after insert or update on public.sleep_entries
for each row
execute function public.tg_wellness_record_mutation();

drop trigger if exists sleep_goals_record_mutation on public.sleep_goals;
create trigger sleep_goals_record_mutation
after insert or update on public.sleep_goals
for each row
execute function public.tg_wellness_record_mutation();

drop trigger if exists hydration_entries_record_mutation on public.hydration_entries;
create trigger hydration_entries_record_mutation
after insert or update on public.hydration_entries
for each row
execute function public.tg_wellness_record_mutation();

drop trigger if exists hydration_goals_record_mutation on public.hydration_goals;
create trigger hydration_goals_record_mutation
after insert or update on public.hydration_goals
for each row
execute function public.tg_wellness_record_mutation();

drop trigger if exists condition_entries_record_mutation on public.condition_entries;
create trigger condition_entries_record_mutation
after insert or update on public.condition_entries
for each row
execute function public.tg_wellness_record_mutation();

-- `condition_entry_symptoms` にはトリガーを取り付けない。症状リンクは体調記録の
-- 保存に伴って全置換される従属データで、独自の冪等キーを持たない（常に NULL）。
-- 再送の引き当ては親（condition_entries）の冪等キーで行う。

-- ---------------------------------------------------------------------------
-- RLS（実装仕様書 6.5節 / 9章）
--
-- 読み取りだけを所有者本人へ許す。INSERT / UPDATE / DELETE は誰にも渡さない
-- （書き手は上の SECURITY DEFINER トリガーだけ）。追記専用の記録を
-- 利用者が書き換えられると、再送の応答をすり替えられてしまう。
-- ---------------------------------------------------------------------------
alter table public.wellness_mutation_log enable row level security;

revoke all on table public.wellness_mutation_log from public;
revoke all on table public.wellness_mutation_log from anon;
revoke all on table public.wellness_mutation_log from authenticated;

grant select on table public.wellness_mutation_log to authenticated;

drop policy if exists wellness_mutation_log_select_own on public.wellness_mutation_log;
create policy wellness_mutation_log_select_own
on public.wellness_mutation_log
for select
to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

comment on policy wellness_mutation_log_select_own on public.wellness_mutation_log is
  '実装仕様書 6.5節: 所有者本人かつ active のときだけ、自分の冪等キーの適用結果を引ける。書き込み権限は誰にも与えない。';
