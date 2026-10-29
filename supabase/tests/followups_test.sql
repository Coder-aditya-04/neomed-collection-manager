-- ===================================================================
-- SQL tests for the follow-up thread rules (migration 0012).
--
--   psql -d neomed -v ON_ERROR_STOP=1 -f supabase/tests/followups_test.sql
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

insert into snapshots (id, report_date, file_name)
values ('c1111111-1111-1111-1111-111111111111', current_date, 's.xls');

insert into parties (id, display_name, normalised_name, current_outstanding, credit_type, credit_days, credit_source)
values ('d1111111-1111-1111-1111-111111111111', 'Impulse', 'IMPULSE', 100000, 'days', 60, 'approved'),
       ('d2222222-2222-2222-2222-222222222222', 'Chetna Enterprises',  'CHETNA ENTERPRISES',  50000, 'days', 30, 'approved'),
       ('d3333333-3333-3333-3333-333333333333', 'Chetana Enterprises', 'CHETANA ENTERPRISES', 50000, 'days', 30, 'approved');

-- ---------- who did it ----------
set local request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';

insert into followups (party_id, method, outcome, next_followup_date)
values ('d1111111-1111-1111-1111-111111111111', 'call', 'Said call after 5 days', current_date + 5);

select pg_temp.check_that(
  'by_user is stamped from the session when the caller leaves it null',
  (select by_user from followups limit 1) = 'a2222222-2222-2222-2222-222222222222');

-- ---------- one live thread per party ----------
insert into followups (party_id, method, outcome)
values ('d1111111-1111-1111-1111-111111111111', 'remark', 'Rang again, accountant on leave');

select pg_temp.check_that(
  'a remark leaves exactly one open follow-up for the party',
  (select count(*) from followups where party_id = 'd1111111-1111-1111-1111-111111111111' and not closed) = 1);

select pg_temp.check_that(
  'the earlier entry is closed with a reason that says it was superseded',
  (select close_reason from followups where method = 'call') like 'Superseded by remark on %');

select pg_temp.check_that(
  'the remark inherits the planned date it was not given',
  (select next_followup_date from followups where method = 'remark') = current_date + 5);

select pg_temp.check_that(
  'nothing is deleted — both entries remain in the log',
  (select count(*) from followups where party_id = 'd1111111-1111-1111-1111-111111111111') = 2);

-- a new date on a later contact replaces the inherited one
insert into followups (party_id, method, outcome, next_followup_date)
values ('d1111111-1111-1111-1111-111111111111', 'whatsapp', 'Sent statement', current_date + 9);

select pg_temp.check_that(
  'a contact with its own date keeps that date',
  (select next_followup_date from followups where party_id = 'd1111111-1111-1111-1111-111111111111' and not closed) = current_date + 9);

-- ---------- a close still needs a reason ----------
do $$
begin
  update followups set closed = true where not closed;
  insert into test_results (label, passed) values ('closing without a reason is refused', false);
exception when check_violation then
  insert into test_results (label, passed) values ('closing without a reason is refused', true);
end $$;

-- ---------- only the team can read ----------
select pg_temp.check_that('a team member passes is_authenticated', is_authenticated());
set local request.jwt.claim.sub = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
select pg_temp.check_that('a session that is not on the team does not', not is_authenticated());
set local request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';

-- ---------- audit ----------
update parties set status = 'legal_notice_sent' where id = 'd1111111-1111-1111-1111-111111111111';
select pg_temp.check_that(
  'a status change is logged with who made it',
  exists (select 1 from audit_log where entity_id = 'd1111111-1111-1111-1111-111111111111'
            and by_user = 'a1111111-1111-1111-1111-111111111111'
            and detail->'status'->>'to' = 'legal_notice_sent'));

-- ---------- fuzzy duplicates ----------
select pg_temp.check_that(
  'CHETNA and CHETANA are offered as a possible duplicate pair',
  exists (select 1 from fn_possible_duplicates(20)
           where (a_name, b_name) in (('Chetna Enterprises', 'Chetana Enterprises'), ('Chetana Enterprises', 'Chetna Enterprises'))));

-- ---------- merge keeps the thread and logs itself ----------
select fn_merge_parties('d3333333-3333-3333-3333-333333333333', 'd2222222-2222-2222-2222-222222222222');
select pg_temp.check_that(
  'a merge is written to the audit log',
  exists (select 1 from audit_log where action = 'merged' and entity_id = 'd2222222-2222-2222-2222-222222222222'));

-- ---------- report ----------
\o
\set QUIET off
select label, detail from test_results where not passed;
\echo
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed, count(*) as total from test_results;
do $$
begin
  if exists (select 1 from test_results where not passed) then
    raise exception 'followups tests failed';
  end if;
end $$;

rollback;
