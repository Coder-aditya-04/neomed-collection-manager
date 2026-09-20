-- ===================================================================
-- Recovery operations. Built from the client meeting of 20 Sep 2026.
--
-- Three things came out of it:
--   1. The header-vs-bills gap is money RECEIVED but not allocated to a
--      bill in Marg. They want a list of those parties to call.
--   2. Month-end statements go out on WhatsApp, picked one by one out of
--      a spreadsheet. They want one click.
--   3. Recovery staff need work allocated, and their calling measured.
-- ===================================================================

-- -------------------------------------------------------------------
-- v_unallocated_receipts
--
-- WHAT THE GAP MEANS. A party buys for 50,000 and pays 30,000, then
-- 20,000 two days later. Marg reduces the party's ledger balance by the
-- full 50,000 but the 20,000 was never settled against a particular
-- bill, so the bill rows still carry it. The party's header total and
-- the sum of its bills then disagree by exactly the unallocated amount.
--
-- On 15 Sep that is about Rs 1.53 Cr across 40 parties. It is not a
-- parsing error and it is not debt they dispute — it is money already in
-- the bank waiting to be pointed at the right bills.
--
-- bills_total minus header is positive when receipts are unallocated,
-- which is the ordinary direction. The reverse happens too and is shown
-- as well, because it means the opposite problem.
-- -------------------------------------------------------------------
create or replace view v_unallocated_receipts as
select
  a.party_id,
  a.display_name,
  a.phone,
  a.contact_person,
  a.current_outstanding                                   as marg_balance,
  a.bill_balance_sum                                      as bills_total,
  round(a.bill_balance_sum - a.current_outstanding, 2)    as unallocated,
  a.bill_count,
  a.oldest_bill_age_days,
  a.needs_credit_term,
  a.responsible_person,
  case
    when a.bill_balance_sum > a.current_outstanding then 'receipt_unallocated'
    else 'bills_short'
  end as gap_type
from v_party_ageing a
where a.bill_balance_sum is not null
  and abs(a.bill_balance_sum - a.current_outstanding) > 1000
order by abs(a.bill_balance_sum - a.current_outstanding) desc;

comment on view v_unallocated_receipts is
  'Parties whose Marg header total disagrees with the sum of their bill rows. '
  'The usual cause is a receipt banked against the party but never settled '
  'against particular bills — money in hand that Marg cannot yet show as '
  'clearing any specific invoice.';

-- responsible_person already exists on parties; make it reachable from the
-- ageing view so the recovery screens can filter by who owns the party.
-- (v_party_ageing is rebuilt in 0003, which now carries it.)

-- -------------------------------------------------------------------
-- Call targets, so "how many calls should have been made" has an answer
-- -------------------------------------------------------------------
create table if not exists recovery_targets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_users (id) on delete cascade,
  period        text not null check (period in ('daily', 'weekly', 'monthly')),
  starts_on     date not null,
  call_target   integer not null default 0 check (call_target >= 0),
  amount_target numeric(14, 2) not null default 0 check (amount_target >= 0),
  created_at    timestamptz not null default now(),
  constraint recovery_targets_unique unique (user_id, period, starts_on)
);

create index if not exists recovery_targets_user_idx on recovery_targets (user_id, starts_on desc);

-- -------------------------------------------------------------------
-- v_recovery_activity — every logged contact, with who and what was said
-- -------------------------------------------------------------------
create or replace view v_recovery_activity as
select
  f.id,
  f.party_id,
  p.display_name         as party_name,
  p.current_outstanding,
  f.by_user,
  u.full_name            as by_name,
  f.contact_date,
  f.method,
  f.outcome,
  f.notes,
  f.next_followup_date,
  f.closed,
  f.created_at
from followups f
join parties p on p.id = f.party_id
left join app_users u on u.id = f.by_user;

