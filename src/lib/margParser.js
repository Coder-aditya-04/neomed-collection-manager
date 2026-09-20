/**
 * Marg ERP "outstanding bill-wise" .xls parser.
 *
 * File shape (see spec PART 1 — relied upon, not guessed):
 *   rows 0-3  company header            -> skipped
 *   row  4    column headers            -> validated
 *   row  5+   interleaved party-header and bill rows
 *
 * A PARTY HEADER ROW has column 0 filled (the name) and column 5 filled
 * (that party's total balance). A BILL ROW has column 0 empty and column 1
 * filled (the bill number). Every bill row belongs to the nearest party
 * header row above it.
 *
 * RULE 3 — a party's outstanding is the header row's column 5. It is never
 * the sum of its bill rows' balances. In the reference file the two disagree
 * for 15 parties by ~Rs 1 crore in aggregate; summing bills gives 8.93 Cr
 * where Marg shows 7.93 Cr. Bill rows exist here only to carry the ageing
 * split, which SQL later rescales so the buckets reconcile to the header.
 */

export const COLUMNS = {
  PARTY_NAME: 0,
  BILL_NO: 1,
  BILL_DATE: 2,
  BILL_AMT: 3,
  RECEIVED: 4,
  BALANCE: 5,
  CUMULATIVE: 6,
  DUE_DATE: 7,
  DAYS: 8,
  PDC: 9,
  REMARK: 10,
};

export const HEADER_ROW_INDEX = 4;
export const FIRST_DATA_ROW_INDEX = 5;

/** Gap above which a header-vs-bills disagreement is worth reporting (rupees). */
export const RECONCILE_TOLERANCE = 1000;

/**
 * Sub-rupee balances count as nil when a party is classified as owing / in
 * credit / at zero.
 *
 * The real export carries three parties at plus or minus one paise
 * (two at -0.01 and one at +0.01).
 * Read strictly, two become credit balances and one becomes a debtor, which
 * is how the expected 709/97/13 turns into 710/99/10. A paise is neither a
 * debt to chase nor an advance to adjust.
 *
 * The threshold sits below one rupee on purpose: two parties sit at exactly
 * -1, and those are real credit balances that must stay counted as such.
 *
 * This rounds the CLASSIFICATION only. current_outstanding keeps the exact
 * figure Marg gave, and the totals still sum every paise, so nothing is
 * hidden (rule 8).
 */
export const ZERO_TOLERANCE = 0.5;

const EXPECTED_HEADERS = [
  'party name', 'bill no', 'bill date', 'bill amt', 'received',
  'balance', 'cumulative total', 'due date', 'days', 'p.d.c', 'remark',
];

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const BILL_TYPE_PREFIXES = ['CRE', 'CN', 'CSHE', 'PDSN'];

/* ------------------------------------------------------------------ */
/* cell helpers                                                        */
/* ------------------------------------------------------------------ */

/** True when a cell carries nothing meaningful. Zero is meaningful. */
export function isBlank(cell) {
  if (cell === null || cell === undefined) return true;
  if (typeof cell === 'number') return false;
  return String(cell).trim() === '';
}

/**
 * Marg writes numbers as numbers, but exports can carry strings with Indian
 * digit grouping, a rupee sign, or a trailing/leading minus. Returns 0 for
 * anything unreadable so a stray cell cannot poison a total.
 */
