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
