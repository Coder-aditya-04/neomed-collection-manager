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
