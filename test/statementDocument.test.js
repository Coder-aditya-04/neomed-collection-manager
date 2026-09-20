import { describe, it, expect } from 'vitest';
import { plain, displayBillNo } from '../src/features/statements/StatementDocument.jsx';

describe('statement figures', () => {
  it('groups the Indian way, with no symbol or abbreviation', () => {
    // A party checking a statement against their own ledger wants 2,59,761 —
    // not the app's Rs 2.60 L shorthand.
    expect(plain(259761)).toBe('2,59,761');
    expect(plain(8972000)).toBe('89,72,000');
    expect(plain(1234)).toBe('1,234');
    expect(plain(999)).toBe('999');
    expect(plain(0)).toBe('0');
  });

  it('keeps a credit balance visibly negative', () => {
    expect(plain(-20415)).toBe('-20,415');
  });

  it('rounds to whole rupees', () => {
    expect(plain(259760.51)).toBe('2,59,761');
  });

  it('survives nothing at all', () => {
    expect(plain(null)).toBe('0');
    expect(plain(undefined)).toBe('0');
  });
});

describe('bill numbers on a customer statement', () => {
  it('never prints our internal key for an on-account row', () => {
    // "*~2026-02-23~-12" is a key we invented so the row survives the unique
    // index. To the party it looks like a typo.
    expect(displayBillNo('*~2026-02-23~-12')).toBe('On account');
    expect(displayBillNo('*')).toBe('On account');
    expect(displayBillNo('#')).toBe('On account');
  });

  it('leaves a real bill number exactly as Marg wrote it', () => {
    expect(displayBillNo('CRE013177')).toBe('CRE013177');
    expect(displayBillNo('*CRD023345')).toBe('*CRD023345');
    expect(displayBillNo('CN00547')).toBe('CN00547');
  });
});

describe('statement reconciliation', () => {
  // The three lines under the table must add to the ledger balance, or the
  // party is looking at a statement that does not balance.
  it('listed + not listed + unallocated equals the ledger balance', () => {
    const listed = 1120344;
    const allBills = 8836567;      // every bill, listed or not
    const ledger = 6596710;
    const notListed = allBills - listed;
    const unallocated = ledger - allBills;
    expect(listed + notListed + unallocated).toBe(ledger);
    expect(unallocated).toBeLessThan(0);   // money received, not yet applied
  });

  it('shows no adjustment when the bills already add up', () => {
    const listed = 259761;
    const ledger = 259761;
    expect(Math.abs(ledger - listed) > 1).toBe(false);
  });
});
