-- ===================================================================
-- SQL tests for build order step 3 — v_party_ageing and fn_priority_list.
--
-- Run against a database with all migrations applied:
--   psql -d neomed -v ON_ERROR_STOP=1 -f supabase/tests/ageing_priority_test.sql
--
-- Every fixture date is expressed relative to current_date, so the expected
-- buckets are the same whenever the suite is run.
-- ===================================================================

begin;

-- Assertions return a void row each; only the report at the end is wanted.
\o /dev/null
\set QUIET on

create temp table test_results (
  id     serial primary key,
  label  text not null,
  passed boolean not null,
  detail text
) on commit drop;

create or replace function pg_temp.check_that(p_label text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into test_results (label, passed, detail)
  values (p_label, coalesce(p_cond, false), p_detail);
end;
$$;

-- NULL-safe equality for numerics.
create or replace function pg_temp.check_eq(p_label text, p_actual numeric, p_expected numeric)
returns void language plpgsql as $$
begin
  insert into test_results (label, passed, detail)
  values (
    p_label,
    p_actual is not distinct from p_expected,
    format('expected %s, got %s', coalesce(p_expected::text, 'NULL'), coalesce(p_actual::text, 'NULL'))
  );
end;
$$;

-- ===================================================================
-- fn_expected_due_date
-- ===================================================================

select pg_temp.check_that(
  'days model: bill + 30 days',
  fn_expected_due_date('2026-08-03', 'days', 30, null, null, 0) = '2026-09-02');

select pg_temp.check_that(
  'cycle: 3 Aug makes the August window, due 25 Sep',
  fn_expected_due_date('2026-08-03', 'cycle', null, 5, 25, 1) = '2026-09-25');

select pg_temp.check_that(
  'cycle: 8 Aug missed it, rides September, due 25 Oct',
  fn_expected_due_date('2026-08-08', 'cycle', null, 5, 25, 1) = '2026-10-25');

select pg_temp.check_that(
  'cycle: the 78-day wait is normal, not lateness',
  fn_expected_due_date('2026-08-08', 'cycle', null, 5, 25, 1) - '2026-08-08'::date = 78);

select pg_temp.check_that(
  'cycle: lag 0 pays in the same month',
  fn_expected_due_date('2026-08-03', 'cycle', null, 5, 25, 0) = '2026-08-25');

select pg_temp.check_that(
  'cycle: pay day 31 clamps to the last day of a 30-day month',
  fn_expected_due_date('2026-09-02', 'cycle', null, 5, 31, 0) = '2026-09-30');

select pg_temp.check_that(
  'cycle: pay day 31 clamps to 28 in a non-leap February',
  fn_expected_due_date('2026-02-02', 'cycle', null, 5, 31, 0) = '2026-02-28');

select pg_temp.check_that(
  'none: never infers a due date (rule 1)',
  fn_expected_due_date('2026-08-03', 'none', null, null, null, 0) is null);

select pg_temp.check_that(
  'a bill with no date has no due date',
  fn_expected_due_date(null, 'days', 30, null, null, 0) is null);

-- ===================================================================
-- Fixture
-- ===================================================================

insert into snapshots (id, report_date, file_name, party_count, bill_count,
                       total_owed, total_credit, net_total)
values ('11111111-1111-1111-1111-111111111111', current_date, 'test.xls',
        9, 0, 0, 0, 0);

insert into parties (id, display_name, normalised_name, category, credit_type,
                     credit_days, credit_source, status, current_outstanding,
                     oldest_bill_age_days)
values
  ('a0000000-0000-0000-0000-000000000001', 'Approved Days Ltd', 'APPROVED DAYS LTD',
   'retailer', 'days', 30, 'approved', 'active', 100000, 130),
  ('a0000000-0000-0000-0000-000000000004', 'Claim Blocked Hospital', 'CLAIM BLOCKED HOSPITAL',
   'hospital', 'days', 30, 'approved', 'active', 1000000, 200),
  ('a0000000-0000-0000-0000-000000000005', 'Disputed Hospital', 'DISPUTED HOSPITAL',
   'hospital', 'days', 30, 'approved', 'dispute', 900000, 200),
  ('a0000000-0000-0000-0000-000000000006', 'Small Chemist', 'SMALL CHEMIST',
   'retailer', 'days', 30, 'approved', 'active', 5000, 200),
  ('a0000000-0000-0000-0000-000000000007', 'Credit Balance Medicals', 'CREDIT BALANCE MEDICALS',
   'retailer', 'days', 30, 'approved', 'active', -20000, 40),
  ('a0000000-0000-0000-0000-000000000008', 'Mismatch Party', 'MISMATCH PARTY',
   'hospital', 'days', 30, 'approved', 'active', 3123000, 400),
  ('a0000000-0000-0000-0000-000000000009', 'Zero Balance Clinic', 'ZERO BALANCE CLINIC',
   'retailer', 'days', 30, 'approved', 'active', 0, 10);

-- No recorded term: credit_type and credit_source must agree.
insert into parties (id, display_name, normalised_name, category, credit_type,
                     credit_source, status, current_outstanding, oldest_bill_age_days)
values ('a0000000-0000-0000-0000-000000000002', 'No Term Hospital', 'NO TERM HOSPITAL',
        'hospital', 'none', 'not_set', 'active', 500000, 268);

-- Category default: a working assumption, never an approved term.
insert into parties (id, display_name, normalised_name, category, credit_type,
                     cycle_submit_day, cycle_pay_day, cycle_lag_months,
                     credit_source, status, current_outstanding, oldest_bill_age_days)
values ('a0000000-0000-0000-0000-000000000003', 'Assumed Cycle Hospital', 'ASSUMED CYCLE HOSPITAL',
        'hospital', 'cycle', 5, 25, 1, 'category_default', 'active', 800000, 300);

-- Approved Days Ltd: one bill per bucket, summing exactly to the header total
-- so the reconcile ratio is 1 and the buckets are directly assertable.
insert into bills (snapshot_id, party_id, bill_no, bill_type, bill_date, bill_amount, received, balance, bill_age_days)
values
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001',
   'CRE1', 'CRE', current_date - 20,  40000, 0, 40000, 20),   -- due +10  -> within terms
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001',
   'CRE2', 'CRE', current_date - 45,  30000, 0, 30000, 45),   -- overdue 15 -> 1-30
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001',
   'CRE3', 'CRE', current_date - 80,  20000, 0, 20000, 80),   -- overdue 50 -> 31-60
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001',
   'CRE4', 'CRE', current_date - 130, 10000, 0, 10000, 130);  -- overdue 100 -> 60+

