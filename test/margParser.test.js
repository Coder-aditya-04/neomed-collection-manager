import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseMargRows,
  parseMargWorkbook,
  parseMargDate,
  normaliseName,
  billTypeOf,
  toNumber,
  classifyRow,
  daysBetween,
} from '../src/lib/margParser.js';
import { makeMargRows, TARGETS, NAMED_MISMATCHES, REPORT_DATE } from './fixtures/makeMargFile.js';

const fixture = makeMargRows();
const parsed = parseMargRows(fixture.rows, { reportDate: REPORT_DATE });

const byName = new Map(parsed.parties.map((p) => [p.display_name, p]));

/* ================================================================== */
describe('cell readers', () => {
/* ================================================================== */

  it('reads numbers, including the dialects an export can emit', () => {
    expect(toNumber(1234.5)).toBe(1234.5);
    expect(toNumber('1,23,456')).toBe(123456);       // Indian grouping
    expect(toNumber('₹ 5,000')).toBe(5000);
    expect(toNumber('(1,234)')).toBe(-1234);         // accounting negative
    expect(toNumber('1234-')).toBe(-1234);           // trailing-minus dialect
    expect(toNumber('')).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('not a number')).toBe(0);
  });

  it('treats a literal zero as present, not blank', () => {
    // P.D.C. is 0 on all 8,197 rows; reading 0 as empty would misclassify rows.
    expect(classifyRow([null, 0, null])).toBe('bill');
  });

  it('classifies party header rows and bill rows by column 0', () => {
    expect(classifyRow(['SOME HOSPITAL', null, null, null, null, 5000])).toBe('party');
    expect(classifyRow([null, 'CRE1001', '02-Sep-26'])).toBe('bill');
    expect(classifyRow([null, null, null])).toBe('blank');
    expect(classifyRow([])).toBe('blank');
  });
});

/* ================================================================== */
describe('date parsing', () => {
/* ================================================================== */

  it('reads DD-MMM-YY', () => {
    expect(parseMargDate('02-Sep-26')).toBe('2026-09-02');
    expect(parseMargDate('31-Dec-23')).toBe('2023-12-31');
    expect(parseMargDate('1-Jan-24')).toBe('2024-01-01');
  });

  it('does not repeat the Date.parse two-digit-year bug', () => {
    // Date.parse('02-Sep-26') is engine-dependent and has historically read
    // the year as 1926. Every bill in this file would then be ~36,000 days old.
    expect(parseMargDate('02-Sep-26')).toBe('2026-09-02');
    expect(parseMargDate('02-Sep-26').startsWith('2026')).toBe(true);
  });

  it('pivots two-digit years at 70', () => {
    expect(parseMargDate('01-Jan-69')).toBe('2069-01-01');
    expect(parseMargDate('01-Jan-70')).toBe('1970-01-01');
  });

  it('rejects impossible and unreadable dates', () => {
    expect(parseMargDate('31-Feb-26')).toBeNull();
    expect(parseMargDate('32-Jan-26')).toBeNull();
    expect(parseMargDate('02-Xyz-26')).toBeNull();
    expect(parseMargDate('')).toBeNull();
    expect(parseMargDate(null)).toBeNull();
  });

  it('measures age in whole days', () => {
    expect(daysBetween('2026-09-02', '2026-09-09')).toBe(7);
    expect(daysBetween('2023-12-31', '2024-01-01')).toBe(1);
    expect(daysBetween(null, '2026-09-09')).toBeNull();
  });
});

