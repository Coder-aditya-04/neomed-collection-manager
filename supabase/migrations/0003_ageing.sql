-- ===================================================================
-- Ageing. Build order step 3.
--
-- The logic lives here, not in React: one definition, one answer, and the
-- assistant and the screens cannot drift apart.
-- ===================================================================

-- -------------------------------------------------------------------
-- fn_expected_due_date — the two credit models
--
-- 'days'  : bill_date + credit_days.
--
-- 'cycle' : bills must reach the party by cycle_submit_day to make that
--           month's run; payment is released on cycle_pay_day, cycle_lag_months
--           later. A bill that misses the window waits for the next cycle,
--           and that wait is normal for the party, not lateness.
--
--           submit 5th, pay 25th, lag 1 —
--             bill 3 Aug  -> made the August window  -> due 25 Sep
--             bill 8 Aug  -> missed it, rides September -> due 25 Oct
--
-- 'none'  : NULL. There is no due date to infer, and inferring one is
--           exactly what rule 1 forbids.
-- -------------------------------------------------------------------
create or replace function fn_expected_due_date(
  p_bill_date   date,
  p_credit_type text,
  p_credit_days integer,
  p_submit_day  integer,
  p_pay_day     integer,
  p_lag_months  integer
) returns date
language plpgsql
immutable
as $$
declare
  v_month_start   date;
  v_days_in_month integer;
begin
  if p_bill_date is null then
    return null;
  end if;

  if p_credit_type = 'days' then
    if p_credit_days is null then
      return null;
    end if;
    return p_bill_date + p_credit_days;
  end if;

  if p_credit_type = 'cycle' then
    if p_submit_day is null or p_pay_day is null then
      return null;
    end if;

    v_month_start := date_trunc('month', p_bill_date)::date;

    -- Past the submission day means this month's run was missed.
    if extract(day from p_bill_date)::integer > p_submit_day then
      v_month_start := (v_month_start + interval '1 month')::date;
    end if;

    v_month_start := (v_month_start + make_interval(months => coalesce(p_lag_months, 0)))::date;

    -- A pay day of 31 in a 30-day month means the last day of that month,
    -- not the 1st of the next.
    v_days_in_month := extract(day from (v_month_start + interval '1 month' - interval '1 day'))::integer;

    return v_month_start + (least(p_pay_day, v_days_in_month) - 1);
  end if;

  return null;  -- 'none'
end;
$$;

