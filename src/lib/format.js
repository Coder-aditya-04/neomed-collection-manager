/**
 * Money and figures, rendered the one way the product allows (rule 7).
 *
 * This is the JavaScript twin of fn_fmt_inr in 0004_priority.sql. The two
 * must agree character for character: reason strings arrive pre-formatted
 * from Postgres and sit beside figures formatted here, and a reader must not
 * be able to tell which came from where. test/format.test.js pins the pairs
 * that were verified against the database.
 */

const CRORE = 10000000;
const LAKH = 100000;
const MINUS = '−'; // true minus, not a hyphen — matches the SQL side
const EM_DASH = '—';

/** Two decimals, trailing zeros kept: 7.93, 89.72, 1.00. */
function fixed2(n) {
  return n.toFixed(2);
}

/** Indian digit grouping: 1,23,456 — last three, then pairs. */
export function groupIndian(n) {
  const s = String(Math.round(Math.abs(n)));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * ₹7.93 Cr · ₹89.72 L · ₹99,999 · −₹12.61 L · —
 *
 * The sign sits outside the rupee symbol, which is how credit balances are
 * written throughout the spec.
 */
export function formatInr(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return EM_DASH;
  const n = Number(value);
  const sign = n < 0 ? MINUS : '';
  const abs = Math.abs(n);

  if (abs >= CRORE) return `${sign}₹${fixed2(abs / CRORE)} Cr`;
  if (abs >= LAKH) return `${sign}₹${fixed2(abs / LAKH)} L`;
  return `${sign}₹${groupIndian(abs)}`;
}

/** A signed delta, for "what changed" figures: +₹11.4 L, −₹3.42 L. */
export function formatInrDelta(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return EM_DASH;
  const n = Number(value);
  if (n === 0) return formatInr(0);
  return n > 0 ? `+${formatInr(n)}` : formatInr(n);
}

/** Plain counts, grouped the Indian way: 8,197 · 819. */
export function formatCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return EM_DASH;
  return groupIndian(Number(value));
}

/**
 * Bill age. Never the word "overdue" — Marg holds no credit terms, so an age
 * is all this figure can honestly claim to be (spec PART 1).
 */
export function formatAge(days) {
  if (days === null || days === undefined) return EM_DASH;
  return `${groupIndian(days)}d`;
}

/**
 * Days past an expected due date. Only ever called with a figure derived from
 * a recorded credit term; a party without one has no overdue days at all and
 * must render as "cannot say", not as zero.
 */
export function formatOverdue(days) {
  if (days === null || days === undefined) return 'no term set';
  if (days <= 0) return 'within terms';
  return `${groupIndian(days)}d over`;
}

/** 43% — whole numbers; a decimal here implies a precision we do not have. */
export function formatPct(part, whole) {
  if (!whole) return EM_DASH;
  return `${Math.round((Number(part) / Number(whole)) * 100)}%`;
}

/** "12 Sep 2026", for dates shown beside figures. */
export function formatDate(iso) {
  if (!iso) return EM_DASH;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return EM_DASH;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

/**
 * How a credit term reads on screen. An unset term says so in words — it is
 * never blank, and never a zero that could be mistaken for "due immediately".
 */
export function formatCreditTerm(party) {
  if (!party || party.credit_type === 'none' || party.credit_source === 'not_set') {
    return 'Term not set';
  }
  if (party.credit_type === 'days') {
    return `${party.credit_days} days`;
  }
  if (party.credit_type === 'cycle') {
    const lag = party.cycle_lag_months === 0
      ? 'same month'
      : party.cycle_lag_months === 1
        ? 'next month'
        : `+${party.cycle_lag_months} months`;
    return `by ${ordinal(party.cycle_submit_day)}, paid ${ordinal(party.cycle_pay_day)} ${lag}`;
  }
  return 'Term not set';
}

/** Rule 2: an assumed term must never be shown as though it were approved. */
export function creditTermBadge(party) {
  if (!party || party.credit_source === 'not_set') {
    return { label: 'TERM NOT SET', tone: 'unset' };
  }
  if (party.credit_source === 'category_default') {
    return { label: `${formatCreditTerm(party).toUpperCase()} · ASSUMED`, tone: 'assumed' };
  }
  return { label: `${formatCreditTerm(party).toUpperCase()} · APPROVED`, tone: 'approved' };
}

function ordinal(n) {
  const v = Number(n);
  if (!v) return String(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const k = v % 100;
  return v + (s[(k - 20) % 10] || s[k] || s[0]);
}
