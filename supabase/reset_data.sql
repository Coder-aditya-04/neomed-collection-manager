-- ===================================================================
-- RESET — clears all imported and operational data.
--
-- Paste into the Supabase SQL editor and run. It removes every snapshot,
-- bill, party, derived payment event, follow-up, promise and claim, so the
-- next import starts from nothing.
--
-- WHAT SURVIVES: the schema itself, the settings rows, and your users and
-- their roles. You will not have to set the system up again.
--
-- WHAT DOES NOT: everything else, including any credit terms already
-- entered — those live on the party rows. If terms have been typed in,
-- export them first (see the query at the bottom).
--
-- There is no undo.
-- ===================================================================

begin;

-- Order matters only where a foreign key would block the delete; the cascades
-- handle the rest. bill_changes goes first because it is the one table the
-- retention job is otherwise forbidden to touch, so it is deleted explicitly
-- rather than by accident.
delete from bill_changes;
delete from party_profiles;
delete from promises;
delete from followups;
delete from claims;
delete from import_warnings;

-- Bills cascade from snapshots, but parties reference the snapshot too, so
-- that link is cleared before the snapshots go.
delete from bills;
update parties set last_snapshot_id = null;
delete from snapshots;

delete from parties;

commit;

-- ===================================================================
-- Confirm everything is empty
-- ===================================================================
select
  (select count(*) from snapshots)       as snapshots,
  (select count(*) from parties)         as parties,
  (select count(*) from bills)           as bills,
  (select count(*) from bill_changes)    as bill_changes,
  (select count(*) from party_profiles)  as profiles,
  (select count(*) from followups)       as followups,
  (select count(*) from promises)        as promises,
  (select count(*) from claims)          as claims,
  (select count(*) from import_warnings) as warnings,
  (select count(*) from settings)        as settings_kept,
  (select count(*) from app_users)       as users_kept;

-- ===================================================================
-- BEFORE RESETTING: save any credit terms already entered
--
-- Run this first and keep the output. Terms are the one thing here that
-- cannot be re-derived from a Marg file, because Marg does not hold them.
-- ===================================================================
--
-- select normalised_name, credit_type, credit_days, cycle_submit_day,
--        cycle_pay_day, cycle_lag_months, credit_source, phone, contact_person
-- from parties
-- where credit_source <> 'not_set' or phone is not null;
--
-- To put them back after re-importing, for each row:
--
-- update parties set
--   credit_type = '...', credit_days = ..., cycle_submit_day = ...,
--   cycle_pay_day = ..., cycle_lag_months = ..., credit_source = 'approved',
--   phone = '...', contact_person = '...'
-- where normalised_name = '...';
