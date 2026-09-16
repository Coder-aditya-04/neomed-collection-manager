-- ===================================================================
-- RLS tests.
--
--   psql -d neomed -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
--
-- Note the two distinct failure shapes: a USING clause that rejects a row
-- makes the statement affect zero rows silently, while a WITH CHECK that
-- rejects one raises. Both are asserted below, because only checking for a
-- raised error would let every blocked UPDATE pass unnoticed.
-- ===================================================================

begin;

\o /dev/null
\set QUIET on

create temp table test_results (
  id serial primary key, label text not null, passed boolean not null, detail text
) on commit drop;

create or replace function pg_temp.record(p_label text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into test_results (label, passed, detail) values (p_label, coalesce(p_cond, false), p_detail);
end;
$$;

-- ---------- fixture ----------
insert into auth.users (id, email) values
  ('b0000000-0000-0000-0000-00000000000a', 'owner@neomed.in'),
  ('b0000000-0000-0000-0000-00000000000b', 'accounts@neomed.in'),
  ('b0000000-0000-0000-0000-00000000000c', 'sales@neomed.in');

insert into app_users (id, full_name, role) values
  ('b0000000-0000-0000-0000-00000000000a', 'R. Salunkhe', 'owner'),
  ('b0000000-0000-0000-0000-00000000000b', 'A. Deshmukh', 'accounts'),
  ('b0000000-0000-0000-0000-00000000000c', 'S. Pawar',    'sales');

insert into parties (id, display_name, normalised_name, category, current_outstanding)
values ('c0000000-0000-0000-0000-000000000001', 'Test Hospital', 'TEST HOSPITAL', 'hospital', 500000);

insert into snapshots (id, report_date, file_name)
values ('d0000000-0000-0000-0000-000000000001', current_date, 'rls.xls');

-- ---------- helpers ----------

-- Runs `p_sql` as `p_user` and reports how it failed, if it did.
-- Returns 'ok' | 'blocked_silently' (RLS USING) | 'error:<msg>' (WITH CHECK
-- or a missing privilege).
create or replace function pg_temp.as_user(p_user uuid, p_sql text)
returns text language plpgsql as $$
declare
  affected integer;
  result   text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  begin
    execute p_sql;
    get diagnostics affected = row_count;
    result := case when affected = 0 then 'blocked_silently' else 'ok' end;
  exception when others then
    result := 'error:' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

-- ===================================================================
-- Reads — everyone authenticated sees everything
-- ===================================================================

select pg_temp.record('sales can read parties',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'select 1 from parties limit 1') = 'ok');

select pg_temp.record('sales can read bills',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'select 1 from bills limit 1') in ('ok', 'blocked_silently'));

select pg_temp.record('sales can read the ageing view',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'select 1 from v_party_ageing limit 1') in ('ok', 'blocked_silently'));

-- ===================================================================
-- Credit terms — the rule 1 boundary. Sales must not be able to set one.
-- ===================================================================

select pg_temp.record('sales CANNOT write a credit term',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'update parties set credit_type = ''days'', credit_days = 30, credit_source = ''approved''
       where id = ''c0000000-0000-0000-0000-000000000001''') <> 'ok');

select pg_temp.record('accounts CAN write a credit term',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
    'update parties set credit_type = ''days'', credit_days = 30, credit_source = ''approved''
       where id = ''c0000000-0000-0000-0000-000000000001''') = 'ok');

select pg_temp.record('owner CAN write a credit term',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000a',
    'update parties set credit_days = 45 where id = ''c0000000-0000-0000-0000-000000000001''') = 'ok');

select pg_temp.record('sales CANNOT create a party',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'insert into parties (display_name, normalised_name) values (''Sneaky'', ''SNEAKY'')') <> 'ok');

-- ===================================================================
-- Claims — owner and accounts only
-- ===================================================================

select pg_temp.record('sales CANNOT raise a claim',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'insert into claims (party_id, claim_type, claim_value)
       values (''c0000000-0000-0000-0000-000000000001'', ''expiry'', 1000)') <> 'ok');

select pg_temp.record('accounts CAN raise a claim',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
    'insert into claims (party_id, claim_type, claim_value)
       values (''c0000000-0000-0000-0000-000000000001'', ''expiry'', 1000)') = 'ok');

-- ===================================================================
-- Follow-ups and promises — sales' own ground
-- ===================================================================

select pg_temp.record('sales CAN log a follow-up',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'insert into followups (party_id, method, outcome)
       values (''c0000000-0000-0000-0000-000000000001'', ''call'', ''Promised Friday'')') = 'ok');

select pg_temp.record('sales CAN record a promise',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'insert into promises (party_id, due_date, promised_amount)
       values (''c0000000-0000-0000-0000-000000000001'', current_date + 7, 50000)') = 'ok');

-- ===================================================================
-- Imported rows — insert-only, and only for owner/accounts
-- ===================================================================

select pg_temp.record('sales CANNOT insert a snapshot',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'insert into snapshots (report_date, file_name) values (current_date + 1, ''x.xls'')') <> 'ok');

select pg_temp.record('accounts CAN insert a snapshot',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
    'insert into snapshots (report_date, file_name) values (current_date + 2, ''y.xls'')') = 'ok');

select pg_temp.record('accounts CAN insert bills',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
    'insert into bills (snapshot_id, party_id, bill_no, bill_date, balance)
       values (''d0000000-0000-0000-0000-000000000001'', ''c0000000-0000-0000-0000-000000000001'',
               ''CRE900'', current_date - 10, 1000)') = 'ok');

-- No role is granted UPDATE or DELETE on bills, so these fail on privileges
-- before RLS is even consulted.
select pg_temp.record('accounts CANNOT update a bill (rule 4)',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
    'update bills set balance = 0 where bill_no = ''CRE900''') <> 'ok');

select pg_temp.record('owner CANNOT update a bill (rule 4)',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000a',
    'update bills set balance = 0 where bill_no = ''CRE900''') <> 'ok');

select pg_temp.record('owner CANNOT delete a bill (rule 4)',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000a',
    'delete from bills where bill_no = ''CRE900''') <> 'ok');

select pg_temp.record('owner CANNOT update a snapshot (rule 4)',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000a',
    'update snapshots set net_total = 1 where id = ''d0000000-0000-0000-0000-000000000001''') <> 'ok');

-- ===================================================================
-- Derived tables are never hand-edited
-- ===================================================================

select pg_temp.record('owner CANNOT hand-edit a party profile',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000a',
    'insert into party_profiles (party_id, reliability)
       values (''c0000000-0000-0000-0000-000000000001'', ''good'')') <> 'ok');

select pg_temp.record('accounts CANNOT invent a payment event',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
    'insert into bill_changes (party_id, bill_no, delta, change_type)
       values (''c0000000-0000-0000-0000-000000000001'', ''CRE900'', 500, ''payment'')') <> 'ok');

-- ===================================================================
-- Settings — owner only
-- ===================================================================

select pg_temp.record('accounts CANNOT change a threshold',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
    'update settings set value = ''50000''::jsonb where key = ''small_balance_threshold''') <> 'ok');

select pg_temp.record('owner CAN change a threshold',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000a',
    'update settings set value = ''50000''::jsonb where key = ''small_balance_threshold''') = 'ok');

select pg_temp.record('sales CANNOT promote themselves',
  pg_temp.as_user('b0000000-0000-0000-0000-00000000000c',
    'update app_users set role = ''owner'' where id = ''b0000000-0000-0000-0000-00000000000c''') <> 'ok');

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
  if n > 0 then raise exception '% RLS test(s) failed', n; end if;
end $$;

rollback;
