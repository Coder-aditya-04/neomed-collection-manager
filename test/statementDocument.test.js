import { describe, it, expect } from 'vitest';
import { plain } from '../src/features/statements/StatementDocument.jsx';

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
