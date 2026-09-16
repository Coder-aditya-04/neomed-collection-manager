# Neomed Collection Manager

Receivables management for a pharmaceutical distributor in Nashik. The only
data source is a bill-wise outstanding `.xls` exported by hand from Marg ERP.

**Status: all three phases built. Live on real data.**

- **Live:** https://neomed-collection-manager.vercel.app/
- **Supabase:** project `goncujtgaxoegtozpnbc`
- **Docs:** [Handover](docs/HANDOVER.md) (for the client) · [Operations](docs/OPERATIONS.md) (for whoever maintains this)
- **Tests:** 210 — 108 JavaScript, 102 SQL

The 9 Sep export is imported: 819 parties, 8,197 bills, ₹7.93 Cr net, matching
Marg exactly.

```
ACCEPTANCE                 ACTUAL           EXPECTED         MATCH
Parties                    819              819              yes
  owing                    709              709              yes
  in credit                97               97               yes
  at zero                  13               13               yes
Bill rows                  8197             8197             yes
Owed                       ₹8.06 Cr         ₹8.06 Cr         yes
Credit                     −₹12.61 L        −₹12.61 L        yes
Net                        ₹7.93 Cr         ₹7.93 Cr         yes

THE TRAP
sum of bill balances     ₹8.93 Cr   <- what a naive parser reports
sum of header balances   ₹7.93 Cr   <- what Marg shows the owner
```

Re-run it any time with `node scripts/acceptance.mjs`.

| Step | What | State |
|---|---|---|
| 1 | Schema, RLS policies | Done, applied to the live project |
| 2 | Parser + import screen | Done, verified against the real 9 Sep export |
| 3 | `v_party_ageing`, `fn_priority_list` | Done |
| 4 | Parties list, virtualised, with detail drawer | Done |
| 5 | Credit master bulk editor | Done |
| 6 | Dashboard | Done |
| 7 | Follow-ups, promises, claims, settings | Done |
| 8 | `fn_diff_snapshots`, `fn_compute_profiles`, `fn_settle_promises` | Done — **needs migration 0006 applied to Supabase** |
| 9 | Assistant intent router | Done |

Steps 8 and 9 cannot show anything until a **second** day's export is
imported: payment history is derived by comparing consecutive snapshots, and
there is only one so far.

---

## Setup

```bash
npm install
cp .env.example .env     # then fill in your Supabase URL and anon key
npm run dev
```

### Supabase

The project `goncujtgaxoegtozpnbc` is live and `.env` is configured against
it, but **its database is still empty** — none of the tables exist yet.

1. Open the project's **SQL editor** and run
   [`supabase/migrations/_all_in_one.sql`](supabase/migrations/_all_in_one.sql).
   It concatenates all five migrations in order, is safe to re-run, and has
   been verified to apply twice cleanly to a fresh Postgres 17.

   (DDL cannot be applied through the REST API, which is why this is a manual
   paste rather than something the build does for you. The individual
   numbered migrations remain the source of truth; `_all_in_one.sql` is
   generated from them.)

   Do **not** apply `supabase/tests/_local_auth_stub.sql` — Supabase supplies
   the `auth` schema those migrations reference.

2. Create a **public storage bucket named `marg-imports`**. Every original
   export is archived there for audit. If it is missing the import still
   completes, but the snapshot is recorded with an `original_not_archived`
   warning and has no audit copy.

3. Add yourself to `app_users` with a role, or nothing will be writable:

   ```sql
   insert into app_users (id, full_name, role)
   values ('<your auth.users id>', 'R. Salunkhe', 'owner');
   ```

---

## Tests

```bash
npm test                    # 108 JavaScript tests — parser, formatting, intent routing
./supabase/tests/run.sh     # 102 SQL tests — ageing, priority, diffing, profiles, RLS
```

