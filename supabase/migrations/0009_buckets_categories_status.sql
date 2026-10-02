-- ===================================================================
-- Client review, 20 September 2026.
--
-- Four changes, all of them things the desk asked for after a week of
-- using the system:
--
--   1. Six ageing buckets instead of four, still measured against the
--      party's own credit term.
--   2. Party categories the trade actually uses.
--   3. Collection status on a party — legal notice sent, case filed —
--      so the defaulters list can be worked rather than just read.
--   4. A follow-up cannot be closed without saying why.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Categories
--
-- The desk works in Retailer / Wholesaler / Doctor / Customer. Hospital
-- is kept because it is where the money is — 19 of the top 20 parties —
-- and because the cycle-based credit default is keyed to it. The old
-- 'institution' and 'cash' values stay legal so no existing row becomes
-- invalid; they simply are not offered for new ones.
-- -------------------------------------------------------------------
alter table parties drop constraint if exists parties_category_check;
alter table parties add constraint parties_category_check check (
  category is null or category in
    ('hospital', 'retailer', 'wholesaler', 'doctor', 'customer', 'institution', 'cash')
);

-- -------------------------------------------------------------------
-- 2. Collection status
--
-- 'status' already existed with active/hold/dispute/legal/write_off.
-- The desk needs to distinguish a notice from a filed case, and to mark
-- a party as settled. Old values are migrated rather than dropped, so
-- nothing already recorded is lost or silently reinterpreted.
-- -------------------------------------------------------------------
alter table parties drop constraint if exists parties_status_check;

update parties set status = 'legal_case_filed' where status = 'legal';
update parties set status = 'written_off'      where status = 'write_off';
update parties set status = 'in_process'       where status = 'hold';

alter table parties add constraint parties_status_check check (
  status in ('active', 'legal_notice_sent', 'legal_case_filed',
             'in_process', 'dispute', 'settled', 'written_off')
);

-- Why the status was set. A status change without a reason is an
-- opinion; with one it is a record somebody else can act on.
alter table parties add column if not exists status_note text;
alter table parties add column if not exists status_changed_on date;

comment on column parties.status is
  'Collection status. active = ordinary chasing. legal_notice_sent and '
  'legal_case_filed are escalations. in_process = being worked outside the '
  'normal cycle. dispute, settled and written_off take the party out of the '
  'priority list entirely.';

-- -------------------------------------------------------------------
-- 3. A follow-up cannot be closed without a reason
--
-- Closing a follow-up is how somebody says "this is dealt with". Without
-- a reason the register fills with closed rows that nobody can learn
-- anything from, and the next person rings the party blind.
--
-- Enforced by the database, not by the form, because the form is not the
-- only way a row can be written.
-- -------------------------------------------------------------------
alter table followups add column if not exists close_reason text;

-- Existing closed rows predate the rule and cannot be invented after the
-- fact. They are marked as such, honestly, rather than back-filled with
-- a guess.
update followups
set close_reason = 'Closed before a reason was required'
where closed and (close_reason is null or btrim(close_reason) = '');

alter table followups drop constraint if exists followups_closed_needs_reason;
alter table followups add constraint followups_closed_needs_reason check (
  not closed or (close_reason is not null and btrim(close_reason) <> '')
);

comment on constraint followups_closed_needs_reason on followups is
  'A follow-up closes only with a stated reason. Closing is how somebody '
  'says the matter is dealt with; without a reason the next person rings '
  'the party blind.';

