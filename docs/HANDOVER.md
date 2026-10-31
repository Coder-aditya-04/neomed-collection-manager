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

**Follow-ups.** One live thread per party. A call, visit or WhatsApp starts
or continues it; a *remark* adds what was said today without closing it;
*close* asks why, and the reason stays in the log. Filter by person to see
your own.

**Work a band.** Click any band on Today's ageing strip — the ₹1.10 Cr at
180+, say — and the parties and invoices behind it open as a worklist, with
ring / remark / close on each.

**To allocate.** The "difference" parties: money received that Marg holds
against the party's name without it being applied to any particular bill —
the 30,000-then-20,000 case. Their balance is already reduced but the
invoices keep ageing as though nothing arrived. Open a party and the receipts
are listed with their dates, above the bills they could be set against, so
the call can be specific: "the 20,000 you sent on 14 September is still
unapplied — shall we put it against bill 4471?"

**Parties that leave the file.** Marg's outstanding report lists only parties
with something outstanding, so a party that pays off simply stops appearing.
Every import now sets such parties to nil; the row, its history, rating and
term are kept, and the party page says "Not in the latest Marg file".

**Merging duplicates.** The shortlist compares the distinctive part of each
name with the trade words (MEDICAL, GENERAL STORES, PHARMA, HOSPITAL, DR and
so on) set aside, so ALPHA and BETA are no longer offered as a pair
because they both run a "medical and general stores". A pair that is two
different parties can be dismissed with *Not the same* and stays dismissed.
Two parties the shortlist never paired can be merged from either party's
page with *Merge…*, choosing which name survives.

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

Settings → **Users and logins**. Two things, kept apart on purpose:

- A **person** can be assigned parties and appears in every report. Adding one
  takes a name and a role. No login needed — most of the recovery desk works
  this way.
- A **login** is an email and password that signs in as that person. Add it
  when the person is created, or later with *Give a login* against their name:
  everything already recorded against them moves with them.

Roles, enforced by the database rather than by hiding buttons:

| Role | Can do |
|---|---|
| Owner | Everything, including users, roles and settings |
| Accounts | Everything except users and settings — imports, credit terms, claims |
| Recovery | Log calls, remarks, follow-ups and promises on any party |

**One-time setup in Supabase**, so logins can be created from inside the app:
Authentication → Providers → Email → **Allow new users to sign up** on, and
**Confirm email** off. Without the second, a new person is sent a
confirmation mail and cannot sign in until they click it.

A login by itself grants nothing. Someone who signs up without being on the
Users list can read and write nothing at all — only the owner can add them.

**Passwords.** Write the password down for the person when you create it;
it is not stored anywhere readable. To reset one: Supabase → Authentication →
Users → the three dots against their row → *Send password recovery*.

**Who did what.** Every call, remark and close carries the name of the person
who made it. Every change to a party's record — status, rating, term, owner,
contact — is logged with who changed it, and shows on the party's timeline.

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
