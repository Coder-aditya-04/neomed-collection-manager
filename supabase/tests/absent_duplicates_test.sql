-- ===================================================================
-- SQL tests for migration 0013: parties absent from the latest file,
-- duplicate detection on the distinctive part of a name, dismissals.
--
--   psql -d neomed -v ON_ERROR_STOP=1 -f supabase/tests/absent_duplicates_test.sql
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

-- ---------- fixture ----------
insert into app_users (id, full_name, role) values
  ('a1111111-1111-1111-1111-111111111111', 'Nilesh',  'owner'),
  ('a2222222-2222-2222-2222-222222222222', 'Prajwal', 'sales');

insert into snapshots (id, report_date, file_name) values
  ('c1111111-1111-1111-1111-111111111111', current_date - 1, 'old.xls'),
  ('c2222222-2222-2222-2222-222222222222', current_date,     'new.xls');

insert into parties (id, display_name, normalised_name, current_outstanding, oldest_bill_age_days, last_snapshot_id) values
  ('d1111111-1111-1111-1111-111111111111', 'Dr Example Gastro Clinic, Solapur', 'DR EXAMPLE GASTRO CLINIC SOLAPUR', 456000, 26, 'c1111111-1111-1111-1111-111111111111'),
  ('d2222222-2222-2222-2222-222222222222', 'Example Healthcare Dr',            'EXAMPLE HEALTHCARE DR',            4854000, 113, 'c2222222-2222-2222-2222-222222222222'),
  ('d0000000-0000-0000-0000-000000000000', 'Riverside Institute of Medical Science & Researc', 'RIVERSIDE INSTITUTE OF MEDICAL SCIENCE & RESEARC', 632000, 280, 'c1111111-1111-1111-1111-111111111111');

-- The clinic had a bill yesterday and none today; Impulse has one today.
insert into bills (snapshot_id, party_id, bill_no, bill_date, bill_amount, balance) values
  ('c1111111-1111-1111-1111-111111111111', 'd1111111-1111-1111-1111-111111111111', 'B1', current_date - 27, 456000, 456000),
  ('c2222222-2222-2222-2222-222222222222', 'd2222222-2222-2222-2222-222222222222', 'B2', current_date - 113, 4854000, 4854000);

-- ---------- the name core ----------
select pg_temp.check_that(
  'trade words come off the name',
  fn_name_core('ALPHA MEDICAL AND GENERAL STORES') = 'ALPHA',
  fn_name_core('ALPHA MEDICAL AND GENERAL STORES'));

select pg_temp.check_that(
  'C/O is removed whole and single letters survive',
  fn_name_core('PT RAMESH PATIL C/O DR SURESH JOSHI') = 'RAMESH PATIL SURESH JOSHI'
  and fn_name_core('S K MEDICAL') = 'S K',
  fn_name_core('PT RAMESH PATIL C/O DR SURESH JOSHI') || ' | ' || fn_name_core('S K MEDICAL'));

-- ---------- absent parties ----------
set local request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
do $$
begin
  perform fn_zero_absent_parties('c2222222-2222-2222-2222-222222222222');
  perform pg_temp.check_that('recovery role is refused by fn_zero_absent_parties', false);
exception when others then
  perform pg_temp.check_that('recovery role is refused by fn_zero_absent_parties', true);
end $$;

set local request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select pg_temp.check_that(
  'an older snapshot id is a no-op',
  fn_zero_absent_parties('c1111111-1111-1111-1111-111111111111') = 0);

select pg_temp.check_that(
  'two stale parties are cleared against the latest file',
  fn_zero_absent_parties('c2222222-2222-2222-2222-222222222222') = 2);

select pg_temp.check_that(
  'the clinic that vanished from the file now reads nil',
  (select current_outstanding = 0 and oldest_bill_age_days is null
     from parties where id = 'd1111111-1111-1111-1111-111111111111'));

select pg_temp.check_that(
  'a party present in the file is untouched',
  (select current_outstanding = 4854000 and oldest_bill_age_days = 113
     from parties where id = 'd2222222-2222-2222-2222-222222222222'));

select pg_temp.check_that(
  'the clinic still records the last file it appeared in',
  (select last_snapshot_id = 'c1111111-1111-1111-1111-111111111111'
     from parties where id = 'd1111111-1111-1111-1111-111111111111'));

select pg_temp.check_that(
  'running it again changes nothing',
  fn_zero_absent_parties(null) = 0);