/* ================================================================== */
describe('names and bill numbers', () => {
/* ================================================================== */

  it('normalises for matching but never for display', () => {
    expect(normaliseName('Acme Hospital ,')).toBe('ACME HOSPITAL');
    expect(normaliseName('SOME  HEALTHCARE   PVT LTD')).toBe('SOME HEALTHCARE PVT LTD');
    expect(normaliseName('  sunrise multispeciality.  ')).toBe('SUNRISE MULTISPECIALITY');
  });

  it('keeps PVT LTD and NEW, which distinguish real ledgers', () => {
    // Dropping these is the fuzzy searcher's job, not the identity key's:
    // Marg may hold both spellings as genuinely separate parties.
    expect(normaliseName('EXAMPLE HOSPITAL NEW'))
      .not.toBe(normaliseName('EXAMPLE HOSPITAL'));
  });

  it('classifies bill types by prefix', () => {
    expect(billTypeOf('CRE10432')).toBe('CRE');
    expect(billTypeOf('CN2051')).toBe('CN');
    expect(billTypeOf('CSHE512')).toBe('CSHE');
    expect(billTypeOf('PDSN104')).toBe('PDSN');
    expect(billTypeOf('XYZ1')).toBe('OTHER');
    expect(billTypeOf('*')).toBe('OTHER');
  });

  it('sees through the on-account marker to the series underneath', () => {
    // "*" marks an on-account entry and is orthogonal to the series. Matching
    // it unstripped sent 1,718 of the real file's rows to OTHER.
    expect(billTypeOf('*CN0061')).toBe('CN');
    expect(billTypeOf('*PDSN01')).toBe('PDSN');
    expect(billTypeOf('*CRE0099')).toBe('CRE');
    expect(billTypeOf('#RTGS')).toBe('OTHER');
  });

  it('flags a marker-prefixed number as on account but keeps it as its own key', () => {
    const rows = headerRows().concat([
      ['MARKER HOSPITAL', null, null, null, null, -5000, null, null, null, null, null],
      [null, '*CRD023345', '12-Jan-26', -5000, 0, -5000, -5000, '12-Jan-26', 240, 0, null],
    ]);
    const out = parseMargRows(rows, { reportDate: REPORT_DATE });
    expect(out.bills[0].is_on_account).toBe(true);
    // It already identifies the row, so it must not be replaced by a synthetic.
    expect(out.bills[0].bill_no).toBe('*CRD023345');
  });
});

/* ================================================================== */
describe('THE CRITICAL RULE — party total comes from the header row', () => {
/* ================================================================== */

  it('reports the header net total, not the bill-row net total', () => {
    expect(parsed.totals.netTotal).toBe(TARGETS.netTotal);
    expect(inCrore(parsed.totals.netTotal)).toBe('7.93');
  });

  it('would have produced a visibly different figure by summing bills', () => {
    // This is the failure the spec calls fatal: ~8.93 Cr instead of ~7.93 Cr.
    const billSumNet = parsed.bills.reduce((a, b) => a + b.balance, 0);
    expect(billSumNet).toBeGreaterThan(parsed.totals.netTotal);
    expect(billSumNet - parsed.totals.netTotal).toBeGreaterThan(9000000); // ~Rs 1 Cr
    expect(inCrore(billSumNet)).not.toBe('7.93');
  });

  it('takes each named disagreement from its header row', () => {
    for (const m of NAMED_MISMATCHES) {
      const party = byName.get(m.name);
      expect(party, `${m.name} should be present`).toBeDefined();
      expect(party.current_outstanding).toBe(m.header);
      expect(party.bill_balance_sum).toBe(m.billSum);
      expect(party.current_outstanding).not.toBe(party.bill_balance_sum);
    }
  });

  it('carries a ratio that rescales age buckets back onto the header total', () => {
    const biggest = byName.get('PARTY C (LARGEST EXPOSURE)');
    const rescaled = biggest.bill_balance_sum * biggest.reconcile_ratio;
    expect(rescaled).toBeCloseTo(biggest.current_outstanding, 2);
  });
});

/* ================================================================== */
describe('reconciliation warnings', () => {
/* ================================================================== */

  const mismatchWarnings = parsed.warnings.filter((w) => w.warning_type === 'header_vs_bills_mismatch');

  it('raises one per party whose gap exceeds Rs 1,000', () => {
    expect(mismatchWarnings).toHaveLength(TARGETS.mismatchCount);
  });

  it('names each one with both figures and the gap', () => {
    const worst = mismatchWarnings.find((w) => w.party_name === 'PARTY A (LARGE HOSPITAL)');
    expect(worst).toBeDefined();
    expect(worst.detail.header_balance).toBe(3123000);
    expect(worst.detail.bill_balance_sum).toBe(5286000);
    expect(worst.detail.gap).toBe(3123000 - 5286000);
  });

  it('stays quiet about parties that reconcile', () => {
    const reconciling = parsed.parties.filter(
      (p) => Math.abs(p.current_outstanding - p.bill_balance_sum) <= 1000
    );
    const noisy = reconciling.filter((p) =>
      mismatchWarnings.some((w) => w.party_name === p.display_name)
    );
    expect(noisy).toEqual([]);
  });

  it('flags every credit balance as needing adjustment', () => {
    const credit = parsed.warnings.filter((w) => w.warning_type === 'credit_balance');
    expect(credit).toHaveLength(TARGETS.creditCount);
  });
});

