# Neomed Collection Manager — handover

A receivables system for Neomed Pharma Agencies, built on the daily
outstanding export from Marg ERP.

**Live:** https://neomed-collection-manager.vercel.app/

---

## What problem this solves

Marg tells you what is owed. It does not tell you what is *late*, because it
holds no credit terms — its Due Date column simply repeats the Bill Date on
almost every row. So the only thing the export can honestly say is how old a
bill is, and "old" and "late" are not the same thing. A hospital on a monthly
cycle can have a 78-day-old bill that is perfectly on time.

This system keeps those two ideas apart. It records the credit terms Marg
cannot, measures every bill against the term that actually applies to that
party, and refuses to call anything overdue until someone has told it what the
term is.

---

## What it does today

**Import.** The daily `.xls` is read in the browser. Before anything is
written you see what the file contains, what changed since yesterday, and
every discrepancy it found. Nothing reaches the database until you confirm.

**The book, correctly totalled.** The 9 September file gives ₹7.93 Cr across
819 parties and 8,359 bills — the same figure Marg shows, to the rupee, for
every party.

An earlier version of this document claimed that Marg's header totals
disagreed with the sum of its own bill rows for 46 parties, by about ₹1 crore.
**That was wrong, and the fault was ours.** Marg writes receipts and
adjustments with the bill-number column empty, and the parser was treating
any row without a number as blank — 161 rows per file, carrying −₹1.53 Cr.
Dropping them is what made the totals disagree. With those rows read
correctly the gap is zero parties and ₹0.00 on all four exports. Marg was
right throughout.

The system still takes the header figure as the party's total, as Marg does,
and still reports any disagreement it finds. There simply aren't any.

**Ageing that respects how each party actually pays.** Two models:

- *Days* — so many days from the bill date. How retailers work.
- *Monthly cycle* — bills must reach the party by a certain day to make that
  month's run, and payment is released on a set day, that month or the next.
  How hospitals work, which matters because most of the largest parties are
  hospitals.

**A priority list that excludes what it should.** A party held up by our own
unsettled claim is not a defaulter and does not appear. Nor does one in
dispute, one below the small-balance threshold, or one whose credit term has
never been recorded.

**Credit master.** Where the terms get typed in, largest parties first, so the
work is finite: the top hundred rows cover most of the money.

**Registers.** Claims grouped by who owes the internal action; follow-ups
ordered missed first; promises, which close only when a payment supports them.

**To allocate.** The "difference" parties: money received that Marg holds
against the party's name without it being applied to any particular bill —
the 30,000-then-20,000 case. Their balance is already reduced but the
invoices keep ageing as though nothing arrived. Open a party and the receipts
are listed with their dates, above the bills they could be set against, so
the call can be specific: "the 20,000 you sent on 14 September is still
unapplied — shall we put it against bill 4471?"

**Statements.** Month-end party statements in Marg's own format, every bill
listed, ready to send on WhatsApp.

**Recovery desk.** Who called whom, what the customer said, calls made against
calls due, efficiency, and weekly and monthly targets per person.

**Assistant.** Ask in plain English — "who should I call today", "parties
above 5 lakh", "how much does X owe", "which parties have a difference to
settle". Answers come back as figures, ageing strips and ranked lists. There
is no language model behind it: questions are routed by pattern, so the same
question always gives the same answer and nothing is ever invented.

---

## The rules it will not break

These are deliberate, and enforced by the database rather than by good
intentions:

1. **A credit term is never guessed.** Not from bill dates, not from due
   dates, not from past behaviour. If it is not recorded, the system says so
   and asks. This is the whole point of the product.
2. **A category default is not an approved term.** Where one is used it is
   labelled as an assumption everywhere it appears.
3. **A party's total comes from Marg's own header figure**, never from adding
   up bill rows.
4. **Imported rows are never edited.** Correcting a figure means importing a
   new file. Marg stays the financial truth.
5. **A promise closes only when a payment supports it.** Nobody can mark one
   kept by hand.
6. **A credit balance is never counted as debt.** 97 parties are in credit by
   ₹12.61 L between them; that is an advance, not money owed.
7. **Every figure traces to a snapshot and a rule.** No estimates, and no
   rounding that hides a discrepancy.

