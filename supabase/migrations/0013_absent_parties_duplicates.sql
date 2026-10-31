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
