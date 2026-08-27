-- 実装仕様書 5.3節「既定種別は `seed_default_body_measurement_types` RPCで投入する」。
--
-- > 既定種別（`is_default=true`）の作成・変更は、`seed_default_body_measurement_types`
-- > RPC等のサーバー側処理に限定し、`authenticated`ロールから直接`is_default=true`の
-- > 行をINSERT/UPDATEできないようにする（既定カタログの偽装・改ざん防止）。
--
-- SECURITY DEFINER で置く。migration 20260827000600 が authenticated から
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
-- （カタログのキーは migration 20260827000500 のトリガーがカスタム種別へ禁じており、
-- ここでの正規化は「過去に作られた行」と「カタログ自体の更新」への備え）。
create or replace function public.seed_default_body_measurement_types()
returns setof public.body_measurement_types
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

  -- 既定種別の書き込みを許す唯一の目印（migration 20260827000500 のトリガーが読む GUC）。
  -- is_local => true なので、このトランザクションの終わりで必ず消える。
  perform pg_catalog.set_config('app.body_measurement_seed', 'on', true);

  insert into public.body_measurement_types as existing (
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
  on conflict (owner_id, measurement_key) do update
    set is_default      = true,
        display_name    = excluded.display_name,
        unit_constraint = excluded.unit_constraint,
        default_unit    = excluded.default_unit,
        sort_order      = excluded.sort_order,
        -- 既定種別はアーカイブ不可（CHECK 制約）。正規化のときに必ず解除する。
        archived_at     = null
    where existing.owner_id = actor
      and (
        existing.is_default      is distinct from true
        or existing.display_name    is distinct from excluded.display_name
        or existing.unit_constraint is distinct from excluded.unit_constraint
        or existing.default_unit    is distinct from excluded.default_unit
        or existing.sort_order      is distinct from excluded.sort_order
        or existing.archived_at     is not null
      );

  perform pg_catalog.set_config('app.body_measurement_seed', 'off', true);

  return query
    select t.*
    from public.body_measurement_types t
    where t.owner_id = actor
      and t.is_default
    order by t.sort_order, t.measurement_key;
end;
$$;

comment on function public.seed_default_body_measurement_types() is
  '実装仕様書 5.3節: 既定10種別を呼び出し元の所有者へ冪等に投入・正規化し、既定種別の全件を返す。is_default を書ける唯一の経路。';

revoke all on function public.seed_default_body_measurement_types() from public, anon, authenticated;
grant execute on function public.seed_default_body_measurement_types() to authenticated;
