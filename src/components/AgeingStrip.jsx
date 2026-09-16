import { formatInr, formatPct } from '../lib/format.js';

/** within terms · 1-30 over · 31-60 over · 60+ over */
export const BUCKET_COLORS = ['var(--color-age-0)', 'var(--color-age-1)', 'var(--color-age-2)', 'var(--color-age-3)'];
export const BUCKET_LABELS = ['Within terms', '1–30 over', '31–60 over', '60+ over'];
export const BUCKET_SHORT = ['In terms', '1–30', '31–60', '60+'];

/** Pull the four buckets off a v_party_ageing row, or null when unjudgeable. */
export function bucketsOf(row) {
  if (!row || row.needs_credit_term) return null;
  return [
    Number(row.within_terms ?? 0),
    Number(row.over_1_30 ?? 0),
    Number(row.over_31_60 ?? 0),
    Number(row.over_60 ?? 0),
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
            className="relative min-w-[3px] border border-[rgba(15,31,46,.16)] bg-white/50 p-[2px] shadow-[inset_0_1px_2px_rgba(15,31,46,.08)]"
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

  if (!row || row.credit_source === 'not_set') {
    return (
      <span className={`${base} border border-[#C4D0D9] border-l-[3px] border-l-[#8A98A4] bg-[#F0F3F6] text-[#4A5A68]`}>
        Term not set
      </span>
    );
  }
  const text = termText(row);
  if (row.credit_source === 'category_default') {
    return (
      <span className={`${base} border border-dashed border-[#C9A93E] bg-white text-[#7A6410]`} title="A category default, not an approved term">
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
