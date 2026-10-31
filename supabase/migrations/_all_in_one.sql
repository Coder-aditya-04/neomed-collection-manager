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
-- Dropped rather than replaced: a later migration widens the returned
-- columns, and Postgres refuses to replace a function whose OUT parameters
-- differ. Without this, re-running the migrations in order fails here.
drop function if exists fn_priority_list(integer);

create function fn_priority_list(p_limit integer default 20)
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
-- Dropped first: a later migration widens this view, and Postgres refuses
-- to replace a view with fewer columns than it has. Without the drop, re-
-- running the migrations in order fails here.
drop view if exists v_recovery_activity;
create view v_recovery_activity as
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


-- ############ 0009_buckets_categories_status.sql ############

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


-- ############ 0010_analytics.sql ############

-- ===================================================================
-- Analytics.
--
-- Everything here is derived from data already recorded — snapshots and
-- bill_changes. Nothing is modelled, projected or smoothed: a trend line
-- that invents points between two imports would be a drawing, not a
-- measurement, and the owner would make decisions on it.
-- ===================================================================

-- -------------------------------------------------------------------
-- v_book_trend — the book, import by import.
--
-- One row per snapshot. This is the only honest time series available:
-- the book is only known on the days somebody exported it.
-- -------------------------------------------------------------------
create or replace view v_book_trend as
select
  s.id as snapshot_id,
  s.report_date,
  s.party_count,
  s.bill_count,
  s.total_owed,
  s.total_credit,
  s.net_total,
  s.net_total - lag(s.net_total) over (order by s.report_date) as change_from_previous,
  s.report_date - lag(s.report_date) over (order by s.report_date) as days_since_previous
from snapshots s
order by s.report_date;

-- -------------------------------------------------------------------
-- v_collection_trend — money observed arriving, per import interval.
--
-- Derived from bill_changes: a balance that fell between two snapshots
-- is money that came in. It measures what the exports reveal, which is
-- not the same as every rupee banked — a bill paid and re-billed between
-- two files nets to nothing and is invisible. Labelled as observed for
-- that reason.
-- -------------------------------------------------------------------
create or replace view v_collection_trend as
select
  bc.detected_to                                        as on_date,
  bc.detected_from                                      as since_date,
  sum(bc.delta) filter (where bc.change_type in ('payment','settled'))  as collected,
  count(*) filter (where bc.change_type = 'payment')::int              as part_payments,
  count(*) filter (where bc.change_type = 'settled')::int              as bills_cleared,
  sum(bc.delta) filter (where bc.change_type = 'new_bill')             as new_billing,
  count(distinct bc.party_id) filter (where bc.change_type in ('payment','settled'))::int as paying_parties
from bill_changes bc
group by bc.detected_to, bc.detected_from
order by bc.detected_to;

-- -------------------------------------------------------------------
-- v_category_exposure — where the money sits by trade category.
-- -------------------------------------------------------------------
create or replace view v_category_exposure as
select
  coalesce(a.category, 'uncategorised')                          as category,
  count(*)::int                                                  as party_count,
  coalesce(sum(a.current_outstanding) filter (where a.current_outstanding > 0), 0) as owed,
  coalesce(sum(a.over_60), 0)                                    as over_60,
  count(*) filter (where a.needs_credit_term)::int               as without_term,
  coalesce(avg(pp.actual_payment_days) filter (where pp.actual_payment_days is not null), null) as avg_payment_days
from v_party_ageing a
left join party_profiles pp on pp.party_id = a.party_id
group by coalesce(a.category, 'uncategorised')
order by owed desc;

