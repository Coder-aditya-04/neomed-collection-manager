import { formatInr, formatPct } from '../lib/format.js';

/*
 * Seven segments: money not yet due, then six bands of days PAST THE DUE
 * DATE. The client asked for 0-30 through 180+, and all six of those are
 * overdue bands — money that has not fallen due yet still has to go
 * somewhere, so it keeps the first segment.
 *
 * The ramp runs teal -> yellow -> orange -> red -> dark red. Two reds at the
 * end rather than one, because 180+ and 120-180 are different conversations
 * and a single red collapses them.
 */
export const BUCKET_COLORS = [
  'var(--color-age-0)',
  'var(--color-age-1)',
  'var(--color-age-2)',
  'var(--color-age-3)',
  'var(--color-age-4)',
  'var(--color-age-5)',
  'var(--color-age-6)',
];
export const BUCKET_LABELS = [
  'Not yet due', '0–30 over', '30–60 over', '60–90 over',
  '90–120 over', '120–180 over', '180+ over',
];
export const BUCKET_SHORT = ['In terms', '0–30', '30–60', '60–90', '90–120', '120–180', '180+'];

/*
 * A number, or zero — never NaN.
 *
 * Number(undefined) is NaN, and NaN poisons every sum it touches: one
 * missing column turned the dashboard's total into NaN, `NaN > 0` came back
 * false, and the page announced that not one party had a credit term while a
 * hundred of them plainly did. A column can be missing for an ordinary
 * reason — the database is a migration behind the deployed code — and the
 * screen should degrade, not lie.
 */
export function amount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The seven buckets off any row that carries them, in display order. */
export function bucketsFromRow(row) {
  return [
    amount(row?.within_terms), amount(row?.over_1_30), amount(row?.over_31_60),
    amount(row?.over_61_90), amount(row?.over_91_120), amount(row?.over_121_180),
    amount(row?.over_180),
  ];
}

/** The seven buckets off a v_party_ageing row, or null when unjudgeable. */
export function bucketsOf(row) {
  if (!row || row.needs_credit_term) return null;
  return [
    amount(row.within_terms),
    amount(row.over_1_30),
    amount(row.over_31_60),
    amount(row.over_61_90),
    amount(row.over_91_120),
    amount(row.over_121_180),
    amount(row.over_180),
  ];
}

/**
 * The ageing strip.
 *
 * A party with no approved term gets a hatched placeholder, never four
 * coloured segments. Drawing buckets there would present bill age as
 * lateness, which is the one thing this product promises not to do.
 */
export default function AgeingStrip({ buckets, height = 8, width, title }) {
  if (!buckets) {
    return (
      <div
        title={title ?? 'No credit term set — this money cannot be aged against a due date'}
        style={{
          height,
          width: width ?? '100%',
          background:
            'repeating-linear-gradient(45deg, #D9E0E6 0 3px, transparent 3px 6px)',
          border: '1px solid #C4D0D9',
          borderRadius: 1.5,
        }}
      />
    );
  }

  const total = buckets.reduce((a, b) => a + Math.abs(b), 0);
  if (total <= 0) {
    return <div style={{ height, width: width ?? '100%', background: '#EFF2F5', borderRadius: 1.5 }} />;
  }

  return (
    <div className="flex gap-[2px]" style={{ height, width: width ?? '100%' }}>
      {buckets.map((v, i) => {
        const share = Math.abs(v) / total;
        if (share <= 0) return null;
        return (
          <div
            key={i}
            title={`${BUCKET_LABELS[i]} — ${formatInr(v)} · ${formatPct(Math.abs(v), total)}`}
            style={{
              flexGrow: Math.max(share * 100, 0.6),
              flexBasis: 0,
              background: BUCKET_COLORS[i],
              borderRadius: 1.5,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.3)',
            }}
          />
        );
      })}
    </div>
  );
}

/** The dashboard's large strip, with figures underneath each segment. */
export function AgeingStripLarge({ buckets, bills }) {
  const total = (buckets ?? []).reduce((a, b) => a + Math.abs(b), 0);
  return (
    <div>
      <div className="flex h-[34px] gap-[3px]">
        {(buckets ?? []).map((v, i) => (
          <div
            key={i}
            className="relative min-w-[3px] border border-[rgba(15,31,46,.16)] bg-surface/50 p-[2px] shadow-[inset_0_1px_2px_rgba(15,31,46,.08)]"
            style={{ flexGrow: Math.max((Math.abs(v) / (total || 1)) * 100, 0.6), flexBasis: 0 }}
          >
            <div
              className="h-full rounded-[2px] shadow-[inset_0_1px_0_rgba(255,255,255,.38),inset_0_-2px_3px_rgba(15,31,46,.18)]"
              style={{ background: BUCKET_COLORS[i] }}
            />
          </div>
        ))}
      </div>
      <div className="mt-[7px] flex gap-[3px]">
        {(buckets ?? []).map((v, i) => (
          <div key={i} style={{ flexGrow: Math.max((Math.abs(v) / (total || 1)) * 100, 0.6), flexBasis: 0, minWidth: 0 }}>
            <div className="truncate text-[10px] uppercase tracking-[0.07em] text-mute">{BUCKET_LABELS[i]}</div>
            <div className="tnum mt-px text-[13.5px] font-medium">{formatInr(v)}</div>
            <div className="tnum truncate text-[10px] text-faint">
              {formatPct(Math.abs(v), total)}
              {bills ? ` · ${bills[i]}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The three credit-term states, rendered the same way everywhere (rule 2). */
export function TermBadge({ row }) {
  const base =
    'inline-block font-mono text-[9.5px] font-medium uppercase tracking-[0.04em] px-[7px] py-[2px] whitespace-nowrap rounded-[2px]';

  /*
   * Some rows carry the term, some only carry whether it was assumed — the
   * priority list is the latter. Without this the badge fell through to the
   * approved branch and printed "TERM NOT SET · APPROVED", which is two
   * contradictory claims in one label and told the reader nothing true.
   */
  if (row && row.credit_source === undefined) {
    return row.term_is_assumed ? (
      <span className={`${base} border border-dashed border-[#C9A93E] bg-surface text-[#7A6410]`}
            title="A category default, not an approved term">
        Assumed term
      </span>
    ) : (
      <span className={`${base} border border-[rgba(0,133,122,.30)] bg-[rgba(0,133,122,.10)] text-teal-deep`}>
        Approved term
      </span>
    );
  }

  if (!row || row.credit_source === 'not_set') {
    return (
      <span className={`${base} border border-hair border-l-[3px] border-l-[#8A98A4] bg-[#F0F3F6] text-[#4A5A68]`}>
        Term not set
      </span>
    );
  }
  const text = termText(row);
  if (row.credit_source === 'category_default') {
    return (
      <span className={`${base} border border-dashed border-[#C9A93E] bg-surface text-[#7A6410]`} title="A category default, not an approved term">
        {text} · assumed
      </span>
    );
  }
  return (
    <span className={`${base} border border-[rgba(0,133,122,.30)] bg-[rgba(0,133,122,.10)] text-teal-deep`}>
      {text} · approved
    </span>
  );
}

function termText(row) {
  if (row.credit_type === 'days') return `${row.credit_days}d`;
  if (row.credit_type === 'cycle') {
    const lag = row.cycle_lag_months === 0 ? 'same' : row.cycle_lag_months === 1 ? 'next' : `+${row.cycle_lag_months}m`;
    return `by ${row.cycle_submit_day} · pay ${row.cycle_pay_day} ${lag}`;
  }
  return 'term not set';
}
