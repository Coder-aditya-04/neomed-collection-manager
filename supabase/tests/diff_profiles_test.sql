-- ===================================================================
-- SQL tests for build order step 8 — diffing, profiles and promise
-- settlement.
--
--   psql -d neomed -v ON_ERROR_STOP=1 -f supabase/tests/diff_profiles_test.sql
-- ===================================================================

begin;

\o /dev/null
\set QUIET on

create temp table test_results (
  id serial primary key, label text not null, passed boolean not null, detail text
) on commit drop;

create or replace function pg_temp.check_that(p_label text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into test_results (label, passed, detail) values (p_label, coalesce(p_cond, false), p_detail);
end;
$$;

create or replace function pg_temp.check_eq(p_label text, p_actual numeric, p_expected numeric)
returns void language plpgsql as $$
begin
  insert into test_results (label, passed, detail)
  values (p_label, p_actual is not distinct from p_expected,
          format('expected %s, got %s', coalesce(p_expected::text,'NULL'), coalesce(p_actual::text,'NULL')));
end;
$$;

-- ---------- fixture: three snapshots a week apart ----------

insert into snapshots (id, report_date, file_name) values
  ('51111111-1111-1111-1111-111111111111', current_date - 14, 's1.xls'),
  ('52222222-2222-2222-2222-222222222222', current_date - 7,  's2.xls'),
  ('53333333-3333-3333-3333-333333333333', current_date,      's3.xls');

insert into parties (id, display_name, normalised_name, credit_type, credit_days,
                     credit_source, current_outstanding)
values
  ('b1111111-1111-1111-1111-111111111111', 'Steady Payer',  'STEADY PAYER',  'days', 30, 'approved', 10000),
  ('b2222222-2222-2222-2222-222222222222', 'Slow Payer',    'SLOW PAYER',    'days', 30, 'approved', 50000),
  ('b3333333-3333-3333-3333-333333333333', 'Thin History',  'THIN HISTORY',  'days', 30, 'approved', 20000);

-- Snapshot 1
insert into bills (snapshot_id, party_id, bill_no, bill_date, balance) values
  ('51111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111', 'A1', current_date - 44, 10000),
  ('51111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111', 'A2', current_date - 40, 20000),
  ('51111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111', 'A3', current_date - 38, 15000),
  ('51111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', 'B1', current_date - 120, 50000),
  ('51111111-1111-1111-1111-111111111111', 'b3333333-3333-3333-3333-333333333333', 'C1', current_date - 20, 20000);

-- Snapshot 2: A1 part-paid, A2 gone (settled), B1 grew, a new bill appeared.
insert into bills (snapshot_id, party_id, bill_no, bill_date, balance) values
  ('52222222-2222-2222-2222-222222222222', 'b1111111-1111-1111-1111-111111111111', 'A1', current_date - 44, 4000),
  ('52222222-2222-2222-2222-222222222222', 'b1111111-1111-1111-1111-111111111111', 'A3', current_date - 38, 15000),
  ('52222222-2222-2222-2222-222222222222', 'b1111111-1111-1111-1111-111111111111', 'A4', current_date - 10, 8000),
  ('52222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'B1', current_date - 120, 55000),
  ('52222222-2222-2222-2222-222222222222', 'b3333333-3333-3333-3333-333333333333', 'C1', current_date - 20, 20000);

-- Snapshot 3: A1 cleared, A3 cleared, B1 part-paid.
insert into bills (snapshot_id, party_id, bill_no, bill_date, balance) values
  ('53333333-3333-3333-3333-333333333333', 'b1111111-1111-1111-1111-111111111111', 'A4', current_date - 10, 8000),
  ('53333333-3333-3333-3333-333333333333', 'b2222222-2222-2222-2222-222222222222', 'B1', current_date - 120, 40000),
  ('53333333-3333-3333-3333-333333333333', 'b3333333-3333-3333-3333-333333333333', 'C1', current_date - 20, 20000);

-- ===================================================================
-- fn_diff_snapshots
-- ===================================================================

select pg_temp.check_that('first diff writes events',
  fn_diff_snapshots('51111111-1111-1111-1111-111111111111', '52222222-2222-2222-2222-222222222222') > 0);

select pg_temp.check_that('a falling balance is a payment',
  exists (select 1 from bill_changes
          where bill_no = 'A1' and change_type = 'payment' and delta = 6000));

select pg_temp.check_that('a payment is stored as money received, not as a negative',
  (select delta from bill_changes where bill_no = 'A1' and change_type = 'payment') > 0);

select pg_temp.check_that('a bill that disappears is settled for its whole balance',
  exists (select 1 from bill_changes
          where bill_no = 'A2' and change_type = 'settled' and delta = 20000));

select pg_temp.check_that('a bill absent from the older file is new',
  exists (select 1 from bill_changes where bill_no = 'A4' and change_type = 'new_bill'));

select pg_temp.check_that('a rising balance is an increase',
  exists (select 1 from bill_changes
          where bill_no = 'B1' and change_type = 'increase' and delta = 5000));

select pg_temp.check_that('an unchanged bill produces no event',
  not exists (select 1 from bill_changes where bill_no = 'C1'));

select pg_temp.check_that('the bill date is carried onto the change',
  (select bill_date from bill_changes where bill_no = 'A1' limit 1) = current_date - 44);

-- IDEMPOTENCE — the import path and the nightly job can both call this.
do $$
declare before_count integer; second_run integer; after_count integer;
begin
  select count(*) into before_count from bill_changes;
  select fn_diff_snapshots('51111111-1111-1111-1111-111111111111',
                           '52222222-2222-2222-2222-222222222222') into second_run;
  select count(*) into after_count from bill_changes;
  perform pg_temp.check_that('re-running the same diff inserts nothing', second_run = 0);
  perform pg_temp.check_that('re-running the same diff changes no rows', before_count = after_count);
end $$;

do $$
declare ok boolean := false;
begin
  begin
    perform fn_diff_snapshots('53333333-3333-3333-3333-333333333333',
                              '51111111-1111-1111-1111-111111111111');
  exception when others then ok := true;
  end;
  perform pg_temp.check_that('diffing backwards in time is refused', ok);
end $$;

select pg_temp.check_that('fn_diff_latest compares the two newest snapshots',
  fn_diff_latest() > 0);

select pg_temp.check_that('the second diff settles A1 for its remaining balance',
  exists (select 1 from bill_changes
          where bill_no = 'A1' and change_type = 'settled' and delta = 4000
            and from_snapshot_id = '52222222-2222-2222-2222-222222222222'));

-- ===================================================================
-- fn_what_changed
-- ===================================================================

select pg_temp.check_eq('what_changed counts the settlements',
  (select settled_count from fn_what_changed()), 2);      -- A1 and A3

select pg_temp.check_eq('what_changed sums the money received',
  (select settled_value + payments_value from fn_what_changed()), 4000 + 15000 + 15000);

-- ===================================================================
-- fn_compute_profiles
-- ===================================================================

select pg_temp.check_that('profiles are computed for every party',
  fn_compute_profiles() >= 3);

select pg_temp.check_that('a party with fewer than three settled bills stays unknown',
  (select reliability = 'unknown' and actual_payment_days is null
   from party_profiles where party_id = 'b3333333-3333-3333-3333-333333333333'));

select pg_temp.check_that('a party with no settled bills at all stays unknown',
  (select settled_bill_count = 0 and reliability = 'unknown'
   from party_profiles where party_id = 'b2222222-2222-2222-2222-222222222222'));

select pg_temp.check_eq('settled bills are counted',
  (select settled_bill_count from party_profiles
   where party_id = 'b1111111-1111-1111-1111-111111111111'), 3);

select pg_temp.check_that('payment days are derived once there is enough history',
  (select actual_payment_days is not null
   from party_profiles where party_id = 'b1111111-1111-1111-1111-111111111111'));

select pg_temp.check_that('a bill paid in instalments raises the partial rate',
  (select partial_payment_rate > 0
   from party_profiles where party_id = 'b1111111-1111-1111-1111-111111111111'));

select pg_temp.check_that('the last payment date is recorded',
  (select last_payment_date is not null
   from party_profiles where party_id = 'b1111111-1111-1111-1111-111111111111'));

select pg_temp.check_that('recomputing is safe to repeat',
  fn_compute_profiles() >= 3);

-- A profile is derived, never opinion: reliability must follow the figures.
select pg_temp.check_that('reliability is one of the four defined values',
  not exists (select 1 from party_profiles
              where reliability not in ('good', 'fair', 'poor', 'unknown')));

-- ===================================================================
-- fn_settle_promises — RULE 5
-- ===================================================================

insert into promises (id, party_id, promised_on, due_date, promised_amount)
values
  -- Steady Payer really did pay in the window.
  ('c1111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111',
   current_date - 10, current_date - 1, 5000),
  -- Slow Payer promised and nothing arrived.
  ('c2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222',
   current_date - 30, current_date - 20, 25000),
  -- Still inside its window.
  ('c3333333-3333-3333-3333-333333333333', 'b3333333-3333-3333-3333-333333333333',
   current_date - 2, current_date + 10, 5000);

select pg_temp.check_that('settlement runs', fn_settle_promises() >= 1);

select pg_temp.check_that('a promise backed by real payments is kept',
  (select status = 'kept' from promises where id = 'c1111111-1111-1111-1111-111111111111'));

select pg_temp.check_that('a kept promise names its evidence',
  (select coalesce(array_length(linked_change_ids, 1), 0) >= 1
   from promises where id = 'c1111111-1111-1111-1111-111111111111'));

select pg_temp.check_that('a promise with no payment and no time left is broken',
  (select status = 'broken' from promises where id = 'c2222222-2222-2222-2222-222222222222'));

select pg_temp.check_that('a promise still inside its window stays open',
  (select status = 'open' from promises where id = 'c3333333-3333-3333-3333-333333333333'));

do $$
declare ok boolean := false;
begin
  begin
    -- The constraint, not the function, is the last line of defence.
    insert into promises (party_id, due_date, promised_amount, status)
    values ('b2222222-2222-2222-2222-222222222222', current_date, 1000, 'kept');
  exception when others then ok := true;
  end;
  perform pg_temp.check_that('a promise still cannot be marked kept by hand', ok);
end $$;

-- ===================================================================
-- Profiles feed the priority ranking
-- ===================================================================

select pg_temp.check_that('priority ranking reads reliability from the profile',
  exists (select 1 from fn_priority_list(50)
          where party_id = 'b2222222-2222-2222-2222-222222222222'
            and reliability = 'unknown'));

-- ===================================================================
-- Report
-- ===================================================================

\o
\echo ''
\echo '--- failures ---'
select label, detail from test_results where not passed order by id;
\echo ''
select count(*) filter (where passed) as passed,
       count(*) filter (where not passed) as failed,
       count(*) as total
from test_results;

do $$
declare n integer;
begin
  select count(*) into n from test_results where not passed;
  if n > 0 then raise exception '% diff/profile test(s) failed', n; end if;
end $$;

rollback;