The assistant obeys the same rules. Asked how overdue a party is when no term
is recorded, it says it cannot answer, explains that age is not lateness, and
asks for the term — rather than producing a confident wrong number.

---

## Where it stands

**Phase 1 — complete and live.** Parser, import, database, ageing engine,
parties list, party detail, credit master, dashboard.

**Phase 2 — complete.** Claims, follow-ups, promises, roles.

**Phase 3 — built, one step from finished.** Snapshot comparison, derived
payment history, behaviour profiles, and the assistant are all written and
tested. They need a second day's export before they can show anything: the
system learns how a party pays by comparing today's file with yesterday's, and
there is only one file in it so far.

**Terms are going in.** 94 of the top 100 parties now have an approved term,
which makes 81% of the book judgeable. The remaining 745 parties hold ₹1.43 Cr
between them and still sit under "cannot be judged" — small accounts, mostly.
Typing in a term is what turns a balance into a collection case, and it is the
one thing only Neomed can supply.

---

## Adding someone to the system

Two steps, because a login and a role are separate things. A person who has
one without the other cannot work: no login means no access at all, and no
role means they can sign in but every screen refuses them.

**1. Create the login.** In Supabase → **Authentication** → **Users** →
*Add user* → *Create new user*. Enter their email and a password, and tick
**Auto Confirm User** — without it they will be sent a confirmation mail that
may never arrive. Copy the **UID** that appears against the new row.

**2. Give them a role.** Supabase → **SQL Editor**, and run:

```sql
insert into app_users (id, full_name, role)
values ('<the UID you copied>', 'Full Name', 'sales');
```

`role` must be exactly one of:

| Role | Can do |
|---|---|
| `owner` | Everything, including settings, targets and managing users |
| `accounts` | Everything except settings and roles — imports, credit terms, claims |
| `sales` | Log calls, follow-ups and promises. Cannot change credit terms or import |

The roles are enforced by the database itself, not by hiding buttons. A sales
user who tried to change a credit term through any other route would still be
refused.

**To change somebody's role** — `update app_users set role = 'accounts' where
id = '<UID>';`

**To remove somebody** — delete them in Authentication → Users. Their row in
`app_users` goes with them, but every call, promise and claim they recorded
stays, because that history belongs to the party and not to the employee.

**Passwords.** People change their own display name in Settings. For a
password reset, use Supabase → Authentication → Users → the three dots
against their row → *Send password recovery*.

---

## What it costs to run

| | |
|---|---|
| Database, authentication, file storage | ₹0 — the free tier covers roughly 25 MB a year |
| Hosting | ₹0 |
| Assistant | ₹0 — no language model, so nothing to meter |
| Domain, if wanted | about ₹900 a year |

Nothing here bills per use. The only reason to pay would be exceeding 500 MB
of database, which on this volume takes years, or wanting daily backups.

---

## Getting started

1. Sign in.
2. **Credit master** — fill in terms for the largest parties. Hospitals
   usually share a cycle, so select several and set them at once. The progress
   bar shows how much of the book becomes judgeable as you go.
3. **Today** — the dashboard fills in as terms are recorded.
4. **Import** — drop the new export in each morning. Roughly a minute.

The system gets more useful with each day's file, because each one adds to the
payment history it derives.

---

## Honest limitations

- **Behaviour profiles need history.** A party is rated `unknown` until three
  of its bills have been settled and observed. Expect a few weeks before the
  ratings mean much.
- **Payment history is inferred, not read.** Marg does not export receipts, so
  payments are derived from balances falling between two files. Reliable, but
  it only sees what two consecutive exports reveal — money paid and re-billed
  the same day is invisible.
- **The export is manual.** If nobody exports the file, the book goes stale.
  Every screen shows the age of the snapshot it is reading for that reason.
- **Some bill series are unclassified.** 1,634 rows use voucher prefixes
  (CRA, CRB, CRC, CRD) that were not in the specification. They are imported
  and counted correctly; they are simply grouped as "other" until someone at
  Neomed says what those series mean.
- **Marg already holds a due date for 19 parties**, implying credit periods of
  60 or 30 days. These are shown for review but deliberately not applied —
  rule 1 — so someone should confirm or reject them.
