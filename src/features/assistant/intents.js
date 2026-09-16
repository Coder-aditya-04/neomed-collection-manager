/**
 * The assistant's intent router.
 *
 * There is no language model here. A question is matched to one of a fixed
 * set of intents, its parameters are pulled out, and Postgres does every
 * piece of arithmetic. That is not a compromise: it costs nothing to run,
 * returns the same answer twice, and cannot invent a number.
 *
 * matchIntent is pure — no network, no database — so the whole routing layer
 * is testable without a server.
 */

/* ------------------------------------------------------------------ */
/* text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Words that identify a company form rather than a company. */
const STOPWORDS = new Set([
  'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'NEW', 'THE', 'DR', 'CO',
  'CENTRE', 'CENTER', 'AND', 'OF',
]);

export function normaliseText(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenise(s) {
  return normaliseText(s).split(' ').filter(Boolean);
}

/** Tokens that actually distinguish one party from another. */
export function significantTokens(s) {
  const all = tokenise(s);
  const kept = all.filter((t) => !STOPWORDS.has(t) && t.length > 1);
  // A name made entirely of stopwords still has to match on something.
  return kept.length ? kept : all;
}

/* ------------------------------------------------------------------ */
/* amounts                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads the amounts people actually type: "5 lakh", "₹5L", "50 lakh",
 * "1 crore", "1.5cr", "10000", "10,000".
 * Returns rupees, or null when there is no amount in the text.
 */
export function parseAmount(text) {
  // Deliberately not normaliseText: that strips the decimal point, which turns
  // "1.5 cr" into "1 5 CR" and matches the 5.
  const s = String(text ?? '').toUpperCase().replace(/[,]/g, '').replace(/\s+/g, ' ').trim();

  const withUnit =
    /(\d+(?:\.\d+)?)\s*(CRORE|CRORES|CR|LAKH|LAKHS|LAC|LACS|L|THOUSAND|K)\b/.exec(s);
  if (withUnit) {
    const n = Number.parseFloat(withUnit[1]);
    const unit = withUnit[2];
    if (/^(CRORE|CRORES|CR)$/.test(unit)) return Math.round(n * 10000000);
    if (/^(LAKH|LAKHS|LAC|LACS|L)$/.test(unit)) return Math.round(n * 100000);
    return Math.round(n * 1000);
  }

  // A bare number, but only when it is not obviously a count of days.
  const bare = /(?:ABOVE|OVER|MORE THAN|GREATER THAN|ATLEAST|AT LEAST|RS|INR|₹)\s*(\d+)(?!\s*(?:DAY|MONTH|YEAR))/.exec(s);
  if (bare) return Number.parseInt(bare[1], 10);

  return null;
}

/** "older than 90 days", "90+ days", "over 6 months". */
export function parseDays(text) {
  const s = normaliseText(text);
  const months = /(\d+)\s*(MONTH|MONTHS)/.exec(s);
  if (months) return Number.parseInt(months[1], 10) * 30;
  const years = /(\d+)\s*(YEAR|YEARS)/.exec(s);
  if (years) return Number.parseInt(years[1], 10) * 365;
  const days = /(\d+)\s*(DAY|DAYS|D)\b/.exec(s);
  if (days) return Number.parseInt(days[1], 10);
  const bare = /(?:OLDER THAN|MORE THAN|BEYOND|PAST|OVER)\s+(\d+)/.exec(s);
  if (bare) return Number.parseInt(bare[1], 10);
  return null;
}

/** "top 10", "top five", "biggest 20". */
export function parseCount(text, fallback = 10) {
  const s = normaliseText(text);
  const words = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10, TWENTY: 20, FIFTY: 50 };
  const m = /\b(?:TOP|FIRST|BIGGEST|LARGEST|WORST)\s+(\d+|[A-Z]+)\b/.exec(s);
  if (!m) return fallback;
  const raw = m[1];
  if (/^\d+$/.test(raw)) return Math.min(Number.parseInt(raw, 10), 100);
  return words[raw] ?? fallback;
}

/* ------------------------------------------------------------------ */
/* fuzzy party matching                                                */
/* ------------------------------------------------------------------ */

/**
 * Scores a party name against the words in a question.
 *
 * An exact token match is worth 3, a prefix match 1.5, a substring 1. The
 * total is divided by the square root of the party's token count so that a
 * long name cannot win simply by having more words to hit.
 */
export function scoreParty(partyName, queryTokens) {
  const partyTokens = significantTokens(partyName);
  if (!partyTokens.length || !queryTokens.length) return 0;

  let score = 0;
  for (const qt of queryTokens) {
    let best = 0;
    for (const pt of partyTokens) {
      if (pt === qt) best = Math.max(best, 3);
      else if (pt.startsWith(qt) || qt.startsWith(pt)) best = Math.max(best, 1.5);
      else if (pt.includes(qt) || qt.includes(pt)) best = Math.max(best, 1);
    }
    score += best;
  }
  return score / Math.sqrt(partyTokens.length);
}

