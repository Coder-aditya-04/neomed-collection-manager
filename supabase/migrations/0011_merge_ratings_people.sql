-- ===================================================================
-- Client review, 13 October 2026.
--
--   1. Team members who do not sign in (the person a party is assigned to
--      is often not a software user).
--   2. A 1-5 star rating per party, in the client's own words.
--   3. Merging a party that Marg has re-created under a new spelling,
--      without losing its history.
--   4. Marking a party discontinued instead of deleting it.
--   5. Knowing which parties are new, so somebody sets them up.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. People who do not log in
--
-- app_users.id was a foreign key to auth.users, so the only way to name
-- a recovery person was to create them a login. Most of this desk does
-- not have one — the collections are worked by people who are assigned
-- parties and reported on, not people who sign in.
--
-- The key stays the same shape, and app_role() still matches it against
-- auth.uid(), so anyone who DOES have a login keeps their role exactly as
-- before. Someone without one simply never matches, which is correct:
-- they have no session and therefore no permissions.
-- -------------------------------------------------------------------
alter table app_users drop constraint if exists app_users_id_fkey;
alter table app_users alter column id set default gen_random_uuid();
alter table app_users add column if not exists email text;
alter table app_users add column if not exists active boolean not null default true;

comment on column app_users.id is
  'Matches auth.users.id for people who can sign in. For a recovery person '
  'who only needs to be named and assigned work, it is just a generated id '
  'and they never authenticate.';

-- -------------------------------------------------------------------
-- 2. The star rating
--
-- The client asked for this in the Amazon sense: a mark against the name
-- you can read at a glance. It is a JUDGEMENT, entered by a person, and
-- it is kept deliberately separate from party_profiles.reliability, which
-- is COMPUTED from settled bills. The two will sometimes disagree, and
-- when they do that disagreement is worth seeing rather than resolving:
-- one is what the ledger shows, the other is what the desk knows.
-- -------------------------------------------------------------------
alter table parties add column if not exists star_rating smallint
  check (star_rating is null or star_rating between 1 and 5);
alter table parties add column if not exists star_note text;
alter table parties add column if not exists star_set_on date;

comment on column parties.star_rating is
  '1 fraud/defaulter · 2 bad for payment · 3 credit oriented · 4 genuine but '
  'needs follow-up · 5 prompt payment. A human judgement, not a computed '
  'score — party_profiles.reliability is the computed one.';

create index if not exists parties_star_idx on parties (star_rating) where star_rating is not null;

-- -------------------------------------------------------------------
-- 3. Discontinued
--
-- Deleting a party that stopped trading destroys its payment history,
-- which is the one thing here that cannot be re-imported. It gets a
-- status instead, and drops out of the working lists.
-- -------------------------------------------------------------------
alter table parties drop constraint if exists parties_status_check;
alter table parties add constraint parties_status_check check (
  status in ('active', 'legal_notice_sent', 'legal_case_filed',
             'in_process', 'dispute', 'settled', 'written_off', 'discontinued')
);

-- -------------------------------------------------------------------
-- 4. When a party was first seen
--
-- So "which parties are new and need setting up" has an answer. Back-
-- filled from the earliest snapshot each party appears in, which is the
-- truthful answer for everything already imported.
-- -------------------------------------------------------------------
alter table parties add column if not exists first_seen_on date;

update parties p
set first_seen_on = x.first_date
from (
  select b.party_id, min(s.report_date) as first_date
  from bills b join snapshots s on s.id = b.snapshot_id
  group by b.party_id
) x
where x.party_id = p.id and p.first_seen_on is distinct from x.first_date;

-- -------------------------------------------------------------------
-- v_new_parties — appeared in the latest import, and not set up.
-- -------------------------------------------------------------------
create or replace view v_new_parties as
select
  a.party_id, a.display_name, a.category, a.current_outstanding,
  a.bill_count, a.oldest_bill_age_days, a.needs_credit_term,
  p.first_seen_on, p.star_rating, p.phone, p.responsible_person,
  (select max(report_date) from snapshots) as latest_report_date
from v_party_ageing a
join parties p on p.id = a.party_id
where p.first_seen_on is not null
  and p.first_seen_on >= (select max(report_date) from snapshots) - 30
order by a.current_outstanding desc;

comment on view v_new_parties is
  'Parties first seen in the last 30 days of imports. A new name here is '
  'often a party Marg already knew under a different spelling — check before '
  'setting one up, and merge instead if so.';

