-- ===================================================================
-- Neomed Collection Manager — complete schema.
-- Paste into the Supabase SQL editor. Safe to re-run.
-- ===================================================================

-- ############ 0001_schema.sql ############

-- ===================================================================
-- Neomed Collection Manager — schema
-- Build order step 1.
-- ===================================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------------
-- app_users — role carrier, keyed to Supabase auth
-- -------------------------------------------------------------------
create table if not exists app_users (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null,
  role       text not null check (role in ('owner', 'accounts', 'sales')),
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------------
-- snapshots — one Marg export. Immutable once written.
-- -------------------------------------------------------------------
create table if not exists snapshots (
  id            uuid primary key default gen_random_uuid(),
  report_date   date not null,
  uploaded_at   timestamptz not null default now(),
  uploaded_by   uuid references app_users (id),
  file_name     text not null,
  storage_path  text,
  party_count   integer not null default 0,
  bill_count    integer not null default 0,
  total_owed    numeric(14, 2) not null default 0,
  total_credit  numeric(14, 2) not null default 0,
  net_total     numeric(14, 2) not null default 0,
  constraint snapshots_report_date_unique unique (report_date)
);

create index if not exists snapshots_report_date_idx on snapshots (report_date desc);

-- -------------------------------------------------------------------
-- parties
-- -------------------------------------------------------------------
create table if not exists parties (
  id               uuid primary key default gen_random_uuid(),
  display_name     text not null,
  normalised_name  text not null unique,
  aliases          text[] not null default '{}',
  category         text check (category in ('hospital', 'retailer', 'institution', 'cash')),

  -- CREDIT TERMS — two models, both required. Retailers run on days from the
  -- bill date; hospitals and institutions run on a monthly submission/payment
  -- cycle. 19 of the top 20 parties are hospitals, so 'cycle' is the common
  -- case here, not an edge case.
  credit_type       text not null default 'none' check (credit_type in ('days', 'cycle', 'none')),
  credit_days       integer check (credit_days is null or credit_days between 0 and 365),
  cycle_submit_day  integer check (cycle_submit_day is null or cycle_submit_day between 1 and 31),
  cycle_pay_day     integer check (cycle_pay_day is null or cycle_pay_day between 1 and 31),
  cycle_lag_months  integer not null default 0 check (cycle_lag_months between 0 and 6),
  credit_source     text not null default 'not_set'
                      check (credit_source in ('approved', 'category_default', 'not_set')),

  -- Marg's export carries no contact details, so these are entered by hand.
  -- The import payload never includes them, which is what stops a daily file
  -- from wiping a number someone typed in.
  phone              text,
  contact_person     text,

  responsible_person uuid references app_users (id),
  salesperson        uuid references app_users (id),
  status             text not null default 'active'
                       check (status in ('active', 'hold', 'dispute', 'legal', 'write_off')),

  current_outstanding  numeric(14, 2) not null default 0,
  oldest_bill_age_days integer,
  last_snapshot_id     uuid references snapshots (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Each credit model must carry exactly the fields it needs and no others,
  -- so a half-filled term can never be read as a whole one.
  constraint parties_credit_model_coherent check (
    (credit_type = 'days'
      and credit_days is not null
      and cycle_submit_day is null and cycle_pay_day is null)
    or (credit_type = 'cycle'
      and cycle_submit_day is not null and cycle_pay_day is not null
      and credit_days is null)
    or (credit_type = 'none'
      and credit_days is null and cycle_submit_day is null and cycle_pay_day is null)
  ),

  -- RULE 1: an unrecorded term stays unrecorded. 'none' and 'not_set' are the
  -- same fact seen from two angles and may never drift apart, because the
  -- ageing view and the assistant's stop rule both key off them.
  constraint parties_none_implies_not_set check (
    (credit_type = 'none') = (credit_source = 'not_set')
  )
);

create index if not exists parties_outstanding_idx on parties (current_outstanding desc);
create index if not exists parties_credit_source_idx on parties (credit_source);
create index if not exists parties_status_idx on parties (status);

-- -------------------------------------------------------------------
-- bills — the imported rows. Immutable once written.
-- -------------------------------------------------------------------
create table if not exists bills (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references snapshots (id) on delete cascade,
  party_id      uuid not null references parties (id) on delete cascade,
  bill_no       text not null,
  bill_type     text not null default 'OTHER'
                  check (bill_type in ('CRE', 'CN', 'CSHE', 'PDSN', 'OTHER')),
  bill_date     date,
  bill_amount   numeric(14, 2) not null default 0,
  received      numeric(14, 2) not null default 0,
  balance       numeric(14, 2) not null default 0,
  -- Computed from bill_date, so it always means age.
  bill_age_days integer,

  -- Marg's own Due Date and "Days" column, kept verbatim.
  --
  -- The Days column is days PAST DUE, measured from the due date — not bill
  -- age. On most rows Marg's due date equals the bill date and the two read
  -- the same; on the rows where Marg carries a real credit period they
  -- diverge, and the figure goes negative before a bill falls due.
  --
  -- marg_due_date is recorded, never promoted into a credit term: rule 1
  -- names due dates among the things a term may not be derived from. It
  -- surfaces as an import warning for a human to approve or reject.
  marg_due_date date,
  days_past_due integer,
  constraint bills_unique_per_snapshot unique (snapshot_id, bill_no, party_id)
);

create index if not exists bills_party_snapshot_idx on bills (party_id, snapshot_id);
create index if not exists bills_snapshot_balance_idx on bills (snapshot_id, balance);

-- -------------------------------------------------------------------
-- bill_changes — derived payment events. NEVER pruned.
-- -------------------------------------------------------------------
create table if not exists bill_changes (
  id               uuid primary key default gen_random_uuid(),
  party_id         uuid not null references parties (id) on delete cascade,
  bill_no          text not null,
  from_snapshot_id uuid references snapshots (id) on delete set null,
  to_snapshot_id   uuid references snapshots (id) on delete set null,
  from_balance     numeric(14, 2),
  to_balance       numeric(14, 2),
  delta            numeric(14, 2) not null default 0,
  change_type      text not null check (change_type in ('payment', 'new_bill', 'settled', 'increase')),
  detected_from    date,
  detected_to      date,
  created_at       timestamptz not null default now(),
  -- fn_diff_snapshots must be safe to re-run over the same pair.
  constraint bill_changes_idempotent unique (party_id, bill_no, from_snapshot_id, to_snapshot_id)
);

create index if not exists bill_changes_party_idx on bill_changes (party_id, detected_to desc);
create index if not exists bill_changes_type_idx on bill_changes (change_type);

comment on table bill_changes is
  'Derived payment events. The retention job must never prune this table: it is '
  'the only record of when money actually arrived, and deleting it destroys '
  'every behaviour profile permanently.';

-- -------------------------------------------------------------------
-- party_profiles — computed only, never hand-edited
-- -------------------------------------------------------------------
create table if not exists party_profiles (
  party_id             uuid primary key references parties (id) on delete cascade,
  actual_payment_days  integer,
  payment_consistency  numeric(10, 2),
  partial_payment_rate numeric(5, 4) not null default 0,
  settled_bill_count   integer not null default 0,
  reliability          text not null default 'unknown'
                         check (reliability in ('good', 'fair', 'poor', 'unknown')),
  last_payment_date    date,
  last_payment_amount  numeric(14, 2),
  trend_90d            numeric(14, 2),
  computed_at          timestamptz not null default now()
);

-- -------------------------------------------------------------------
-- followups
-- -------------------------------------------------------------------
create table if not exists followups (
  id                 uuid primary key default gen_random_uuid(),
  party_id           uuid not null references parties (id) on delete cascade,
  by_user            uuid references app_users (id),
  contact_date       date not null default current_date,
  method             text not null check (method in ('call', 'visit', 'whatsapp', 'email')),
  outcome            text,
  notes              text,
  next_followup_date date,
  closed             boolean not null default false,
  created_at         timestamptz not null default now()
);

create index if not exists followups_party_idx on followups (party_id, contact_date desc);
create index if not exists followups_next_idx on followups (next_followup_date) where closed = false;

-- -------------------------------------------------------------------
-- promises
-- -------------------------------------------------------------------
create table if not exists promises (
  id               uuid primary key default gen_random_uuid(),
  party_id         uuid not null references parties (id) on delete cascade,
  promised_on      date not null default current_date,
  due_date         date not null,
  promised_amount  numeric(14, 2) not null,
  received_amount  numeric(14, 2) not null default 0,
  status           text not null default 'open' check (status in ('open', 'kept', 'partial', 'broken')),
  -- RULE 5: a promise closes only when a bill_change supports it. Anything
  -- other than 'open' must name the payment events that justify it.
  linked_change_ids uuid[] not null default '{}',
  is_pdc           boolean not null default false,
  cheque_no        text,
  created_at       timestamptz not null default now(),
  -- coalesce matters: array_length of an empty array is NULL, and a CHECK
  -- that evaluates to NULL passes, which would let 'kept' through with no
  -- evidence at all — precisely what rule 5 forbids.
  constraint promises_closed_needs_evidence check (
    status in ('open', 'broken')
    or coalesce(array_length(linked_change_ids, 1), 0) >= 1
  )
);

create index if not exists promises_party_idx on promises (party_id, due_date desc);
create index if not exists promises_status_idx on promises (status);

-- -------------------------------------------------------------------
-- claims
-- -------------------------------------------------------------------
create table if not exists claims (
  id           uuid primary key default gen_random_uuid(),
  party_id     uuid not null references parties (id) on delete cascade,
  claim_type   text not null
                 check (claim_type in ('expiry', 'breakage', 'scheme', 'rate_diff', 'short_supply')),
  raised_on    date not null default current_date,
  claim_value  numeric(14, 2) not null default 0,
  payment_held numeric(14, 2) not null default 0,
  pending_with text,
  status       text not null default 'open' check (status in ('open', 'settled', 'rejected')),
  settled_on   date,
  created_at   timestamptz not null default now()
);

create index if not exists claims_party_open_idx on claims (party_id) where status = 'open';

-- -------------------------------------------------------------------
-- settings
-- -------------------------------------------------------------------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------------------
-- import_warnings
-- -------------------------------------------------------------------
create table if not exists import_warnings (
  id           uuid primary key default gen_random_uuid(),
  snapshot_id  uuid not null references snapshots (id) on delete cascade,
  party_id     uuid references parties (id) on delete set null,
  warning_type text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists import_warnings_snapshot_idx on import_warnings (snapshot_id, warning_type);

-- ===================================================================
-- Immutability — RULE 4. Marg is the financial truth, so an imported
-- row is never edited afterwards. RLS alone would not do: it does not
-- constrain the service role, and the import path runs elevated.
-- ===================================================================
create or replace function fn_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are immutable (rule 4): % attempted on %',
    tg_table_name, tg_op, tg_table_name
    using hint = 'Import a new snapshot instead of editing an imported one.';
end;
$$;

-- UPDATE only, on both tables. Deletion is deliberately left to the retention
-- job, which drops whole snapshots and lets bills cascade; a delete trigger
-- here would block that cascade and make pruning impossible. No application
-- role is granted DELETE (see 0002_rls.sql), so the only route to a delete is
-- the elevated retention routine.
drop trigger if exists bills_immutable on bills;
create trigger bills_immutable
  before update on bills
  for each row execute function fn_block_mutation();

drop trigger if exists snapshots_immutable on snapshots;
create trigger snapshots_immutable
  before update on snapshots
  for each row execute function fn_block_mutation();

comment on function fn_block_mutation is
  'Rejects edits to imported rows (rule 4). Correcting a figure means importing '
  'a new snapshot, never editing an old one.';

-- keep parties.updated_at honest
create or replace function fn_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists parties_touch on parties;
create trigger parties_touch
  before update on parties
  for each row execute function fn_touch_updated_at();

-- ############ 0002_rls.sql ############

-- ===================================================================
-- Row Level Security
--
-- Everyone authenticated reads. Owner and accounts write parties, credit
-- terms and claims. Sales write follow-ups and promises only. Bills and
-- snapshots are insert-only from the import path and never updatable.
-- ===================================================================

-- Role lookup. SECURITY DEFINER so a policy on app_users cannot recurse into
-- itself while the policy is being evaluated; search_path is pinned so the
-- definer's rights cannot be redirected at a shadowed table.
create or replace function app_role()
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select role from app_users where id = auth.uid();
$$;

revoke all on function app_role() from public;
grant execute on function app_role() to authenticated;

create or replace function is_authenticated()
returns boolean
language sql
stable
as $$
  select auth.uid() is not null;
$$;

alter table app_users       enable row level security;
alter table snapshots       enable row level security;
alter table parties         enable row level security;
alter table bills           enable row level security;
alter table bill_changes    enable row level security;
alter table party_profiles  enable row level security;
alter table followups       enable row level security;
alter table promises        enable row level security;
alter table claims          enable row level security;
alter table settings        enable row level security;
alter table import_warnings enable row level security;

-- -------------------------------------------------------------------
-- Table privileges. Stated explicitly rather than leaning on Supabase's
-- bootstrap grants, so this schema behaves the same on any Postgres.
-- RLS above narrows all of it; note that bills and snapshots are never
-- granted UPDATE or DELETE to anyone.
-- -------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on parties, claims, followups, promises, settings, app_users
  to authenticated;
grant insert on snapshots, bills, import_warnings to authenticated;

-- -------------------------------------------------------------------
-- Read: every authenticated user sees everything.
-- -------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'app_users', 'snapshots', 'parties', 'bills', 'bill_changes',
    'party_profiles', 'followups', 'promises', 'claims', 'settings', 'import_warnings'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format(
      'create policy %I on %I for select to authenticated using (is_authenticated())',
      t || '_read', t
    );
  end loop;
end $$;

-- -------------------------------------------------------------------
-- parties — owner and accounts only. Credit terms live here, so this is
-- the policy that protects rule 1.
-- -------------------------------------------------------------------
drop policy if exists parties_write on parties;
create policy parties_write on parties
  for all to authenticated
  using (app_role() in ('owner', 'accounts'))
  with check (app_role() in ('owner', 'accounts'));

-- -------------------------------------------------------------------
-- claims — owner and accounts only.
-- -------------------------------------------------------------------
drop policy if exists claims_write on claims;
create policy claims_write on claims
  for all to authenticated
  using (app_role() in ('owner', 'accounts'))
  with check (app_role() in ('owner', 'accounts'));

-- -------------------------------------------------------------------
-- followups and promises — sales may write these, and so may the other
-- two roles.
-- -------------------------------------------------------------------
drop policy if exists followups_write on followups;
create policy followups_write on followups
  for all to authenticated
  using (app_role() in ('owner', 'accounts', 'sales'))
  with check (app_role() in ('owner', 'accounts', 'sales'));

drop policy if exists promises_write on promises;
create policy promises_write on promises
  for all to authenticated
  using (app_role() in ('owner', 'accounts', 'sales'))
  with check (app_role() in ('owner', 'accounts', 'sales'));

-- -------------------------------------------------------------------
-- snapshots and bills — INSERT only, and only for owner/accounts, who are
-- the roles that run an import. No update policy and no delete policy
-- exists for either table, so neither operation is reachable from the
-- client under any role. Pruning runs elevated, outside RLS.
-- -------------------------------------------------------------------
drop policy if exists snapshots_insert on snapshots;
create policy snapshots_insert on snapshots
  for insert to authenticated
  with check (app_role() in ('owner', 'accounts'));

drop policy if exists bills_insert on bills;
create policy bills_insert on bills
  for insert to authenticated
  with check (app_role() in ('owner', 'accounts'));

drop policy if exists import_warnings_insert on import_warnings;
create policy import_warnings_insert on import_warnings
  for insert to authenticated
  with check (app_role() in ('owner', 'accounts'));

-- -------------------------------------------------------------------
-- settings — owner only.
-- -------------------------------------------------------------------
drop policy if exists settings_write on settings;
create policy settings_write on settings
  for all to authenticated
  using (app_role() = 'owner')
  with check (app_role() = 'owner');

-- -------------------------------------------------------------------
-- app_users — owner manages the team. A user may not change their own role.
-- -------------------------------------------------------------------
drop policy if exists app_users_write on app_users;
create policy app_users_write on app_users
  for all to authenticated
  using (app_role() = 'owner')
  with check (app_role() = 'owner');

-- -------------------------------------------------------------------
-- bill_changes and party_profiles — derived tables. Read-only to every
-- client; written only by the scheduled Edge Functions, which connect with
-- the service role and bypass RLS. No write policy is defined on purpose.
-- -------------------------------------------------------------------
comment on table party_profiles is
  'Computed by fn_compute_profiles. No client write policy exists: a profile '
  'is derived from bill_changes and must never be hand-edited.';

-- ############ 0003_ageing.sql ############

-- ===================================================================
-- Ageing. Build order step 3.
--
-- The logic lives here, not in React: one definition, one answer, and the
-- assistant and the screens cannot drift apart.
-- ===================================================================

-- -------------------------------------------------------------------
-- fn_expected_due_date — the two credit models
--
-- 'days'  : bill_date + credit_days.
--
-- 'cycle' : bills must reach the party by cycle_submit_day to make that
--           month's run; payment is released on cycle_pay_day, cycle_lag_months
--           later. A bill that misses the window waits for the next cycle,
--           and that wait is normal for the party, not lateness.
--
--           submit 5th, pay 25th, lag 1 —
--             bill 3 Aug  -> made the August window  -> due 25 Sep
--             bill 8 Aug  -> missed it, rides September -> due 25 Oct
--
-- 'none'  : NULL. There is no due date to infer, and inferring one is
--           exactly what rule 1 forbids.
-- -------------------------------------------------------------------
create or replace function fn_expected_due_date(
  p_bill_date   date,
  p_credit_type text,
  p_credit_days integer,
  p_submit_day  integer,
  p_pay_day     integer,
  p_lag_months  integer
) returns date
language plpgsql
immutable
as $$
declare
  v_month_start   date;
  v_days_in_month integer;
begin
  if p_bill_date is null then
    return null;
  end if;

  if p_credit_type = 'days' then
    if p_credit_days is null then
      return null;
    end if;
    return p_bill_date + p_credit_days;
  end if;

  if p_credit_type = 'cycle' then
    if p_submit_day is null or p_pay_day is null then
      return null;
    end if;

    v_month_start := date_trunc('month', p_bill_date)::date;

    -- Past the submission day means this month's run was missed.
    if extract(day from p_bill_date)::integer > p_submit_day then
      v_month_start := (v_month_start + interval '1 month')::date;
    end if;

    v_month_start := (v_month_start + make_interval(months => coalesce(p_lag_months, 0)))::date;

    -- A pay day of 31 in a 30-day month means the last day of that month,
    -- not the 1st of the next.
    v_days_in_month := extract(day from (v_month_start + interval '1 month' - interval '1 day'))::integer;

    return v_month_start + (least(p_pay_day, v_days_in_month) - 1);
  end if;

  return null;  -- 'none'
end;
$$;

comment on function fn_expected_due_date is
  'Expected due date from a party''s credit model. Returns NULL for credit_type '
  '''none'' — an unrecorded term is never estimated (rule 1).';

-- Databases created before contact details existed need these before the
-- view below can reference them. Idempotent, and a no-op on a fresh install
-- where 0001 already added them.
alter table parties add column if not exists phone text;
alter table parties add column if not exists contact_person text;

-- -------------------------------------------------------------------
-- v_latest_snapshot
-- -------------------------------------------------------------------
-- CASCADE because later migrations build views on top of these, and a
-- column cannot be added to a view in place. Everything dropped here is
-- recreated by the migration that owns it, further down the same run.
drop view if exists v_portfolio_ageing cascade;
drop view if exists v_party_ageing cascade;
drop view if exists v_latest_snapshot cascade;

create view v_latest_snapshot as
  select *
  from snapshots
  order by report_date desc
  limit 1;

-- -------------------------------------------------------------------
-- v_party_ageing
--
-- Four bucket totals per party for the latest snapshot, measured against
-- overdue_days and never against bill age, then scaled so they sum to
-- parties.current_outstanding — the header figure, which is what the owner
-- sees in Marg.
--
-- Buckets are NULL, not zero, when the party has no recorded term. Zero
-- would read as "nothing is overdue"; NULL reads as "we cannot say", which
-- is the truth and is what the stop rule depends on.
-- -------------------------------------------------------------------
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
    sum(balance)                                                              as bill_balance_sum,
    sum(balance) filter (where overdue_days is not null and overdue_days <= 0) as within_terms,
    sum(balance) filter (where overdue_days between 1 and 30)                  as over_1_30,
    sum(balance) filter (where overdue_days between 31 and 60)                 as over_31_60,
    sum(balance) filter (where overdue_days > 60)                              as over_60,
    max(overdue_days)                                                          as max_overdue_days,
    count(*)                                                                   as bill_count,
    -- A bill with no readable date cannot be placed in any bucket; if any
    -- exist the buckets below are incomplete and must say so.
    count(*) filter (where overdue_days is null)                               as unplaceable_bills
  from scored_bills
  group by party_id
),
scaled as (
  select
    p.id as party_id,
    p.display_name,
    p.normalised_name,
    p.category,
    p.phone,
    p.contact_person,
    p.responsible_person,
    p.status,
    p.credit_type,
    p.credit_source,
    p.credit_days,
    p.cycle_submit_day,
    p.cycle_pay_day,
    p.cycle_lag_months,
    p.current_outstanding,
    p.oldest_bill_age_days,
    coalesce(rb.bill_count, 0)       as bill_count,
    rb.bill_balance_sum,
    rb.max_overdue_days,
    coalesce(rb.unplaceable_bills, 0) as unplaceable_bills,
    p.credit_source = 'not_set'      as needs_credit_term,
    -- Rule 2: a category default is a working assumption, not an approved
    -- term. Everything downstream must label it as one.
    p.credit_source = 'category_default' as term_is_assumed,
    p.current_outstanding < 0        as is_credit_balance,
    -- Rule 3: bill rows only ever supply the SHAPE of the ageing. The header
    -- total supplies the size, and this ratio maps one onto the other.
    case
      when rb.bill_balance_sum is null or rb.bill_balance_sum = 0 then null
      else p.current_outstanding / rb.bill_balance_sum
    end as reconcile_ratio,
    rb.within_terms, rb.over_1_30, rb.over_31_60, rb.over_60
  from parties p
  left join raw_buckets rb on rb.party_id = p.id
)
select
  party_id,
  display_name,
  normalised_name,
  category,
  phone,
  contact_person,
  responsible_person,
  status,
  credit_type,
  credit_source,
  credit_days,
  cycle_submit_day,
  cycle_pay_day,
  cycle_lag_months,
  current_outstanding,
  oldest_bill_age_days,
  bill_count,
  bill_balance_sum,
  reconcile_ratio,
  max_overdue_days,
  unplaceable_bills,
  needs_credit_term,
  term_is_assumed,
  is_credit_balance,
  case when needs_credit_term then null
       else round(coalesce(within_terms, 0) * coalesce(reconcile_ratio, 1), 2) end as within_terms,
  case when needs_credit_term then null
       else round(coalesce(over_1_30,   0) * coalesce(reconcile_ratio, 1), 2) end as over_1_30,
  case when needs_credit_term then null
       else round(coalesce(over_31_60,  0) * coalesce(reconcile_ratio, 1), 2) end as over_31_60,
  case when needs_credit_term then null
       else round(coalesce(over_60,     0) * coalesce(reconcile_ratio, 1), 2) end as over_60
from scaled;

comment on view v_party_ageing is
  'Per-party ageing for the latest snapshot. Buckets are measured against '
  'overdue_days (never bill age), scaled to the Marg header total, and NULL '
  'wherever no credit term is recorded.';

-- -------------------------------------------------------------------
-- v_portfolio_ageing — the dashboard strip.
--
-- Judgeable money only. Parties with no term are reported as their own
-- figure rather than folded in, because adding them would present age as
-- lateness for 612 of the 819 parties.
-- -------------------------------------------------------------------
create view v_portfolio_ageing as
select
  coalesce(sum(within_terms) filter (where not needs_credit_term and not is_credit_balance), 0) as within_terms,
  coalesce(sum(over_1_30)    filter (where not needs_credit_term and not is_credit_balance), 0) as over_1_30,
  coalesce(sum(over_31_60)   filter (where not needs_credit_term and not is_credit_balance), 0) as over_31_60,
  coalesce(sum(over_60)      filter (where not needs_credit_term and not is_credit_balance), 0) as over_60,
  coalesce(sum(current_outstanding) filter (where needs_credit_term and current_outstanding > 0), 0) as unjudgeable_amount,
  count(*) filter (where needs_credit_term)                       as unjudgeable_parties,
  coalesce(sum(current_outstanding) filter (where current_outstanding > 0), 0) as total_owed,
  coalesce(sum(current_outstanding) filter (where current_outstanding < 0), 0) as total_credit,
  coalesce(sum(current_outstanding), 0)                            as net_total,
  count(*)                                                         as party_count
from v_party_ageing;

-- -------------------------------------------------------------------
-- Views run with the caller's rights, not the owner's. Without this a
-- view silently bypasses RLS on the tables beneath it — harmless while
-- every authenticated user may read everything, but it would stop being
-- harmless the moment that changes.
-- -------------------------------------------------------------------
alter view v_latest_snapshot   set (security_invoker = on);
alter view v_party_ageing      set (security_invoker = on);
alter view v_portfolio_ageing  set (security_invoker = on);

-- A dropped view loses its grants, and these are rebuilt rather than replaced
-- (a view's column list cannot be changed in place). Granting here, in the
-- migration that creates them, keeps the two in step — relying on the blanket
-- grant in 0002 would leave them unreadable, since that runs first.
grant select on v_latest_snapshot, v_party_ageing, v_portfolio_ageing to authenticated;

-- ############ 0004_priority.sql ############

-- ===================================================================
-- Priority ranking. Build order step 3.
-- ===================================================================

-- -------------------------------------------------------------------
-- fn_fmt_inr — rule 7. One definition of how money reads, shared by the
-- reason strings and anything else that has to render a figure in SQL.
-- -------------------------------------------------------------------
create or replace function fn_fmt_inr(v numeric)
returns text
language sql
immutable
as $$
  -- The sign sits outside the rupee symbol (−₹12.61 L), which is how the
  -- credit balances are written throughout the spec.
  select case
    when v is null then '—'
    else (case when v < 0 then '−' else '' end)
      || case
           when abs(v) >= 10000000 then '₹' || to_char(abs(v) / 10000000, 'FM999990.00') || ' Cr'
           when abs(v) >= 100000   then '₹' || to_char(abs(v) / 100000,   'FM999990.00') || ' L'
           else '₹' || to_char(round(abs(v)), 'FM99,99,99,990')
         end
  end;
$$;

-- -------------------------------------------------------------------
-- fn_setting_numeric — a setting with a fallback, so a missing row cannot
-- silently change a threshold.
-- -------------------------------------------------------------------
create or replace function fn_setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
as $$
  select coalesce((select (value #>> '{}')::numeric from settings where key = p_key), p_default);
$$;

-- -------------------------------------------------------------------
-- fn_priority_list — who to work first.
--
--   score = outstanding × log(max(overdue_days,1) + 1) × reliability_weight
--
-- Exclusions are as important as the ranking. A party held up by our own
-- open claim is not a defaulter and belongs in Claims; a party with no
-- recorded term cannot be called late at all.
-- -------------------------------------------------------------------
create or replace function fn_priority_list(p_limit integer default 20)
returns table (
  rank              integer,
  party_id          uuid,
  display_name      text,
  current_outstanding numeric,
  oldest_bill_age_days integer,
  max_overdue_days  integer,
  within_terms      numeric,
  over_1_30         numeric,
  over_31_60        numeric,
  over_60           numeric,
  reliability       text,
  term_is_assumed   boolean,
  priority_score    numeric,
  reason            text
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
        when 'good' then 1.0
        when 'fair' then 1.4
        when 'poor' then 1.9
        else 1.2
      end as reliability_weight
    from v_party_ageing a
    left join party_profiles pp on pp.party_id = a.party_id
    cross join threshold t
    where
      -- held by our own pending action: a claims problem, not a collection one
      not exists (
        select 1 from claims c
        where c.party_id = a.party_id and c.status = 'open'
      )
      and a.status not in ('dispute', 'legal', 'write_off')
      -- rule 1: no recorded term means no judgement of lateness
      and not a.needs_credit_term
      and a.current_outstanding > 0
      and a.current_outstanding >= t.small_balance
  ),
  scored as (
    select
      e.*,
      -- ln() yields double precision, so the product is cast back to numeric
      -- before rounding: round(double precision, int) has no signature, and
      -- money stays numeric everywhere else.
      round(
        (e.current_outstanding
         * ln(greatest(coalesce(e.max_overdue_days, 0), 1) + 1)
         * e.reliability_weight)::numeric
      , 2) as priority_score
    from eligible e
  )
  select
    row_number() over (order by s.priority_score desc, s.current_outstanding desc)::integer as rank,
    s.party_id,
    s.display_name,
    s.current_outstanding,
    s.oldest_bill_age_days,
    s.max_overdue_days,
    s.within_terms,
    s.over_1_30,
    s.over_31_60,
    s.over_60,
    s.reliability,
    s.term_is_assumed,
    s.priority_score,
    -- Built from this party's own figures. Nothing here is boilerplate, and
    -- an assumed term always says so (rule 2).
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
        else
          fn_fmt_inr(s.current_outstanding) || ' outstanding, all of it within terms.'
      end,
      'Oldest bill ' || s.oldest_bill_age_days || ' days.',
      case
        when s.reliability = 'unknown' then 'No settled history yet, so behaviour is unrated.'
        else 'Pays ' || s.reliability || '.'
      end,
      case
        when s.term_is_assumed then 'Term is a category default, not an approved one — confirm before escalating.'
        else null
      end
    ) as reason
  from scored s
  order by s.priority_score desc, s.current_outstanding desc
  limit greatest(p_limit, 0);
$$;

comment on function fn_priority_list is
  'Ranked collection list for the latest snapshot. Excludes claim-blocked, '
  'disputed/legal/written-off, term-less, sub-threshold and non-positive '
  'parties. Reason strings are generated from each party''s own figures.';

-- -------------------------------------------------------------------
-- fn_needs_credit_term — the work queue behind the credit master, and the
-- figure the assistant quotes when it has to refuse a question.
-- -------------------------------------------------------------------
create or replace function fn_needs_credit_term(p_limit integer default 100)
returns table (
  rank                 integer,
  party_id             uuid,
  display_name         text,
  category             text,
  current_outstanding  numeric,
  oldest_bill_age_days integer,
  bill_count           integer
)
language sql
stable
as $$
  select
    row_number() over (order by a.current_outstanding desc)::integer as rank,
    a.party_id, a.display_name, a.category,
    a.current_outstanding, a.oldest_bill_age_days, a.bill_count
  from v_party_ageing a
  where a.needs_credit_term and a.current_outstanding > 0
  order by a.current_outstanding desc
  limit greatest(p_limit, 0);
$$;

-- ############ 0005_seed_settings.sql ############

-- ===================================================================
-- Settings defaults.
-- ===================================================================

insert into settings (key, value) values
  ('small_balance_threshold', '10000'::jsonb)
on conflict (key) do nothing;

-- Category defaults are ASSUMPTIONS. Writing one onto a party sets
-- credit_source = 'category_default', never 'approved', and every screen
-- that shows it has to say so (rule 2).
insert into settings (key, value) values
  ('category_defaults', '{
     "hospital":    {"credit_type": "cycle", "cycle_submit_day": 5, "cycle_pay_day": 25, "cycle_lag_months": 1},
     "institution": {"credit_type": "cycle", "cycle_submit_day": 7, "cycle_pay_day": 25, "cycle_lag_months": 1},
     "retailer":    {"credit_type": "days",  "credit_days": 30},
     "cash":        {"credit_type": "days",  "credit_days": 0}
   }'::jsonb)
on conflict (key) do nothing;

insert into settings (key, value) values
  ('retention_policy', '{
     "daily_days": 90,
     "weekly_until_days": 365,
     "weekly_keep_dow": 1,
     "monthly_after_days": 365,
     "never_prune": ["bill_changes"]
   }'::jsonb)
on conflict (key) do nothing;

-- ############ 0006_diff_profiles.sql ############

-- ===================================================================
-- Snapshot diffing and behaviour profiles. Build order step 8.
--
-- This is where the product stops describing today and starts knowing
-- how a party actually behaves. Marg holds no payment history, so the
-- history is DERIVED by comparing consecutive snapshots: a balance that
-- fell is money that arrived.
-- ===================================================================

-- bill_changes must survive the retention job, which prunes old snapshots.
-- Once the source snapshot is gone the bill row goes with it, so the bill's
-- own date has to live on the change record or every profile silently loses
-- its history.
alter table bill_changes add column if not exists bill_date date;

-- -------------------------------------------------------------------
-- fn_diff_snapshots — what moved between two snapshots.
--
-- Idempotent: re-running over the same pair changes nothing, which matters
-- because the import path and the nightly job can both reach for it.
-- -------------------------------------------------------------------
create or replace function fn_diff_snapshots(p_from uuid, p_to uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_from_date date;
  v_to_date   date;
  v_inserted  integer;
begin
  select report_date into v_from_date from snapshots where id = p_from;
  select report_date into v_to_date   from snapshots where id = p_to;

  if v_from_date is null or v_to_date is null then
    raise exception 'fn_diff_snapshots: snapshot not found (from=%, to=%)', p_from, p_to;
  end if;
  if v_from_date >= v_to_date then
    raise exception 'fn_diff_snapshots: % is not earlier than %', v_from_date, v_to_date;
  end if;

  with a as (
    select party_id, bill_no, balance, bill_date
    from bills where snapshot_id = p_from
  ),
  b as (
    select party_id, bill_no, balance, bill_date
    from bills where snapshot_id = p_to
  ),
  joined as (
    select
      coalesce(a.party_id, b.party_id) as party_id,
      coalesce(a.bill_no,  b.bill_no)  as bill_no,
      coalesce(a.bill_date, b.bill_date) as bill_date,
      a.balance as from_balance,
      b.balance as to_balance
    from a
    full outer join b
      on a.party_id = b.party_id and a.bill_no = b.bill_no
  ),
  classified as (
    select
      party_id, bill_no, bill_date, from_balance, to_balance,
      case
        -- Gone from the newer file: paid off and dropped by Marg.
        when to_balance is null   then 'settled'
        -- Absent from the older file: newly billed.
        when from_balance is null then 'new_bill'
        when to_balance < from_balance then 'payment'
        when to_balance > from_balance then 'increase'
        else null                      -- unchanged; not an event
      end as change_type,
      case
        when to_balance is null   then from_balance          -- whole balance cleared
        when from_balance is null then to_balance            -- whole balance added
        else to_balance - from_balance
      end as delta
    from joined
  )
  insert into bill_changes (
    party_id, bill_no, bill_date, from_snapshot_id, to_snapshot_id,
    from_balance, to_balance, delta, change_type, detected_from, detected_to
  )
  select
    party_id, bill_no, bill_date, p_from, p_to,
    from_balance, to_balance,
    -- A payment is stored as a positive amount of money received.
    case when change_type in ('payment', 'settled') then abs(delta) else delta end,
    change_type, v_from_date, v_to_date
  from classified
  where change_type is not null
  on conflict (party_id, bill_no, from_snapshot_id, to_snapshot_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function fn_diff_snapshots is
  'Derives payment events between two snapshots. Idempotent. Payments and '
  'settlements are stored as positive amounts received.';

-- -------------------------------------------------------------------
-- fn_diff_latest — diff the two most recent snapshots. What the import
-- path calls once a new file lands.
-- -------------------------------------------------------------------
create or replace function fn_diff_latest()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_to uuid;
  v_from uuid;
begin
  select id into v_to from snapshots order by report_date desc limit 1;
  select id into v_from from snapshots order by report_date desc offset 1 limit 1;
  if v_from is null or v_to is null then
    return 0;  -- need two snapshots before anything can be compared
  end if;
  return fn_diff_snapshots(v_from, v_to);
end;
$$;

-- -------------------------------------------------------------------
-- fn_compute_profiles — how each party actually pays.
--
-- Everything here comes from bill_changes, never from a person's opinion.
-- A party stays 'unknown' with NULL days until at least three of its bills
-- have been settled: two data points is an anecdote, not a pattern.
-- -------------------------------------------------------------------
create or replace function fn_compute_profiles()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count integer;
begin
  with settled as (
    -- A bill is settled when it disappears, or when its balance reaches nil.
    select
      bc.party_id,
      bc.bill_no,
      bc.bill_date,
      bc.detected_to as settled_on,
      bc.detected_to - bc.bill_date as days_to_settle
    from bill_changes bc
    where bc.change_type = 'settled'
      and bc.bill_date is not null
  ),
  instalments as (
    -- Money-movement events per finished bill. The final clearing shows up as
    -- 'settled', not 'payment', so counting payments alone would read a bill
    -- that was part-paid and then cleared as a single instalment.
    -- Only bills that actually finished are counted, since a bill still being
    -- paid down cannot yet be called partial or not.
    select bc.party_id, bc.bill_no, count(*) as payment_events
    from bill_changes bc
    where bc.change_type in ('payment', 'settled')
      and exists (
        select 1 from bill_changes s
        where s.party_id = bc.party_id and s.bill_no = bc.bill_no and s.change_type = 'settled'
      )
    group by bc.party_id, bc.bill_no
  ),
  last_payment as (
    select distinct on (party_id)
      party_id, detected_to as paid_on, delta as amount
    from bill_changes
    where change_type in ('payment', 'settled')
    order by party_id, detected_to desc, delta desc
  ),
  recent as (
    select party_id, sum(delta) as received_90d
    from bill_changes
    where change_type in ('payment', 'settled')
      and detected_to >= current_date - 90
    group by party_id
  ),
  agg as (
    select
      s.party_id,
      count(*)                                                   as settled_bill_count,
      percentile_cont(0.5) within group (order by s.days_to_settle) as median_days,
      stddev_samp(s.days_to_settle)                              as consistency
    from settled s
    group by s.party_id
  ),
  partials as (
    select
      party_id,
      count(*) filter (where payment_events > 1)::numeric
        / nullif(count(*), 0) as partial_rate
    from instalments
    group by party_id
  ),
  final as (
    select
      p.id as party_id,
      coalesce(a.settled_bill_count, 0) as settled_bill_count,
      case when coalesce(a.settled_bill_count, 0) >= 3
           then round(a.median_days)::integer end as actual_payment_days,
      case when coalesce(a.settled_bill_count, 0) >= 3
           then round(a.consistency, 2) end as payment_consistency,
      coalesce(round(pt.partial_rate, 4), 0) as partial_payment_rate,
      lp.paid_on  as last_payment_date,
      lp.amount   as last_payment_amount,
      coalesce(r.received_90d, 0) as trend_90d,
      -- The expected term this party is being measured against. A party with
      -- no recorded term can still be rated, because the rating is about
      -- consistency rather than lateness.
      case
        when p.credit_type = 'days' then p.credit_days
        when p.credit_type = 'cycle' then 45   -- a cycle's typical wait
        else null
      end as expected_days,
      a.median_days,
      a.consistency
    from parties p
    left join agg a       on a.party_id = p.id
    left join partials pt on pt.party_id = p.id
    left join last_payment lp on lp.party_id = p.id
    left join recent r    on r.party_id = p.id
  )
  insert into party_profiles (
    party_id, actual_payment_days, payment_consistency, partial_payment_rate,
    settled_bill_count, reliability, last_payment_date, last_payment_amount,
    trend_90d, computed_at
  )
  select
    party_id, actual_payment_days, payment_consistency, partial_payment_rate,
    settled_bill_count,
    case
      when settled_bill_count < 3 then 'unknown'
      when expected_days is null then
        -- No term to compare against, so rate on steadiness alone.
        case when consistency <= 15 then 'good'
             when consistency <= 35 then 'fair'
             else 'poor' end
      when median_days > expected_days + 30 then 'poor'
      when median_days <= expected_days + 7 and consistency <= 20 then 'good'
      else 'fair'
    end,
    last_payment_date, last_payment_amount, trend_90d, now()
  from final
  on conflict (party_id) do update set
    actual_payment_days  = excluded.actual_payment_days,
    payment_consistency  = excluded.payment_consistency,
    partial_payment_rate = excluded.partial_payment_rate,
    settled_bill_count   = excluded.settled_bill_count,
    reliability          = excluded.reliability,
    last_payment_date    = excluded.last_payment_date,
    last_payment_amount  = excluded.last_payment_amount,
    trend_90d            = excluded.trend_90d,
    computed_at          = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function fn_compute_profiles is
  'Recomputes every party_profiles row from bill_changes. Returns unknown and '
  'NULL payment days until a party has at least three settled bills.';

-- -------------------------------------------------------------------
-- fn_what_changed — the movement between the last two snapshots, as the
-- dashboard and the assistant both want it.
-- -------------------------------------------------------------------
create or replace function fn_what_changed()
returns table (
  from_date       date,
  to_date         date,
  payments_count  integer,
  payments_value  numeric,
  settled_count   integer,
  settled_value   numeric,
  new_bill_count  integer,
  new_bill_value  numeric,
  increase_count  integer,
  increase_value  numeric,
  net_change      numeric
)
language sql
stable
as $$
  with pair as (
    select
      (select id from snapshots order by report_date desc offset 1 limit 1) as from_id,
      (select id from snapshots order by report_date desc limit 1)          as to_id
  )
  select
    min(bc.detected_from), max(bc.detected_to),
    count(*) filter (where bc.change_type = 'payment')::integer,
    coalesce(sum(bc.delta) filter (where bc.change_type = 'payment'), 0),
    count(*) filter (where bc.change_type = 'settled')::integer,
    coalesce(sum(bc.delta) filter (where bc.change_type = 'settled'), 0),
    count(*) filter (where bc.change_type = 'new_bill')::integer,
    coalesce(sum(bc.delta) filter (where bc.change_type = 'new_bill'), 0),
    count(*) filter (where bc.change_type = 'increase')::integer,
    coalesce(sum(bc.delta) filter (where bc.change_type = 'increase'), 0),
    coalesce(sum(case when bc.change_type in ('payment', 'settled') then -bc.delta else bc.delta end), 0)
  from bill_changes bc
  cross join pair
  where bc.from_snapshot_id = pair.from_id and bc.to_snapshot_id = pair.to_id;
$$;

-- -------------------------------------------------------------------
-- RULE 5 — a promise closes only when a payment supports it.
--
-- Matches open promises against money that actually arrived between the
-- promise date and a few days past its due date. Nothing here can mark a
-- promise kept by hand; the evidence is recorded alongside the status.
-- -------------------------------------------------------------------
create or replace function fn_settle_promises(p_grace_days integer default 3)
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count integer;
begin
  with evidence as (
    select
      pr.id as promise_id,
      pr.promised_amount,
      coalesce(sum(bc.delta), 0) as received,
      array_remove(array_agg(bc.id), null) as change_ids
    from promises pr
    left join bill_changes bc
      on bc.party_id = pr.party_id
     and bc.change_type in ('payment', 'settled')
     and bc.detected_to >= pr.promised_on
     and bc.detected_to <= pr.due_date + p_grace_days
    where pr.status = 'open'
    group by pr.id, pr.promised_amount
  ),
  decided as (
    select
      promise_id, received, change_ids,
      case
        when received >= promised_amount then 'kept'
        when received > 0                then 'partial'
        -- Nothing arrived and the window has closed.
        when current_date > (select due_date + p_grace_days from promises where id = promise_id)
                                         then 'broken'
        else null                        -- still open, still time
      end as new_status
    from evidence
  )
  update promises pr
  set status = d.new_status,
      received_amount = d.received,
      linked_change_ids = d.change_ids
  from decided d
  where pr.id = d.promise_id
    and d.new_status is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function fn_settle_promises is
  'Closes promises against derived payment events only (rule 5). A promise '
  'marked kept or partial always names the bill_changes that justify it.';

revoke all on function fn_diff_snapshots(uuid, uuid) from public;
revoke all on function fn_compute_profiles() from public;
revoke all on function fn_settle_promises(integer) from public;
grant execute on function fn_diff_snapshots(uuid, uuid) to authenticated;
grant execute on function fn_diff_latest() to authenticated;
grant execute on function fn_compute_profiles() to authenticated;
grant execute on function fn_settle_promises(integer) to authenticated;
grant execute on function fn_what_changed() to authenticated;

-- ############ 0007_recovery.sql ############

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

-- ############ 0008_unapplied_receipts.sql ############

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

-- Existing rows: the parser keys a numberless row as "*~<date>~<amount>".
update bills set is_on_account = true
where is_on_account = false and (bill_no like '*~%' or bill_no like '*%' or bill_no like '#%');

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
