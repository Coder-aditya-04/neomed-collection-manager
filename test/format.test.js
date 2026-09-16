import { describe, it, expect } from 'vitest';
import {
  formatInr, formatInrDelta, formatCount, formatAge, formatOverdue,
  formatPct, formatDate, formatCreditTerm, creditTermBadge, groupIndian,
} from '../src/lib/format.js';

/**
 * The expected strings below are not hand-written: they were produced by
 * fn_fmt_inr running in Postgres and pasted in. Rule 8 says every figure
 * traces to a rule, and a figure that reads differently depending on whether
 * SQL or React rendered it does not.
 */
const SQL_VERIFIED = [
  [79300000, '₹7.93 Cr'],
  [80600000, '₹8.06 Cr'],
  [8972000, '₹89.72 L'],
  [3123000, '₹31.23 L'],
  [1261000, '₹12.61 L'],
  [-1261000, '−₹12.61 L'],
  [123456, '₹1.23 L'],
  [99999, '₹99,999'],
  [950, '₹950'],
  [0, '₹0'],
  [-8972000, '−₹89.72 L'],
  [100000, '₹1.00 L'],
  [10000000, '₹1.00 Cr'],
  [-500, '−₹500'],
];

describe('formatInr agrees with fn_fmt_inr in Postgres', () => {
  for (const [input, expected] of SQL_VERIFIED) {
    it(`${input} -> ${expected}`, () => {
      expect(formatInr(input)).toBe(expected);
    });
  }

  it('uses a true minus sign, not a hyphen', () => {
    expect(formatInr(-1261000).charCodeAt(0)).toBe(0x2212);
  });

  it('renders nothing-known as an em dash, never as zero', () => {
    expect(formatInr(null)).toBe('—');
    expect(formatInr(undefined)).toBe('—');
    expect(formatInr(NaN)).toBe('—');
  });
});

describe('Indian digit grouping', () => {
  it('groups the last three, then in pairs', () => {
    expect(groupIndian(1234)).toBe('1,234');
    expect(groupIndian(123456)).toBe('1,23,456');
    expect(groupIndian(8197)).toBe('8,197');
    expect(groupIndian(12345678)).toBe('1,23,45,678');
    expect(groupIndian(819)).toBe('819');
  });

  it('formats the counts the product actually shows', () => {
    expect(formatCount(8197)).toBe('8,197');
    expect(formatCount(819)).toBe('819');
    expect(formatCount(612)).toBe('612');
  });
});

describe('deltas', () => {
  it('signs a rise and a fall', () => {
    expect(formatInrDelta(1140000)).toBe('+₹11.40 L');
    expect(formatInrDelta(-342000)).toBe('−₹3.42 L');
    expect(formatInrDelta(0)).toBe('₹0');
  });
});

describe('age is never dressed up as lateness', () => {
  it('renders a bill age plainly', () => {
    expect(formatAge(2370)).toBe('2,370d');
    expect(formatAge(0)).toBe('0d');
    expect(formatAge(null)).toBe('—');
  });

  it('says so when there is no term to be late against', () => {
    // The whole point of rule 1: no term means no overdue figure exists,
    // and zero would read as "nothing is overdue".
    expect(formatOverdue(null)).toBe('no term set');
    expect(formatOverdue(undefined)).toBe('no term set');
  });

  it('distinguishes within-terms from over', () => {
    expect(formatOverdue(0)).toBe('within terms');
    expect(formatOverdue(-10)).toBe('within terms');
    expect(formatOverdue(78)).toBe('78d over');
  });
});

describe('credit terms on screen', () => {
  it('writes a days term', () => {
    expect(formatCreditTerm({ credit_type: 'days', credit_days: 30, credit_source: 'approved' }))
      .toBe('30 days');
  });

  it('writes a cycle term in the client\'s own language', () => {
    expect(formatCreditTerm({
      credit_type: 'cycle', cycle_submit_day: 5, cycle_pay_day: 25,
      cycle_lag_months: 1, credit_source: 'approved',
    })).toBe('by 5th, paid 25th next month');

    expect(formatCreditTerm({
      credit_type: 'cycle', cycle_submit_day: 3, cycle_pay_day: 21,
      cycle_lag_months: 0, credit_source: 'approved',
    })).toBe('by 3rd, paid 21st same month');
  });

  it('never renders an unset term as blank or zero', () => {
    expect(formatCreditTerm({ credit_type: 'none', credit_source: 'not_set' })).toBe('Term not set');
    expect(formatCreditTerm(null)).toBe('Term not set');
  });

  it('labels an assumed term as assumed (rule 2)', () => {
    const badge = creditTermBadge({
      credit_type: 'days', credit_days: 60, credit_source: 'category_default',
    });
    expect(badge.tone).toBe('assumed');
    expect(badge.label).toContain('ASSUMED');
    expect(badge.label).not.toContain('APPROVED');
  });

  it('marks an approved term as approved', () => {
    const badge = creditTermBadge({
      credit_type: 'days', credit_days: 60, credit_source: 'approved',
    });
    expect(badge.tone).toBe('approved');
    expect(badge.label).toContain('APPROVED');
  });

  it('marks an unset term as unset', () => {
    expect(creditTermBadge({ credit_source: 'not_set' }).tone).toBe('unset');
  });
});

describe('percentages and dates', () => {
  it('rounds percentages to whole numbers', () => {
    expect(formatPct(4040000, 7930000)).toBe('51%');
    expect(formatPct(0, 100)).toBe('0%');
    expect(formatPct(5, 0)).toBe('—');
  });

  it('formats a date beside a figure', () => {
    expect(formatDate('2026-09-12')).toBe('12 Sep 2026');
    expect(formatDate('2023-12-01')).toBe('1 Dec 2023');
    expect(formatDate(null)).toBe('—');
  });
});
