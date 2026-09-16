/**
 * Builds a synthetic Marg outstanding export with the same shape, quirks and
 * aggregate figures as the reference file (outstanding__9_SEP_26.xls).
 *
 * The point is the trap in spec PART 1: bill balances deliberately overshoot
 * the party header balances by ~Rs 1 crore, exactly as they do in the real
 * export. A parser that sums bill rows lands near 8.93 Cr; one that reads
 * header rows lands on 7.93 Cr. The fixture makes that difference assertable
 * without needing the client's actual file.
 */

export const REPORT_DATE = '2026-09-09';

export const TARGETS = {
  partyCount: 819,
  billCount: 8197,
  owingCount: 709,
  creditCount: 97,
  zeroCount: 13,
  totalOwed: 80600000,      // Rs 8.06 Cr
  totalCredit: -1261000,    // -Rs 12.61 L
  netTotal: 79339000,       // Rs 7.93 Cr — the figure Marg shows the owner
  mismatchCount: 15,
};

/** The four disagreements named in the spec, in rupees. */
export const NAMED_MISMATCHES = [
  { name: 'PARTY A (LARGE HOSPITAL)',         header: 3123000, billSum: 5286000 },
  { name: 'PARTY B (ONCOLOGY CENTRE)',       header: 2944000, billSum: 4334000 },
  { name: 'PARTY C (LARGEST EXPOSURE)',  header: 8972000, billSum: 9952000 },
  { name: 'PARTY D (NURSING HOME)',    header:  677000, billSum: 1604000 },
];

