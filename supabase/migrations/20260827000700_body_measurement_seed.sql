-- 実装仕様書 5.3節「既定種別は `seed_default_body_measurement_types` RPCで投入する」。
--
-- SECURITY INVOKER のまま置く。呼び出し元の JWT で動くため、
--   - RLS（所有者 + public.is_active_user()）がそのまま効く
--   - 他人の行を作れない（insert ポリシーの with check が owner_id を縛る）
-- という性質を関数側で作り直さずに済む。SECURITY DEFINER にすると RLS を
-- 迂回してしまい、所有者判定を関数の中で再実装することになる。
--
-- 何度呼んでも同じ結果になる（実装仕様書 6.4節の冪等性の考え方）。
-- 既に投入済みのキーは `on conflict do nothing` で読み飛ばし、
-- 常に「所有者の既定種別10件」を返す。
create or replace function public.seed_default_body_measurement_types()
returns setof public.body_measurement_types
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

  insert into public.body_measurement_types (
    owner_id, measurement_key, display_name, unit_constraint, default_unit, is_default, sort_order
  )
  select
    actor,
    d.measurement_key,
    d.display_name,
    d.unit_constraint,
    d.default_unit,
    true,
    d.sort_order
  from public.default_body_measurement_types() d
  on conflict (owner_id, measurement_key) do nothing;

  return query
    select t.*
    from public.body_measurement_types t
    where t.owner_id = actor
      and t.is_default
    order by t.sort_order, t.measurement_key;
end;
$$;

comment on function public.seed_default_body_measurement_types() is
  '実装仕様書 5.3節: 既定10種別を呼び出し元の所有者へ冪等に投入し、既定種別の全件を返す。';

revoke all on function public.seed_default_body_measurement_types() from public, anon, authenticated;
grant execute on function public.seed_default_body_measurement_types() to authenticated;