/* ================================================================== */
describe('acceptance figures for the reference export', () => {
/* ================================================================== */

  it('counts 819 parties, split 709 owing / 97 credit / 13 zero', () => {
    expect(parsed.totals.partyCount).toBe(TARGETS.partyCount);
    expect(parsed.totals.owingCount).toBe(TARGETS.owingCount);
    expect(parsed.totals.creditCount).toBe(TARGETS.creditCount);
    expect(parsed.totals.zeroCount).toBe(TARGETS.zeroCount);
  });

  it('counts 8,197 bill rows', () => {
    expect(parsed.totals.billCount).toBe(TARGETS.billCount);
    expect(parsed.bills).toHaveLength(TARGETS.billCount);
  });

  it('totals Rs 8.06 Cr owed and -Rs 12.61 L in credit', () => {
    expect(parsed.totals.totalOwed).toBe(TARGETS.totalOwed);
    expect(parsed.totals.totalCredit).toBe(TARGETS.totalCredit);
  });

  it('never counts a negative balance as debt', () => {
    // Rule 6. totalOwed is positive balances only.
    const positives = parsed.parties.filter((p) => p.current_outstanding > 0);
    expect(positives.reduce((a, p) => a + p.current_outstanding, 0)).toBe(TARGETS.totalOwed);
  });

  it('finds the 2,370-day-old bill', () => {
    const oldest = Math.max(...parsed.parties.map((p) => p.oldest_bill_age_days ?? 0));
    expect(oldest).toBe(2370);
  });
});

