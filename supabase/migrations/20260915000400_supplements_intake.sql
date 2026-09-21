-- 実装仕様書 5.6節「サプリメント」の最重要部分。
--
-- > 服用時は期限が近いロットから消費（FEFO）し、負在庫となる操作は原子的RPC
-- > （`record_supplement_intake` / `void_supplement_intake`）が拒否する。
--
-- ## なぜ RPC にまとめるのか
--
-- 1回の服用記録は、最低でも次の3つの書き込みを伴う。
--
--   (a) `supplement_intake_logs` への記録の追加
--   (b) `supplement_inventory_lots.remaining_quantity` の減算（1つとは限らない）
--   (c) `supplement_inventory_movements` への「どのロットからいくつ引いたか」の追記
--
-- API から (a)(b)(c) を別々に投げると、途中で失敗したときに
--
--   - 記録だけ残って在庫が減っていない（実在庫と表示が食い違う）
--   - 在庫だけ減って記録が無い（利用者は理由の分からない減りを見る）
--   - 在庫は減ったが「どこから引いたか」が残らず、**取消しても正しく戻せない**
--
-- という半端な状態が生まれる。単一の関数呼び出しにすれば本体は1トランザクションで
-- 実行されるので、どこで失敗しても全部まとめて巻き戻る。
-- 体調記録の `save_condition_entry()`（migration 20260903000500）と同じ理由。
--
-- ## 同時実行（Phase 4-1a の教訓）
--
-- 「在庫を数えてから引く」は、数えた値と引くときの値がずれると壊れる。
-- 同じ所有者が同じ商品へ同時に服用を記録すると、READ COMMITTED では互いの
-- 未コミットの減算が見えないため、
--
--   残量3錠 → T1 と T2 が同時に「2錠引ける」と判断 → 両方成功 → 残量 -1
--
-- が起こりうる。Phase 4-1a のカスタム症状30件上限で同じ形の穴を踏んだので、
-- 同じ守り方をする——**所有者単位の `pg_advisory_xact_lock` で先に順番を決める**。
-- ロックは所有者IDから導くので、直列化されるのは同じ利用者の同時操作だけ
-- （他の利用者は待たされない）。トランザクション単位なのでコミット／ロールバックで
-- 自動解放され、1トランザクションで取るキーは常に1本なのでデッドロックしない。
--
-- 睡眠・水分・体調の1引数版ロックと**別のロック空間**にするため2引数版を使う
-- （`pg_advisory_xact_lock(classid, objid)`）。機能をまたいだ無関係な待ちを避ける。
--
-- そして、ロックに頼りきらない。`supplement_inventory_lots` の
-- `check (remaining_quantity >= 0)`（migration 20260915000100）が最終防衛線として
-- 負在庫を無条件に拒否する。ロックは競合の**直列化**、CHECK は不変条件の**保証**。
--
-- ## 権限
--
-- SECURITY DEFINER。`supplement_intake_logs` は authenticated から書き込み権限を
-- 完全に剥奪してあり（migration 20260915000200）、書けるのは定義者ロール＝本関数だけ。
-- RLS を迂回するので、RLS が担っていた検査を関数側で明示する。
--   - `auth.uid()` が無ければ拒否（未認証）
--   - `public.is_active_user()` が false なら拒否（実装仕様書 6.5節）
--   - 読み書きは常に `owner_id = actor` に限定（他人の商品・ロット・記録に触れない）

-- ---------------------------------------------------------------------------
-- 所有者単位の在庫ロックのキー空間。
-- ---------------------------------------------------------------------------
create or replace function public.supplement_inventory_lock_class()
returns integer
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.hashtext('supplement_inventory');
$$;

comment on function public.supplement_inventory_lock_class() is
  '実装仕様書 5.6節: サプリメント在庫の所有者単位ロックのキー空間（他機能の advisory lock と衝突させないための classid）。';

