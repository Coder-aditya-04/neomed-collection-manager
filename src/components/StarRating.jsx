/*
 * The star rating, in the client's own words.
 *
 * This is a JUDGEMENT a person enters, and it is kept separate from
 * party_profiles.reliability, which is COMPUTED from bills that have actually
 * settled. The two will sometimes disagree — a party can pay every invoice on
 * time and still be one the owner does not trust — and when they disagree that
 * is worth seeing, not resolving. So they are never merged into one number and
 * never shown as if they were the same thing.
 */

export const STAR_MEANINGS = [
  null,
  { label: 'Fraud / defaulter', color: 'var(--color-age-6)', short: 'Fraud' },
  { label: 'Bad for payment', color: 'var(--color-age-4)', short: 'Bad payer' },
  { label: 'Credit oriented', color: 'var(--color-age-2)', short: 'Credit oriented' },
  { label: 'Genuine, needs follow-up', color: 'var(--color-age-1)', short: 'Genuine' },
  { label: 'Prompt payment', color: 'var(--color-age-0)', short: 'Prompt' },
];

function Star({ filled, color, size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden
         fill={filled ? color : 'none'} stroke={filled ? color : 'var(--color-hair)'} strokeWidth="1.6">
      <path d="M12 3.5l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8z"
            strokeLinejoin="round" />
    </svg>
  );
}

/** Read-only, for lists. Nothing at all when the party has not been rated. */
export function Stars({ value, size = 11, showLabel = false }) {
  const n = Number(value);
  if (!n || n < 1 || n > 5) return null;
  const meaning = STAR_MEANINGS[n];

  return (
    <span className="inline-flex items-center gap-[3px]" title={`${n} star — ${meaning.label}`}>
      <span className="inline-flex gap-[1px]">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} filled={i <= n} color={meaning.color} size={size} />
        ))}
      </span>
      {showLabel ? (
        <span className="text-[11px]" style={{ color: meaning.color }}>{meaning.short}</span>
      ) : null}
    </span>
  );
}

/**
 * The editor. Every level is named, because "3 stars" means nothing on its own
 * and two people would rate the same party differently without the words.
 */
export function StarPicker({ value, onChange, disabled }) {
  const n = Number(value) || 0;

  return (
    <div className="grid gap-[3px]">
      {[5, 4, 3, 2, 1].map((i) => {
        const m = STAR_MEANINGS[i];
        const on = n === i;
        return (
          <button
            key={i}
            type="button"
            disabled={disabled}
            onClick={() => onChange(on ? null : i)}
            className={[
              'flex items-center gap-[8px] rounded-[3px] border px-[8px] py-[4px] text-left text-[12px] transition-colors',
              on ? 'border-teal bg-teal/[0.09]' : 'border-hair bg-surface hover:border-teal/50',
            ].join(' ')}
          >
            <span className="inline-flex gap-[1px]">
              {[1, 2, 3, 4, 5].map((j) => (
                <Star key={j} filled={j <= i} color={m.color} size={12} />
              ))}
            </span>
            <span className={on ? 'font-medium' : ''}>{m.label}</span>
          </button>
        );
      })}
      {n ? (
        <button type="button" disabled={disabled} onClick={() => onChange(null)}
                className="mt-[2px] text-left text-[11px] text-faint hover:text-mute hover:underline">
          Clear the rating
        </button>
      ) : null}
    </div>
  );
}
