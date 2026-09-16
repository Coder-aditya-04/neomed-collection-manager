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