/* Deterministic PRNG so every run produces byte-identical fixtures. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Split `total` into `parts` integers that sum to exactly `total`. */
function split(total, parts, rand) {
  if (parts <= 1) return [total];
  const weights = Array.from({ length: parts }, () => 0.25 + rand());
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.round((w / sum) * total));
  const drift = total - out.reduce((a, b) => a + b, 0);
  out[0] += drift;
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Render an ISO date as Marg's DD-MMM-YY text, e.g. "02-Sep-26". */
function margDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${MONTH_NAMES[m - 1]}-${String(y % 100).padStart(2, '0')}`;
}

/** ISO date `age` days before the report date. */
function isoDaysBefore(age) {
  const base = Date.parse(`${REPORT_DATE}T00:00:00Z`);
  const d = new Date(base - age * 86400000);
  return d.toISOString().slice(0, 10);
}

const NAME_A = ['SHREE', 'NEW', 'JAI', 'SAI', 'OM', 'MAHALAXMI', 'BALAJI', 'GODAVARI',
  'PANCHVATI', 'SATPUR', 'NASHIK', 'DEOLALI', 'GANGAPUR', 'CIDCO', 'TRIMBAK', 'ANAND',
  'SANJIVANI', 'AROGYA', 'JEEVAN', 'SUYASH', 'PRAGATI', 'SAMARTH', 'VISHWA', 'KRISHNA'];
const NAME_B = ['MEDICAL', 'PHARMA', 'CHEMIST', 'DRUG HOUSE', 'HOSPITAL', 'NURSING HOME',
  'CLINIC', 'AGENCIES', 'MEDICOS', 'HEALTHCARE', 'DISTRIBUTORS', 'SURGICALS'];

/** Messy names, the way Marg really holds them. */
function makeName(i, rand) {
  let n = `${NAME_A[Math.floor(rand() * NAME_A.length)]} ${NAME_B[Math.floor(rand() * NAME_B.length)]} ${i}`;
  const r = rand();
  if (r < 0.10) n += ' PVT LTD';
  else if (r < 0.16) n += ' ,';
  else if (r < 0.22) n = n.replace(' ', '  ');
  else if (r < 0.28) n = n.toLowerCase();
  return n;
}

function billNoFor(i, k, rand) {
  const r = rand();
  if (r < 0.77) return `CRE${10000 + i * 7 + k}`;
  if (r < 0.87) return `CN${2000 + i + k}`;
  if (r < 0.95) return `CSHE${500 + i + k}`;
  return `PDSN${100 + i + k}`;
}

/**
 * @returns {{rows: Array<Array<any>>, meta: object}} sheet as array-of-arrays
 */
export function makeMargRows() {
  const rand = prng(20260909);
  const rows = [];

  // Rows 0-3: company header. Skipped by the parser.
  rows.push(['NEOMED PHARMA AGENCIES', null, null, null, null, null, null, null, null, null, null]);
  rows.push(['NASHIK, MAHARASHTRA', null, null, null, null, null, null, null, null, null, null]);
  rows.push(['Outstanding Bill Wise', null, null, null, null, null, null, null, null, null, null]);
  rows.push([`As on ${margDate(REPORT_DATE)}`, null, null, null, null, null, null, null, null, null, null]);

  // Row 4: column headers.
  rows.push(['Party Name', 'Bill No.', 'Bill Date', 'Bill Amt.', 'Received',
    'Balance', 'Cumulative Total', 'Due Date', 'Days', 'P.D.C.', 'Remark']);

  /* ---- decide every party's header balance and bill-balance sum ---- */

  const parties = [];

  // 15 reconciliation mismatches: the 4 named, plus 11 more to reach the count.
  const extraMismatchGap = 4540000;
  const extraGaps = split(extraMismatchGap, 11, rand);
  const mismatches = [
    ...NAMED_MISMATCHES,
    ...extraGaps.map((gap, i) => {
      const header = 150000 + Math.round(rand() * 400000);
      return { name: makeName(900 + i, rand), header, billSum: header + gap };
    }),
  ];
  for (const m of mismatches) {
    parties.push({ name: m.name, header: m.header, billSum: m.billSum, kind: 'owing' });
  }

  // Remaining owing parties, summing to the exact owed target.
  const mismatchHeaderTotal = mismatches.reduce((a, m) => a + m.header, 0);
  const remainingOwing = TARGETS.owingCount - mismatches.length;
  const remainingOwed = TARGETS.totalOwed - mismatchHeaderTotal;
  const owedParts = split(remainingOwed, remainingOwing, rand);
  owedParts.forEach((v, i) => {
    // Header and bills agree for these — the ordinary case.
    parties.push({ name: makeName(i, rand), header: v, billSum: v, kind: 'owing' });
  });

  // 97 credit balances (advances, unadjusted credit notes) — not debt.
  const creditParts = split(TARGETS.totalCredit, TARGETS.creditCount, rand);
  creditParts.forEach((v, i) => {
    parties.push({ name: makeName(2000 + i, rand), header: v, billSum: v, kind: 'credit' });
  });

  // 13 parties sitting at exactly zero.
  for (let i = 0; i < TARGETS.zeroCount; i++) {
    parties.push({ name: makeName(3000 + i, rand), header: 0, billSum: 0, kind: 'zero' });
  }

  /* ---- hand out bill rows so the total lands on 8,197 ---- */

  const n = parties.length;
  const base = Math.floor(TARGETS.billCount / n);
  const counts = new Array(n).fill(base);
  let leftover = TARGETS.billCount - base * n;
  // Give the spare rows to the biggest books, as a real ledger would.
  const order = parties
    .map((p, i) => [i, Math.abs(p.header)])
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);
  for (let k = 0; leftover > 0; k++, leftover--) counts[order[k % n]]++;
  // Zero-balance parties need an even count: offsetting pairs that net to nil.
  parties.forEach((p, i) => {
    if (p.kind === 'zero' && counts[i] % 2 === 1) {
      counts[i]++;
      const donor = order.find((j) => parties[j].kind !== 'zero' && counts[j] > 1);
      counts[donor]--;
    }
  });

  /* ---- emit the interleaved rows ---- */

  let onAccountEmitted = 0;
  let oldestEmitted = 0;

  parties.forEach((p, i) => {
    // PARTY HEADER ROW: column 0 = name, column 5 = total, rest empty.
    rows.push([p.name, null, null, null, null, p.header, null, null, null, null, null]);

    const k = counts[i];
    let balances;
    if (p.kind === 'zero') {
      // Offsetting pairs: +x, -x.
      balances = [];
      for (let j = 0; j < k / 2; j++) {
        const v = 1000 + Math.round(rand() * 40000);
        balances.push(v, -v);
      }
    } else {
      balances = split(p.billSum, k, rand);
    }

    let cumulative = 0;
    balances.forEach((balance, j) => {
      // The reference file's oldest bill is 2,370 days old (back to Dec 2023).
      let age;
      if (i === 2 && j === 0 && oldestEmitted === 0) {
        age = 2370;
        oldestEmitted = 1;
      } else {
        age = Math.round(12 + Math.pow(rand(), 0.55) * 900);
      }
      const billDate = isoDaysBefore(age);

      // A handful of on-account entries carry "*" instead of a bill number,
      // and the same party can carry several of them.
      const onAccount = rand() < 0.004 && p.kind === 'owing';
      const billNo = onAccount ? '*' : billNoFor(i, j, rand);
      if (onAccount) onAccountEmitted++;

      const received = Math.max(0, Math.round(rand() * 8000));
      const billAmount = balance + received;
      cumulative += balance;

      rows.push([
        null,                    // 0  party name — empty on bill rows
        billNo,                  // 1
        margDate(billDate),      // 2  DD-MMM-YY text
        billAmount,              // 3
        received,                // 4
        balance,                 // 5
        cumulative,              // 6  cumulative total
        margDate(billDate),      // 7  Due Date == Bill Date, always
        age,                     // 8  "Days" is bill AGE, not days overdue
        0,                       // 9  P.D.C. — 0 on every row
        null,                    // 10 Remark — empty on every row
      ]);
    });
  });

  return {
    rows,
    meta: {
      reportDate: REPORT_DATE,
      partyCount: parties.length,
      billCount: counts.reduce((a, b) => a + b, 0),
      onAccountEmitted,
      mismatchNames: mismatches.map((m) => m.name),
      billSumTotal: parties.reduce((a, p) => a + p.billSum, 0),
      headerTotal: parties.reduce((a, p) => a + p.header, 0),
    },
  };
}
