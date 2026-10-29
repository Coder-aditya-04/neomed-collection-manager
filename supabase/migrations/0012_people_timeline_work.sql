-- ===================================================================
-- Client review, 29 October 2026.
--
-- The thread through all of it is accountability: who did what, to which
-- party, and when. That needs three things the schema did not have — a
-- stamp on every action, logins that can be created without a developer,
-- and a timeline that keeps a thread alive while recording each turn.
-- ===================================================================

create extension if not exists pg_trgm;

-- -------------------------------------------------------------------
-- 1. Only people on the team can read anything
--
-- Logins are about to be creatable from inside the app, which means the
-- project's sign-up endpoint is in use. Every read policy keyed on "is
-- there a session", which was fine while the only sessions were ones a
-- developer had made by hand. It is not fine once anyone holding the
-- public key could register: a session alone must grant nothing. Now a
-- session grants access only if the person is in app_users.
--
-- SECURITY DEFINER because this is read from the app_users policy itself,
-- and a policy that queries its own table under RLS recurses.
-- -------------------------------------------------------------------
create or replace function is_authenticated()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select auth.uid() is not null
     and exists (select 1 from app_users u where u.id = auth.uid() and u.active);
$$;

revoke all on function is_authenticated() from public;
grant execute on function is_authenticated() to authenticated, anon;

-- -------------------------------------------------------------------
-- 2. Who did it
--
-- followups.by_user existed and was never written: not one insert in the
-- application set it. So "who called whom" could not be answered, which
-- the desk noticed. Stamped here, at the database, so no caller can
-- forget again. A session that is not on the team (should never happen
-- now, see above) stamps nothing rather than violating the key.
-- -------------------------------------------------------------------
alter table followups drop constraint if exists followups_method_check;
alter table followups add constraint followups_method_check
  check (method in ('call', 'visit', 'whatsapp', 'email', 'remark'));

comment on column followups.method is
  'call / visit / whatsapp / email are contacts. remark is a note added to a '
  'thread that stays open — "rang again, said Friday" — so a party chased '
  'daily keeps one live follow-up and a full record of what was said.';

create or replace function fn_followup_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_prev followups%rowtype;
begin
  if new.by_user is null then
    new.by_user := auth.uid();
  end if;
  if new.by_user is not null
     and not exists (select 1 from app_users u where u.id = new.by_user) then
    new.by_user := null;
  end if;

  /*
   * ONE live thread per party.
   *
   * The desk's "Missed" list showed the same party three times because every
   * contact left its own open row behind. A new contact now supersedes the
   * earlier open ones — they are closed with a reason that says so, and they
   * stay in the log with everything that was said — and if the new row has
   * no next date of its own it inherits the one that was planned, so sending
   * a statement does not quietly cancel Friday's call.
   */
  select * into v_prev
  from followups
  where party_id = new.party_id and not closed and id <> new.id
  order by contact_date desc, created_at desc
  limit 1;

  if v_prev.id is not null then
    if new.next_followup_date is null then
      new.next_followup_date := v_prev.next_followup_date;
    end if;

    update followups
    set closed = true,
        close_reason = 'Superseded by ' || new.method || ' on ' || to_char(new.contact_date, 'DD Mon YYYY')
    where party_id = new.party_id and not closed and id <> new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists followups_before_insert on followups;
create trigger followups_before_insert
  before insert on followups
  for each row execute function fn_followup_before_insert();

-- The rows already there: keep the latest open one per party, retire the rest.
with ranked as (
  select id, row_number() over (partition by party_id order by contact_date desc, created_at desc) as rn
  from followups where not closed
)
update followups f
set closed = true, close_reason = 'Superseded by a later follow-up'
from ranked r
where r.id = f.id and r.rn > 1;

-- -------------------------------------------------------------------
-- 3. Statement delivery, per party
--
-- Some parties insist on paper. Some must not be sent anything on
-- WhatsApp at all. The desk has been carrying that in their heads.
-- -------------------------------------------------------------------
alter table parties add column if not exists statement_mode text not null default 'whatsapp'
  check (statement_mode in ('whatsapp', 'physical', 'do_not_send'));

comment on column parties.statement_mode is
  'whatsapp = send on WhatsApp. physical = a printed statement is compulsory '
  'for this party. do_not_send = send nothing, on any channel.';

-- -------------------------------------------------------------------
-- 4. The audit log
--
-- Every change a person makes to a party, with who made it. Written by a
-- trigger so the application cannot forget, and readable by everyone on
-- the team because a log only one person can see is not a log.
-- -------------------------------------------------------------------
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  by_user     uuid,
  entity      text not null,
  entity_id   uuid,
  action      text not null,
  detail      jsonb not null default '{}'::jsonb
);