// One distinctive token against a five-word party name scores 3/sqrt(5) ≈ 1.34,
// so the bar has to sit below that or "how much does KIMS owe" matches nothing.
// Unrelated words score 0, so there is a wide gap between a hit and a miss.
export const MATCH_THRESHOLD = 1.2;

/**
 * Best party for a question, or null. Returns the runners-up too, so the
 * answer can offer alternatives rather than guessing between close calls.
 */
export function findParty(question, parties) {
  const queryTokens = significantTokens(question).filter((t) => !INTENT_WORDS.has(t));
  if (!queryTokens.length || !parties?.length) return null;

  const scored = parties
    .map((p) => ({ party: p, score: scoreParty(p.display_name, queryTokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < MATCH_THRESHOLD) return null;
  return {
    party: scored[0].party,
    score: scored[0].score,
    alternatives: scored.slice(1, 4).filter((x) => x.score >= MATCH_THRESHOLD * 0.7).map((x) => x.party),
  };
}

/** Words that belong to the question, not to a party's name. */
const INTENT_WORDS = new Set([
  'HOW', 'MUCH', 'DOES', 'DO', 'OWE', 'OWES', 'WHAT', 'WHO', 'WHICH', 'WHEN',
  'IS', 'ARE', 'THE', 'ME', 'SHOW', 'TELL', 'GIVE', 'LIST', 'FOR', 'ABOUT',
  'OVERDUE', 'OUTSTANDING', 'BALANCE', 'PARTY', 'PARTIES', 'TOTAL', 'CALL',
  'TODAY', 'PAY', 'PAID', 'PAYMENT', 'BILL', 'BILLS', 'DAYS', 'OLD', 'OLDER',
  'THAN', 'ABOVE', 'OVER', 'MORE', 'TOP', 'LAKH', 'CRORE', 'CR', 'RS', 'INR',
]);

/* ------------------------------------------------------------------ */
/* intents                                                             */
/* ------------------------------------------------------------------ */

/**
 * Ordered: the first pattern that matches wins, so the specific ones come
 * before the general ones.
 */
const INTENTS = [
  {
    intent: 'help',
    patterns: [/\bHELP\b/, /WHAT CAN YOU/, /WHAT DO YOU KNOW/, /^\s*\?\s*$/],
  },
  {
    intent: 'needs_credit_term',
    patterns: [
      /\bJUDGE\b/, /NO CREDIT TERM/, /WITHOUT (A )?TERM/,
      /TERM NOT SET/, /MISSING TERM/, /UNJUDGEABLE/, /NEED.{0,12}TERM/,
    ],
  },
  {
    intent: 'credit_balance_parties',
    patterns: [/CREDIT BALANCE/, /NEGATIVE BALANCE/, /ADVANCE/, /IN CREDIT/],
  },
  {
    intent: 'claim_blocked',
    patterns: [/CLAIM/, /BLOCKED/, /EXPIRY/, /BREAKAGE/, /SHORT SUPPLY/, /RATE DIFF/],
  },
  {
    intent: 'broken_promises',
    patterns: [/BROKE.{0,3} (A )?PROMISE/, /BROKEN PROMISE/, /PROMISE.{0,10}(BROKEN|KEPT|MISSED)/, /\bPROMISE/],
  },
  {
    intent: 'missed_followups',
    patterns: [/MISSED FOLLOW/, /FOLLOW UP/, /FOLLOWUP/, /NOT CALLED/, /OVERDUE FOLLOW/],
  },
  {
    intent: 'what_changed',
    patterns: [/WHAT CHANGED/, /SINCE (THE )?LAST/, /WHAT MOVED/, /WHO PAID/, /CHANGED SINCE/],
  },
  {
    intent: 'small_accounts',
    patterns: [
      /SMALL ACCOUNT/, /SMALL BALANCE/, /\bTOO SMALL\b/, /SMALL.{0,15}(ACCOUNT|PART|BALANCE)/,
      /BELOW .{0,20}(THRESHOLD|10)/, /WRITE OFF/, /NOT WORTH/,
    ],
  },
  {
    intent: 'who_to_call',
    patterns: [
      /WHO (SHOULD|DO) I CALL/, /WHO TO CALL/, /WORK FIRST/, /PRIORITY/, /CHASE/, /WHO FIRST/,
      /TODAY.{0,10}CALL/, /CALL.{0,10}(LIST|TODAY)/, /CALL ON PRIORITY/,
      /PAYMENT.{0,10}PENDING/, /PENDING.{0,10}PAYMENT/, /WHO.{0,15}(PENDING|NOT PAID|HASN T PAID|HAS NOT PAID)/,
      /\bDEFAULTER/, /WHO OWES/,
    ],
  },
  {
    intent: 'ageing_breakdown',
    patterns: [/AGEING/, /AGING/, /BUCKET/, /BREAKDOWN/, /HOW OLD IS THE BOOK/],
  },
  {
    intent: 'older_than',
    patterns: [/OLDER THAN/, /BILL.{0,20}OLDER/, /BEYOND \d+ DAY/, /MORE THAN \d+ DAY/],
  },
  {
    intent: 'above_amount',
    // Word boundaries matter: without them "OVERALL" contains "OVER" and every
    // summary question routes here instead.
    patterns: [/\b(ABOVE|OVER|MORE THAN|GREATER THAN|AT LEAST|ATLEAST)\b.{0,20}(LAKH|CRORE|\bCR\b|\bL\b|\d)/],
  },
  {
    intent: 'top_parties',
    patterns: [/\bTOP \d*/, /BIGGEST/, /LARGEST/, /MOST MONEY/, /WORST \d*/],
  },
  {
    intent: 'party_count',
    patterns: [/HOW MANY PARTIES/, /HOW MANY BILLS/, /\bCOUNT\b/, /HOW MANY/],
  },
  {
    intent: 'summary',
    patterns: [
      /^(SUMMARY|OVERVIEW|POSITION|STATUS)$/, /OVERALL/, /TOTAL OUTSTANDING/,
      /HOW MUCH.{0,15}(OWED|OUTSTANDING|TOTAL)/, /WHERE (DO )?WE STAND/, /THE BOOK/,
    ],
  },
];

/**
 * Route a question.
 *
 * Party lookup is tried whenever the question names a party, because
 * "how overdue is X" should reach X rather than the generic overdue intent.
 *
 * @param {string} question
 * @param {Array} parties  v_party_ageing rows, for fuzzy name matching
 */
export function matchIntent(question, parties = []) {
  const raw = String(question ?? '').trim();
  if (!raw) return { intent: 'help', params: {} };

  const s = normaliseText(raw);

  // A named party wins over a generic pattern, unless the question is clearly
  // about the whole book.
  const named = findParty(raw, parties);
  const aboutEverything = /\b(ALL|EVERY|TOTAL|BOOK|PORTFOLIO|OVERALL|SUMMARY)\b/.test(s);

  if (named && !aboutEverything) {
    // "How has X paid over the last month" is a question about behaviour, not
    // about today's balance.
    if (/\b(HISTORY|BEHAVIOU?R|PATTERN|TRACK RECORD|RECORD|TREND|HOW (HAS|HAVE|DO|DOES|DID)|OVER THE LAST|PAST \d+|LAST \d+|USUALLY|TYPICALLY|RELIABLE|PAYS)\b/.test(s)) {
      return {
        intent: 'party_history',
        params: {
          partyId: named.party.party_id,
          partyName: named.party.display_name,
          days: parseDays(raw) ?? 90,
        },
      };
    }
    return {
      intent: 'party_lookup',
      params: {
        partyId: named.party.party_id,
        partyName: named.party.display_name,
        alternatives: named.alternatives,
        score: named.score,
      },
    };
  }

  for (const { intent, patterns } of INTENTS) {
    if (patterns.some((re) => re.test(s))) {
      return { intent, params: paramsFor(intent, raw) };
    }
  }

  // An unmatched question is said to be unmatched. Guessing an intent would
  // produce a confident answer to a question nobody asked.
  return { intent: 'unmatched', params: { question: raw } };
}

function paramsFor(intent, raw) {
  switch (intent) {
    case 'top_parties':
      return { limit: parseCount(raw, 10) };
    case 'above_amount':
      return { amount: parseAmount(raw) ?? 500000 };
    case 'older_than':
      return { days: parseDays(raw) ?? 90 };
    case 'who_to_call':
      return { limit: parseCount(raw, 10) };
    case 'needs_credit_term':
      return { limit: 20 };
    default:
      return {};
  }
}

/** What the assistant will answer, for the help card and the chips. */
export const CAPABILITIES = [
  { intent: 'summary', example: 'What is the overall position?' },
  { intent: 'party_lookup', example: 'How much does Godavari owe?' },
  { intent: 'party_history', example: 'What is the payment history of Godavari?' },
  { intent: 'top_parties', example: 'Top 10 by outstanding' },
  { intent: 'above_amount', example: 'Parties above 5 lakh' },
  { intent: 'older_than', example: 'Parties with a bill older than 90 days' },
  { intent: 'ageing_breakdown', example: 'Show the ageing breakdown' },
  { intent: 'who_to_call', example: 'Give me today\'s calls on priority' },
  { intent: 'needs_credit_term', example: 'Which parties cannot I judge?' },
  { intent: 'credit_balance_parties', example: 'Who is in credit?' },
  { intent: 'claim_blocked', example: 'Who is blocked by a claim?' },
  { intent: 'small_accounts', example: 'Which accounts are too small to chase?' },
  { intent: 'what_changed', example: 'What changed since the last import?' },
  { intent: 'broken_promises', example: 'Who did not keep their promise?' },
  { intent: 'missed_followups', example: 'Which follow-ups were missed?' },
  { intent: 'party_count', example: 'How many parties are there?' },
];
