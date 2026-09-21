-- Phase 4-2a review follow-up: 在庫ロットがある商品の `default_unit` を固定する。
--
-- 在庫の数量・残量・消費量は**すべて商品の `default_unit` で数える**
-- （migration 20260915000100 冒頭の注記、docs/api/supplements.md 2.4節）。
-- ところが既存のガード `tg_supplement_lot_guard` は**ロット側の
-- INSERT / UPDATE でしか**単位一致を見ていなかったため、
--
--   1. 商品 `vitamin_c`（`default_unit = 'tablet'`）にロットを1件登録する
--   2. 商品の `default_unit` だけを 'g' に更新する（誰も止めない）
--
-- という順序で、ロットは 'tablet'、商品は 'g' という食い違いを作れてしまう。
-- そのあとの FEFO 消費（`record_supplement_intake`）は単位の違う数量を
-- 数値だけで減算するため、「g の服用で tablet のロットを減らす」という
-- 無意味な在庫の動きが記録される。
--
-- 商品側の UPDATE にも同じ不変条件を張る。残量 0 のロットも「存在する」に
-- 数える——残量が尽きても行は残り、その行の更新（メモの訂正など）が
-- あとから単位不一致で通らなくなるため。
--
-- API 層（`src/server/supplements/repository.ts` の `saveProduct`）は保存前に
-- 同じ判定をして 400 `SUPPLEMENT_UNIT_MISMATCH` を返す。ここはその最終防衛線で、
-- 「ロットの登録」と「単位の変更」が同時に走って事前検査をすり抜けた場合に効く。

create or replace function public.tg_supplement_product_unit_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.default_unit is distinct from old.default_unit
     and exists (
       select 1
       from public.supplement_inventory_lots l
       where l.product_id = old.id
         and l.owner_id = old.owner_id
     )
  then
    raise exception
      'cannot change the supplement product default unit while inventory lots exist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.tg_supplement_product_unit_guard() is
  '実装仕様書 5.6節: 在庫ロットが1件でもある商品の既定単位（＝在庫の単位）の変更を拒否する。';

revoke all on function public.tg_supplement_product_unit_guard() from public, anon, authenticated;

drop trigger if exists supplement_products_unit_guard on public.supplement_products;
create trigger supplement_products_unit_guard
before update of default_unit on public.supplement_products
for each row
execute function public.tg_supplement_product_unit_guard();