create index if not exists audit_log_entity_idx on audit_log (entity, entity_id, at desc);
create index if not exists audit_log_at_idx on audit_log (at desc);
create index if not exists audit_log_by_idx on audit_log (by_user, at desc);

alter table audit_log enable row level security;
grant select on audit_log to authenticated;
drop policy if exists audit_log_read on audit_log;
create policy audit_log_read on audit_log for select to authenticated using (is_authenticated());

create or replace function fn_audit_parties()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_col text;
begin
  foreach v_col in array array[
    'display_name', 'category', 'status', 'status_note', 'star_rating',
    'credit_type', 'credit_days', 'cycle_submit_day', 'cycle_pay_day',
    'cycle_lag_months', 'credit_source', 'responsible_person',
    'phone', 'contact_person', 'statement_mode'
  ] loop
    if to_jsonb(old) -> v_col is distinct from to_jsonb(new) -> v_col then
      v_changes := v_changes || jsonb_build_object(
        v_col, jsonb_build_object('from', to_jsonb(old) -> v_col, 'to', to_jsonb(new) -> v_col));
    end if;
  end loop;

  if v_changes <> '{}'::jsonb then
    insert into audit_log (by_user, entity, entity_id, action, detail)
    values (auth.uid(), 'party', new.id, 'updated', v_changes);
  end if;
  return new;
end;
$$;

drop trigger if exists parties_audit on parties;
create trigger parties_audit
  after update on parties
  for each row execute function fn_audit_parties();