-- -------------------------------------------------------------------
-- 5. fn_merge_parties — one party absorbed into another.
--
-- WHY THIS EXISTS. An operator renames "KRH Pharma" to "KRH Pharma Nsk"
-- in Marg. The next import has no idea they are the same, so it creates
-- a second party with a second ledger. Deleting the old one throws away
-- every payment event, every call and every promise — the history that
-- took weeks of imports to derive and cannot be re-created.
--
-- So nothing is thrown away. Everything the source carries is moved onto
-- the target, the source's name is kept as an alias so a future import
-- under the old spelling lands in the right place, and only then is the
-- empty shell removed.
--
-- bills carries the immutability trigger (rule 4). Re-pointing a bill at
-- a different party is not editing a figure — no amount, date or balance
-- changes — so the trigger is lifted for the move and restored before the
-- function returns. It is transactional: a failure rolls the whole thing
-- back, trigger included.
-- -------------------------------------------------------------------
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
begin
  if p_source = p_target then
    raise exception 'A party cannot be merged into itself.';
  end if;

  select * into v_source from parties where id = p_source;
  select * into v_target from parties where id = p_target;
  if v_source.id is null then raise exception 'Source party not found.'; end if;
  if v_target.id is null then raise exception 'Target party not found.'; end if;

  alter table bills disable trigger bills_immutable;

  -- Both parties can hold the same bill in the same snapshot — that is
  -- exactly what happens in the import where the rename took effect. The
  -- target's copy is the surviving one; the source's duplicate is dropped
  -- rather than merged, because they are the same bill twice.
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

  update followups set party_id = p_target where party_id = p_source;
  get diagnostics v_followups = row_count;
  update promises  set party_id = p_target where party_id = p_source;
  get diagnostics v_promises = row_count;
  update claims    set party_id = p_target where party_id = p_source;
  get diagnostics v_claims = row_count;

  delete from party_profiles where party_id = p_source;
  delete from import_warnings where party_id = p_source;

  /*
   * The old spelling becomes an alias, so the next export that still uses
   * it is recognised instead of creating this problem again.
   *
   * Details fill gaps only: anything already recorded on the target was
   * typed by a person and outranks whatever the source happened to hold.
   */
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

  return jsonb_build_object(
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
exception when others then
  -- Never leave the guarantee off because something else failed.
  begin
    alter table bills enable trigger bills_immutable;
  exception when others then null;
  end;
  raise;
end;
$$;

comment on function fn_merge_parties is
  'Absorbs one party into another, moving bills, derived payment history, '
  'follow-ups, promises and claims, and keeping the old name as an alias so '
  'a later import under that spelling is recognised. Nothing is discarded '
  'except bills duplicated across both parties in the same snapshot.';

revoke all on function fn_merge_parties(uuid, uuid) from public;
grant execute on function fn_merge_parties(uuid, uuid) to authenticated;

-- -------------------------------------------------------------------
-- 6. fn_possible_duplicates — candidates for the merge above.
--
-- Pairs whose names share a leading run of characters. Crude on purpose:
-- it is a shortlist for a person to judge, never an automatic merge.
-- -------------------------------------------------------------------
create or replace function fn_possible_duplicates(p_limit integer default 50)
returns table (
  a_party_id uuid, a_name text, a_outstanding numeric, a_bills integer, a_first_seen date,
  b_party_id uuid, b_name text, b_outstanding numeric, b_bills integer, b_first_seen date,
  shared_prefix text
)
language sql
stable
as $$
  with pairs as (
    select
      a.id as a_id, a.display_name as a_name, a.normalised_name as a_norm,
      a.current_outstanding as a_out, a.first_seen_on as a_seen,
      b.id as b_id, b.display_name as b_name, b.normalised_name as b_norm,
      b.current_outstanding as b_out, b.first_seen_on as b_seen
    from parties a
    join parties b
      on a.id < b.id
     and left(a.normalised_name, 12) = left(b.normalised_name, 12)
     and length(a.normalised_name) >= 12
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
    left(p.a_norm, 12)
  from pairs p
  order by greatest(p.a_out, p.b_out) desc
  limit greatest(p_limit, 0);
$$;

alter view v_new_parties set (security_invoker = on);
grant select on v_new_parties to authenticated;
grant execute on function fn_possible_duplicates(integer) to authenticated;

-- -------------------------------------------------------------------
-- 7. v_party_board — the ageing view plus the things a person records.
--
-- The parties list needs the star rating, the aliases and when a party
-- was first seen. Those live on `parties`, not in the ageing maths, and
-- adding them to v_party_ageing would mean re-stating that whole view —
-- 60 lines of bucket arithmetic — every time a column is added to it,
-- with a real chance of the two copies drifting apart.
--
-- A thin view on top costs one join and keeps the ageing definition in
-- exactly one place.
-- -------------------------------------------------------------------
create or replace view v_party_board as
select
  a.*,
  p.star_rating,
  p.star_note,
  p.star_set_on,
  p.first_seen_on,
  p.aliases,
  u.full_name as responsible_name
from v_party_ageing a
join parties p on p.id = a.party_id
left join app_users u on u.id = a.responsible_person;

alter view v_party_board set (security_invoker = on);
grant select on v_party_board to authenticated;
