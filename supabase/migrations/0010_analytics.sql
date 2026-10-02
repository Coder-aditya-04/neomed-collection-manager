-- ===================================================================
-- Analytics.
--
-- Everything here is derived from data already recorded — snapshots and
-- bill_changes. Nothing is modelled, projected or smoothed: a trend line
-- that invents points between two imports would be a drawing, not a
-- measurement, and the owner would make decisions on it.
-- ===================================================================

-- -------------------------------------------------------------------
-- v_book_trend — the book, import by import.
--
-- One row per snapshot. This is the only honest time series available:
-- the book is only known on the days somebody exported it.
-- -------------------------------------------------------------------
create or replace view v_book_trend as
select
  s.id as snapshot_id,
  s.report_date,
  s.party_count,
  s.bill_count,
  s.total_owed,
  s.total_credit,
  s.net_total,
  s.net_total - lag(s.net_total) over (order by s.report_date) as change_from_previous,
  s.report_date - lag(s.report_date) over (order by s.report_date) as days_since_previous
from snapshots s
order by s.report_date;

-- -------------------------------------------------------------------
-- v_collection_trend — money observed arriving, per import interval.
--
-- Derived from bill_changes: a balance that fell between two snapshots
-- is money that came in. It measures what the exports reveal, which is
-- not the same as every rupee banked — a bill paid and re-billed between
-- two files nets to nothing and is invisible. Labelled as observed for
-- that reason.
-- -------------------------------------------------------------------
create or replace view v_collection_trend as
select
  bc.detected_to                                        as on_date,
  bc.detected_from                                      as since_date,
  sum(bc.delta) filter (where bc.change_type in ('payment','settled'))  as collected,
  count(*) filter (where bc.change_type = 'payment')::int              as part_payments,
  count(*) filter (where bc.change_type = 'settled')::int              as bills_cleared,
  sum(bc.delta) filter (where bc.change_type = 'new_bill')             as new_billing,
  count(distinct bc.party_id) filter (where bc.change_type in ('payment','settled'))::int as paying_parties
from bill_changes bc
group by bc.detected_to, bc.detected_from
order by bc.detected_to;

-- -------------------------------------------------------------------
-- v_category_exposure — where the money sits by trade category.
-- -------------------------------------------------------------------
create or replace view v_category_exposure as
select
  coalesce(a.category, 'uncategorised')                          as category,
  count(*)::int                                                  as party_count,
  coalesce(sum(a.current_outstanding) filter (where a.current_outstanding > 0), 0) as owed,
  coalesce(sum(a.over_60), 0)                                    as over_60,
  count(*) filter (where a.needs_credit_term)::int               as without_term,
  coalesce(avg(pp.actual_payment_days) filter (where pp.actual_payment_days is not null), null) as avg_payment_days
from v_party_ageing a
left join party_profiles pp on pp.party_id = a.party_id
group by coalesce(a.category, 'uncategorised')
order by owed desc;

-- -------------------------------------------------------------------
-- fn_collection_cycle — how long Neomed actually waits to be paid.
--
-- The client asked for two figures: the average repaying days of one
-- party, and Neomed's own cycle overall. The first is already on
-- party_profiles. This is the second.
--
-- The median is reported alongside the mean on purpose. A handful of
-- very old bills drags an average badly, and the owner would read the
-- inflated number as typical. Where they disagree, the median is the
-- one that describes an ordinary invoice.
-- -------------------------------------------------------------------
create or replace function fn_collection_cycle()
returns table (
  rated_parties      integer,
  settled_bills      integer,
  mean_days          numeric,
  median_days        numeric,
  p90_days           numeric,
  fastest_days       integer,
  slowest_days       integer
)
language sql
stable
as $$
  with settled as (
    select bc.detected_to - bc.bill_date as days
    from bill_changes bc
    where bc.change_type = 'settled'
      and bc.bill_date is not null
      and bc.detected_to - bc.bill_date between 0 and 3650
  )
  select
    (select count(*)::int from party_profiles where actual_payment_days is not null),
    (select count(*)::int from settled),
    round(avg(days)::numeric, 1),
    round(percentile_cont(0.5) within group (order by days)::numeric, 1),
    round(percentile_cont(0.9) within group (order by days)::numeric, 1),
    min(days)::int,
    max(days)::int
  from settled;
$$;

-- -------------------------------------------------------------------
-- fn_payment_behaviour — the per-party repayment picture.
--
-- Only parties with enough settled history to say anything. A party with
-- two settled bills is an anecdote, and rating one would put a confident
-- label on noise.
-- -------------------------------------------------------------------
create or replace function fn_payment_behaviour(p_limit integer default 25)
returns table (
  party_id            uuid,
  display_name        text,
  category            text,
  current_outstanding numeric,
  actual_payment_days integer,
  payment_consistency numeric,
  partial_payment_rate numeric,
  settled_bill_count  integer,
  reliability         text,
  last_payment_date   date,
  expected_days       integer,
  days_beyond_term    integer
)
language sql
stable
as $$
  select
    a.party_id, a.display_name, a.category, a.current_outstanding,
    pp.actual_payment_days, pp.payment_consistency, pp.partial_payment_rate,
    pp.settled_bill_count, pp.reliability, pp.last_payment_date,
    case when a.credit_type = 'days'  then a.credit_days
         when a.credit_type = 'cycle' then 45
         else null end as expected_days,
    case when a.credit_type = 'days'  then pp.actual_payment_days - a.credit_days
         when a.credit_type = 'cycle' then pp.actual_payment_days - 45
         else null end as days_beyond_term
  from v_party_ageing a
  join party_profiles pp on pp.party_id = a.party_id
  where pp.settled_bill_count >= 3
    and pp.actual_payment_days is not null
  order by a.current_outstanding desc
  limit greatest(p_limit, 0);
$$;

alter view v_book_trend        set (security_invoker = on);
alter view v_collection_trend  set (security_invoker = on);
alter view v_category_exposure set (security_invoker = on);

grant select on v_book_trend, v_collection_trend, v_category_exposure to authenticated;
grant execute on function fn_collection_cycle() to authenticated;
grant execute on function fn_payment_behaviour(integer) to authenticated;
