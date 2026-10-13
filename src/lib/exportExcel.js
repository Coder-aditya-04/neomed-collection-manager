import { formatCreditTerm } from './format.js';

/*
 * Excel export.
 *
 * SheetJS is already a dependency for reading Marg's .xls, and it is loaded
 * lazily here for the same reason it is lazy on the import screen: it is the
 * largest thing in the bundle and most sessions never export anything.
 *
 * Figures are written as NUMBERS, never as "₹52.03 L" strings. The whole point
 * of handing somebody a spreadsheet is that they can sum, sort and pivot it,
 * and a formatted string is a picture of a number. Display formatting is left
 * to Excel's own cell format.
 */

function termLabel(p) {
  if (p.credit_type === 'days') return Number(p.credit_days) === 0 ? 'Cash' : `${p.credit_days} days`;
  if (p.credit_type === 'cycle') {
    const lag = p.cycle_lag_months === 0 ? 'same month'
      : p.cycle_lag_months === 1 ? 'next month' : `+${p.cycle_lag_months} months`;
    return `Cycle — by ${p.cycle_submit_day}, paid ${p.cycle_pay_day} ${lag}`;
  }
  return 'Not set';
}

const SOURCE_LABEL = {
  approved: 'Approved',
  category_default: 'Assumed (category default)',
  not_set: 'Not set',
};

const STAR_LABEL = {
  1: '1 — Fraud / defaulter',
  2: '2 — Bad for payment',
  3: '3 — Credit oriented',
  4: '4 — Genuine, needs follow-up',
  5: '5 — Prompt payment',
};

/**
 * The credit master as a workbook.
 *
 * Two sheets, because the client asked two different questions: "give me the
 * credit master" and "how many parties are on each credit cycle". The summary
 * sheet answers the second directly rather than leaving them to pivot 900 rows
 * to find out.
 */
export async function exportCreditMaster(parties, { reportDate } = {}) {
  const XLSX = await import('xlsx');

  const rows = parties.map((p) => ({
    'Party': p.display_name,
    'Category': p.category ?? '',
    'Credit term': termLabel(p),
    'Term type': p.credit_type ?? 'none',
    'Credit days': p.credit_type === 'days' ? Number(p.credit_days) : null,
    'Submit by': p.credit_type === 'cycle' ? Number(p.cycle_submit_day) : null,
    'Paid on': p.credit_type === 'cycle' ? Number(p.cycle_pay_day) : null,
    'Months later': p.credit_type === 'cycle' ? Number(p.cycle_lag_months) : null,
    'Term status': SOURCE_LABEL[p.credit_source] ?? p.credit_source,
    'Rating': p.star_rating ? STAR_LABEL[p.star_rating] : '',
    'Collection status': p.status ?? '',
    'Outstanding': Number(p.current_outstanding),
    'Open bills': Number(p.bill_count ?? 0),
    'Oldest bill (days)': p.oldest_bill_age_days == null ? null : Number(p.oldest_bill_age_days),
    'Days past term': p.needs_credit_term || p.max_overdue_days == null ? null : Number(p.max_overdue_days),
    'Not yet due': p.needs_credit_term ? null : Number(p.within_terms ?? 0),
    '0-30 over': p.needs_credit_term ? null : Number(p.over_1_30 ?? 0),
    '30-60 over': p.needs_credit_term ? null : Number(p.over_31_60 ?? 0),
    '60-90 over': p.needs_credit_term ? null : Number(p.over_61_90 ?? 0),
    '90-120 over': p.needs_credit_term ? null : Number(p.over_91_120 ?? 0),
    '120-180 over': p.needs_credit_term ? null : Number(p.over_121_180 ?? 0),
    '180+ over': p.needs_credit_term ? null : Number(p.over_180 ?? 0),
    'Phone': p.phone ?? '',
    'Contact person': p.contact_person ?? '',
    'Owner': p.responsible_name ?? '',
  }));

  /*
   * The summary the client asked for: how many parties sit on each term.
   * Keyed on the term as written, so "30 days" and "60 days" are separate
   * lines and a monthly cycle is its own line rather than being averaged
   * into a day count it does not have.
   */
  const groups = new Map();
  for (const p of parties) {
    const key = termLabel(p);
    if (!groups.has(key)) {
      groups.set(key, { key, parties: 0, outstanding: 0, bills: 0, approved: 0, assumed: 0, notSet: 0 });
    }
    const g = groups.get(key);
    g.parties += 1;
    g.outstanding += Number(p.current_outstanding ?? 0);
    g.bills += Number(p.bill_count ?? 0);
    if (p.credit_source === 'approved') g.approved += 1;
    else if (p.credit_source === 'category_default') g.assumed += 1;
    else g.notSet += 1;
  }

  const summary = [...groups.values()]
    .sort((a, b) => b.outstanding - a.outstanding)
    .map((g) => ({
      'Credit term': g.key,
      'Parties': g.parties,
      'Outstanding': Math.round(g.outstanding * 100) / 100,
      'Open bills': g.bills,
      'Approved': g.approved,
      'Assumed': g.assumed,
      'Not set': g.notSet,
    }));

  summary.push({
    'Credit term': 'TOTAL',
    'Parties': parties.length,
    'Outstanding': Math.round(parties.reduce((a, p) => a + Number(p.current_outstanding ?? 0), 0) * 100) / 100,
    'Open bills': parties.reduce((a, p) => a + Number(p.bill_count ?? 0), 0),
    'Approved': summary.reduce((a, r) => a + r.Approved, 0),
    'Assumed': summary.reduce((a, r) => a + r.Assumed, 0),
    'Not set': summary.reduce((a, r) => a + r['Not set'], 0),
  });

  const wb = XLSX.utils.book_new();

  const wsSummary = XLSX.utils.json_to_sheet(summary);
  wsSummary['!cols'] = [{ wch: 34 }, { wch: 9 }, { wch: 15 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'By credit term');

  const wsAll = XLSX.utils.json_to_sheet(rows);
  wsAll['!cols'] = [
    { wch: 40 }, { wch: 13 }, { wch: 30 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 9 },
    { wch: 12 }, { wch: 26 }, { wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 16 },
    { wch: 14 }, ...Array(7).fill({ wch: 13 }), { wch: 14 }, { wch: 18 }, { wch: 16 },
  ];
  wsAll['!freeze'] = { xSplit: 1, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsAll, 'Credit master');

  const stamp = (reportDate ?? new Date().toISOString().slice(0, 10)).replaceAll('-', '');
  XLSX.writeFile(wb, `Neomed credit master ${stamp}.xlsx`);

  return { parties: rows.length, terms: groups.size };
}
