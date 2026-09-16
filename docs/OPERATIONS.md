# Operations

How to run, deploy and maintain the system. For whoever maintains the code.

---

## Daily import

1. Export the outstanding bill-wise report from Marg as `.xls`.
2. Open **Import**, drop the file, read the preview, confirm.

The preview writes nothing. It shows the parsed totals, the movement since the
previous snapshot, and every reconciliation warning, so a bad export can be
discarded without leaving a trace.

After a second snapshot exists, run the derived-history jobs:

```sql
select fn_diff_latest();       -- payment events between the last two files
select fn_compute_profiles();  -- behaviour ratings from those events
select fn_settle_promises();   -- close promises against real payments
```

These are idempotent — safe to run repeatedly. Schedule them nightly with
Supabase's cron (`pg_cron`) once imports are routine:

```sql
select cron.schedule('nightly-derive', '30 20 * * *', $$
  select fn_diff_latest();
  select fn_compute_profiles();
  select fn_settle_promises();
$$);
```

Order matters: diffing writes the events, profiles read them, promises close
against them.

---

## Command-line import

For backfilling, or when the browser is inconvenient:

```bash
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_KEY=<service key> \
node scripts/import-file.mjs "outstanding_ 9 SEP 26.xls"
```

Builds the same payloads as the import screen, so it doubles as a check that
the schema accepts real parsed data. `--resume` continues into an existing
snapshot for the same date. It does **not** archive the original file to
storage — browser imports do that.

---

## Checking a parse without importing

```bash
node scripts/acceptance.mjs "outstanding_ 9 SEP 26.xls"
```

Prints the figures beside what the specification expects, shows what summing
bill rows would have produced instead, and lists every reconciliation warning.
Run this against any new export that looks suspicious.

---

## Tests

```bash
npm test                    # 104 JavaScript — parser, formatting, intent routing
./supabase/tests/run.sh     # 102 SQL — ageing, priority, diffing, profiles, RLS
```

`run.sh` needs a local Postgres 15+ on `PGPORT` (default 5433):

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
initdb -D /tmp/nmpg -U postgres --auth=trust
pg_ctl -D /tmp/nmpg -o "-p 5433 -c listen_addresses=127.0.0.1" -l /tmp/nmpg.log start
```

It rebuilds the database, applies every migration **twice** (they must be
idempotent), then runs all three suites.

---

## Deploying

Vercel builds and publishes on every push to `main`. GitHub Actions runs the
test suite in parallel; it no longer deploys, because GitHub Pages cannot serve
a private repository on a free plan.

Two environment variables supply the client configuration, both set in Vercel
under **Settings → Environment Variables**:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Set both as **Config**, not **Secret**. Vite inlines anything prefixed `VITE_`
into the JavaScript bundle at build time, so the value reaches every visitor's
browser no matter how it is stored — marking it Secret hides it from your team
in the Vercel dashboard while still shipping it to the public. Vercel warns
about exactly this.

That is fine for these two. The anon key is a public client credential by
design; what protects the data is row level security, not the secrecy of the
key. **The service role key is different** — it bypasses RLS entirely and must
never appear in the front end, in a repository, in a `VITE_` variable, or in a
chat message.

---

## Database changes

Migrations are numbered and idempotent. Add a new numbered file, then
regenerate the paste-ready bundle:

```bash
{
  for f in supabase/migrations/000*.sql; do
    echo; echo "-- ############ $(basename "$f") ############"; echo
    cat "$f"
  done
} > supabase/migrations/_all_in_one.sql
```

Apply via the Supabase SQL editor. DDL cannot go through the REST API, so this
step is manual. Never apply `supabase/tests/_local_auth_stub.sql` to a real
project — Supabase provides that schema itself.

---

## Users and roles

Create the user in **Authentication → Users**, then give them a role:

```sql
insert into app_users (id, full_name, role)
select id, 'Full Name', 'accounts' from auth.users where email = '...';
```

| Role | Can write |
|---|---|
| `owner` | everything, including settings and roles |
| `accounts` | credit terms, claims, follow-ups, promises, imports |
| `sales` | follow-ups and promises only |

A user with no `app_users` row can sign in and see nothing. That is RLS
working, not a bug.

---

## Retention

Roughly 2 million bill rows a year will outgrow the free tier. The policy in
`settings.retention_policy`:

- last 90 days — keep every snapshot
- 90 days to a year — keep the Monday one each week
- older than a year — keep one a month
- always keep the first and last snapshot of each month

**Never prune `bill_changes`.** It is small, it is the only record of when
money actually arrived, and deleting it destroys every behaviour profile
permanently. Pruning must run *after* `fn_diff_latest` has processed the
snapshots being removed, never before — the diff is what turns a snapshot into
history before it is thrown away.

The pruning job is not written yet. It is not needed until the database
approaches 500 MB, which on this volume is a year or more away.

---

## Things that will surprise you

**Marg's "Days" column is days past due, not bill age.** On most rows its due
date equals the bill date so the two coincide, but on 121 rows it carries a
real due date and the figure goes negative before a bill falls due.
`bill_age_days` is computed from the bill date; Marg's own figures are kept
beside it as `marg_due_date` and `days_past_due`.

**`*` is a prefix, not a bill number.** 1,718 rows are marker-prefixed
(`*CRD023345`, `*CN0061`, `#RTGS`); only 98 are a bare `*`. The marker means
on-account — a receipt or adjustment rather than a sale — and is stripped
before the series is read.

**Views use `security_invoker`.** Without it a view silently bypasses RLS on
the tables beneath it.

**`array_length` of an empty array is NULL, and a CHECK that evaluates to NULL
passes.** This is why `promises_closed_needs_evidence` wraps it in `coalesce`.

**`ln()` returns double precision**, so products involving it need casting
back to numeric before `round(x, 2)`.

**Bills and snapshots reject UPDATE** by trigger, and no role is granted
UPDATE or DELETE on either. Deletion is left open only so the retention job
can drop whole snapshots and let bills cascade.
