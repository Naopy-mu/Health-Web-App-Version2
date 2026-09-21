-- Phase 4-2a review follow-up: make the summary's weekly window and archived-product
-- policy internally consistent.
--
-- `weekly_scheduled_count` already uses the seven local calendar days ending on the
-- reference day. Apply the same half-open local-day window to `weekly_taken_count`
-- instead of a rolling 168 hours. Also exclude lots belonging to archived products
-- from `expiring_lot_count`, matching `low_stock_product_count`.

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
        and l.recorded_at >= ((local_day - 6)::timestamp
                              at time zone coalesce(p_timezone, 'Asia/Tokyo'))
        and l.recorded_at < ((local_day + 1)::timestamp
                             at time zone coalesce(p_timezone, 'Asia/Tokyo'))
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
      join public.supplement_products p
        on p.id = l.product_id
       and p.owner_id = l.owner_id
       and p.archived_at is null
      where l.owner_id = actor
        and l.remaining_quantity > 0
        and l.expires_on is not null
        and l.expires_on <= local_day + p_expiring_within_days
    ) as expiring_lot_count;
end;
$$;

comment on function public.supplement_summary(timestamptz, text, integer) is
  '実装仕様書 5.6節「集計」: ローカル日境界の直近7日間の予定数・服用数、月の服用数、アーカイブされていない商品の低在庫数・期限接近ロット数を所有者スコープで返す。';
