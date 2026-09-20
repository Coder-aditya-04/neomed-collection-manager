import { describe, it, expect } from 'vitest';
import { buildStatementText, statementWhatsAppLink, planBatch } from '../src/features/statements/statement.js';

const PARTY = {
  display_name: 'GODAVARI NURSING HOME',
  contact_person: 'Dr Kulkarni',
  phone: '9876543210',
  current_outstanding: 8972000,
  bill_count: 3,
  oldest_bill_age_days: 214,
};

const BILLS = [
  { bill_no: 'CRE008216', bill_date: '2026-07-06', balance: 8524000 },
  { bill_no: 'CRE008347', bill_date: '2026-07-08', balance: 20415 },
  { bill_no: 'CRE008350', bill_date: '2026-07-08', balance: 3559 },
];

describe('statement text', () => {
  const text = buildStatementText(PARTY, BILLS, { asOf: '2026-09-15' });

  it('leads with the balance in Indian format', () => {
    expect(text).toContain('₹89.72 L');
    expect(text).toContain('as on 15 Sep 2026');
  });

  it('greets the contact person when one is known', () => {
    expect(text).toContain('Dear Dr Kulkarni');
  });

  it('falls back to a neutral greeting when none is', () => {
    expect(buildStatementText({ ...PARTY, contact_person: null }, BILLS, {}))
      .toContain('Dear Sir/Madam');
  });

  it('lists bills oldest first, since those are the ones being asked about', () => {
    const first = text.indexOf('CRE008216');
    const later = text.indexOf('CRE008350');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(later);
  });

  it('leaves out bills that are already settled', () => {
    const withPaid = [...BILLS, { bill_no: 'CRE009999', bill_date: '2026-08-01', balance: 0 }];
    expect(buildStatementText(PARTY, withPaid, {})).not.toContain('CRE009999');
  });

  it('summarises rather than listing eighty bills at a party', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      bill_no: `CRE${9000 + i}`, bill_date: '2026-08-01', balance: 1000,
    }));
    const t = buildStatementText(PARTY, many, {});
    expect(t).toContain('and 18 more totalling');
    expect(t).not.toContain('CRE9029');
  });

  it('asks them to name anything already paid', () => {
    // This is what surfaces the unallocated receipts the client cares about.
    expect(text.toLowerCase()).toContain('already settled');
  });

  it('copes with a party that has no open bills', () => {
    const t = buildStatementText(PARTY, [], {});
    expect(t).toContain('₹89.72 L');
    expect(t).not.toContain('Bill details');
  });
});

describe('whatsapp link', () => {
  it('carries the statement to a normalised number', () => {
    const url = statementWhatsAppLink(PARTY, BILLS, { asOf: '2026-09-15' });
    expect(url.startsWith('https://wa.me/919876543210')).toBe(true);
    const text = decodeURIComponent(new URL(url).searchParams.get('text'));
    expect(text).toContain('CRE008216');
  });

  it('produces nothing without a usable number', () => {
    expect(statementWhatsAppLink({ ...PARTY, phone: null }, BILLS, {})).toBeNull();
  });
});

describe('batch planning', () => {
  it('separates who can be sent to from who cannot', () => {
    const plan = planBatch([
      PARTY,
      { ...PARTY, display_name: 'NO NUMBER', phone: null, current_outstanding: 50000 },
    ]);
    expect(plan.sendable).toHaveLength(1);
    expect(plan.missingNumber).toHaveLength(1);
    expect(plan.missingValue).toBe(50000);
  });

  it('counts the value that cannot be reached, so it is not silently skipped', () => {
    const plan = planBatch([{ ...PARTY, phone: '' }]);
    expect(plan.sendableValue).toBe(0);
    expect(plan.missingValue).toBe(8972000);
  });
});
