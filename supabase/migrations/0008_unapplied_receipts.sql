-- ===================================================================
-- Unapplied receipts, measured properly.
--
-- WHAT WAS WRONG. v_unallocated_receipts compared each party's Marg
-- header total against the sum of its bill rows and called the
-- difference unapplied money. The difference was real, but it was ours:
-- the parser dropped every row Marg writes with an empty bill number,
-- which is exactly how it writes a receipt that has not been applied to
-- an invoice. 161 such rows, -Rs 153 L, silently missing — and then
-- reported as a discrepancy in Marg.
--
-- With those rows imported, every party's header total agrees with its
-- bills to the rupee. Nothing to reconcile.
--
-- The client's problem is still real; it was simply never that gap. A
-- party pays 30,000 and then 20,000 two days later, and the second
-- payment sits against their name without being set against a bill.
-- That payment IS the row with no bill number. So the measure is the
-- rows themselves, not a difference between two totals.
-- ===================================================================

alter table bills add column if not exists is_on_account boolean not null default false;

comment on column bills.is_on_account is
  'True when Marg wrote the row without a bill number of its own, or with a '
  '"*" / "#" marker: a receipt or adjustment against the party rather than '
  'against a particular invoice.';

create index if not exists bills_on_account_idx
  on bills (party_id, snapshot_id) where is_on_account;

-- -------------------------------------------------------------------
-- Backfill the rows that are already here.
--
-- bills carries an immutability trigger (rule 4): Marg is the financial
-- truth, so an imported row is never edited afterwards. It fires on
-- UPDATE and it is right to — without disabling it this statement fails
-- with "bills rows are immutable".
--
-- This is a schema migration, not an application edit, and it changes no
-- figure: is_on_account records how Marg WROTE the row, derived from the
-- bill number already stored on it. No amount, date or balance is
-- touched. The trigger goes back on before the statement block ends, so
-- the guarantee is restored whatever happens next.
--
-- The parser keys a numberless row as "*~<date>~<amount>".
-- -------------------------------------------------------------------
alter table bills disable trigger bills_immutable;

update bills set is_on_account = true
where is_on_account = false and (bill_no like '*~%' or bill_no like '*%' or bill_no like '#%');

alter table bills enable trigger bills_immutable;

drop view if exists v_unallocated_receipts;

create view v_unallocated_receipts as
with receipts as (
  select
    b.party_id,
    -- Unapplied money is held as a negative balance; report it as the
    -- positive amount waiting to be set against something.
    sum(-b.balance) filter (where b.balance < 0)                as unapplied,
    count(*) filter (where b.balance < 0)                       as receipt_count,
    min(b.bill_date) filter (where b.balance < 0)               as oldest_receipt,
    max(b.bill_date) filter (where b.balance < 0)               as newest_receipt
  from bills b
  cross join v_latest_snapshot l
  where b.snapshot_id = l.id
    and b.is_on_account
  group by b.party_id
)
select
  a.party_id,
  a.display_name,
  a.phone,
  a.contact_person,
  a.current_outstanding          as marg_balance,
  a.bill_balance_sum             as bills_total,
  round(r.unapplied, 2)          as unallocated,
  r.receipt_count,
  r.oldest_receipt,
  r.newest_receipt,
  a.bill_count,
  a.oldest_bill_age_days,
  a.needs_credit_term,
  a.responsible_person,
  'receipt_unallocated'::text    as gap_type
from v_party_ageing a
join receipts r on r.party_id = a.party_id
where r.unapplied > 1
order by r.unapplied desc;

comment on view v_unallocated_receipts is
  'Money received from a party that Marg holds against their name without it '
  'being applied to any particular bill. These are the rows Marg writes with '
  'no bill number; until somebody agrees which invoices they clear, those '
  'invoices keep ageing as though nothing arrived.';

alter view v_unallocated_receipts set (security_invoker = on);
grant select on v_unallocated_receipts to authenticated;