-- ---------- duplicates ----------
-- Inserted only now: these carry balances and no bills, and would have
-- counted as absent above.
insert into parties (id, display_name, normalised_name, current_outstanding, oldest_bill_age_days, last_snapshot_id) values
  ('d3333333-3333-3333-3333-333333333333', 'Alpha Medical and General Stores', 'ALPHA MEDICAL AND GENERAL STORES', 102000, 200, 'c2222222-2222-2222-2222-222222222222'),
  ('d4444444-4444-4444-4444-444444444444', 'Beta Medical and General Stores',   'BETA MEDICAL AND GENERAL STORES',   194, 30, 'c2222222-2222-2222-2222-222222222222'),
  ('d5555555-5555-5555-5555-555555555555', 'KRH Pharma',                          'KRH PHARMA',                          100000, 90, 'c2222222-2222-2222-2222-222222222222'),
  ('d6666666-6666-6666-6666-666666666666', 'KRH Pharma Nsk',                      'KRH PHARMA NSK',                      50000, 10, 'c2222222-2222-2222-2222-222222222222'),
  ('d7777777-7777-7777-7777-777777777777', 'Sunrise Medicals',               'SUNRISE MEDICALS',               -520, 40, 'c2222222-2222-2222-2222-222222222222'),
  ('d8888888-8888-8888-8888-888888888888', 'Sunrise Medicos',                'SUNRISE MEDICOS',                2406, 12, 'c2222222-2222-2222-2222-222222222222'),
  ('d9999999-9999-9999-9999-999999999999', 'ABC Agencies Dr',                     'ABC AGENCIES DR',                     358000, 60, 'c2222222-2222-2222-2222-222222222222'),
  ('daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'AB Agencies Dr',                      'AB AGENCIES DR',                      12092, 20, 'c2222222-2222-2222-2222-222222222222'),
  ('dbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'S K Medical',                         'S K MEDICAL',                         32006, 50, 'c2222222-2222-2222-2222-222222222222'),
  ('dccccccc-cccc-cccc-cccc-cccccccccccc', 'S J Medical',                         'S J MEDICAL',                         10414, 50, 'c2222222-2222-2222-2222-222222222222'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Chetna Enterprises',                  'CHETNA ENTERPRISES',                  50000, 30, 'c2222222-2222-2222-2222-222222222222'),
  ('deeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Chetana Enterprises',                 'CHETANA ENTERPRISES',                 50000, 30, 'c2222222-2222-2222-2222-222222222222'),
  ('dfffffff-ffff-ffff-ffff-ffffffffffff', 'Riverside Women & Children Hospital',   'RIVERSIDE WOMEN & CHILDREN HOSPITAL',   644000, 282, 'c2222222-2222-2222-2222-222222222222'),
  ('e1111111-1111-1111-1111-111111111111', 'Omkar Enterprises Dr',            'OMKAR ENTERPRISES DR',            352000, 287, 'c2222222-2222-2222-2222-222222222222'),
  ('e2222222-2222-2222-2222-222222222222', 'Omkar Enterprises Dr Satpur',     'OMKAR ENTERPRISES DR SATPUR',     1000, 20, 'c2222222-2222-2222-2222-222222222222');

create temp table offered on commit drop as
  select least(a_party_id, b_party_id) as lo, greatest(a_party_id, b_party_id) as hi, matched_on
  from fn_possible_duplicates(200);

select pg_temp.check_that(
  'ALPHA and BETA are not paired on their shared trade words',
  not exists (select 1 from offered where lo = 'd3333333-3333-3333-3333-333333333333' and hi = 'd4444444-4444-4444-4444-444444444444'));

select pg_temp.check_that(
  'ABC AGENCIES and AB AGENCIES are not paired',
  not exists (select 1 from offered where lo = 'd9999999-9999-9999-9999-999999999999' and hi = 'daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));

select pg_temp.check_that(
  'S K MEDICAL and S J MEDICAL are not paired',
  not exists (select 1 from offered where lo = 'dbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and hi = 'dccccccc-cccc-cccc-cccc-cccccccccccc'));

select pg_temp.check_that(
  'KRH PHARMA and KRH PHARMA NSK are paired as the same name (NSK is a place, not a name)',
  exists (select 1 from offered where lo = 'd5555555-5555-5555-5555-555555555555' and hi = 'd6666666-6666-6666-6666-666666666666'
            and matched_on = 'same name'));

select pg_temp.check_that(
  'OMKAR and OMKAR SATPUR are paired as one extending the other',
  exists (select 1 from offered where lo = 'e1111111-1111-1111-1111-111111111111' and hi = 'e2222222-2222-2222-2222-222222222222'
            and matched_on = 'one name extends the other'));

select pg_temp.check_that(
  'SUNRISE MEDICALS and MEDICOS are paired as the same name',
  exists (select 1 from offered where lo = 'd7777777-7777-7777-7777-777777777777' and hi = 'd8888888-8888-8888-8888-888888888888'
            and matched_on = 'same name'));

select pg_temp.check_that(
  'CHETNA and CHETANA are paired on spelling',
  exists (select 1 from offered where lo = 'dddddddd-dddd-dddd-dddd-dddddddddddd' and hi = 'deeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
            and matched_on = 'spelling'));

select pg_temp.check_that(
  'the two RIVERSIDE parties are offered so the desk can decide',
  exists (select 1 from offered where lo = 'd0000000-0000-0000-0000-000000000000' and hi = 'dfffffff-ffff-ffff-ffff-ffffffffffff'));

-- ---------- dismissal ----------
select fn_dismiss_duplicate('dfffffff-ffff-ffff-ffff-ffffffffffff', 'd0000000-0000-0000-0000-000000000000');

select pg_temp.check_that(
  'a dismissed pair is no longer offered',
  not exists (select 1 from fn_possible_duplicates(200)
               where least(a_party_id, b_party_id) = 'd0000000-0000-0000-0000-000000000000'
                 and greatest(a_party_id, b_party_id) = 'dfffffff-ffff-ffff-ffff-ffffffffffff'));

select pg_temp.check_that(
  'the dismissal records who made it',
  (select by_user from duplicate_dismissals limit 1) = 'a1111111-1111-1111-1111-111111111111');

-- ---------- report ----------
\o
\set QUIET off
select label, detail from test_results where not passed;
\echo
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed, count(*) as total from test_results;
do $$
begin
  if exists (select 1 from test_results where not passed) then
    raise exception 'absent_duplicates_test: % check(s) failed', (select count(*) from test_results where not passed);
  end if;
end $$;

rollback;
