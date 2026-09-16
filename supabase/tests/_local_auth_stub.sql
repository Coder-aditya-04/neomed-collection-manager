-- Local-only stand-in for the pieces of Supabase's auth schema the migrations
-- reference. Never applied to a real Supabase project, which supplies these.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase derives auth.uid() from the request JWT. Locally it reads a GUC so
-- a test can say "run the next statements as this user".
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Supabase grants these roles; create them so GRANT statements resolve.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

-- Supabase grants these on its own auth schema. Without them every RLS policy
-- raises "permission denied for schema auth" instead of evaluating, which
-- makes negative tests pass for the wrong reason.
grant usage on schema auth to authenticated, anon, service_role;
grant select on auth.users to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