-- -------------------------------------------------------------------
-- fn_recovery_scorecard — what each person did over a window.
--
-- Efficiency is contacts made against contacts promised: the follow-ups
-- they committed to for a date, versus the ones they actually logged.
-- A person with no commitments has no efficiency, not 100% — which is
-- why it returns NULL rather than a flattering number.
-- -------------------------------------------------------------------
create or replace function fn_recovery_scorecard(p_from date, p_to date)
returns table (
  user_id          uuid,
  full_name        text,
  role             text,
  calls            integer,
  whatsapps        integer,
  visits           integer,
  emails           integer,
  total_contacts   integer,
  parties_touched  integer,
  due_in_window    integer,
  done_in_window   integer,
  efficiency_pct   numeric,
  promises_taken   integer,
  promised_amount  numeric,
  collected_amount numeric,
  call_target      integer,
  amount_target    numeric
)
language sql
stable
as $$
  with people as (
    select id, full_name, role from app_users
  ),
  contacts as (
    select
      f.by_user,
      count(*) filter (where f.method = 'call')::integer     as calls,
      count(*) filter (where f.method = 'whatsapp')::integer as whatsapps,
      count(*) filter (where f.method = 'visit')::integer    as visits,
      count(*) filter (where f.method = 'email')::integer    as emails,
      count(*)::integer                                      as total_contacts,
      count(distinct f.party_id)::integer                    as parties_touched
    from followups f
    where f.contact_date between p_from and p_to
    group by f.by_user
  ),
  commitments as (
    -- Work that fell due in the window, and whether a contact followed it.
    select
      f.by_user,
      count(*)::integer as due_in_window,
      count(*) filter (
        where exists (
          select 1 from followups g
          where g.party_id = f.party_id
            and g.contact_date >= f.next_followup_date
            and g.contact_date <= p_to
            and g.id <> f.id
        ) or f.closed
      )::integer as done_in_window
    from followups f
    where f.next_followup_date between p_from and p_to
    group by f.by_user
  ),
  promised as (
    select
      pr.party_id, po.by_user,
      count(*)::integer as promises_taken,
      sum(pr.promised_amount) as promised_amount,
      sum(pr.received_amount) as collected_amount
    from promises pr
    -- A promise is credited to whoever last spoke to that party before it.
    left join lateral (
      select f.by_user from followups f
      where f.party_id = pr.party_id and f.contact_date <= pr.promised_on
      order by f.contact_date desc limit 1
    ) po on true
    where pr.promised_on between p_from and p_to
    group by pr.party_id, po.by_user
  ),
  promised_by_user as (
    select by_user,
           sum(promises_taken)::integer as promises_taken,
           sum(promised_amount) as promised_amount,
           sum(collected_amount) as collected_amount
    from promised group by by_user
  ),
  targets as (
    select user_id,
           sum(call_target)::integer as call_target,
           sum(amount_target) as amount_target
    from recovery_targets
    where starts_on between p_from - 31 and p_to
    group by user_id
  )
  select
    pe.id, pe.full_name, pe.role,
    coalesce(c.calls, 0), coalesce(c.whatsapps, 0), coalesce(c.visits, 0),
    coalesce(c.emails, 0), coalesce(c.total_contacts, 0), coalesce(c.parties_touched, 0),
    coalesce(cm.due_in_window, 0), coalesce(cm.done_in_window, 0),
    case
      when coalesce(cm.due_in_window, 0) = 0 then null
      else round(cm.done_in_window::numeric * 100 / cm.due_in_window, 1)
    end,
    coalesce(pb.promises_taken, 0),
    coalesce(pb.promised_amount, 0),
    coalesce(pb.collected_amount, 0),
    coalesce(t.call_target, 0),
    coalesce(t.amount_target, 0)
  from people pe
  left join contacts c            on c.by_user = pe.id
  left join commitments cm        on cm.by_user = pe.id
  left join promised_by_user pb   on pb.by_user = pe.id
  left join targets t             on t.user_id = pe.id
  order by coalesce(c.total_contacts, 0) desc, pe.full_name;
$$;

comment on function fn_recovery_scorecard is
  'Per-person calling activity over a window, with efficiency measured as '
  'commitments met against commitments due. Returns NULL efficiency where '
  'nothing was committed, rather than a flattering 100%.';

-- -------------------------------------------------------------------
-- fn_party_contact_counts — per party, how much each channel was used.
-- Answers "how many WhatsApps and how many calls has this party had".
-- -------------------------------------------------------------------
create or replace function fn_party_contact_counts(p_party uuid)
returns table (
  calls       integer,
  whatsapps   integer,
  visits      integer,
  emails      integer,
  first_contact date,
  last_contact  date
)
language sql
stable
as $$
  select
    count(*) filter (where method = 'call')::integer,
    count(*) filter (where method = 'whatsapp')::integer,
    count(*) filter (where method = 'visit')::integer,
    count(*) filter (where method = 'email')::integer,
    min(contact_date), max(contact_date)
  from followups where party_id = p_party;
$$;

-- -------------------------------------------------------------------
-- Grants and policies for the new objects
-- -------------------------------------------------------------------
alter table recovery_targets enable row level security;

grant select on v_unallocated_receipts, v_recovery_activity to authenticated;
grant select, insert, update, delete on recovery_targets to authenticated;

alter view v_unallocated_receipts set (security_invoker = on);
alter view v_recovery_activity    set (security_invoker = on);

drop policy if exists recovery_targets_read on recovery_targets;
create policy recovery_targets_read on recovery_targets
  for select to authenticated using (is_authenticated());

-- Only the people who run the desk set targets.
drop policy if exists recovery_targets_write on recovery_targets;
create policy recovery_targets_write on recovery_targets
  for all to authenticated
  using (app_role() in ('owner', 'accounts'))
  with check (app_role() in ('owner', 'accounts'));

grant execute on function fn_recovery_scorecard(date, date) to authenticated;
grant execute on function fn_party_contact_counts(uuid) to authenticated;