-- -------------------------------------------------------------------
-- 4. Six ageing buckets
--
-- Still measured against fn_expected_due_date, never against bill age:
-- a hospital on a monthly cycle can hold a 78-day-old bill and be
-- perfectly on time. Buckets remain NULL for a party with no recorded
-- term, because "we cannot say" is not the same as "nothing is overdue".
--
-- Seven segments, not six: the client's 0-30 .. 180+ are all past the
-- due date, and money that is not yet due has to go somewhere. It keeps
-- its own segment at the front.
-- -------------------------------------------------------------------
drop view if exists v_portfolio_ageing cascade;
drop view if exists v_party_ageing cascade;

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
    sum(balance)                                                               as bill_balance_sum,
    sum(balance) filter (where overdue_days is not null and overdue_days <= 0) as within_terms,
    sum(balance) filter (where overdue_days between 1 and 30)                  as over_1_30,
    sum(balance) filter (where overdue_days between 31 and 60)                 as over_31_60,
    sum(balance) filter (where overdue_days between 61 and 90)                 as over_61_90,
    sum(balance) filter (where overdue_days between 91 and 120)                as over_91_120,
    sum(balance) filter (where overdue_days between 121 and 180)               as over_121_180,
    sum(balance) filter (where overdue_days > 180)                             as over_180,
    max(overdue_days)                                                          as max_overdue_days,
    count(*)                                                                   as bill_count,
    count(*) filter (where overdue_days is null)                               as unplaceable_bills
  from scored_bills
  group by party_id
),
scaled as (
  select
    p.id as party_id,
    p.display_name, p.normalised_name, p.category, p.phone, p.contact_person,
    p.responsible_person, p.status, p.status_note, p.status_changed_on,
    p.credit_type, p.credit_source, p.credit_days,
    p.cycle_submit_day, p.cycle_pay_day, p.cycle_lag_months,
    p.current_outstanding, p.oldest_bill_age_days,
    coalesce(rb.bill_count, 0)        as bill_count,
    rb.bill_balance_sum,
    rb.max_overdue_days,
    coalesce(rb.unplaceable_bills, 0) as unplaceable_bills,
    p.credit_source = 'not_set'           as needs_credit_term,
    p.credit_source = 'category_default'  as term_is_assumed,
    p.current_outstanding < 0             as is_credit_balance,
    case
      when rb.bill_balance_sum is null or rb.bill_balance_sum = 0 then null
      else p.current_outstanding / rb.bill_balance_sum
    end as reconcile_ratio,
    rb.within_terms, rb.over_1_30, rb.over_31_60,
    rb.over_61_90, rb.over_91_120, rb.over_121_180, rb.over_180
  from parties p
  left join raw_buckets rb on rb.party_id = p.id
)
select
  party_id, display_name, normalised_name, category, phone, contact_person,
  responsible_person, status, status_note, status_changed_on,
  credit_type, credit_source, credit_days,
  cycle_submit_day, cycle_pay_day, cycle_lag_months,
  current_outstanding, oldest_bill_age_days, bill_count, bill_balance_sum,
  reconcile_ratio, max_overdue_days, unplaceable_bills,
  needs_credit_term, term_is_assumed, is_credit_balance,
  case when needs_credit_term then null
       else round(coalesce(within_terms,  0) * coalesce(reconcile_ratio, 1), 2) end as within_terms,
  case when needs_credit_term then null
       else round(coalesce(over_1_30,     0) * coalesce(reconcile_ratio, 1), 2) end as over_1_30,
  case when needs_credit_term then null
       else round(coalesce(over_31_60,    0) * coalesce(reconcile_ratio, 1), 2) end as over_31_60,
  case when needs_credit_term then null
       else round(coalesce(over_61_90,    0) * coalesce(reconcile_ratio, 1), 2) end as over_61_90,
  case when needs_credit_term then null
       else round(coalesce(over_91_120,   0) * coalesce(reconcile_ratio, 1), 2) end as over_91_120,
  case when needs_credit_term then null
       else round(coalesce(over_121_180,  0) * coalesce(reconcile_ratio, 1), 2) end as over_121_180,
  case when needs_credit_term then null
       else round(coalesce(over_180,      0) * coalesce(reconcile_ratio, 1), 2) end as over_180,
  -- Kept so nothing downstream that still asks for the old four-bucket
  -- shape breaks: everything past 60 days, as the old view reported it.
  case when needs_credit_term then null
       else round((coalesce(over_61_90, 0) + coalesce(over_91_120, 0)
                 + coalesce(over_121_180, 0) + coalesce(over_180, 0))
                 * coalesce(reconcile_ratio, 1), 2) end as over_60
from scaled;

comment on view v_party_ageing is
  'Per-party ageing for the latest snapshot. Seven segments: money not yet '
  'due, then six buckets of days past the due date. Measured against the '
  'party''s own credit term, never against bill age, and NULL throughout '
  'wherever no term is recorded.';