comment on function fn_expected_due_date is
  'Expected due date from a party''s credit model. Returns NULL for credit_type '
  '''none'' — an unrecorded term is never estimated (rule 1).';

-- Databases created before contact details existed need these before the
-- view below can reference them. Idempotent, and a no-op on a fresh install
-- where 0001 already added them.
alter table parties add column if not exists phone text;
alter table parties add column if not exists contact_person text;

-- -------------------------------------------------------------------
-- v_latest_snapshot
-- -------------------------------------------------------------------
drop view if exists v_portfolio_ageing;
drop view if exists v_party_ageing;
drop view if exists v_latest_snapshot;

create view v_latest_snapshot as
  select *
  from snapshots
  order by report_date desc
  limit 1;

-- -------------------------------------------------------------------
-- v_party_ageing
--
-- Four bucket totals per party for the latest snapshot, measured against
-- overdue_days and never against bill age, then scaled so they sum to
-- parties.current_outstanding — the header figure, which is what the owner
-- sees in Marg.
--
-- Buckets are NULL, not zero, when the party has no recorded term. Zero
-- would read as "nothing is overdue"; NULL reads as "we cannot say", which
-- is the truth and is what the stop rule depends on.
-- -------------------------------------------------------------------
create view v_party_ageing as
with latest as (
  select id, report_date from v_latest_snapshot
),
scored_bills as (
  select
    b.party_id,
    b.balance,
    case
      when p.credit_source = 'not_set' then null
      else current_date - fn_expected_due_date(
             b.bill_date, p.credit_type, p.credit_days,
             p.cycle_submit_day, p.cycle_pay_day, p.cycle_lag_months)
    end as overdue_days
  from bills b
  join parties p on p.id = b.party_id
  cross join latest l
  where b.snapshot_id = l.id
),
raw_buckets as (
  select
    party_id,
    sum(balance)                                                              as bill_balance_sum,
    sum(balance) filter (where overdue_days is not null and overdue_days <= 0) as within_terms,
    sum(balance) filter (where overdue_days between 1 and 30)                  as over_1_30,
    sum(balance) filter (where overdue_days between 31 and 60)                 as over_31_60,
    sum(balance) filter (where overdue_days > 60)                              as over_60,
    max(overdue_days)                                                          as max_overdue_days,
    count(*)                                                                   as bill_count,
    -- A bill with no readable date cannot be placed in any bucket; if any
    -- exist the buckets below are incomplete and must say so.
    count(*) filter (where overdue_days is null)                               as unplaceable_bills
  from scored_bills
  group by party_id
),
scaled as (
  select
    p.id as party_id,
    p.display_name,
    p.normalised_name,
    p.category,
    p.phone,
    p.contact_person,
    p.status,
    p.credit_type,
    p.credit_source,
    p.credit_days,
    p.cycle_submit_day,
    p.cycle_pay_day,
    p.cycle_lag_months,
    p.current_outstanding,
    p.oldest_bill_age_days,
    coalesce(rb.bill_count, 0)       as bill_count,
    rb.bill_balance_sum,
    rb.max_overdue_days,
    coalesce(rb.unplaceable_bills, 0) as unplaceable_bills,
    p.credit_source = 'not_set'      as needs_credit_term,
    -- Rule 2: a category default is a working assumption, not an approved
    -- term. Everything downstream must label it as one.
    p.credit_source = 'category_default' as term_is_assumed,
    p.current_outstanding < 0        as is_credit_balance,
    -- Rule 3: bill rows only ever supply the SHAPE of the ageing. The header
    -- total supplies the size, and this ratio maps one onto the other.
    case
      when rb.bill_balance_sum is null or rb.bill_balance_sum = 0 then null
      else p.current_outstanding / rb.bill_balance_sum
    end as reconcile_ratio,
    rb.within_terms, rb.over_1_30, rb.over_31_60, rb.over_60
  from parties p
  left join raw_buckets rb on rb.party_id = p.id
)
select
  party_id,
  display_name,
  normalised_name,
  category,
  phone,
  contact_person,
  status,
  credit_type,
  credit_source,
  credit_days,
  cycle_submit_day,
  cycle_pay_day,
  cycle_lag_months,
  current_outstanding,
  oldest_bill_age_days,
  bill_count,
  bill_balance_sum,
  reconcile_ratio,
  max_overdue_days,
  unplaceable_bills,
  needs_credit_term,
  term_is_assumed,
  is_credit_balance,
  case when needs_credit_term then null
       else round(coalesce(within_terms, 0) * coalesce(reconcile_ratio, 1), 2) end as within_terms,
  case when needs_credit_term then null
       else round(coalesce(over_1_30,   0) * coalesce(reconcile_ratio, 1), 2) end as over_1_30,
  case when needs_credit_term then null
       else round(coalesce(over_31_60,  0) * coalesce(reconcile_ratio, 1), 2) end as over_31_60,
  case when needs_credit_term then null
       else round(coalesce(over_60,     0) * coalesce(reconcile_ratio, 1), 2) end as over_60
from scaled;

comment on view v_party_ageing is
  'Per-party ageing for the latest snapshot. Buckets are measured against '
  'overdue_days (never bill age), scaled to the Marg header total, and NULL '
  'wherever no credit term is recorded.';

-- -------------------------------------------------------------------
-- v_portfolio_ageing — the dashboard strip.
--
-- Judgeable money only. Parties with no term are reported as their own
-- figure rather than folded in, because adding them would present age as
-- lateness for 612 of the 819 parties.
-- -------------------------------------------------------------------
create view v_portfolio_ageing as
select
  coalesce(sum(within_terms) filter (where not needs_credit_term and not is_credit_balance), 0) as within_terms,
  coalesce(sum(over_1_30)    filter (where not needs_credit_term and not is_credit_balance), 0) as over_1_30,
  coalesce(sum(over_31_60)   filter (where not needs_credit_term and not is_credit_balance), 0) as over_31_60,
  coalesce(sum(over_60)      filter (where not needs_credit_term and not is_credit_balance), 0) as over_60,
  coalesce(sum(current_outstanding) filter (where needs_credit_term and current_outstanding > 0), 0) as unjudgeable_amount,
  count(*) filter (where needs_credit_term)                       as unjudgeable_parties,
  coalesce(sum(current_outstanding) filter (where current_outstanding > 0), 0) as total_owed,
  coalesce(sum(current_outstanding) filter (where current_outstanding < 0), 0) as total_credit,
  coalesce(sum(current_outstanding), 0)                            as net_total,
  count(*)                                                         as party_count
from v_party_ageing;

-- -------------------------------------------------------------------
-- Views run with the caller's rights, not the owner's. Without this a
-- view silently bypasses RLS on the tables beneath it — harmless while
-- every authenticated user may read everything, but it would stop being
-- harmless the moment that changes.
-- -------------------------------------------------------------------
alter view v_latest_snapshot   set (security_invoker = on);
alter view v_party_ageing      set (security_invoker = on);
alter view v_portfolio_ageing  set (security_invoker = on);

-- A dropped view loses its grants, and these are rebuilt rather than replaced
-- (a view's column list cannot be changed in place). Granting here, in the
-- migration that creates them, keeps the two in step — relying on the blanket
-- grant in 0002 would leave them unreadable, since that runs first.
grant select on v_latest_snapshot, v_party_ageing, v_portfolio_ageing to authenticated;
