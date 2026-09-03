-- 実装仕様書 5.5節「既定の飲み物候補10種を提供し、任意の種別を追加できる」
-- 「症状（既定13種＋任意30件まで）」。
--
-- 既定種別（`is_default = true`）を書ける唯一の経路。身体測定の
-- `seed_default_body_measurement_types()`（migration 20260827000700）と同じ設計。
--
-- SECURITY DEFINER で置く。migration 20260903000200 が authenticated から
-- `is_default` 列の INSERT/UPDATE 権限を剥奪しているため、既定種別を作れるのは
-- 所有者ロール（= 本関数の定義者）だけになる。呼び出し元の JWT では書けない。
--
-- SECURITY DEFINER は RLS を迂回するため、RLS が担っていた検査を関数側で明示する。
--   - `auth.uid()` が無ければ拒否（未認証）
--   - `public.is_active_user()` が false なら拒否（実装仕様書 6.5節）
--   - 書き込み・読み出しは常に `owner_id = actor` に限定（他人の行に触れない）
--
-- 何度呼んでも同じ結果になる（実装仕様書 6.4節の冪等性の考え方）。
-- 既に同じキーの行があるときは**カタログの内容へ正規化する**。`do nothing` だと、
-- 先に同名のカスタム種別を作っておくことで既定種別になりすませてしまう
-- （カタログのキーは migration 20260903000100 のトリガーがカスタム種別へ禁じており、
-- ここでの正規化は「過去に作られた行」と「カタログ自体の更新」への備え）。

-- ---------------------------------------------------------------------------
-- 既定の飲み物候補10種
-- ---------------------------------------------------------------------------
create or replace function public.seed_default_beverage_types()
returns setof public.beverage_types
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'account is not active' using errcode = '42501';
  end if;

  -- 既定種別の書き込みを許す唯一の目印（migration 20260903000100 のトリガーが読む GUC）。
  -- is_local => true なので、このトランザクションの終わりで必ず消える。
  perform pg_catalog.set_config('app.wellness_seed', 'on', true);

  insert into public.beverage_types as existing (
    owner_id, beverage_key, display_name, default_unit, default_amount,
    contains_caffeine, contains_alcohol, is_default, sort_order
  )
  select
    actor,
    d.beverage_key,
    d.display_name,
    d.default_unit,
    d.default_amount,
    d.contains_caffeine,
    d.contains_alcohol,
    true,
    d.sort_order
  from public.default_beverage_types() d
  on conflict (owner_id, beverage_key) do update
    set is_default        = true,
        display_name      = excluded.display_name,
        default_unit      = excluded.default_unit,
        default_amount    = excluded.default_amount,
        contains_caffeine = excluded.contains_caffeine,
        contains_alcohol  = excluded.contains_alcohol,
        sort_order        = excluded.sort_order,
        -- 既定種別はアーカイブ不可（CHECK 制約）。正規化のときに必ず解除する。
        archived_at       = null
    where existing.owner_id = actor
      and (
        existing.is_default        is distinct from true
        or existing.display_name      is distinct from excluded.display_name
        or existing.default_unit      is distinct from excluded.default_unit
        or existing.default_amount    is distinct from excluded.default_amount
        or existing.contains_caffeine is distinct from excluded.contains_caffeine
        or existing.contains_alcohol  is distinct from excluded.contains_alcohol
        or existing.sort_order        is distinct from excluded.sort_order
        or existing.archived_at       is not null
      );

  perform pg_catalog.set_config('app.wellness_seed', 'off', true);

  return query
    select b.*
    from public.beverage_types b
    where b.owner_id = actor
      and b.is_default
    order by b.sort_order, b.beverage_key;
end;
$$;

comment on function public.seed_default_beverage_types() is
  '実装仕様書 5.5節: 既定10種の飲み物を呼び出し元の所有者へ冪等に投入・正規化し、既定種別の全件を返す。is_default を書ける唯一の経路。';

revoke all on function public.seed_default_beverage_types() from public, anon, authenticated;
grant execute on function public.seed_default_beverage_types() to authenticated;