create view v_portfolio_ageing as
select
  coalesce(sum(within_terms)  filter (where not needs_credit_term and not is_credit_balance), 0) as within_terms,
  coalesce(sum(over_1_30)     filter (where not needs_credit_term and not is_credit_balance), 0) as over_1_30,
  coalesce(sum(over_31_60)    filter (where not needs_credit_term and not is_credit_balance), 0) as over_31_60,
  coalesce(sum(over_61_90)    filter (where not needs_credit_term and not is_credit_balance), 0) as over_61_90,
  coalesce(sum(over_91_120)   filter (where not needs_credit_term and not is_credit_balance), 0) as over_91_120,
  coalesce(sum(over_121_180)  filter (where not needs_credit_term and not is_credit_balance), 0) as over_121_180,
  coalesce(sum(over_180)      filter (where not needs_credit_term and not is_credit_balance), 0) as over_180,
  coalesce(sum(over_60)       filter (where not needs_credit_term and not is_credit_balance), 0) as over_60,
  coalesce(sum(current_outstanding) filter (where needs_credit_term and current_outstanding > 0), 0) as unjudgeable_amount,
  count(*) filter (where needs_credit_term)                                    as unjudgeable_parties,
  coalesce(sum(current_outstanding) filter (where current_outstanding > 0), 0) as total_owed,
  coalesce(sum(current_outstanding) filter (where current_outstanding < 0), 0) as total_credit,
  coalesce(sum(current_outstanding), 0)                                        as net_total,
  count(*)                                                                     as party_count
from v_party_ageing;

alter view v_party_ageing     set (security_invoker = on);
alter view v_portfolio_ageing set (security_invoker = on);
grant select on v_party_ageing, v_portfolio_ageing to authenticated;

-- -------------------------------------------------------------------
-- 5. Rebuild what the cascade took with it
--
-- v_unallocated_receipts is defined on v_party_ageing, so dropping that
-- view dropped this one too. Recreated verbatim from 0008 — if the two
-- ever diverge, this is the one that runs.
-- -------------------------------------------------------------------
create or replace view v_unallocated_receipts as
with receipts as (
  select
    b.party_id,
    sum(-b.balance) filter (where b.balance < 0)  as unapplied,
    count(*) filter (where b.balance < 0)         as receipt_count,
    min(b.bill_date) filter (where b.balance < 0) as oldest_receipt,
    max(b.bill_date) filter (where b.balance < 0) as newest_receipt
  from bills b
  cross join v_latest_snapshot l
  where b.snapshot_id = l.id and b.is_on_account
  group by b.party_id
)
select
  a.party_id, a.display_name, a.phone, a.contact_person,
  a.current_outstanding   as marg_balance,
  a.bill_balance_sum      as bills_total,
  round(r.unapplied, 2)   as unallocated,
  r.receipt_count, r.oldest_receipt, r.newest_receipt,
  a.bill_count, a.oldest_bill_age_days, a.needs_credit_term, a.responsible_person,
  'receipt_unallocated'::text as gap_type
from v_party_ageing a
join receipts r on r.party_id = a.party_id
where r.unapplied > 1
order by r.unapplied desc;

alter view v_unallocated_receipts set (security_invoker = on);
grant select on v_unallocated_receipts to authenticated;

-- -------------------------------------------------------------------
-- 6. The priority list must exclude the new terminal statuses
--
-- Without this, a party that has been settled or written off keeps
-- appearing at the top of the call list, and the escalated ones vanish
-- from it entirely — 'legal' no longer exists as a value, so the old
-- exclusion silently stopped matching anything.
--
-- A party under legal action STAYS on the list. Somebody still has to
-- chase it; the status tells them how to pitch the call, not to skip it.
-- -------------------------------------------------------------------
-- The column list changes, and Postgres will not replace a function whose
-- OUT parameters differ. Dropped first, deliberately.
drop function if exists fn_priority_list(integer);