export function toNumber(cell) {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : 0;
  if (isBlank(cell)) return 0;
  let s = String(cell).trim().replace(/[₹,\s]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {           // (1,234) accounting negative
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {              // 1234- trailing-minus dialect
    negative = true;
    s = s.slice(0, -1);
  }
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -Math.abs(n) : n;
}

/**
 * Parse Marg's DD-MMM-YY date strings ("02-Sep-26") to an ISO date string.
 *
 * Date.parse is deliberately avoided: it reads two-digit years
 * inconsistently across engines and would silently place this file's bills
 * in 1926. Years pivot at 70 (00-69 -> 2000s, 70-99 -> 1900s), which covers
 * the real range of Dec 2023 to Sep 2026.
 *
 * Returns null when the cell cannot be read as a date.
 */
export function parseMargDate(cell) {
  if (isBlank(cell)) return null;

  // Some exports hand back a real Date or an Excel serial instead of text.
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return toIso(cell.getFullYear(), cell.getMonth() + 1, cell.getDate());
  }
  if (typeof cell === 'number' && cell > 0) {
    const ms = Math.round((cell - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  const text = String(cell).trim();
  const m = /^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2}|\d{4})$/.exec(text);
  if (!m) return null;

  const day = Number.parseInt(m[1], 10);
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;

  let year = Number.parseInt(m[3], 10);
  if (m[3].length === 2) year += year < 70 ? 2000 : 1900;

  if (day < 1 || day > daysInMonth(year, month)) return null;
  return toIso(year, month, day);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toIso(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Whole days between two ISO dates, positive when `to` is later. */
export function daysBetween(fromIso, toIso_) {
  if (!fromIso || !toIso_) return null;
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso_}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/* ------------------------------------------------------------------ */
/* names and bill numbers                                              */
/* ------------------------------------------------------------------ */

/**
 * Identity key for a party. Uppercase, collapse internal whitespace, strip
 * trailing punctuation — exactly that and no more.
 *
 * Deliberately does NOT drop PVT / LTD / NEW. Those are dropped by the
 * assistant's fuzzy *search*, but dropping them here would merge
 * "EXAMPLE HOSPITAL NEW" into "EXAMPLE HOSPITAL", and Marg may well
 * hold both as separate ledgers. The display string is always kept intact.
 */
export function normaliseName(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:\-/\\'"]+$/g, '')
    .trim();
}

/** True when a bill number carries Marg's on-account marker. */
export function isOnAccountNumber(billNo) {
  const s = String(billNo ?? '').trim();
  return s.startsWith('*') || s.startsWith('#');
}

/** A number that is nothing but a marker, so it cannot key a row on its own. */
export function isBareMarker(billNo) {
  const s = String(billNo ?? '').trim();
  return s === '' || s === '*' || s === '#';
}

/**
 * CRE | CN | CSHE | PDSN | OTHER, from the bill number's series prefix.
 *
 * The leading "*" / "#" is stripped first. It marks an on-account entry — a
 * receipt or adjustment rather than a sale — and is orthogonal to the series:
 * "*CN0061" is still a credit note. Matching it unstripped sent 1,718 of the
 * real file's 8,197 rows to OTHER, including every on-account CN and PDSN.
 */
export function billTypeOf(billNo) {
  const s = String(billNo ?? '').trim().toUpperCase().replace(/^[*#\s]+/, '');
  // Longest prefix first so CSHE wins over CN-ish matches, CRE before CN.
  const ordered = [...BILL_TYPE_PREFIXES].sort((a, b) => b.length - a.length);
  for (const prefix of ordered) {
    if (s.startsWith(prefix)) return prefix;
  }
  return 'OTHER';
}

/**
 * On-account entries carry "*" (or nothing) as their bill number. Those must
 * survive the (snapshot_id, party_id, bill_no) unique key AND stay stable
 * across snapshots, otherwise tomorrow's diff reads every one of them as a
 * settlement plus a new bill.
 *
 * A synthetic key built from the row's own date and amount is stable for as
 * long as the row itself is unchanged, which is the best available anchor.
 */
export function synthesiseBillNo(billDateIso, billAmount) {
  const d = billDateIso ?? 'nodate';
  const a = Math.round(Number(billAmount) || 0);
  return `*~${d}~${a}`;
}


/* ------------------------------------------------------------------ */
/* report date                                                         */
/* ------------------------------------------------------------------ */

const MONTH_RE = '(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)';

/**
 * Work out which day an export represents.
 *
 * Marg writes no "as on" date into the file, so the filename is the only
 * statement of intent — and these arrive as "outstanding_10 sep.xls", with
 * no year at all. The year is taken from the bills themselves.
 *
 * The "Days" column is deliberately NOT used. It is computed when the file is
 * exported, not for the day it represents, so a back-dated report run today
 * yields today's date from it. The reference set was exported on 17 Sep with
 * as-on filters of 10, 12 and 15 Sep; reading Days would have stamped all
 * three with the same date and destroyed the ordering the diff depends on.
 *
 * @param {string} fileName
 * @param {string[]} billDates  ISO dates seen in the file, for the year and a sanity check
 */
export function inferReportDate(fileName, billDates = []) {
  const text = String(fileName ?? '').toUpperCase();
  const sorted = [...billDates].filter(Boolean).sort();
  // The newest date is often a stray post-dated bill, so the year comes from
  // the bulk of the file rather than from its single furthest row.
  const anchor = sorted.length ? sorted[Math.floor(sorted.length * 0.98)] : null;

  const m =
    new RegExp(`(\\d{1,2})[_\\-\\s]*${MONTH_RE}[A-Z]*[_\\-\\s]*(\\d{4}|\\d{2})?`).exec(text) ||
    new RegExp(`${MONTH_RE}[A-Z]*[_\\-\\s]*(\\d{1,2})[_\\-\\s]*(\\d{4}|\\d{2})?`).exec(text);

  if (m) {
    let day, month, year;
    if (/^\d/.test(m[1])) {
      day = Number.parseInt(m[1], 10);
      month = MONTHS[m[2].slice(0, 3).toLowerCase()];
      year = m[3];
    } else {
      month = MONTHS[m[1].slice(0, 3).toLowerCase()];
      day = Number.parseInt(m[2], 10);
      year = m[3];
    }
    if (month && day >= 1 && day <= 31) {
      let y;
      if (year) {
        y = Number.parseInt(year, 10);
        if (year.length === 2) y += y < 70 ? 2000 : 1900;
      } else {
        y = anchor ? Number.parseInt(anchor.slice(0, 4), 10) : new Date().getFullYear();
      }
      return toIso(y, month, day);
    }
  }

  // Nothing readable in the name: the last day the file has bills for is the
  // closest honest answer.
  return anchor ?? new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* row classification                                                  */
/* ------------------------------------------------------------------ */

/**
 * Party header row, bill row, or nothing.
 *
 * A bill row is NOT identified by having a bill number. Marg writes receipts
 * and adjustments with the number column empty — in the reference file 161
 * such rows carry -Rs 153 L between them, and treating them as blank dropped
 * every one. Worse, it dropped them silently and then reported the hole it
 * had made as a discrepancy between Marg's totals and its own bills.
 *
 * So a row counts as a bill when it has no party name but carries anything
 * that makes it a transaction: a number, a date, or money.
 */
export function classifyRow(row) {
  if (!row || row.length === 0) return 'blank';
  if (!isBlank(row[COLUMNS.PARTY_NAME])) return 'party';  // column 0 marks a party

  const hasBillNo = !isBlank(row[COLUMNS.BILL_NO]);
  const hasDate = !isBlank(row[COLUMNS.BILL_DATE]);
  const hasMoney =
    toNumber(row[COLUMNS.BALANCE]) !== 0 ||
    toNumber(row[COLUMNS.BILL_AMT]) !== 0 ||
    toNumber(row[COLUMNS.RECEIVED]) !== 0;

  return hasBillNo || hasDate || hasMoney ? 'bill' : 'blank';
}

/* ------------------------------------------------------------------ */
/* the parse                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse an array-of-arrays sheet into parties, bills and warnings.
 *
 * @param {Array<Array<any>>} rows   sheet as AoA (XLSX sheet_to_json header:1)
 * @param {{reportDate: string}} opts ISO date the export represents
 */
export function parseMargRows(rows, opts = {}) {
  const warnings = [];

  if (!Array.isArray(rows) || rows.length <= FIRST_DATA_ROW_INDEX) {
    throw new Error(
      `Not a Marg outstanding export: expected more than ${FIRST_DATA_ROW_INDEX} rows, got ${
        Array.isArray(rows) ? rows.length : 0
      }.`
    );
  }

  verifyHeaderRow(rows[HEADER_ROW_INDEX], warnings);

  // The date has to be known before bills are read, because bill age is
  // measured against it. When it is not supplied it is inferred from the
  // file name and the bill dates inside.
  const billDates = [];
  for (let i = FIRST_DATA_ROW_INDEX; i < rows.length; i++) {
    const row = rows[i];
    if (!row || classifyRow(row) !== 'bill') continue;
    const d = parseMargDate(row[COLUMNS.BILL_DATE]);
    if (d) billDates.push(d);
  }
  const reportDate = opts.reportDate ?? inferReportDate(opts.fileName ?? '', billDates);

  const newestBill = billDates.length ? [...billDates].sort().at(-1) : null;
  if (newestBill && newestBill > reportDate) {
    warnings.push({
      warning_type: 'bill_dated_after_report',
      party_name: null,
      detail: {
        report_date: reportDate,
        newest_bill_date: newestBill,
        message:
          `The file carries a bill dated ${newestBill}, after the report date ${reportDate}. ` +
          'Usually a post-dated entry; check the report date is right.',
      },
    });
  }

  const parties = [];
  let current = null;
  let orphanBills = 0;

  for (let i = FIRST_DATA_ROW_INDEX; i < rows.length; i++) {
    const row = rows[i];
    const kind = classifyRow(row);
    if (kind === 'blank') continue;

    if (kind === 'party') {
      current = startParty(row, i);
      parties.push(current);
      continue;
    }

    if (!current) {
      // A bill with no party above it cannot be attributed to anyone. Dropping
      // it would quietly lose money, so it is reported instead.
      orphanBills++;
      continue;
    }
    current.bills.push(readBill(row, i, reportDate));
  }

  if (orphanBills > 0) {
    warnings.push({
      warning_type: 'orphan_bill_rows',
      party_name: null,
      detail: {
        count: orphanBills,
        message: `${orphanBills} bill row(s) appeared before any party header and were not imported.`,
      },
    });
  }

  for (const party of parties) {
    finaliseParty(party, warnings);
  }

  dedupeNames(parties, warnings);

  return {
    reportDate,
    parties: parties.map(toPartyRecord),
    bills: parties.flatMap((p) => p.bills.map((b) => ({ ...b, normalised_name: p.normalised_name }))),
    warnings,
    totals: summarise(parties),
  };
}

function verifyHeaderRow(headerRow, warnings) {
  const got = (headerRow ?? []).map((c) => String(c ?? '').trim().toLowerCase());
  const mismatches = [];
  EXPECTED_HEADERS.forEach((expected, idx) => {
    const actual = got[idx] ?? '';
    if (!actual.startsWith(expected.slice(0, 6))) {
      mismatches.push({ column: idx, expected, actual });
    }
  });
  // The first six columns carry every figure the app relies on. If those
  // moved, the export is a different report and must not be trusted.
  const critical = mismatches.filter((m) => m.column <= COLUMNS.BALANCE);
  if (critical.length > 0) {
    throw new Error(
      'Unexpected column layout on row 5 — this does not look like a Marg ' +
        'outstanding bill-wise export. Mismatched: ' +
        critical.map((m) => `col ${m.column} expected "${m.expected}", got "${m.actual}"`).join('; ')
    );
  }
  if (mismatches.length > 0) {
    warnings.push({
      warning_type: 'header_layout_drift',
      party_name: null,
      detail: {
        message: 'Trailing columns differ from the expected layout; figures were still read from columns 0-8.',
        mismatches,
      },
    });
  }
}

function startParty(row, rowIndex) {
  const displayName = String(row[COLUMNS.PARTY_NAME]).trim();
  return {
    row_index: rowIndex,
    display_name: displayName,
    normalised_name: normaliseName(displayName),
    // RULE 3: this, and only this, is the party's outstanding.
    header_balance: toNumber(row[COLUMNS.BALANCE]),
    bills: [],
  };
}

function readBill(row, rowIndex, reportDate) {
  const rawBillNo = String(row[COLUMNS.BILL_NO] ?? '').trim();
  const billDate = parseMargDate(row[COLUMNS.BILL_DATE]);
  const dueDate = parseMargDate(row[COLUMNS.DUE_DATE]);
  const billAmount = toNumber(row[COLUMNS.BILL_AMT]);

  /*
   * Marg's "Days" column is days PAST DUE, measured from the Due Date — not
   * bill age. On most rows Due Date equals Bill Date, so the two coincide and
   * the column reads like an age; on the 121 rows of the reference file where
   * Marg carries a real due date they diverge, and some are negative because
   * the bill is not due yet.
   *
   * bill_age_days must mean age, so it is computed from the bill date. The
   * file's own figure is kept alongside it under its true name, and is used as
   * a fallback only when the bill date cannot be read.
   */
  const daysCell = row[COLUMNS.DAYS];
  const daysPastDueFromFile = isBlank(daysCell) ? null : Math.round(toNumber(daysCell));
  const ageComputed = daysBetween(billDate, reportDate);

  const onAccount = isOnAccountNumber(rawBillNo);
  const bare = isBareMarker(rawBillNo);

  return {
    row_index: rowIndex,
    bill_no_raw: rawBillNo,
    // A bare marker cannot identify a row; anything else already does.
    bill_no: bare ? synthesiseBillNo(billDate, billAmount) : rawBillNo,
    is_on_account: onAccount,
    bill_type: billTypeOf(rawBillNo),
    bill_date: billDate,
    // Marg's own due date, recorded but never turned into a credit term (rule 1).
    marg_due_date: dueDate,
    marg_has_due_date: Boolean(dueDate && billDate && dueDate !== billDate),
    bill_amount: billAmount,
    received: toNumber(row[COLUMNS.RECEIVED]),
    balance: toNumber(row[COLUMNS.BALANCE]),
    bill_age_days: ageComputed ?? daysPastDueFromFile,
    days_past_due: daysPastDueFromFile,
  };
}

function finaliseParty(party, warnings) {
  const billSum = party.bills.reduce((acc, b) => acc + b.balance, 0);
  party.bill_balance_sum = billSum;

  const ages = party.bills.map((b) => b.bill_age_days).filter((d) => typeof d === 'number');
  party.oldest_bill_age_days = ages.length ? Math.max(...ages) : null;
  party.bill_count = party.bills.length;

  // Ratio SQL uses to rescale age buckets back onto the header total, so the
  // buckets always add up to the figure the owner sees in Marg.
  party.reconcile_ratio = billSum === 0 ? null : party.header_balance / billSum;

  const gap = party.header_balance - billSum;
  if (Math.abs(gap) > RECONCILE_TOLERANCE) {
    warnings.push({
      warning_type: 'header_vs_bills_mismatch',
      party_name: party.display_name,
      detail: {
        header_balance: round2(party.header_balance),
        bill_balance_sum: round2(billSum),
        gap: round2(gap),
        bill_count: party.bills.length,
        message:
          `Header total and the sum of bill balances differ by ${round2(gap)}. ` +
          'The header figure was used, per Marg. Ageing buckets are rescaled to match it.',
      },
    });
  }

  if (party.bills.length === 0 && party.header_balance !== 0) {
    warnings.push({
      warning_type: 'party_without_bills',
      party_name: party.display_name,
      detail: {
        header_balance: round2(party.header_balance),
        message: 'Party carries a balance but no bill rows, so it cannot be aged.',
      },
    });
  }

  /*
   * Marg carries a real due date on a minority of rows, which means someone
   * entered a credit period for those bills. That is recorded fact, not
   * inference, so it is surfaced — but it is NOT written into the party's
   * credit term. Rule 1 names due dates explicitly among the things a term
   * may never be back-calculated from; approving it stays a human decision,
   * and this warning is what puts it in front of one.
   */
  const withDueDate = party.bills.filter((b) => b.marg_has_due_date);
  if (withDueDate.length > 0) {
    const spans = withDueDate
      .map((b) => daysBetween(b.bill_date, b.marg_due_date))
      .filter((d) => typeof d === 'number');
    warnings.push({
      warning_type: 'marg_due_date_present',
      party_name: party.display_name,
      detail: {
        bill_count: withDueDate.length,
        observed_spans_days: [...new Set(spans)].sort((a, b) => a - b),
        message:
          `Marg carries a due date on ${withDueDate.length} of this party's bills, ` +
          `implying a credit period of ${[...new Set(spans)].sort((a, b) => a - b).join(' or ')} days. ` +
          'Recorded for review — it has NOT been applied as a credit term.',
      },
    });
  }

  if (party.header_balance < -ZERO_TOLERANCE) {
    warnings.push({
      warning_type: 'credit_balance',
      party_name: party.display_name,
      detail: {
        header_balance: round2(party.header_balance),
        message: 'Credit balance — advance or unadjusted credit note. Not debt; excluded from collection views.',
      },
    });
  }

  dedupeBillNumbers(party, warnings);
}

/**
 * The (snapshot, party, bill_no) unique key admits no repeats. Real exports
 * do repeat: several on-account "*" rows, and occasionally a genuine bill
 * number twice. Both are suffixed rather than dropped — losing a row would
 * lose money — and each is reported.
 */
function dedupeBillNumbers(party, warnings) {
  const seen = new Map();
  for (const bill of party.bills) {
    const base = bill.bill_no;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) {
      bill.bill_no = `${base}~${n}`;
      warnings.push({
        warning_type: 'duplicate_bill_no',
        party_name: party.display_name,
        detail: {
          bill_no: base,
          occurrence: n,
          stored_as: bill.bill_no,
          balance: round2(bill.balance),
          message: bill.is_on_account
            ? 'Repeated on-account entry; stored under a synthetic key so it survives the unique index.'
            : 'Bill number appears more than once for this party; stored under a suffixed key.',
        },
      });
    }
  }
}

/**
 * normalised_name is unique in Postgres. Two spellings that normalise the
 * same would collide on insert, so they are merged here — header balances
 * summed, bills concatenated — and reported.
 */
function dedupeNames(parties, warnings) {
  const byName = new Map();
  const absorbed = new Set();
  for (const party of parties) {
    const existing = byName.get(party.normalised_name);
    if (!existing) {
      byName.set(party.normalised_name, party);
      continue;
    }
    absorbed.add(existing);
    warnings.push({
      warning_type: 'duplicate_party_name',
      party_name: party.display_name,
      detail: {
        normalised_name: party.normalised_name,
        merged_into: existing.display_name,
        added_balance: round2(party.header_balance),
        message: 'Two header rows normalise to the same name; their balances and bills were merged.',
      },
    });
    existing.header_balance += party.header_balance;
    existing.bill_balance_sum += party.bill_balance_sum;
    existing.bills.push(...party.bills);
    existing.bill_count = existing.bills.length;
    const ages = existing.bills.map((b) => b.bill_age_days).filter((d) => typeof d === 'number');
    existing.oldest_bill_age_days = ages.length ? Math.max(...ages) : null;
    existing.reconcile_ratio =
      existing.bill_balance_sum === 0 ? null : existing.header_balance / existing.bill_balance_sum;
    party.merged = true;
  }
  // A merge can pull two bills carrying the same number into one party, so
  // the absorbing party's numbers have to be made unique again. Re-running is
  // safe: already-suffixed numbers are unique and pass through untouched.
  for (const party of absorbed) {
    dedupeBillNumbers(party, warnings);
  }

  // Drop merged duplicates in place.
  for (let i = parties.length - 1; i >= 0; i--) {
    if (parties[i].merged) parties.splice(i, 1);
  }
}

function toPartyRecord(p) {
  return {
    display_name: p.display_name,
    normalised_name: p.normalised_name,
    current_outstanding: round2(p.header_balance),
    bill_balance_sum: round2(p.bill_balance_sum),
    reconcile_ratio: p.reconcile_ratio,
    oldest_bill_age_days: p.oldest_bill_age_days,
    bill_count: p.bill_count,
    source_row: p.row_index,
  };
}

function summarise(parties) {
  let totalOwed = 0;
  let totalCredit = 0;
  let owingCount = 0;
  let creditCount = 0;
  let zeroCount = 0;
  let billCount = 0;

  for (const p of parties) {
    const v = p.header_balance;
    billCount += p.bills.length;
    // Totals keep the exact figures; only the counts use the tolerance.
    if (v > ZERO_TOLERANCE) {
      totalOwed += v;
      owingCount++;
    } else if (v < -ZERO_TOLERANCE) {
      totalCredit += v;
      creditCount++;
    } else {
      zeroCount++;
      if (v > 0) totalOwed += v;
      else if (v < 0) totalCredit += v;
    }
  }

  return {
    partyCount: parties.length,
    billCount,
    owingCount,
    creditCount,
    zeroCount,
    totalOwed: round2(totalOwed),
    totalCredit: round2(totalCredit),
    netTotal: round2(totalOwed + totalCredit),
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* workbook entry point                                                */
/* ------------------------------------------------------------------ */

/**
 * Read a Marg .xls (legacy BIFF) ArrayBuffer and parse it.
 *
 * `XLSX` is injected so the parser stays testable without bundling SheetJS
 * into the test run; the import screen passes the real module.
 */
export function parseMargWorkbook(arrayBuffer, XLSX, opts = {}) {
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('The workbook contains no sheets.');
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: null, raw: true });
  return parseMargRows(rows, opts);
}