-- -------------------------------------------------------------------
-- fn_collection_cycle — how long Neomed actually waits to be paid.
--
-- The client asked for two figures: the average repaying days of one
-- party, and Neomed's own cycle overall. The first is already on
-- party_profiles. This is the second.
--
-- The median is reported alongside the mean on purpose. A handful of
-- very old bills drags an average badly, and the owner would read the
-- inflated number as typical. Where they disagree, the median is the
-- one that describes an ordinary invoice.
-- -------------------------------------------------------------------
create or replace function fn_collection_cycle()
returns table (
  rated_parties      integer,
  settled_bills      integer,
  mean_days          numeric,
  median_days        numeric,
  p90_days           numeric,
  fastest_days       integer,
  slowest_days       integer
)
language sql
stable
as $$
  with settled as (
    select bc.detected_to - bc.bill_date as days
    from bill_changes bc
    where bc.change_type = 'settled'
      and bc.bill_date is not null
      and bc.detected_to - bc.bill_date between 0 and 3650
  )
  select
    (select count(*)::int from party_profiles where actual_payment_days is not null),
    (select count(*)::int from settled),
    round(avg(days)::numeric, 1),
    round(percentile_cont(0.5) within group (order by days)::numeric, 1),
    round(percentile_cont(0.9) within group (order by days)::numeric, 1),
    min(days)::int,
    max(days)::int
  from settled;
$$;

-- -------------------------------------------------------------------
-- fn_payment_behaviour — the per-party repayment picture.
--
-- Only parties with enough settled history to say anything. A party with
-- two settled bills is an anecdote, and rating one would put a confident
-- label on noise.
-- -------------------------------------------------------------------
create or replace function fn_payment_behaviour(p_limit integer default 25)
returns table (
  party_id            uuid,
  display_name        text,
  category            text,
  current_outstanding numeric,
  actual_payment_days integer,
  payment_consistency numeric,
  partial_payment_rate numeric,
  settled_bill_count  integer,
  reliability         text,
  last_payment_date   date,
  expected_days       integer,
  days_beyond_term    integer
)
language sql
stable
as $$
  select
    a.party_id, a.display_name, a.category, a.current_outstanding,
    pp.actual_payment_days, pp.payment_consistency, pp.partial_payment_rate,
    pp.settled_bill_count, pp.reliability, pp.last_payment_date,
    case when a.credit_type = 'days'  then a.credit_days
         when a.credit_type = 'cycle' then 45
         else null end as expected_days,
    case when a.credit_type = 'days'  then pp.actual_payment_days - a.credit_days
         when a.credit_type = 'cycle' then pp.actual_payment_days - 45
         else null end as days_beyond_term
  from v_party_ageing a
  join party_profiles pp on pp.party_id = a.party_id
  where pp.settled_bill_count >= 3
    and pp.actual_payment_days is not null
  order by a.current_outstanding desc
  limit greatest(p_limit, 0);
$$;

alter view v_book_trend        set (security_invoker = on);
alter view v_collection_trend  set (security_invoker = on);
alter view v_category_exposure set (security_invoker = on);

grant select on v_book_trend, v_collection_trend, v_category_exposure to authenticated;
grant execute on function fn_collection_cycle() to authenticated;
grant execute on function fn_payment_behaviour(integer) to authenticated;


-- ############ 0011_merge_ratings_people.sql ############

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
drop function if exists fn_possible_duplicates(integer);  -- return shape changes in 0012
create function fn_possible_duplicates(p_limit integer default 50)
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
drop view if exists v_party_board;  -- widened in 0012; see note in 0007
create view v_party_board as
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


-- ############ 0012_people_timeline_work.sql ############

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


-- ############ 0013_absent_parties_duplicates.sql ############

-- ===================================================================
-- Client review, 31 October 2026.
--
--   1. A party that drops out of the Marg export kept its old balance.
--   2. The duplicate shortlist paired parties that only shared the words
--      "MEDICAL AND GENERAL STORES".
--   3. A pair the desk knows to be different kept coming back.
-- ===================================================================

create extension if not exists fuzzystrmatch;

