-- ===================================================================
-- Snapshot diffing and behaviour profiles. Build order step 8.
--
-- This is where the product stops describing today and starts knowing
-- how a party actually behaves. Marg holds no payment history, so the
-- history is DERIVED by comparing consecutive snapshots: a balance that
-- fell is money that arrived.
-- ===================================================================

-- bill_changes must survive the retention job, which prunes old snapshots.
-- Once the source snapshot is gone the bill row goes with it, so the bill's
-- own date has to live on the change record or every profile silently loses
-- its history.
alter table bill_changes add column if not exists bill_date date;

-- -------------------------------------------------------------------
-- fn_diff_snapshots — what moved between two snapshots.
--
-- Idempotent: re-running over the same pair changes nothing, which matters
-- because the import path and the nightly job can both reach for it.
-- -------------------------------------------------------------------
create or replace function fn_diff_snapshots(p_from uuid, p_to uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_from_date date;
  v_to_date   date;
  v_inserted  integer;
begin
  select report_date into v_from_date from snapshots where id = p_from;
  select report_date into v_to_date   from snapshots where id = p_to;

  if v_from_date is null or v_to_date is null then
    raise exception 'fn_diff_snapshots: snapshot not found (from=%, to=%)', p_from, p_to;
  end if;
  if v_from_date >= v_to_date then
    raise exception 'fn_diff_snapshots: % is not earlier than %', v_from_date, v_to_date;
  end if;

  with a as (
    select party_id, bill_no, balance, bill_date
    from bills where snapshot_id = p_from
  ),
  b as (
    select party_id, bill_no, balance, bill_date
    from bills where snapshot_id = p_to
  ),
  joined as (
    select
      coalesce(a.party_id, b.party_id) as party_id,
      coalesce(a.bill_no,  b.bill_no)  as bill_no,
      coalesce(a.bill_date, b.bill_date) as bill_date,
      a.balance as from_balance,
      b.balance as to_balance
    from a
    full outer join b
      on a.party_id = b.party_id and a.bill_no = b.bill_no
  ),
  classified as (
    select
      party_id, bill_no, bill_date, from_balance, to_balance,
      case
        -- Gone from the newer file: paid off and dropped by Marg.
        when to_balance is null   then 'settled'
        -- Absent from the older file: newly billed.
        when from_balance is null then 'new_bill'
        when to_balance < from_balance then 'payment'
        when to_balance > from_balance then 'increase'
        else null                      -- unchanged; not an event
      end as change_type,
      case
        when to_balance is null   then from_balance          -- whole balance cleared
        when from_balance is null then to_balance            -- whole balance added
        else to_balance - from_balance
      end as delta
    from joined
  )
  insert into bill_changes (
    party_id, bill_no, bill_date, from_snapshot_id, to_snapshot_id,
    from_balance, to_balance, delta, change_type, detected_from, detected_to
  )
  select
    party_id, bill_no, bill_date, p_from, p_to,
    from_balance, to_balance,
    -- A payment is stored as a positive amount of money received.
    case when change_type in ('payment', 'settled') then abs(delta) else delta end,
    change_type, v_from_date, v_to_date
  from classified
  where change_type is not null
  on conflict (party_id, bill_no, from_snapshot_id, to_snapshot_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function fn_diff_snapshots is
  'Derives payment events between two snapshots. Idempotent. Payments and '
  'settlements are stored as positive amounts received.';

-- -------------------------------------------------------------------
-- fn_diff_latest — diff the two most recent snapshots. What the import
-- path calls once a new file lands.
-- -------------------------------------------------------------------
create or replace function fn_diff_latest()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_to uuid;
  v_from uuid;
begin
  select id into v_to from snapshots order by report_date desc limit 1;
  select id into v_from from snapshots order by report_date desc offset 1 limit 1;
  if v_from is null or v_to is null then
    return 0;  -- need two snapshots before anything can be compared
  end if;
  return fn_diff_snapshots(v_from, v_to);
end;
$$;

-- -------------------------------------------------------------------
-- fn_compute_profiles — how each party actually pays.
--
-- Everything here comes from bill_changes, never from a person's opinion.
-- A party stays 'unknown' with NULL days until at least three of its bills
-- have been settled: two data points is an anecdote, not a pattern.
-- -------------------------------------------------------------------
create or replace function fn_compute_profiles()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count integer;
begin
  with settled as (
    -- A bill is settled when it disappears, or when its balance reaches nil.
    select
      bc.party_id,
      bc.bill_no,
      bc.bill_date,
      bc.detected_to as settled_on,
      bc.detected_to - bc.bill_date as days_to_settle
    from bill_changes bc
    where bc.change_type = 'settled'
      and bc.bill_date is not null
  ),
  instalments as (
    -- Money-movement events per finished bill. The final clearing shows up as
    -- 'settled', not 'payment', so counting payments alone would read a bill
    -- that was part-paid and then cleared as a single instalment.
    -- Only bills that actually finished are counted, since a bill still being
    -- paid down cannot yet be called partial or not.
    select bc.party_id, bc.bill_no, count(*) as payment_events
    from bill_changes bc
    where bc.change_type in ('payment', 'settled')
      and exists (
        select 1 from bill_changes s
        where s.party_id = bc.party_id and s.bill_no = bc.bill_no and s.change_type = 'settled'
      )
    group by bc.party_id, bc.bill_no
  ),
  last_payment as (
    select distinct on (party_id)
      party_id, detected_to as paid_on, delta as amount
    from bill_changes
    where change_type in ('payment', 'settled')
    order by party_id, detected_to desc, delta desc
  ),
  recent as (
    select party_id, sum(delta) as received_90d
    from bill_changes
    where change_type in ('payment', 'settled')
      and detected_to >= current_date - 90
    group by party_id
  ),
  agg as (
    select
      s.party_id,
      count(*)                                                   as settled_bill_count,
      percentile_cont(0.5) within group (order by s.days_to_settle) as median_days,
      stddev_samp(s.days_to_settle)                              as consistency
    from settled s
    group by s.party_id
  ),
  partials as (
    select
      party_id,
      count(*) filter (where payment_events > 1)::numeric
        / nullif(count(*), 0) as partial_rate
    from instalments
    group by party_id
  ),
  final as (
    select
      p.id as party_id,
      coalesce(a.settled_bill_count, 0) as settled_bill_count,
      case when coalesce(a.settled_bill_count, 0) >= 3
           then round(a.median_days)::integer end as actual_payment_days,
      case when coalesce(a.settled_bill_count, 0) >= 3
           then round(a.consistency, 2) end as payment_consistency,
      coalesce(round(pt.partial_rate, 4), 0) as partial_payment_rate,
      lp.paid_on  as last_payment_date,
      lp.amount   as last_payment_amount,
      coalesce(r.received_90d, 0) as trend_90d,
      -- The expected term this party is being measured against. A party with
      -- no recorded term can still be rated, because the rating is about
      -- consistency rather than lateness.
      case
        when p.credit_type = 'days' then p.credit_days
        when p.credit_type = 'cycle' then 45   -- a cycle's typical wait
        else null
      end as expected_days,
      a.median_days,
      a.consistency
    from parties p
    left join agg a       on a.party_id = p.id
    left join partials pt on pt.party_id = p.id
    left join last_payment lp on lp.party_id = p.id
    left join recent r    on r.party_id = p.id
  )
  insert into party_profiles (
    party_id, actual_payment_days, payment_consistency, partial_payment_rate,
    settled_bill_count, reliability, last_payment_date, last_payment_amount,
    trend_90d, computed_at
  )
  select
    party_id, actual_payment_days, payment_consistency, partial_payment_rate,
    settled_bill_count,
    case
      when settled_bill_count < 3 then 'unknown'
      when expected_days is null then
        -- No term to compare against, so rate on steadiness alone.
        case when consistency <= 15 then 'good'
             when consistency <= 35 then 'fair'
             else 'poor' end
      when median_days > expected_days + 30 then 'poor'
      when median_days <= expected_days + 7 and consistency <= 20 then 'good'
      else 'fair'
    end,
    last_payment_date, last_payment_amount, trend_90d, now()
  from final
  on conflict (party_id) do update set
    actual_payment_days  = excluded.actual_payment_days,
    payment_consistency  = excluded.payment_consistency,
    partial_payment_rate = excluded.partial_payment_rate,
    settled_bill_count   = excluded.settled_bill_count,
    reliability          = excluded.reliability,
    last_payment_date    = excluded.last_payment_date,
    last_payment_amount  = excluded.last_payment_amount,
    trend_90d            = excluded.trend_90d,
    computed_at          = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function fn_compute_profiles is
  'Recomputes every party_profiles row from bill_changes. Returns unknown and '
  'NULL payment days until a party has at least three settled bills.';

-- -------------------------------------------------------------------
-- fn_what_changed — the movement between the last two snapshots, as the
-- dashboard and the assistant both want it.
-- -------------------------------------------------------------------
create or replace function fn_what_changed()
returns table (
  from_date       date,
  to_date         date,
  payments_count  integer,
  payments_value  numeric,
  settled_count   integer,
  settled_value   numeric,
  new_bill_count  integer,
  new_bill_value  numeric,
  increase_count  integer,
  increase_value  numeric,
  net_change      numeric
)
language sql
stable
as $$
  with pair as (
    select
      (select id from snapshots order by report_date desc offset 1 limit 1) as from_id,
      (select id from snapshots order by report_date desc limit 1)          as to_id
  )
  select
    min(bc.detected_from), max(bc.detected_to),
    count(*) filter (where bc.change_type = 'payment')::integer,
    coalesce(sum(bc.delta) filter (where bc.change_type = 'payment'), 0),
    count(*) filter (where bc.change_type = 'settled')::integer,
    coalesce(sum(bc.delta) filter (where bc.change_type = 'settled'), 0),
    count(*) filter (where bc.change_type = 'new_bill')::integer,
    coalesce(sum(bc.delta) filter (where bc.change_type = 'new_bill'), 0),
    count(*) filter (where bc.change_type = 'increase')::integer,
    coalesce(sum(bc.delta) filter (where bc.change_type = 'increase'), 0),
    coalesce(sum(case when bc.change_type in ('payment', 'settled') then -bc.delta else bc.delta end), 0)
  from bill_changes bc
  cross join pair
  where bc.from_snapshot_id = pair.from_id and bc.to_snapshot_id = pair.to_id;
$$;

-- -------------------------------------------------------------------
-- RULE 5 — a promise closes only when a payment supports it.
--
-- Matches open promises against money that actually arrived between the
-- promise date and a few days past its due date. Nothing here can mark a
-- promise kept by hand; the evidence is recorded alongside the status.
-- -------------------------------------------------------------------
create or replace function fn_settle_promises(p_grace_days integer default 3)
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count integer;
begin
  with evidence as (
    select
      pr.id as promise_id,
      pr.promised_amount,
      coalesce(sum(bc.delta), 0) as received,
      array_remove(array_agg(bc.id), null) as change_ids
    from promises pr
    left join bill_changes bc
      on bc.party_id = pr.party_id
     and bc.change_type in ('payment', 'settled')
     and bc.detected_to >= pr.promised_on
     and bc.detected_to <= pr.due_date + p_grace_days
    where pr.status = 'open'
    group by pr.id, pr.promised_amount
  ),
  decided as (
    select
      promise_id, received, change_ids,
      case
        when received >= promised_amount then 'kept'
        when received > 0                then 'partial'
        -- Nothing arrived and the window has closed.
        when current_date > (select due_date + p_grace_days from promises where id = promise_id)
                                         then 'broken'
        else null                        -- still open, still time
      end as new_status
    from evidence
  )
  update promises pr
  set status = d.new_status,
      received_amount = d.received,
      linked_change_ids = d.change_ids
  from decided d
  where pr.id = d.promise_id
    and d.new_status is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function fn_settle_promises is
  'Closes promises against derived payment events only (rule 5). A promise '
  'marked kept or partial always names the bill_changes that justify it.';

revoke all on function fn_diff_snapshots(uuid, uuid) from public;
revoke all on function fn_compute_profiles() from public;
revoke all on function fn_settle_promises(integer) from public;
grant execute on function fn_diff_snapshots(uuid, uuid) to authenticated;
grant execute on function fn_diff_latest() to authenticated;
grant execute on function fn_compute_profiles() to authenticated;
grant execute on function fn_settle_promises(integer) to authenticated;
grant execute on function fn_what_changed() to authenticated;