revoke all on function public.supplement_inventory_lock_class() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.record_supplement_intake（実装仕様書 5.6節）
--
-- 服用記録の作成と、期限が近いロットからの優先消費（FEFO）を
-- 単一トランザクションで実行する。負在庫となる操作は拒否する。
--
-- ### FEFO の並び順
--
--   1. `expires_on` 昇順（NULL は最後）……「期限が近いものから」そのもの
--   2. `opened_on`  昇順（NULL は最後）……期限が同じなら開封済みを先に使い切る
--   3. `purchased_on` 昇順（NULL は最後）……先に買ったものから
--   4. `created_at` 昇順 → `id` 昇順 ……完全な決定性のための最終タイブレーク
--
-- 2〜4 を入れるのは、期限が同じロットが複数あるときに「どれから引いたか」が
-- 実行ごとに変わらないようにするため。取消の復元は movements を読んで行うので
-- 正しさには影響しないが、順序が非決定的だと利用者にも試験にも説明できない。
--
-- ### 戻り値
--
-- `{"outcome": "created" | "idempotent_replay", "intake": <行>}` の jsonb。
--
-- 「新規に記録したのか、既に適用済みだったのか」を**呼び出し側が推測しない**ように
-- 関数が名乗る。API 側で「呼ぶ前に冪等キーを引いて、無ければ created」と判断すると、
-- 同じキーの2リクエストが同時に届いたときに両方とも「呼ぶ前には無かった」と観測し、
-- 実際には1件しか作られていないのに両方が `created` を名乗ってしまう。
-- 判定はロックの内側にある関数でしかできない。
--
-- ### 在庫消費量（`p_consume_quantity`）の決め方
--
-- 在庫は商品の `default_unit` で数える（migration 20260915000100）。
--   - 明示指定あり → その値（在庫単位で解釈する）
--   - 省略 & 状態が skipped → 0（スキップは在庫を減らさない）
--   - 省略 & 服用の単位が在庫単位と同じ → 服用量をそのまま引く
--   - 省略 & 単位が違う → 拒否（22023）。黙って 0 にすると在庫が減らないまま
--     「服用済み」になり、利用者は減らない在庫の理由を知りようがない。
--     換算はアプリ側の責任として、明示させる。
-- ---------------------------------------------------------------------------
create or replace function public.record_supplement_intake(
  p_product_id uuid,
  p_idempotency_key text,
  p_recorded_at timestamptz,
  p_status text default 'taken',
  p_amount numeric default null,
  p_unit text default null,
  p_schedule_id uuid default null,
  p_scheduled_for timestamptz default null,
  p_consume_quantity numeric default null,
  p_timezone text default 'Asia/Tokyo',
  p_note text default null,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor       uuid := (select auth.uid());
  existing    public.supplement_intake_logs;
  product     public.supplement_products;
  saved       public.supplement_intake_logs;
  intake_amount numeric;
  intake_unit   text;
  consume       numeric;
  outstanding   numeric;
  taken_now     numeric;
  lot           record;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'account is not active' using errcode = '42501';
  end if;

  -- 実装仕様書 5.6節「冪等キー（8〜200文字）」。CHECK 制約と同じ判定を先に行い、
  -- 在庫へ触れる前に弾く。
  if p_idempotency_key is null
     or pg_catalog.char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'the supplement intake idempotency key must be 8 to 200 characters'
      using errcode = '22023';
  end if;

  -- 取消は専用の RPC（void_supplement_intake）から行う。ここで voided を
  -- 作れてしまうと「在庫を戻さずに取消済みの記録を作る」偽装ができる。
  if p_status is null or p_status not in ('taken', 'skipped', 'as_needed') then
    raise exception 'the supplement intake status must be taken, skipped or as_needed'
      using errcode = '22023';
  end if;

  if p_recorded_at is null then
    raise exception 'recorded_at is required' using errcode = '22023';
  end if;

  -- 所有者単位で直列化する（本ファイル冒頭「同時実行」）。冪等キーの引き当ても
  -- ロックの内側で行う。外で引くと、同じキーの2つの同時リクエストが
  -- 両方とも「未適用」と観測し、在庫を二重に減らしうる。
  perform pg_catalog.pg_advisory_xact_lock(
    public.supplement_inventory_lock_class(),
    pg_catalog.hashtext(actor::text)
  );

  -- 業務キーによる引き当て（docs/api/supplements.md 1.6節）。
  -- 既に記録済みなら在庫へ一切触れず、当時の行をそのまま返す。
  select l.* into existing
  from public.supplement_intake_logs l
  where l.owner_id = actor
    and l.idempotency_key = p_idempotency_key;

  if found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'idempotent_replay',
      'intake', pg_catalog.to_jsonb(existing)
    );
  end if;

  select p.* into product
  from public.supplement_products p
  where p.id = p_product_id
    and p.owner_id = actor;

  if not found then
    raise exception 'supplement product not found for owner' using errcode = '23503';
  end if;

  if product.archived_at is not null then
    raise exception 'the supplement product is archived; cannot record new intakes'
      using errcode = '23514';
  end if;

  if p_schedule_id is not null then
    if not exists (
      select 1
      from public.supplement_schedules s
      where s.id = p_schedule_id
        and s.owner_id = actor
        and s.product_id = p_product_id
    ) then
      raise exception 'supplement schedule not found for owner' using errcode = '23503';
    end if;
  end if;

  intake_amount := coalesce(p_amount, product.default_amount);
  intake_unit   := coalesce(p_unit, product.default_unit);

  if intake_amount is null then
    raise exception 'amount is required because the supplement product has no default amount'
      using errcode = '22023';
  end if;

  -- 在庫消費量（本ファイル冒頭「在庫消費量の決め方」）。
  if p_status = 'skipped' then
    consume := coalesce(p_consume_quantity, 0);
    if consume <> 0 then
      raise exception 'a skipped supplement intake cannot consume inventory'
        using errcode = '22023';
    end if;
  elsif p_consume_quantity is not null then
    consume := p_consume_quantity;
  elsif intake_unit = product.default_unit then
    consume := intake_amount;
  else
    raise exception
      'consume quantity is required when the intake unit differs from the inventory unit'
      using errcode = '22023';
  end if;

  if consume < 0 then
    raise exception 'the supplement consume quantity cannot be negative' using errcode = '22023';
  end if;

  -- 記録を先に作る。在庫の動き（movements）が参照する服用記録IDが要るため。
  -- 在庫が足りなければ下で例外を投げ、この INSERT ごと巻き戻る。
  insert into public.supplement_intake_logs (
    owner_id, product_id, schedule_id, status, scheduled_for, recorded_at, timezone,
    amount, unit, consumed_quantity, idempotency_key, note, client_mutation_id
  )
  values (
    actor, p_product_id, p_schedule_id, p_status, p_scheduled_for, p_recorded_at,
    coalesce(p_timezone, 'Asia/Tokyo'),
    intake_amount, intake_unit, consume, p_idempotency_key, p_note, p_client_mutation_id
  )
  returning * into saved;

  if consume > 0 then
    -- 在庫の動きの種別を「服用による消費」にする（ロットのトリガーが読む GUC）。
    -- is_local => true なのでトランザクション終了時に必ず消える。
    perform pg_catalog.set_config('app.supplement_movement_kind', 'intake_consume', true);
    perform pg_catalog.set_config('app.supplement_intake_log_id', saved.id::text, true);

    outstanding := consume;

    for lot in
      select l.id, l.remaining_quantity
      from public.supplement_inventory_lots l
      where l.owner_id = actor
        and l.product_id = p_product_id
        and l.remaining_quantity > 0
      order by
        l.expires_on asc nulls last,
        l.opened_on asc nulls last,
        l.purchased_on asc nulls last,
        l.created_at asc,
        l.id asc
      for update
    loop
      exit when outstanding <= 0;

      taken_now := least(lot.remaining_quantity, outstanding);

      -- 条件付き UPDATE。`for update` で行を掴んだあとの最新値でも足りることを
      -- WHERE で確かめる（掴む前に別トランザクションが減らしていた場合への備え）。
      update public.supplement_inventory_lots l
      set remaining_quantity = l.remaining_quantity - taken_now
      where l.id = lot.id
        and l.owner_id = actor
        and l.remaining_quantity >= taken_now;

      if found then
        outstanding := outstanding - taken_now;
      end if;
    end loop;

    perform pg_catalog.set_config('app.supplement_movement_kind', '', true);
    perform pg_catalog.set_config('app.supplement_intake_log_id', '', true);

    if outstanding > 0 then
      -- 実装仕様書 5.6節「負在庫となる操作は…拒否する」。
      -- ここまでの記録の作成もロットの減算も、この例外でまとめて巻き戻る。
      raise exception
        'insufficient supplement inventory: % remaining of % required', outstanding, consume
        using errcode = '23514';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'created',
    'intake', pg_catalog.to_jsonb(saved)
  );