-- ---------------------------------------------------------------------------
-- 既定の症状13種
-- ---------------------------------------------------------------------------
create or replace function public.seed_default_symptom_types()
returns setof public.symptom_types
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'account is not active' using errcode = '42501';
  end if;

  perform pg_catalog.set_config('app.wellness_seed', 'on', true);

  insert into public.symptom_types as existing (
    owner_id, symptom_key, display_name, is_default, sort_order
  )
  select
    actor,
    d.symptom_key,
    d.display_name,
    true,
    d.sort_order
  from public.default_symptom_types() d
  on conflict (owner_id, symptom_key) do update
    set is_default   = true,
        display_name = excluded.display_name,
        sort_order   = excluded.sort_order,
        archived_at  = null
    where existing.owner_id = actor
      and (
        existing.is_default   is distinct from true
        or existing.display_name is distinct from excluded.display_name
        or existing.sort_order   is distinct from excluded.sort_order
        or existing.archived_at  is not null
      );

  perform pg_catalog.set_config('app.wellness_seed', 'off', true);

  return query
    select s.*
    from public.symptom_types s
    where s.owner_id = actor
      and s.is_default
    order by s.sort_order, s.symptom_key;
end;
$$;

comment on function public.seed_default_symptom_types() is
  '実装仕様書 5.5節: 既定13種の症状を呼び出し元の所有者へ冪等に投入・正規化し、既定種別の全件を返す。is_default を書ける唯一の経路。';

revoke all on function public.seed_default_symptom_types() from public, anon, authenticated;
grant execute on function public.seed_default_symptom_types() to authenticated;

-- ---------------------------------------------------------------------------
-- 体調記録の症状リンクの全置換（実装仕様書 5.5節）
--
-- 症状リンクは「その体調記録に付いている症状の集合」であり、部分更新ではなく
-- **全置換**で扱う。削除と登録を1つの関数（＝1トランザクション）にまとめることで、
-- 「古い症状だけ消えて新しい症状が入らなかった」中途半端な状態を作らない。
--
-- SECURITY INVOKER にする。RLS がそのまま効くため、他人の体調記録や他人の
-- 症状種別へは触れられない（複合外部キーも同じ所有者を要求する）。
-- ---------------------------------------------------------------------------
create or replace function public.replace_condition_entry_symptoms(
  p_entry_id uuid,
  p_symptoms jsonb
)
returns setof public.condition_entry_symptoms
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if pg_catalog.jsonb_typeof(p_symptoms) is distinct from 'array' then
    raise exception 'symptoms must be a json array' using errcode = '22023';
  end if;

  -- 既定13種 + カスタム30件。トリガー側にも同じ上限があるが、
  -- 大量の削除・登録を走らせる前にここで弾く。
  if pg_catalog.jsonb_array_length(p_symptoms) > 43 then
    raise exception 'a condition entry can link at most 43 symptoms'
      using errcode = '23514';
  end if;

  -- 親が自分のものであることを確かめる（RLS でも弾かれるが、文言を明確にする）。
  if not exists (
    select 1
    from public.condition_entries e
    where e.id = p_entry_id
      and e.owner_id = actor
  ) then
    raise exception 'condition entry not found for owner' using errcode = '23503';
  end if;

  delete from public.condition_entry_symptoms c
  where c.entry_id = p_entry_id
    and c.owner_id = actor;

  insert into public.condition_entry_symptoms (
    owner_id, entry_id, symptom_type_id, severity, note
  )
  select
    actor,
    p_entry_id,
    (item ->> 'symptomTypeId')::uuid,
    (item ->> 'severity')::smallint,
    item ->> 'note'
  from pg_catalog.jsonb_array_elements(p_symptoms) as item;

  return query
    select c.*
    from public.condition_entry_symptoms c
    where c.entry_id = p_entry_id
      and c.owner_id = actor
    order by c.created_at, c.id;
end;
$$;

comment on function public.replace_condition_entry_symptoms(uuid, jsonb) is
  '実装仕様書 5.5節: 体調記録に紐づく症状を1トランザクションで全置換する。所有者は auth.uid() から導出し、RLS がそのまま効く。';

revoke all on function public.replace_condition_entry_symptoms(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_condition_entry_symptoms(uuid, jsonb) to authenticated;