create function fn_priority_list(p_limit integer default 20)
returns table (
  rank integer, party_id uuid, display_name text,
  current_outstanding numeric, oldest_bill_age_days integer, max_overdue_days integer,
  within_terms numeric, over_1_30 numeric, over_31_60 numeric,
  over_61_90 numeric, over_91_120 numeric, over_121_180 numeric, over_180 numeric,
  over_60 numeric,
  reliability text, term_is_assumed boolean, priority_score numeric, reason text
)
language sql
stable
as $$
  with threshold as (
    select fn_setting_numeric('small_balance_threshold', 10000) as small_balance
  ),
  eligible as (
    select
      a.*,
      coalesce(pp.reliability, 'unknown') as reliability,
      case coalesce(pp.reliability, 'unknown')
        when 'good' then 1.0 when 'fair' then 1.4 when 'poor' then 1.9 else 1.2
      end as reliability_weight
    from v_party_ageing a
    left join party_profiles pp on pp.party_id = a.party_id
    cross join threshold t
    where
      not exists (select 1 from claims c where c.party_id = a.party_id and c.status = 'open')
      and a.status not in ('dispute', 'settled', 'written_off')
      and not a.needs_credit_term
      and a.current_outstanding > 0
      and a.current_outstanding >= t.small_balance
  ),
  scored as (
    select e.*,
      round((e.current_outstanding
             * ln(greatest(coalesce(e.max_overdue_days, 0), 1) + 1)
             * e.reliability_weight)::numeric, 2) as priority_score
    from eligible e
  )
  select
    row_number() over (order by s.priority_score desc, s.current_outstanding desc)::integer,
    s.party_id, s.display_name, s.current_outstanding, s.oldest_bill_age_days,
    s.max_overdue_days, s.within_terms, s.over_1_30, s.over_31_60,
    s.over_61_90, s.over_91_120, s.over_121_180, s.over_180, s.over_60,
    s.reliability, s.term_is_assumed, s.priority_score,
    concat_ws(' ',
      case
        when coalesce(s.over_60, 0) > 0 then
          fn_fmt_inr(s.over_60) || ' of ' || fn_fmt_inr(s.current_outstanding)
          || ' is more than 60 days past term.'
        when coalesce(s.over_31_60, 0) > 0 then
          fn_fmt_inr(s.over_31_60) || ' of ' || fn_fmt_inr(s.current_outstanding)
          || ' is 31 to 60 days past term.'
        when coalesce(s.over_1_30, 0) > 0 then
          fn_fmt_inr(s.over_1_30) || ' of ' || fn_fmt_inr(s.current_outstanding)
          || ' is up to 30 days past term.'
        else fn_fmt_inr(s.current_outstanding) || ' outstanding, all of it within terms.'
      end,
      'Oldest bill ' || s.oldest_bill_age_days || ' days.',
      case when s.reliability = 'unknown'
           then 'No settled history yet, so behaviour is unrated.'
           else 'Pays ' || s.reliability || '.' end,
      case when s.status = 'legal_notice_sent' then 'A legal notice has been sent.'
           when s.status = 'legal_case_filed'  then 'A legal case has been filed.'
           when s.status = 'in_process'        then 'Being worked outside the normal cycle.'
           else null end,
      case when s.term_is_assumed
           then 'Term is a category default, not an approved one — confirm before escalating.'
           else null end
    )
  from scored s
  order by s.priority_score desc, s.current_outstanding desc
  limit greatest(p_limit, 0);
$$;

grant execute on function fn_priority_list(integer) to authenticated;

-- -------------------------------------------------------------------
-- 7. Category defaults for the new categories
--
-- Still assumptions, never approved terms — writing one onto a party
-- sets credit_source = 'category_default' and every screen that shows it
-- has to say so.
-- -------------------------------------------------------------------
update settings set value = '{
   "hospital":    {"credit_type": "cycle", "cycle_submit_day": 5, "cycle_pay_day": 25, "cycle_lag_months": 1},
   "institution": {"credit_type": "cycle", "cycle_submit_day": 7, "cycle_pay_day": 25, "cycle_lag_months": 1},
   "wholesaler":  {"credit_type": "days",  "credit_days": 45},
   "retailer":    {"credit_type": "days",  "credit_days": 30},
   "doctor":      {"credit_type": "days",  "credit_days": 30},
   "customer":    {"credit_type": "days",  "credit_days": 15},
   "cash":        {"credit_type": "days",  "credit_days": 0}
 }'::jsonb, updated_at = now()
where key = 'category_defaults';