end;
$$;

comment on function public.record_supplement_intake(
  uuid, text, timestamptz, text, numeric, text, uuid, timestamptz, numeric, text, text, uuid
) is
  '実装仕様書 5.6節: 服用記録の作成と FEFO 在庫消費を1トランザクションで行う。同一 idempotency_key の再送は在庫に触れず当時の記録を返す。在庫不足は 23514 「insufficient supplement inventory」で拒否する。';

revoke all on function public.record_supplement_intake(
  uuid, text, timestamptz, text, numeric, text, uuid, timestamptz, numeric, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.record_supplement_intake(
  uuid, text, timestamptz, text, numeric, text, uuid, timestamptz, numeric, text, text, uuid
) to authenticated;

-- ---------------------------------------------------------------------------
-- public.void_supplement_intake（実装仕様書 5.6節）
--
-- 服用の取消と、消費した在庫のロットへの正確な復元を単一トランザクションで実行する。
--
-- ### 「正確な復元」とは
--
-- 消費は FEFO で**複数のロットにまたがりうる**（3錠の服用が、残1錠のロットと
-- 残10錠のロットから 1 + 2 と引かれる、など）。合計だけを覚えていると、
-- 取消のときにどのロットへいくつ戻すかが決まらない。そこで消費は
-- `supplement_inventory_movements` へ**ロット単位で1行ずつ**記録されており
-- （migration 20260915000100 のトリガー）、復元はその行をそのまま読み返して
-- 同じロットへ同じ量を戻す。
--
-- ### 対象の特定は主キーで行う（Phase 3b / 4-1a の教訓）
--
-- 取消対象は `id`（主キー）で直接引く。日時・商品・状態といった「更新で変わりうる値」
-- では引かない。0件は「その記録がもう無い（または自分のものでない）」を意味する。
--
-- ### 再試行しても安全
--
-- 既に取消済みの記録に対する呼び出しは、在庫に一切触れずその行をそのまま返す
-- （楽観ロックの検査より**先**に判定する。1回目の取消で版番号が進んでいるため、
-- 先に楽観ロックを見ると正常な再送が 409 になってしまう）。
--
-- ### 戻り値
--
-- `{"outcome": "voided" | "idempotent_replay", "intake": <行>}`、または
-- `{"outcome": "conflict"}`（対象なし・版番号不一致。呼び出し側が 409 にする）。
--
-- ### 復元がロットの初期数量を超える場合
--
-- 通常は起こらない（消費は残量を減らすだけ、復元は消費した分しか戻さない）。
-- 消費後に利用者が**手動で残量を減らす調整**を行っていた場合だけ、
-- 単純に足すと `remaining_quantity <= quantity` の CHECK に当たる。
-- そのときは初期数量で頭打ちにして取消自体は成立させ、実際に戻した量を
-- 在庫の動きへ記録する（監査証跡は「戻した量」で正しく残る）。
-- 取消をエラーにして利用者を詰ませるより、事実を正確に記録する方を採る。
-- ---------------------------------------------------------------------------
create or replace function public.void_supplement_intake(
  p_id uuid,
  p_expected_row_version bigint default null,
  p_reason text default null,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor    uuid := (select auth.uid());
  target   public.supplement_intake_logs;
  voided   public.supplement_intake_logs;
  restore  record;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'account is not active' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    public.supplement_inventory_lock_class(),
    pg_catalog.hashtext(actor::text)
  );

  -- 主キーによる直接取得。他の条件に一切依存しない（本ファイル冒頭の注記）。
  select l.* into target
  from public.supplement_intake_logs l
  where l.id = p_id
    and l.owner_id = actor
  for update;

  -- 0件。実装仕様書 6.4節に従い「行が無い」と「版番号が古い」を区別せず
  -- 呼び出し側へ伝える（呼び出し側が 409 にする）。
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end if;

  -- 既に取消済み。在庫へ触れずそのまま返す（安全な再試行）。
  if target.status = 'voided' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'idempotent_replay',
      'intake', pg_catalog.to_jsonb(target)
    );
  end if;

  if p_expected_row_version is not null and target.row_version <> p_expected_row_version then
    return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end if;

  -- 消費したロットへ、消費した量をそのまま戻す。
  perform pg_catalog.set_config('app.supplement_movement_kind', 'intake_void_restore', true);
  perform pg_catalog.set_config('app.supplement_intake_log_id', target.id::text, true);

  for restore in
    select m.lot_id, -pg_catalog.sum(m.quantity_delta) as amount
    from public.supplement_inventory_movements m
    where m.owner_id = actor
      and m.intake_log_id = target.id
      and m.movement_kind = 'intake_consume'
    group by m.lot_id
  loop
    if restore.amount > 0 then
      update public.supplement_inventory_lots l
      set remaining_quantity = least(l.quantity, l.remaining_quantity + restore.amount)
      where l.id = restore.lot_id
        and l.owner_id = actor;
    end if;
  end loop;

  perform pg_catalog.set_config('app.supplement_movement_kind', '', true);
  perform pg_catalog.set_config('app.supplement_intake_log_id', '', true);

  update public.supplement_intake_logs l
  set status             = 'voided',
      voided_at          = pg_catalog.now(),
      void_reason        = p_reason,
      client_mutation_id = coalesce(p_client_mutation_id, l.client_mutation_id)
  where l.id = target.id
    and l.owner_id = actor
  returning l.* into voided;

  return pg_catalog.jsonb_build_object(
    'outcome', 'voided',
    'intake', pg_catalog.to_jsonb(voided)
  );