/* ================================================================== */
describe('the awkward rows', () => {
/* ================================================================== */

  it('keeps on-account "*" entries without crashing or colliding', () => {
    const onAccount = parsed.bills.filter((b) => b.is_on_account);
    expect(onAccount.length).toBeGreaterThan(0);
    for (const b of onAccount) {
      expect(b.bill_no_raw).toBe('*');
      expect(b.bill_no).not.toBe('*');       // a synthetic, stable key
      expect(b.bill_no.startsWith('*~')).toBe(true);
    }
    expect(onAccount.every((b) => b.is_on_account)).toBe(true);
  });

  it('holds bill numbers unique within a party, as the index requires', () => {
    const seen = new Set();
    for (const b of parsed.bills) {
      const key = `${b.normalised_name}::${b.bill_no}`;
      expect(seen.has(key), `duplicate key ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('computes bill age from the bill date, not from Marg\'s Days column', () => {
    // Marg's Days column is days PAST DUE, measured from its due date. Where
    // the due date equals the bill date the two coincide, which is why the
    // column looks like an age; where Marg carries a real credit period they
    // diverge, and the figure can even be negative.
    const sample = parsed.bills.find((b) => b.bill_date && b.bill_age_days != null);
    expect(sample.bill_age_days).toBe(daysBetween(sample.bill_date, REPORT_DATE));
  });

  it('records Marg\'s due date without turning it into a credit term', () => {
    const rows = headerRows().concat([
      ['TERMED HOSPITAL', null, null, null, null, 10000, null, null, null, null, null],
      // Billed 13 Jul, due 11 Sep: a 60-day period Marg is already holding.
      [null, 'CRE100', '13-Jul-26', 10000, 0, 10000, 10000, '11-Sep-26', -2, 0, null],
    ]);
    const out = parseMargRows(rows, { reportDate: REPORT_DATE });
    const bill = out.bills[0];

    expect(bill.marg_due_date).toBe('2026-09-11');
    expect(bill.marg_has_due_date).toBe(true);
    expect(bill.days_past_due).toBe(-2);          // kept under its true name
    expect(bill.bill_age_days).toBe(58);          // 13 Jul -> 9 Sep

    // Surfaced for a human to approve — rule 1 forbids deriving a term from it.
    const warn = out.warnings.find((w) => w.warning_type === 'marg_due_date_present');
    expect(warn).toBeDefined();
    expect(warn.detail.observed_spans_days).toEqual([60]);
    expect(warn.detail.message).toContain('NOT been applied');

    // Nothing on the party record carries a term.
    expect(Object.keys(out.parties[0])).not.toContain('credit_days');
    expect(Object.keys(out.parties[0])).not.toContain('credit_type');
  });

  it('stays quiet when Marg\'s due date just repeats the bill date', () => {
    const rows = headerRows().concat([
      ['PLAIN HOSPITAL', null, null, null, null, 1000, null, null, null, null, null],
      [null, 'CRE200', '02-Sep-26', 1000, 0, 1000, 1000, '02-Sep-26', 7, 0, null],
    ]);
    const out = parseMargRows(rows, { reportDate: REPORT_DATE });
    expect(out.bills[0].marg_has_due_date).toBe(false);
    expect(out.warnings.some((w) => w.warning_type === 'marg_due_date_present')).toBe(false);
  });

  it('survives a party header with no bill rows beneath it', () => {
    const rows = headerRows().concat([
      ['LONELY HOSPITAL', null, null, null, null, 45000, null, null, null, null, null],
    ]);
    const out = parseMargRows(rows, { reportDate: REPORT_DATE });
    expect(out.parties[0].current_outstanding).toBe(45000);
    expect(out.parties[0].reconcile_ratio).toBeNull();
    expect(out.warnings.some((w) => w.warning_type === 'party_without_bills')).toBe(true);
  });

  it('reports bill rows that appear before any party header', () => {
    const rows = headerRows().concat([
      [null, 'CRE999', '02-Sep-26', 1000, 0, 1000, 1000, '02-Sep-26', 7, 0, null],
    ]);
    const out = parseMargRows(rows, { reportDate: REPORT_DATE });
    expect(out.parties).toHaveLength(0);
    expect(out.warnings.some((w) => w.warning_type === 'orphan_bill_rows')).toBe(true);
  });

  it('merges two spellings that normalise identically', () => {
    const rows = headerRows().concat([
      ['ACME MEDICALS ,', null, null, null, null, 1000, null, null, null, null, null],
      [null, 'CRE1', '02-Sep-26', 1000, 0, 1000, 1000, '02-Sep-26', 7, 0, null],
      ['ACME  MEDICALS', null, null, null, null, 500, null, null, null, null, null],
      [null, 'CRE1', '03-Sep-26', 500, 0, 500, 500, '03-Sep-26', 6, 0, null],
    ]);
    const out = parseMargRows(rows, { reportDate: REPORT_DATE });
    expect(out.parties).toHaveLength(1);
    expect(out.parties[0].current_outstanding).toBe(1500);
    // Both parties used CRE1 — the merge must not break the unique key.
    const numbers = out.bills.map((b) => b.bill_no);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(out.warnings.some((w) => w.warning_type === 'duplicate_party_name')).toBe(true);
  });

  it('refuses a file whose money columns are not where they should be', () => {
    const wrong = [
      [], [], [], [],
      ['Date', 'Voucher', 'Narration', 'Debit', 'Credit', 'Running', null, null, null, null, null],
      ['x', null, null, null, null, 1, null, null, null, null, null],
    ];
    expect(() => parseMargRows(wrong, { reportDate: REPORT_DATE })).toThrow(/does not look like a Marg/);
  });

  it('refuses a file too short to contain data', () => {
    expect(() => parseMargRows([[], [], []], { reportDate: REPORT_DATE })).toThrow(/Not a Marg/);
  });
});

/* ================================================================== */
describe('workbook entry point', () => {
/* ================================================================== */

  it('parses a real workbook end to end and lands the same figures', () => {
    const ws = XLSX.utils.aoa_to_sheet(fixture.rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Outstanding');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xls' });

    const out = parseMargWorkbook(buf, XLSX, { reportDate: REPORT_DATE });
    expect(out.totals.partyCount).toBe(TARGETS.partyCount);
    expect(out.totals.billCount).toBe(TARGETS.billCount);
    expect(out.totals.netTotal).toBe(TARGETS.netTotal);
  });
});

/* ------------------------------------------------------------------ */

function headerRows() {
  return [
    ['NEOMED PHARMA AGENCIES', null, null, null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null, null, null, null],
    ['Party Name', 'Bill No.', 'Bill Date', 'Bill Amt.', 'Received',
      'Balance', 'Cumulative Total', 'Due Date', 'Days', 'P.D.C.', 'Remark'],
  ];
}

function inCrore(n) {
  return (n / 1e7).toFixed(2);
}