-- Merges are logged from inside the function that performs them.
create or replace function fn_merge_parties(p_source uuid, p_target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_source parties%rowtype;
  v_target parties%rowtype;
  v_bills int; v_changes int; v_followups int; v_promises int; v_claims int;
  v_dropped int;
  v_result jsonb;
begin
  if p_source = p_target then
    raise exception 'A party cannot be merged into itself.';
  end if;

  select * into v_source from parties where id = p_source;
  select * into v_target from parties where id = p_target;
  if v_source.id is null then raise exception 'Source party not found.'; end if;
  if v_target.id is null then raise exception 'Target party not found.'; end if;

  alter table bills disable trigger bills_immutable;

  delete from bills b
  using bills t
  where b.party_id = p_source
    and t.party_id = p_target
    and t.snapshot_id = b.snapshot_id
    and t.bill_no = b.bill_no;
  get diagnostics v_dropped = row_count;

  update bills set party_id = p_target where party_id = p_source;
  get diagnostics v_bills = row_count;

  alter table bills enable trigger bills_immutable;

  delete from bill_changes b
  using bill_changes t
  where b.party_id = p_source and t.party_id = p_target
    and t.bill_no = b.bill_no
    and t.from_snapshot_id is not distinct from b.from_snapshot_id
    and t.to_snapshot_id is not distinct from b.to_snapshot_id;

  update bill_changes set party_id = p_target where party_id = p_source;
  get diagnostics v_changes = row_count;

  -- Re-pointing follow-ups must not fire the supersede trigger; it is an
  -- UPDATE, and that trigger is BEFORE INSERT, so it does not.
  update followups set party_id = p_target where party_id = p_source;
  get diagnostics v_followups = row_count;
  update promises  set party_id = p_target where party_id = p_source;
  get diagnostics v_promises = row_count;
  update claims    set party_id = p_target where party_id = p_source;
  get diagnostics v_claims = row_count;
  update audit_log set entity_id = p_target where entity = 'party' and entity_id = p_source;

  delete from party_profiles where party_id = p_source;
  delete from import_warnings where party_id = p_source;

  update parties set
    aliases            = array(select distinct unnest(
                            coalesce(aliases, '{}') || v_source.aliases || array[v_source.normalised_name])),
    phone              = coalesce(phone, v_source.phone),
    contact_person     = coalesce(contact_person, v_source.contact_person),
    category           = coalesce(category, v_source.category),
    responsible_person = coalesce(responsible_person, v_source.responsible_person),
    star_rating        = coalesce(star_rating, v_source.star_rating),
    star_note          = coalesce(star_note, v_source.star_note),
    first_seen_on      = least(coalesce(first_seen_on, v_source.first_seen_on),
                               coalesce(v_source.first_seen_on, first_seen_on))
  where id = p_target;

  delete from parties where id = p_source;

  v_result := jsonb_build_object(
    'merged_from', v_source.display_name,
    'merged_into', v_target.display_name,
    'bills_moved', v_bills,
    'duplicate_bills_dropped', v_dropped,
    'payment_events_moved', v_changes,
    'followups_moved', v_followups,
    'promises_moved', v_promises,
    'claims_moved', v_claims,
    'alias_kept', v_source.normalised_name
  );

  insert into audit_log (by_user, entity, entity_id, action, detail)
  values (auth.uid(), 'party', p_target, 'merged', v_result);

  return v_result;
exception when others then
  begin
    alter table bills enable trigger bills_immutable;
  exception when others then null;
  end;
  raise;
end;
$$;

-- -------------------------------------------------------------------
-- 5. Duplicates that a prefix match misses
--
-- CHETNA ENTERPRISES and CHETANA ENTERPRISES differ at the sixth letter,
-- so "same first twelve characters" never saw them. Trigram similarity
-- does. Still a shortlist for a person — never an automatic merge.
-- -------------------------------------------------------------------
drop function if exists fn_possible_duplicates(integer);
create function fn_possible_duplicates(p_limit integer default 60)
returns table (
  a_party_id uuid, a_name text, a_outstanding numeric, a_bills integer, a_first_seen date,
  b_party_id uuid, b_name text, b_outstanding numeric, b_bills integer, b_first_seen date,
  similarity real
)
language sql
stable
as $$
  with pairs as (
    select
      a.id as a_id, a.display_name as a_name, a.current_outstanding as a_out, a.first_seen_on as a_seen,
      b.id as b_id, b.display_name as b_name, b.current_outstanding as b_out, b.first_seen_on as b_seen,
      similarity(a.normalised_name, b.normalised_name) as sim
    from parties a
    join parties b
      on a.id < b.id
     and a.status <> 'discontinued' and b.status <> 'discontinued'
     and (similarity(a.normalised_name, b.normalised_name) >= 0.55
          or (length(a.normalised_name) >= 12
              and left(a.normalised_name, 12) = left(b.normalised_name, 12)))
  )
  select
    p.a_id, p.a_name, p.a_out,
    (select count(*)::int from bills x cross join v_latest_snapshot l
      where x.party_id = p.a_id and x.snapshot_id = l.id),
    p.a_seen,
    p.b_id, p.b_name, p.b_out,
    (select count(*)::int from bills x cross join v_latest_snapshot l
      where x.party_id = p.b_id and x.snapshot_id = l.id),
    p.b_seen,
    p.sim
  from pairs p
  order by p.sim desc, greatest(p.a_out, p.b_out) desc
  limit greatest(p_limit, 0);
$$;

grant execute on function fn_possible_duplicates(integer) to authenticated;

-- -------------------------------------------------------------------
-- 6. Clicking into an ageing bucket
--
-- The strip on Today says ₹1.10 Cr is more than 180 days past term. The
-- desk's question is "which parties, which invoices" — and then "let me
-- work them from here". This returns the invoices, one row per bill, so
-- the screen can group them by party and the person can start ringing.
--
-- Same arithmetic as v_party_ageing — overdue days measured against the
-- party's own term, nothing for a party with no term — but per bill
-- rather than summed, which is what a worklist needs.
-- -------------------------------------------------------------------
create or replace function fn_bucket_bills(p_bucket text, p_limit integer default 6000)
returns table (
  party_id uuid, display_name text, phone text, contact_person text,
  responsible_person uuid, star_rating smallint, status text,
  current_outstanding numeric,
  bill_no text, bill_date date, balance numeric, overdue_days integer
)
language sql
stable
as $$
  with latest as (select id from v_latest_snapshot),
  scored as (
    select
      p.id as party_id, p.display_name, p.phone, p.contact_person,
      p.responsible_person, p.star_rating, p.status, p.current_outstanding,
      b.bill_no, b.bill_date, b.balance,
      (current_date - fn_expected_due_date(
         b.bill_date, p.credit_type, p.credit_days,
         p.cycle_submit_day, p.cycle_pay_day, p.cycle_lag_months))::int as od
    from bills b
    join parties p on p.id = b.party_id
    cross join latest l
    where b.snapshot_id = l.id
      and p.credit_source <> 'not_set'
      and b.balance > 0
  )
  select party_id, display_name, phone, contact_person, responsible_person,
         star_rating, status, current_outstanding, bill_no, bill_date, balance, od
  from scored
  where case p_bucket
          when 'within_terms' then od <= 0
          when 'over_1_30'    then od between 1 and 30
          when 'over_31_60'   then od between 31 and 60
          when 'over_61_90'   then od between 61 and 90
          when 'over_91_120'  then od between 91 and 120
          when 'over_121_180' then od between 121 and 180
          when 'over_180'     then od > 180
          when 'over_60'      then od > 60
          else true
        end
  -- bill_no last: a total order, so paging through this from the client
  -- cannot repeat or skip a row at a page boundary.
  order by current_outstanding desc, display_name, od desc, bill_no
  limit greatest(p_limit, 0);
$$;

grant execute on function fn_bucket_bills(text, integer) to authenticated;

-- -------------------------------------------------------------------
-- 7. Working the To-allocate list
--
-- The list only shrinks when the next import arrives, so between imports
-- the desk needs to mark which parties they have already dealt with.
-- Keyed to the snapshot: a new import is a new list, and the marks on the
-- old one are history, not a filter on the new one.
-- -------------------------------------------------------------------
create table if not exists allocation_work (
  id          uuid primary key default gen_random_uuid(),
  party_id    uuid not null references parties (id) on delete cascade,
  snapshot_id uuid not null references snapshots (id) on delete cascade,
  by_user     uuid references app_users (id),
  note        text,
  done_at     timestamptz not null default now(),
  constraint allocation_work_once unique (party_id, snapshot_id)
);

alter table allocation_work enable row level security;
grant select, insert, update, delete on allocation_work to authenticated;
drop policy if exists allocation_work_read on allocation_work;
create policy allocation_work_read on allocation_work for select to authenticated using (is_authenticated());
drop policy if exists allocation_work_write on allocation_work;
create policy allocation_work_write on allocation_work
  for all to authenticated
  using (app_role() in ('owner', 'accounts', 'sales'))
  with check (app_role() in ('owner', 'accounts', 'sales'));

create or replace function fn_allocation_work_stamp()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.by_user is null then new.by_user := auth.uid(); end if;
  if new.by_user is not null and not exists (select 1 from app_users where id = new.by_user) then
    new.by_user := null;
  end if;
  return new;
end; $$;

drop trigger if exists allocation_work_stamp on allocation_work;
create trigger allocation_work_stamp before insert on allocation_work
  for each row execute function fn_allocation_work_stamp();

-- -------------------------------------------------------------------
-- 8. Linking a login to a person who was added without one
--
-- A recovery person is added by name, assigned parties, and later given
-- a login. The login's id is minted by auth and cannot be chosen, so the
-- person's row has to take the login's id — and everything pointing at
-- the old id has to follow. None of those keys cascade on update, so it
-- is done explicitly, in one transaction.
-- -------------------------------------------------------------------
create or replace function fn_relink_user(p_old uuid, p_new uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_old = p_new then return; end if;
  if not exists (select 1 from app_users where id = p_old) then
    raise exception 'No team member with that id.';
  end if;
  if exists (select 1 from app_users where id = p_new) then
    raise exception 'That login is already linked to a team member.';
  end if;
  if app_role() <> 'owner' then
    raise exception 'Only the owner can link logins.';
  end if;

  alter table app_users disable trigger all;
  insert into app_users (id, full_name, role, created_at, email, active)
  select p_new, full_name, role, created_at, email, active from app_users where id = p_old;
  alter table app_users enable trigger all;

  update parties set responsible_person = p_new where responsible_person = p_old;
  update parties set salesperson = p_new where salesperson = p_old;
  update followups set by_user = p_new where by_user = p_old;
  update recovery_targets set user_id = p_new where user_id = p_old;
  update snapshots set uploaded_by = p_new where uploaded_by = p_old;
  update allocation_work set by_user = p_new where by_user = p_old;
  update audit_log set by_user = p_new where by_user = p_old;

  delete from app_users where id = p_old;

  insert into audit_log (by_user, entity, entity_id, action, detail)
  values (auth.uid(), 'user', p_new, 'login_linked', jsonb_build_object('previous_id', p_old));
end;
$$;

revoke all on function fn_relink_user(uuid, uuid) from public;
grant execute on function fn_relink_user(uuid, uuid) to authenticated;

-- -------------------------------------------------------------------
-- 9. Views pick up the new columns
-- -------------------------------------------------------------------
drop view if exists v_recovery_activity;
create view v_recovery_activity as
select
  f.id, f.party_id,
  p.display_name as party_name,
  p.current_outstanding,
  f.by_user,
  u.full_name as by_name,
  f.contact_date, f.method, f.outcome, f.notes,
  f.next_followup_date, f.closed, f.created_at,
  f.close_reason
from followups f
join parties p on p.id = f.party_id
left join app_users u on u.id = f.by_user;

drop view if exists v_party_board;
create view v_party_board as
select
  a.*,
  p.star_rating, p.star_note, p.star_set_on, p.first_seen_on, p.aliases,
  u.full_name as responsible_name,
  p.statement_mode
from v_party_ageing a
join parties p on p.id = a.party_id
left join app_users u on u.id = a.responsible_person;

alter view v_recovery_activity set (security_invoker = on);
alter view v_party_board set (security_invoker = on);
grant select on v_recovery_activity, v_party_board to authenticated;

-- -------------------------------------------------------------------
-- 10. The owner's name
-- -------------------------------------------------------------------
update app_users set full_name = 'Nilesh'
where role = 'owner' and full_name ilike 'R. Sal%';
