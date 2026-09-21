-- Phase 4-2a review follow-up: 商品の既定単位の変更と、同じ商品への在庫ロット作成を
-- 商品単位の `pg_advisory_xact_lock` で直列化する。
--
-- 不変条件は「在庫ロットの単位は常に商品の `default_unit` と一致する」
-- （migration 20260915000100 冒頭の注記、20260921000200）。これを守る2つの
-- トリガーはどちらも**相手のテーブルを読んで**検査する:
--
--   - `tg_supplement_lot_guard`（ロット側）: 商品の `default_unit` と一致するか
--   - `tg_supplement_product_unit_guard`（商品側）: ロットが1件も無いか
--
-- ところが READ COMMITTED では、相手のトランザクションの**未コミット**の変更は
-- 見えない。
--
--   T1: 商品の default_unit を tablet → g（検査時点でロット0件なので通る）
--   T2: 同じ商品へ tablet のロットを作成（検査時点で商品はまだ tablet なので通る）
--
-- が同時に走ると、両方が検査を通ってコミットされ、商品 = g / ロット = tablet が
-- 残る（実 PostgreSQL で再現: tests/db/supplements-unit-race.pg.test.ts）。
-- T2 はロットの外部キー検査で T1 の行ロックを待たされはするが、単位の検査は
-- その**前に**済んでおり、待ち明けに読み直さない。
--
-- ## 守り方
--
-- Phase 4-1a / 4-2a と同じく、**検査の前に advisory lock で順番を決める**。
-- 両方のトリガーが、検査する前に同じキーのロックを取る:
--
--   - 商品側: `default_unit` が変わる UPDATE のときだけ
--   - ロット側: INSERT のとき、および（将来の経路のため）`product_id` が変わる UPDATE
--
-- ロックを取ったあとの検査は新しいスナップショットで読む（PL/pgSQL の文ごとの
-- スナップショット。READ COMMITTED 前提。PostgREST / RPC は既定の READ COMMITTED で
-- 走る）。先にロックを取った側がコミットした結果を、後の側は必ず観測してから判定する:
--
--   単位変更が先 → ロット作成は待ち明けに新しい単位（g）を読み、tablet を拒否
--   ロット作成が先 → 単位変更は待ち明けにロットを観測し、変更を拒否
--
-- 既存ロットの UPDATE（単位の訂正・残量の調整）ではロックを取らない。コミット済みの
-- ロットは商品側の検査から必ず見えるので、そもそも単位変更と両立しない
-- （競合の窓が無い）。服用の FEFO 消費（残量だけを変える UPDATE）も待たされない。
--
-- ## キー
--
-- 2引数版 `pg_advisory_xact_lock(classid, objid)` を使い、
-- classid = hashtext('supplement_product_unit')、objid = hashtext(商品ID)。
--
--   - **商品単位**: 直列化されるのは同じ商品への単位変更とロット作成だけ。
--     同じ利用者の別商品へのロット登録は待たされない。
--   - **所有者単位の在庫ロック（`supplement_inventory_lock_class()`）とは別の空間**:
--     同じキーにすると、服用 RPC（所有者ロック → ロット行ロック）と、手動のロット
--     UPDATE（ロット行ロック → 所有者ロック）で獲得順が逆になりデッドロックしうる。
--     このキーはロット行ロックの内側でしか取られず、服用 RPC は取らない。
--   - ハッシュ衝突は「無関係な商品どうしが稀に待ち合う」だけで、正しさは損なわない。
--
-- ## 獲得順（デッドロックの回避）
--
-- 商品の UPDATE は、BEFORE トリガーが走る**前に**商品行をロックする。しかも
-- この表は一意キーに生成列（`name_normalized`）を含み、BEFORE UPDATE トリガーが
-- あると生成列は常に再計算扱いになるため、ロックは FOR UPDATE 相当（キー更新）で、
-- 外部キー検査の KEY SHARE と衝突する。ロット作成が advisory を先に取ると、
--
--   ロット作成: advisory 保持 → 外部キー検査で商品行（KEY SHARE）を待つ
--   単位変更  : 商品行 保持   → advisory を待つ
--
-- と獲得順が逆になりデッドロック（40P01）になる（実 PostgreSQL で再現済み）。
-- そこでロット側も**先に商品行へ KEY SHARE を取ってから** advisory を取り、
-- 両側の順序を「商品行 → advisory」に揃える。KEY SHARE は外部キー検査が
-- どのみち取るロックで、前倒しするだけ（新しい種類の待ちは増えない）。
-- 行ロックの強さが将来変わって（生成列の見直しなど）KEY SHARE と単位変更が
-- 衝突しなくなっても、直列化そのものは advisory が担うので不変条件は崩れない。
--
-- `for key share` には対象行への UPDATE 権限（列権限のいずれか）と UPDATE ポリシーの
-- 通過が要る。authenticated は自分の商品の列を UPDATE でき（migration 20260915000200）、
-- 他人の商品はそもそも外部キー（product_id, owner_id）で拒否される。
--
-- `supplement_inventory_lock_class()` は authenticated から実行権限を剥奪してある
-- （migration 20260915000400）。トリガーは SECURITY INVOKER で authenticated として
-- 走るため、キーはここに直接書く（`pg_advisory_xact_lock` / `hashtext` は既定で
-- PUBLIC に実行権限がある。体調の上限検査 `tg_wellness_reference_guard` と同じ）。