`run.sh` needs a local Postgres 15+ listening on `PGPORT` (default 5433). To
raise a throwaway one:

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
initdb -D /tmp/nmpg -U postgres --auth=trust
pg_ctl -D /tmp/nmpg -o "-p 5433 -c listen_addresses=127.0.0.1" -l /tmp/nmpg.log start
```

The runner rebuilds the database, applies every migration twice (they must be
idempotent), then runs both suites.

---

## The parts that matter

### The parser — `src/lib/margParser.js`

The export interleaves two row types: a **party header row** (column 0 = name,
column 5 = that party's total) and **bill rows** beneath it (column 0 empty).

**A party's outstanding is the header row's column 5, never the sum of its
bill rows.** In the reference file the two disagree for 15 parties by about
₹1 crore; summing bill balances gives ₹8.93 Cr where Marg shows ₹7.93 Cr.
Bill rows supply only the *shape* of the ageing, which SQL then rescales onto
the header total. `test/margParser.test.js` asserts both the right answer and
that the wrong method would have produced a visibly different one.

Other quirks handled, all covered by tests: `DD-MMM-YY` dates parsed
explicitly (`Date.parse` misreads two-digit years); `bill_age_days` computed
from the bill date rather than taken from Marg's "Days" column, which is
actually days *past due* (see below); bare `*` rows given stable synthetic
keys so they survive the unique index and do not read as settlements on the
next day's diff; repeated bill numbers suffixed rather than dropped; negative
balances flagged as credit, never as debt; party names normalised for matching
but always displayed as Marg holds them.

### The ageing engine — `supabase/migrations/0003_ageing.sql`

Two credit models, both required — 19 of the top 20 parties are hospitals on
a monthly cycle, so `cycle` is the common case here:

- **days** — `bill_date + credit_days`
- **cycle** — bills must arrive by `cycle_submit_day` to make that month's
  run; payment releases on `cycle_pay_day`, `cycle_lag_months` later. With
  submit 5th / pay 25th / lag 1, a bill dated 3 Aug is due 25 Sep, and one
  dated 8 Aug missed the window and is due 25 Oct — a 78-day wait that is
  normal for that party and is not lateness. Verified in the test suite.
- **none** — no due date. Nothing is inferred.

Buckets are measured against **overdue days**, never bill age, and are
`NULL` — not zero — wherever no term is recorded. Zero would read as "nothing
is overdue"; NULL reads as "we cannot say", which is both the truth and what
the assistant's stop rule depends on.

### Rules held up in the schema, not by convention

- `parties_credit_model_coherent` — a half-filled term cannot be stored.
- `parties_none_implies_not_set` — `credit_type = 'none'` and
  `credit_source = 'not_set'` can never drift apart.
- `promises_closed_needs_evidence` — a promise cannot be marked kept or
  partial without linked `bill_changes`.
- Triggers reject any `UPDATE` to `bills` or `snapshots`; no role is granted
  `UPDATE` or `DELETE` on either. Correcting a figure means importing a new
  snapshot.
- The import payload carries no credit-term columns at all, so an import can
  never overwrite a term someone approved.

---

## Decisions taken without a ruling

Both were flagged; neither had been answered when the build started.

1. **Visual language.** The prototype
   (`Neomed dashboard UI specifications/Neomed Collection Manager.dc.html`)
   governs — teal `#00857A`, Archivo over IBM Plex Mono, frosted panels on a
   drawing-board grid. The `_ds/industry-*` kit in the same folder is a
   different, unused direction and is not referenced.
2. **Credit master.** The written spec wins over the prototype, which offers
   only a days field. The schema carries the full `days | cycle | none` model.

## What the real file disagrees with the spec about

Found by running the parser against `outstanding_ 9 SEP 26.xls`. None of these
changes the money; all of them change what the data means.

**1. The "Days" column is days past due, not bill age.** The spec says Marg
holds no credit terms and that Due Date equals Bill Date on every row. It does
not: **121 rows across 19 parties carry a real due date**, and on those rows
the Days column is measured from it and goes negative before a bill falls due.

```
CRE008766   bill 13-Jul-26   due 11-Sep-26   Days −2     (report date 09-Sep)
CRE006244   bill 13-Jun-26   due 12-Aug-26   Days 28
```

On the other 8,076 rows due date equals bill date, so the two coincide — which
is why it reads as an age. `bill_age_days` is now computed from the bill date;
Marg's own figures are kept as `marg_due_date` and `days_past_due`.

