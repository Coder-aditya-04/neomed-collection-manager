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