create or replace function public.tg_supplement_lot_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  product public.supplement_products;
begin
  -- 商品の単位を読む**前に**、同じ商品の単位変更と直列化する（本ファイル冒頭）。
  if tg_op = 'INSERT' or new.product_id is distinct from old.product_id then
    -- 獲得順を「商品行 → advisory」に揃える（本ファイル冒頭「獲得順」）。
    -- KEY SHARE は外部キー検査があとで取るのと同じロックで、前倒しするだけ。
    perform 1
    from public.supplement_products p
    where p.id = new.product_id
      and p.owner_id = new.owner_id
    for key share;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('supplement_product_unit'),
      pg_catalog.hashtext(new.product_id::text)
    );
  end if;

  select p.* into product
  from public.supplement_products p
  where p.id = new.product_id
    and p.owner_id = new.owner_id;

  if not found then
    raise exception 'supplement product not found for owner' using errcode = '23503';
  end if;

  if new.unit is distinct from product.default_unit then
    raise exception
      'the inventory lot unit must match the supplement product default unit'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and product.archived_at is not null then
    raise exception 'the supplement product is archived; cannot add new inventory lots'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.tg_supplement_lot_guard() is
  '実装仕様書 5.6節: 在庫ロットの単位を商品の既定単位へ揃え、アーカイブ済み商品への新規ロット登録を拒否する。作成時は商品単位の advisory lock で単位変更と直列化する。';

revoke all on function public.tg_supplement_lot_guard() from public, anon, authenticated;

create or replace function public.tg_supplement_product_unit_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.default_unit is distinct from old.default_unit then
    -- ロットの有無を数える**前に**、同じ商品へのロット作成と直列化する
    -- （本ファイル冒頭）。先に作成中だったロットは、その確定後に観測できる。
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('supplement_product_unit'),
      pg_catalog.hashtext(old.id::text)
    );

    if exists (
      select 1
      from public.supplement_inventory_lots l
      where l.product_id = old.id
        and l.owner_id = old.owner_id
    ) then
      raise exception
        'cannot change the supplement product default unit while inventory lots exist'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_supplement_product_unit_guard() is
  '実装仕様書 5.6節: 在庫ロットが1件でもある商品の既定単位（＝在庫の単位）の変更を拒否する。商品単位の advisory lock でロット作成と直列化する。';

revoke all on function public.tg_supplement_product_unit_guard() from public, anon, authenticated;