**Marg is already holding credit periods for 19 parties** — 60 days for 12 of
them, 30 days for 4, 10 days for 1. Rule 1 names due dates among the things a
term may not be derived from, so these are *not* applied. They surface as
`marg_due_date_present` warnings: a head start on the credit master, for a
human to approve or reject. (Two of the 19 show a due date *before* the bill
date, by 1 and 9 days — data-entry noise worth querying.)

**2. `*` is a prefix marker, not a bill number.** The spec says "some rows use
`*` as the bill number". In fact **1,718 rows are marker-prefixed** —
`*CRD023345`, `*CN0061`, `#RTGS` — and only 98 are a bare `*`. The marker means
on-account (a receipt or adjustment, not a sale) and is orthogonal to the
series. Matching prefixes without stripping it sent all 1,718 to `OTHER`,
including every on-account credit note. Fixed: CN went 82 → 156, PDSN 15 → 25.

**3. The bill_type enum does not cover the file.** 1,634 rows remain `OTHER`,
almost all of them a CR series the spec never mentions:

| series | rows | net balance |
|---|---|---|
| CRD | 1,091 | ₹134.77 L |
| CRB | 186 | ₹6.70 L |
| CRC | 127 | ₹9.36 L |
| CRA | 64 | ₹4.69 L |
| CR / CR-numeric | 119 | ₹16.15 L |
| CSH (B/C/D series) | 34 | ₹2.03 L |
| CHEQU, RTGS, BANK, OMC, OLD, MH | 13 | −₹0.17 L |

The spec's `CRE` and `CSHE` look like single series of broader `CR` and `CSH`
families. **What are CRA–CRD?** They carry ₹155 L and 158 of them are negative
(receipts). Until you say, they classify as `OTHER`, which is honest but loses
information. `bill_type` feeds nothing in steps 1–3, so this is not blocking.

**4. Bill dates run back to March 2020, not December 2023.** The oldest bill is
a cash entry, dated 14 Mar 2020 — which *is* 2,370 days before 9 Sep
2026, so the spec's age figure is right and its date range is not.

**5. Three parties sit at ±₹0.01, not at zero.** Read strictly that makes
710 owing / 99 credit / 10 zero instead of 709 / 97 / 13. Classification now
treats sub-rupee balances as nil (`ZERO_TOLERANCE`), which reproduces the
spec's split exactly. The exact figures are still stored and still summed.

**6. The reconciliation warning count cannot be both things the spec says.**
"Log every party where the gap exceeds ₹1,000" and "15 reconciliation warnings
raised" are inconsistent on this file: **46 parties exceed ₹1,000**. Fifteen
would need a threshold of about **₹2.19 L**. The ₹1,000 rule is implemented,
since it is the operative instruction. All four named parties reconcile
exactly as the spec describes:

| party | header | bill rows |
|---|---|---|
| PARTY A (LARGE HOSPITAL) | ₹31.23 L | ₹52.86 L |
| PARTY B (ONCOLOGY CENTRE) | ₹29.44 L | ₹43.34 L |
| PARTY C (LARGEST EXPOSURE) | ₹89.72 L | ₹99.52 L |
| PARTY D (NURSING HOME) | ₹6.77 L | ₹16.04 L |

Also confirmed as the spec states: P.D.C. is 0 on all 8,197 rows, Remark is
empty on all of them, and the CRE count is exactly 6,308.

## Known conflicts still open

- **Category names.** The spec's schema says
  `hospital | retailer | institution | cash`; the prototype uses Hospital,
  Nursing home, Chemist, Institution, Distributor. The schema follows the
  spec. If the prototype's five are what the client actually uses, the CHECK
  constraint and `category_defaults` both need changing.
- **Bucket boundaries.** Buckets top out at **60+** per the spec, but the
  prototype's headline figure, its age colouring and its assistant copy all
  talk about **90 days**. The SQL implements 60+.
- **Category defaults and escalation.** Rule 2 says an assumed term must never
  drive an escalation, but the exclusion list for `fn_priority_list` does not
  exclude `category_default`. They are currently included and flagged
  (`term_is_assumed`), and their reason string ends "Term is a category
  default, not an approved one — confirm before escalating." Excluding them
  outright is a one-line change if that is what Rule 2 means.