end;
$$;

comment on function public.void_supplement_intake(uuid, bigint, text, uuid) is
  '実装仕様書 5.6節: 服用の取消と、消費したロットへの正確な在庫復元を1トランザクションで行う。対象は主キーで直接特定する。取消済みの再送は在庫に触れずそのまま返す。0件返却は対象なしまたは版番号不一致（409）。';

revoke all on function public.void_supplement_intake(uuid, bigint, text, uuid)
  from public, anon, authenticated;
grant execute on function public.void_supplement_intake(uuid, bigint, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- public.supplement_summary（実装仕様書 5.6節「集計」）
--
-- > 週の予定数と服用数、月の服用数、低在庫商品数、期限接近ロット数。
--
-- 予定数は「直近7日間に発生するはずだった回数」。摂取予定の展開は
--   - daily    : 期間内の各日に1回
--   - weekly   : 期間内かつ対象曜日の日に1回
--   - once     : 開始日がその日なら1回
--   - as_needed: 予定発生しない（0回）
-- で数える。日付の境界は `p_timezone`（IANA 名）のローカル日で切る（実装仕様書 6.3節）。
--
-- SECURITY INVOKER。RLS がそのまま効く（他人の行は読めない）。
-- ---------------------------------------------------------------------------
create or replace function public.supplement_summary(
  p_reference timestamptz default now(),
  p_timezone text default 'Asia/Tokyo',
  p_expiring_within_days integer default 30
)
returns table (
  weekly_scheduled_count  bigint,
  weekly_taken_count      bigint,
  monthly_taken_count     bigint,
  low_stock_product_count bigint,
  expiring_lot_count      bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor     uuid := (select auth.uid());
  local_day date;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_expiring_within_days is null or p_expiring_within_days not between 0 and 3650 then
    raise exception 'the expiring window must be between 0 and 3650 days' using errcode = '22023';
  end if;

  local_day := (coalesce(p_reference, pg_catalog.now())
                 at time zone coalesce(p_timezone, 'Asia/Tokyo'))::date;

  return query
  with week_days as (
    select (local_day - offset_days) as day
    from pg_catalog.generate_series(0, 6) as offset_days
  )
  select
    (
      select pg_catalog.count(*)
      from week_days d
      join public.supplement_schedules s
        on s.owner_id = actor
       and s.archived_at is null
       and s.start_date <= d.day
       and (s.end_date is null or s.end_date >= d.day)
       and (
         s.schedule_kind = 'daily'
         or (
           s.schedule_kind = 'weekly'
           and extract(dow from d.day)::smallint = any (s.weekdays)
         )
         or (s.schedule_kind = 'once' and s.start_date = d.day)
       )
    ) as weekly_scheduled_count,
    (
      select pg_catalog.count(*)
      from public.supplement_intake_logs l
      where l.owner_id = actor
        and l.status in ('taken', 'as_needed')
        and l.recorded_at >= coalesce(p_reference, pg_catalog.now()) - interval '7 days'
        and l.recorded_at <= coalesce(p_reference, pg_catalog.now())
    ) as weekly_taken_count,
    (
      select pg_catalog.count(*)
      from public.supplement_intake_logs l
      where l.owner_id = actor
        and l.status in ('taken', 'as_needed')
        and l.recorded_at >= coalesce(p_reference, pg_catalog.now()) - interval '30 days'
        and l.recorded_at <= coalesce(p_reference, pg_catalog.now())
    ) as monthly_taken_count,
    (
      select pg_catalog.count(*)
      from public.supplement_products p
      where p.owner_id = actor
        and p.archived_at is null
        and p.low_stock_threshold is not null
        and coalesce(
              (
                select pg_catalog.sum(l.remaining_quantity)
                from public.supplement_inventory_lots l
                where l.owner_id = actor and l.product_id = p.id
              ),
              0
            ) <= p.low_stock_threshold
    ) as low_stock_product_count,
    (
      select pg_catalog.count(*)
      from public.supplement_inventory_lots l
      where l.owner_id = actor
        and l.remaining_quantity > 0
        and l.expires_on is not null
        and l.expires_on <= local_day + p_expiring_within_days
    ) as expiring_lot_count;
end;
$$;

comment on function public.supplement_summary(timestamptz, text, integer) is
  '実装仕様書 5.6節「集計」: 週の予定数・服用数、月の服用数、低在庫商品数、期限接近ロット数を所有者スコープで返す。';

revoke all on function public.supplement_summary(timestamptz, text, integer)
  from public, anon, authenticated;
grant execute on function public.supplement_summary(timestamptz, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- public.supplement_product_stock（実装仕様書 5.6節「低在庫しきい値」「集計」）
--
-- 商品ごとの在庫の要約。画面の低在庫警告と「あと何回分あるか」の表示に使う。
-- 商品1件ずつロットを引くと N+1 になるので、まとめて1回で返す。
--
-- `remaining_total` は**全ロットの残量合計**（残量 0 のロットも足すが影響しない）。
-- `lot_count` / `nearest_expires_on` は**残量のあるロットだけ**を見る
-- （使い切ったロットの期限を「次に切れる期限」として見せない）。
--
-- SECURITY INVOKER。RLS がそのまま効く（他人の行は読めない）。
-- ---------------------------------------------------------------------------
create or replace function public.supplement_product_stock()
returns table (
  product_id         uuid,
  remaining_total    numeric,
  lot_count          bigint,
  nearest_expires_on date
)
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

  return query
  select
    p.id,
    coalesce(pg_catalog.sum(l.remaining_quantity), 0)::numeric,
    pg_catalog.count(*) filter (where l.remaining_quantity > 0),
    pg_catalog.min(l.expires_on) filter (where l.remaining_quantity > 0)
  from public.supplement_products p
  left join public.supplement_inventory_lots l
    on l.product_id = p.id
   and l.owner_id = p.owner_id
  where p.owner_id = actor
  group by p.id;
end;
$$;

comment on function public.supplement_product_stock() is
  '実装仕様書 5.6節: 商品ごとの残量合計・有効ロット件数・最も近い使用期限を1回で返す（低在庫警告の N+1 を避けるため）。';

revoke all on function public.supplement_product_stock() from public, anon, authenticated;
grant execute on function public.supplement_product_stock() to authenticated;
