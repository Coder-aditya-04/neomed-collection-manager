import { describe, it, expect } from 'vitest';
import {
  matchIntent, parseAmount, parseDays, parseCount,
  scoreParty, findParty, significantTokens, MATCH_THRESHOLD,
} from '../src/features/assistant/intents.js';

/** Stand-in for v_party_ageing rows. */
const PARTIES = [
  { party_id: '1', display_name: 'PARTY C (LARGEST EXPOSURE)', credit_source: 'not_set' },
  { party_id: '2', display_name: 'KIMS MANAVATA CENTRAL DRUG STORE', credit_source: 'approved' },
  { party_id: '3', display_name: 'SUNRISE MULTISPECIALITY PVT LTD', credit_source: 'approved' },
  { party_id: '4', display_name: 'SHREE MEDICAL AND GENERAL STORES', credit_source: 'not_set' },
  { party_id: '5', display_name: 'GODAVARI NURSING HOME ,', credit_source: 'approved' },
];

describe('amount parsing', () => {
  it('reads the forms people actually type', () => {
    expect(parseAmount('parties above 5 lakh')).toBe(500000);
    expect(parseAmount('₹5L')).toBe(500000);
    expect(parseAmount('50 lakh')).toBe(5000000);
    expect(parseAmount('1 crore')).toBe(10000000);
    expect(parseAmount('1.5 cr')).toBe(15000000);
    expect(parseAmount('above 10,000')).toBe(10000);
    expect(parseAmount('2 lacs')).toBe(200000);
  });

  it('returns nothing when there is no amount', () => {
    expect(parseAmount('who should I call today')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });

  it('does not read a day count as an amount', () => {
    // "older than 90 days" must not become a 90-rupee threshold.
    expect(parseAmount('bills older than 90 days')).toBeNull();
  });
});

describe('day parsing', () => {
  it('reads days, months and years', () => {
    expect(parseDays('older than 90 days')).toBe(90);
    expect(parseDays('over 6 months')).toBe(180);
    expect(parseDays('more than 1 year')).toBe(365);
    expect(parseDays('beyond 45')).toBe(45);
  });

  it('returns nothing when there is no period', () => {
    expect(parseDays('top 10 parties')).toBeNull();
  });
});

describe('count parsing', () => {
  it('reads digits and words', () => {
    expect(parseCount('top 10 by outstanding')).toBe(10);
    expect(parseCount('top five parties')).toBe(5);
    expect(parseCount('biggest 20')).toBe(20);
  });

  it('falls back when no count is given', () => {
    expect(parseCount('top parties', 10)).toBe(10);
  });

  it('will not return an unbounded list', () => {
    expect(parseCount('top 5000 parties')).toBe(100);
  });
});

describe('party name matching', () => {
  it('drops company-form words before comparing', () => {
    expect(significantTokens('SUNRISE MULTISPECIALITY PVT LTD')).toEqual(['SUNRISE', 'MULTISPECIALITY']);
  });

  it('keeps something to match on when a name is all stopwords', () => {
    expect(significantTokens('THE CO').length).toBeGreaterThan(0);
  });

  it('scores an exact token above a prefix above a substring', () => {
    const exact = scoreParty('GODAVARI NURSING HOME', ['GODAVARI']);
    const prefix = scoreParty('GODAVARI NURSING HOME', ['GODAV']);
    const none = scoreParty('GODAVARI NURSING HOME', ['ZZZZ']);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(none);
    expect(none).toBe(0);
  });

  it('does not let a long name win just by having more words', () => {
    const short = scoreParty('KIMS', ['KIMS']);
    const long = scoreParty('KIMS MANAVATA CENTRAL DRUG STORE', ['KIMS']);
    expect(short).toBeGreaterThan(long);
  });

  it('finds a party from a partial, messy mention', () => {
    expect(findParty('how much does kims owe', PARTIES).party.party_id).toBe('2');
    expect(findParty('sunrise multispeciality balance', PARTIES).party.party_id).toBe('3');
    expect(findParty('godavari nursing', PARTIES).party.party_id).toBe('5');
  });

  it('refuses to guess when nothing is close enough', () => {
    expect(findParty('some party that does not exist', PARTIES)).toBeNull();
    expect(findParty('', PARTIES)).toBeNull();
  });

  it('offers alternatives rather than picking blindly between close calls', () => {
    const hit = findParty('medical stores', PARTIES);
    if (hit) expect(Array.isArray(hit.alternatives)).toBe(true);
  });
});

describe('intent routing', () => {
  const cases = [
    ['What is the overall position?', 'summary'],
    ['total outstanding', 'summary'],
    ['Top 10 by outstanding', 'top_parties'],
    ['parties above 5 lakh', 'above_amount'],
    ['parties with a bill older than 90 days', 'older_than'],
    ['show the ageing breakdown', 'ageing_breakdown'],
    ['who should I call today', 'who_to_call'],
    ['who broke a promise', 'broken_promises'],
    ['which follow ups were missed', 'missed_followups'],
    ['who is blocked by a claim', 'claim_blocked'],
    ['who is in credit', 'credit_balance_parties'],
    ['which accounts are too small to chase', 'small_accounts'],
    ['which parties cannot I judge', 'needs_credit_term'],
    ['what changed since the last import', 'what_changed'],
    ['how many parties are there', 'party_count'],
    ['help', 'help'],
  ];

  for (const [question, expected] of cases) {
    it(`"${question}" -> ${expected}`, () => {
      expect(matchIntent(question, PARTIES).intent).toBe(expected);
    });
  }

  it('routes a named party to the party lookup', () => {
    const m = matchIntent('how much does kims owe', PARTIES);
    expect(m.intent).toBe('party_lookup');
    expect(m.params.partyId).toBe('2');
  });

  it('lets a whole-book question beat an accidental name match', () => {
    expect(matchIntent('what is the total outstanding across all parties', PARTIES).intent).toBe('summary');
  });

  it('carries the parsed parameters through', () => {
    expect(matchIntent('top 5 parties', PARTIES).params.limit).toBe(5);
    expect(matchIntent('parties above 50 lakh', PARTIES).params.amount).toBe(5000000);
    expect(matchIntent('bills older than 6 months', PARTIES).params.days).toBe(180);
  });

  it('routes the ways a call list actually gets asked for', () => {
    for (const q of [
      "give me today's call on priority",
      'who has payment pending',
      'todays call list',
      'who should I call today',
      'show me the defaulters',
    ]) {
      expect(matchIntent(q, PARTIES).intent, q).toBe('who_to_call');
    }
  });

  it('separates a history question from a balance question', () => {
    const balance = matchIntent('how much does kims owe', PARTIES);
    const history = matchIntent('what is the payment history of kims', PARTIES);
    expect(balance.intent).toBe('party_lookup');
    expect(history.intent).toBe('party_history');
    expect(history.params.partyId).toBe('2');
  });

  it('reads the window out of a history question', () => {
    expect(matchIntent('how has kims paid over the last 1 month', PARTIES).params.days).toBe(30);
    expect(matchIntent('kims track record over 6 months', PARTIES).params.days).toBe(180);
    // No window given falls back to a quarter.
    expect(matchIntent('what is the history of kims', PARTIES).params.days).toBe(90);
  });

  it('routes a broken promise question however it is phrased', () => {
    for (const q of ['who broke a promise', 'who did not keep their promise', 'broken promises']) {
      expect(matchIntent(q, PARTIES).intent, q).toBe('broken_promises');
    }
  });

  it('says a question is unmatched rather than guessing', () => {
    // Guessing an intent produces a confident answer to a question nobody
    // asked, which is worse than admitting the miss.
    const m = matchIntent('what is the weather in nashik tomorrow', PARTIES);
    expect(m.intent).toBe('unmatched');
    expect(m.params.question).toContain('weather');
  });

  it('treats an empty question as a request for help', () => {
    expect(matchIntent('', PARTIES).intent).toBe('help');
    expect(matchIntent('   ', PARTIES).intent).toBe('help');
  });

  it('is deterministic — the same question always routes the same way', () => {
    const a = matchIntent('who should I call today', PARTIES);
    const b = matchIntent('who should I call today', PARTIES);
    expect(a).toEqual(b);
  });

  /*
   * The client says "difference" for a part payment that was never settled
   * against a bill. These are the words they used in the meeting, spelling
   * and all, so these are the words that have to route.
   */
  describe('the difference / unapplied-receipt question', () => {
    const asked = [
      'which parties have a difference to settle',
      'show me the differnce wali parties',
      'who has a diffrence',
      'which payments are not settled',
      'show unallocated payments',
      'who paid but it is not adjusted',
      'parties with part payment pending',
      'what is on account',
      'which parties do I need to allocate',
    ];
    for (const q of asked) {
      it(`routes "${q}"`, () => {
        expect(matchIntent(q, PARTIES).intent).toBe('unapplied_receipts');
      });
    }

    it('does not swallow the credit-balance question, which means something else', () => {
      // A credit balance is a party who is ahead overall. An unapplied
      // receipt is money nobody has pointed at an invoice. Confusing the two
      // would have somebody ringing a party who owes nothing.
      expect(matchIntent('who is in credit', PARTIES).intent).toBe('credit_balance_parties');
      expect(matchIntent('which parties have a negative balance', PARTIES).intent)
        .toBe('credit_balance_parties');
    });
  });
});