-- No Term Hospital: bills exist and are old, but no term means no judgement.
insert into bills (snapshot_id, party_id, bill_no, bill_type, bill_date, bill_amount, received, balance, bill_age_days)
values
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002',
   'CRE10', 'CRE', current_date - 268, 500000, 0, 500000, 268);

insert into bills (snapshot_id, party_id, bill_no, bill_type, bill_date, bill_amount, received, balance, bill_age_days)
values
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003',
   'CRE20', 'CRE', current_date - 300, 800000, 0, 800000, 300),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000004',
   'CRE30', 'CRE', current_date - 200, 1000000, 0, 1000000, 200),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000005',
   'CRE40', 'CRE', current_date - 200, 900000, 0, 900000, 200),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000006',
   'CRE50', 'CRE', current_date - 200, 5000, 0, 5000, 200),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000007',
   'CN60', 'CN', current_date - 40, -20000, 0, -20000, 40);

-- The worst real mismatch: bill balances overshoot the header by 2,163,000.
insert into bills (snapshot_id, party_id, bill_no, bill_type, bill_date, bill_amount, received, balance, bill_age_days)
values
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000008',
   'CRE70', 'CRE', current_date - 400, 3286000, 0, 3286000, 400),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000008',
   'CRE71', 'CRE', current_date - 380, 2000000, 0, 2000000, 380);

insert into claims (party_id, claim_type, claim_value, payment_held, pending_with, status)
values ('a0000000-0000-0000-0000-000000000004', 'expiry', 250000, 250000, 'Returns desk', 'open');

-- ===================================================================
-- v_party_ageing
-- ===================================================================