-- -------------------------------------------------------------------
-- 1. Parties absent from the latest file
--
-- Marg's outstanding report lists only parties with something outstanding.
-- When a party pays off and vanishes from the next export, the import
-- never touched its row, so it carried yesterday's balance forever: the
-- Parties list summed to Rs 7.40 Cr while the file said Rs 6.86 Cr, and a
-- clinic the desk had settled still showed Rs 4.56 L.
--
-- Absent from the file means nil. The row is kept — its history, rating,
-- term and calls are worth keeping — and last_snapshot_id goes on
-- recording the last file it appeared in.
-- -------------------------------------------------------------------
create or replace function fn_zero_absent_parties(p_snapshot uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_snap  uuid;
  v_count integer;
begin
  if app_role() not in ('owner', 'accounts') then
    raise exception 'Only owner or accounts can clear absent parties.';
  end if;

  select id into v_snap from snapshots order by report_date desc limit 1;
  if v_snap is null then
    return 0;
  end if;

  -- Only ever measured against the newest file. Re-importing an older
  -- date must not zero parties that are present today.
  if p_snapshot is not null and p_snapshot <> v_snap then
    return 0;
  end if;

  update parties p
  set current_outstanding  = 0,
      oldest_bill_age_days = null
  where not exists (select 1 from bills b where b.party_id = p.id and b.snapshot_id = v_snap)
    and (p.current_outstanding <> 0 or p.oldest_bill_age_days is not null);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function fn_zero_absent_parties is
  'Sets the balance of every party missing from the latest import to nil. '
  'Marg lists only parties with something outstanding, so absent means paid. '
  'The row and its history are kept.';

revoke all on function fn_zero_absent_parties(uuid) from public;
grant execute on function fn_zero_absent_parties(uuid) to authenticated;

-- The rows already stale. Done directly rather than through the function:
-- the SQL editor has no session for app_role() to read.
update parties p
set current_outstanding  = 0,
    oldest_bill_age_days = null
where exists (select 1 from snapshots)
  and not exists (
    select 1 from bills b
    where b.party_id = p.id
      and b.snapshot_id = (select id from snapshots order by report_date desc limit 1))
  and (p.current_outstanding <> 0 or p.oldest_bill_age_days is not null);

-- -------------------------------------------------------------------
-- 2. The distinctive part of a name
--
-- ALPHA MEDICAL AND GENERAL STORES and BETA MEDICAL AND GENERAL
-- STORES share twenty-six characters and differ in the only word that
-- matters. Trigram similarity on the whole name cannot tell them apart;
-- it scored the pair 0.6 and offered them for merging. So the trade words
-- come off first and the comparison is made on what is left: ALPHA
-- against BETA, which no measure will call alike.
-- -------------------------------------------------------------------
create or replace function fn_name_core(p_name text)
returns text
language sql
immutable
as $$
  with cleaned as (
    -- C/O and M/S go first, whole: split on the slash they would leave a
    -- stray C, O, M or S behind, and a single letter is a real part of a
    -- name like S K MEDICAL.
    select regexp_replace(
             regexp_replace(upper(coalesce(p_name, '')), '\m(C/O|M/S)\M', ' ', 'g'),
             '[^A-Z0-9]+', ' ', 'g') as s
  ),
  words as (
    select w, ord
    from cleaned, unnest(string_to_array(btrim(s), ' ')) with ordinality as t(w, ord)
    where w <> ''
      and w not in (
        'MEDICAL', 'MEDICALS', 'MEDICOS', 'MEDICO', 'MEDICINE', 'MEDICINES',
        'GENERAL', 'STORES', 'STORE', 'AND', 'THE', 'OF', 'A', 'AN',
        'PHARMA', 'PHARMACY', 'PHARMACEUTICALS', 'PHARMACEUTICAL',
        'AGENCIES', 'AGENCY', 'ENTERPRISES', 'ENTERPRISE',
        'HOSPITAL', 'HOSPITALS', 'CLINIC', 'CLINICS', 'NURSING', 'HOME',
        'DR', 'DOCTOR', 'PVT', 'LTD', 'LLP', 'PRIVATE', 'LIMITED', 'CO', 'COMPANY',
        'TRADERS', 'TRADING', 'DISTRIBUTORS', 'DISTRIBUTOR', 'DIST', 'DEPOT',
        'HEALTHCARE', 'HEALTH', 'CARE', 'CENTRE', 'CENTER',
        'INSTITUTE', 'RESEARCH', 'RESEARC', 'SURGICAL', 'SURGICALS', 'SCIENCE', 'SCIENCES',
        'SERVICES', 'SOLUTIONS', 'LIFESCIENCES', 'LIFE', 'UNIT',
        'DRUG', 'DRUGS', 'DRUGGIST', 'DRUGGISTS', 'CHEMIST', 'CHEMISTS',
        'NEW', 'NSK', 'NASHIK', 'PT', 'MR', 'MRS', 'SHRI', 'SHREE', 'SRI'
      )
  )
  select coalesce(string_agg(w, ' ' order by ord), '') from words;
$$;

comment on function fn_name_core is
  'A party name with the trade words removed: ALPHA MEDICAL AND GENERAL '
  'STORES becomes ALPHA. What duplicate detection compares.';

-- -------------------------------------------------------------------
-- 3. Pairs the desk has judged to be different
--
-- A shortlist that keeps re-offering a pair somebody has already looked at
-- teaches people to stop reading it.
-- -------------------------------------------------------------------
create table if not exists duplicate_dismissals (
  a_party_id uuid not null references parties (id) on delete cascade,
  b_party_id uuid not null references parties (id) on delete cascade,
  by_user    uuid references app_users (id),
  at         timestamptz not null default now(),
  primary key (a_party_id, b_party_id),
  constraint duplicate_dismissals_ordered check (a_party_id < b_party_id)
);

alter table duplicate_dismissals enable row level security;
grant select, insert, delete on duplicate_dismissals to authenticated;
drop policy if exists duplicate_dismissals_read on duplicate_dismissals;
create policy duplicate_dismissals_read on duplicate_dismissals
  for select to authenticated using (is_authenticated());
drop policy if exists duplicate_dismissals_write on duplicate_dismissals;
create policy duplicate_dismissals_write on duplicate_dismissals
  for all to authenticated
  using (app_role() in ('owner', 'accounts'))
  with check (app_role() in ('owner', 'accounts'));

-- Callers pass the two ids in either order; the table keeps one order.
create or replace function fn_dismiss_duplicate(p_a uuid, p_b uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if app_role() not in ('owner', 'accounts') then
    raise exception 'Only owner or accounts can dismiss a pair.';
  end if;
  if p_a = p_b then return; end if;
  insert into duplicate_dismissals (a_party_id, b_party_id, by_user)
  values (least(p_a, p_b), greatest(p_a, p_b), auth.uid())
  on conflict do nothing;
end;
$$;

revoke all on function fn_dismiss_duplicate(uuid, uuid) from public;
grant execute on function fn_dismiss_duplicate(uuid, uuid) to authenticated;

-- -------------------------------------------------------------------
-- 4. The core, stored and indexed
--
-- Comparing every party with every other is half a million pairs, and
-- running a similarity measure on each took four and a half seconds —
-- past the request timeout on a small instance. So the core is kept on
-- the row, computed by the database whenever the name changes, with a
-- trigram index over it. Candidates then come from the index: the pairs
-- that share a first word, and the pairs the index says read alike. The
-- precise rules run only on those.
-- -------------------------------------------------------------------
alter table parties add column if not exists name_core text
  generated always as (fn_name_core(normalised_name)) stored;
alter table parties add column if not exists name_first text
  generated always as (split_part(fn_name_core(normalised_name), ' ', 1)) stored;

create index if not exists parties_name_core_trgm on parties using gin (name_core gin_trgm_ops);
create index if not exists parties_name_first_idx on parties (name_first) where name_first <> '';

-- -------------------------------------------------------------------
-- 5. The shortlist, rebuilt on the distinctive part
--
-- A pair is offered when the cores are the same (SUNRISE MEDICALS /
-- SUNRISE MEDICOS), when one core extends the other at a word
-- boundary (OMKAR / OMKAR SATPUR), when they are a letter or two
-- apart (CHETNA / CHETANA), or when they still read alike by trigram.
-- A name made only of trade words has no core and falls back to the
-- whole name. Still a shortlist for a person; never an automatic merge.
-- -------------------------------------------------------------------
drop function if exists fn_possible_duplicates(integer);
create function fn_possible_duplicates(p_limit integer default 60)
returns table (
  a_party_id uuid, a_name text, a_outstanding numeric, a_bills integer, a_first_seen date,
  b_party_id uuid, b_name text, b_outstanding numeric, b_bills integer, b_first_seen date,
  similarity real,
  matched_on text
)
language sql
stable
set pg_trgm.similarity_threshold = 0.3
as $$
  with candidates as (
    -- Same first word of the core: KRH and KRH RH ILLP, RIVERSIDE and RIVERSIDE
    -- WOMEN CHILDREN. A hash join on an indexed column.
    select a.id as a_id, b.id as b_id
    from parties a
    join parties b on a.id < b.id and b.name_first = a.name_first
    where a.name_first <> ''
    union
    -- Cores that read alike: the trigram index answers this per row.
    select a.id, b.id
    from parties a
    join parties b on a.id < b.id and b.name_core % a.name_core
    where a.name_core <> ''
    union
    -- Nothing but trade words on both sides: compare the whole name.
    select a.id, b.id
    from parties a
    join parties b on a.id < b.id and b.normalised_name % a.normalised_name
    where a.name_core = '' and b.name_core = ''
  ),
  pairs as (
    select
      a.id as a_id, a.display_name as a_name, a.current_outstanding as a_out, a.first_seen_on as a_seen,
      b.id as b_id, b.display_name as b_name, b.current_outstanding as b_out, b.first_seen_on as b_seen,
      case
        when a.name_core <> '' and a.name_core = b.name_core then 'same name'
        when a.name_core <> '' and b.name_core <> ''
             and length(least(a.name_core, b.name_core)) >= 3
             and (b.name_core like a.name_core || ' %' or a.name_core like b.name_core || ' %') then 'one name extends the other'
        -- A letter apart is a typo only when there are enough letters for
        -- that to mean something: S K and S J are one apart and different.
        when length(a.name_core) >= 5 and length(b.name_core) >= 5
             and (levenshtein(a.name_core, b.name_core) <= 1
                  or (levenshtein(a.name_core, b.name_core) <= 2 and length(greatest(a.name_core, b.name_core)) >= 9)) then 'spelling'
        when length(a.name_core) >= 4 and length(b.name_core) >= 4
             and similarity(a.name_core, b.name_core) >= 0.5 then 'similar'
        when a.name_core = '' and b.name_core = ''
             and similarity(a.normalised_name, b.normalised_name) >= 0.8 then 'similar'
        else null
      end as how,
      case when a.name_core <> '' and b.name_core <> ''
           then similarity(a.name_core, b.name_core)
           else similarity(a.normalised_name, b.normalised_name) end as sim
    from candidates c
    join parties a on a.id = c.a_id
    join parties b on b.id = c.b_id
    where a.status <> 'discontinued' and b.status <> 'discontinued'
  ),
  offered as (
    select p.*
    from pairs p
    where p.how is not null
      and not exists (
        select 1 from duplicate_dismissals d
        where d.a_party_id = least(p.a_id, p.b_id) and d.b_party_id = greatest(p.a_id, p.b_id))
  )
  select
    o.a_id, o.a_name, o.a_out,
    (select count(*)::int from bills x cross join v_latest_snapshot l
      where x.party_id = o.a_id and x.snapshot_id = l.id),
    o.a_seen,
    o.b_id, o.b_name, o.b_out,
    (select count(*)::int from bills x cross join v_latest_snapshot l
      where x.party_id = o.b_id and x.snapshot_id = l.id),
    o.b_seen,
    o.sim,
    o.how
  from offered o
  order by
    case o.how when 'same name' then 0 when 'one name extends the other' then 1 when 'spelling' then 2 else 3 end,
    o.sim desc,
    greatest(o.a_out, o.b_out) desc
  limit greatest(p_limit, 0);
$$;

grant execute on function fn_possible_duplicates(integer) to authenticated;

-- Merging a party removes it, and the cascade takes its dismissals with it.