select pg_temp.check_eq('within_terms bucket',
  (select within_terms from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000001'), 40000);
select pg_temp.check_eq('1-30 over bucket',
  (select over_1_30 from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000001'), 30000);
select pg_temp.check_eq('31-60 over bucket',
  (select over_31_60 from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000001'), 20000);
select pg_temp.check_eq('60+ over bucket',
  (select over_60 from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000001'), 10000);

select pg_temp.check_that(
  'buckets are measured against overdue days, not bill age',
  -- The 45-day-old bill is only 15 days past a 30-day term, so it belongs in
  -- 1-30. Bucketing by bill age would have put it in 31-60.
  (select over_1_30 from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000001') = 30000);

-- THE STOP RULE
select pg_temp.check_that(
  'no term: all four buckets are NULL, not zero',
  (select within_terms is null and over_1_30 is null and over_31_60 is null and over_60 is null
   from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000002'));

select pg_temp.check_that(
  'no term: needs_credit_term is flagged',
  (select needs_credit_term from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000002'));

select pg_temp.check_that(
  'no term: a 268-day-old bill still does not become an overdue figure',
  (select max_overdue_days is null from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000002'));

-- RULE 2
select pg_temp.check_that(
  'category default is flagged as an assumption',
  (select term_is_assumed and not needs_credit_term
   from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000003'));

select pg_temp.check_that(
  'approved term is not flagged as an assumption',
  (select not term_is_assumed from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000001'));

-- RULE 3 — scaling back onto the Marg header total
select pg_temp.check_eq(
  'mismatch party: buckets sum to the header total, not the bill total',
  (select round(coalesce(within_terms,0) + coalesce(over_1_30,0)
              + coalesce(over_31_60,0) + coalesce(over_60,0), 2)
   from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000008'),
  3123000);

select pg_temp.check_eq(
  'mismatch party: the raw bill sum is preserved for reporting',
  (select bill_balance_sum from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000008'),
  5286000);

select pg_temp.check_that(
  'mismatch party: buckets do NOT sum to the bill total',
  (select round(coalesce(over_60,0), 2) <> 5286000
   from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000008'));

-- RULE 6
select pg_temp.check_that(
  'credit balance is flagged and never counted as debt',
  (select is_credit_balance from v_party_ageing where party_id = 'a0000000-0000-0000-0000-000000000007'));

select pg_temp.check_eq(
  'portfolio total_owed counts positive balances only',
  (select total_owed from v_portfolio_ageing),
  100000 + 1000000 + 900000 + 5000 + 3123000 + 500000 + 800000);

select pg_temp.check_eq(
  'portfolio total_credit is the negative balances',
  (select total_credit from v_portfolio_ageing), -20000);

select pg_temp.check_eq(
  'portfolio strip excludes money it cannot judge',
  (select unjudgeable_amount from v_portfolio_ageing), 500000);

select pg_temp.check_eq(
  'portfolio strip counts the parties it cannot judge',
  (select unjudgeable_parties from v_portfolio_ageing), 1);

-- ===================================================================
-- fn_priority_list
-- ===================================================================

select pg_temp.check_that(
  'excludes a party blocked by our own open claim',
  not exists (select 1 from fn_priority_list(50)
              where party_id = 'a0000000-0000-0000-0000-000000000004'));

select pg_temp.check_that(
  'excludes a disputed party',
  not exists (select 1 from fn_priority_list(50)
              where party_id = 'a0000000-0000-0000-0000-000000000005'));

select pg_temp.check_that(
  'excludes a party with no recorded term',
  not exists (select 1 from fn_priority_list(50)
              where party_id = 'a0000000-0000-0000-0000-000000000002'));

select pg_temp.check_that(
  'excludes a balance below the small-balance threshold',
  not exists (select 1 from fn_priority_list(50)
              where party_id = 'a0000000-0000-0000-0000-000000000006'));

select pg_temp.check_that(
  'excludes a credit balance',
  not exists (select 1 from fn_priority_list(50)
              where party_id = 'a0000000-0000-0000-0000-000000000007'));

select pg_temp.check_that(
  'excludes a zero balance',
  not exists (select 1 from fn_priority_list(50)
              where party_id = 'a0000000-0000-0000-0000-000000000009'));

select pg_temp.check_that(
  'includes the ordinary approved-term party',
  exists (select 1 from fn_priority_list(50)
          where party_id = 'a0000000-0000-0000-0000-000000000001'));

select pg_temp.check_that(
  'ranks the larger, older exposure first',
  (select party_id from fn_priority_list(50) order by rank limit 1)
    = 'a0000000-0000-0000-0000-000000000008');

select pg_temp.check_that(
  'honours the limit argument',
  (select count(*) from fn_priority_list(1)) = 1);

select pg_temp.check_that(
  'reason quotes this party''s own figures in Indian format',
  (select reason like '%₹31.23 L%' and reason like '%Oldest bill 400 days%'
   from fn_priority_list(50) where party_id = 'a0000000-0000-0000-0000-000000000008'));

select pg_temp.check_that(
  'reason says so when the term is only a category default (rule 2)',
  (select reason like '%category default%'
   from fn_priority_list(50) where party_id = 'a0000000-0000-0000-0000-000000000003'));

select pg_temp.check_that(
  'reason does not carry that warning for an approved term',
  (select reason not like '%category default%'
   from fn_priority_list(50) where party_id = 'a0000000-0000-0000-0000-000000000001'));

select pg_temp.check_that(
  'unrated behaviour is stated, not guessed',
  (select reliability = 'unknown' and reason like '%unrated%'
   from fn_priority_list(50) where party_id = 'a0000000-0000-0000-0000-000000000001'));

-- ===================================================================
-- fn_needs_credit_term — the credit master queue
-- ===================================================================

select pg_temp.check_that(
  'lists the party blocking classification',
  exists (select 1 from fn_needs_credit_term(100)
          where party_id = 'a0000000-0000-0000-0000-000000000002'));

select pg_temp.check_that(
  'does not list parties that already have a term',
  not exists (select 1 from fn_needs_credit_term(100)
              where party_id = 'a0000000-0000-0000-0000-000000000001'));

-- ===================================================================
-- Rule 4 — imported rows are immutable
-- ===================================================================

do $$
declare ok boolean := false;
begin
  begin
    update bills set balance = 1 where bill_no = 'CRE1';
  exception when others then
    ok := true;
  end;
  perform pg_temp.check_that('bills reject UPDATE (rule 4)', ok);
end $$;

do $$
declare ok boolean := false;
begin
  begin
    update snapshots set net_total = 1 where id = '11111111-1111-1111-1111-111111111111';
  exception when others then
    ok := true;
  end;
  perform pg_temp.check_that('snapshots reject UPDATE (rule 4)', ok);
end $$;

-- ===================================================================
-- Credit-model coherence — a half-filled term can never look whole
-- ===================================================================

do $$
declare ok boolean := false;
begin
  begin
    insert into parties (display_name, normalised_name, credit_type, credit_source)
    values ('Half Filled', 'HALF FILLED', 'days', 'approved');  -- credit_days missing
  exception when others then
    ok := true;
  end;
  perform pg_temp.check_that('days model without credit_days is rejected', ok);
end $$;

do $$
declare ok boolean := false;
begin
  begin
    insert into parties (display_name, normalised_name, credit_type, cycle_submit_day, credit_source)
    values ('Half Cycle', 'HALF CYCLE', 'cycle', 5, 'approved');  -- cycle_pay_day missing
  exception when others then
    ok := true;
  end;
  perform pg_temp.check_that('cycle model without a pay day is rejected', ok);
end $$;

do $$
declare ok boolean := false;
begin
  begin
    insert into parties (display_name, normalised_name, credit_type, credit_days, credit_source)
    values ('Drifted', 'DRIFTED', 'none', null, 'approved');  -- 'none' must mean 'not_set'
  exception when others then
    ok := true;
  end;
  perform pg_temp.check_that('credit_type none cannot claim an approved source (rule 1)', ok);
end $$;

do $$
declare ok boolean := false;
begin
  begin
    insert into promises (party_id, due_date, promised_amount, status)
    values ('a0000000-0000-0000-0000-000000000001', current_date, 1000, 'kept');
  exception when others then
    ok := true;
  end;
  perform pg_temp.check_that('a promise cannot be marked kept without evidence (rule 5)', ok);
end $$;

-- ===================================================================
-- Report
-- ===================================================================

\o
\echo ''
\echo '--- failures ---'
select label, detail from test_results where not passed order by id;

\echo ''
select
  count(*) filter (where passed)     as passed,
  count(*) filter (where not passed) as failed,
  count(*)                           as total
from test_results;

do $$
declare n integer;
begin
  select count(*) into n from test_results where not passed;
  if n > 0 then
    raise exception '% SQL test(s) failed', n;
  end if;
end $$;

rollback;
