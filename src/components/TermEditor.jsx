/**
 * The credit-term editor, shared by the credit master and the party page.
 *
 * Two models, because retailers and hospitals are paid differently:
 *   days  — a plain number of days from the bill date
 *   cycle — submit by the Nth, paid on the Nth, same month or later
 *
 * It lived inside the credit master. The desk asked to stop filling details
 * in two places, so the party page needs the same control — and one editor
 * means one set of validation rules, not two that drift.
 */
export function TermEditor({ draft, onChange, compact }) {
  const input = `rounded-[2px] border border-hair bg-surface px-[6px] py-[3px] text-[11.5px] tnum ${compact ? '' : 'mt-1'}`;

  return (
    <div className="flex flex-wrap items-center gap-[6px]">
      <select
        value={draft.credit_type}
        onChange={(e) => onChange({ ...draft, credit_type: e.target.value })}
        className="rounded-[2px] border border-hair bg-surface px-[6px] py-[3px] text-[11.5px]"
        aria-label="Credit model"
      >
        <option value="days">Days</option>
        <option value="cycle">Monthly cycle</option>
        <option value="none">Not set</option>
      </select>

      {draft.credit_type === 'days' ? (
        <>
          <input
            type="number" min="0" max="365"
            value={draft.credit_days ?? ''}
            onChange={(e) => onChange({ ...draft, credit_days: e.target.value })}
            className={`${input} w-[64px] text-right`}
            aria-label="Days from bill date"
            placeholder="30"
          />
          <span className="text-[11px] text-faint">days</span>
        </>
      ) : null}

      {draft.credit_type === 'cycle' ? (
        <>
          <span className="text-[11px] text-faint">by</span>
          <input
            type="number" min="1" max="31"
            value={draft.cycle_submit_day ?? ''}
            onChange={(e) => onChange({ ...draft, cycle_submit_day: e.target.value })}
            className={`${input} w-[46px] text-right`}
            aria-label="Submit by day of month"
          />
          <span className="text-[11px] text-faint">pay</span>
          <input
            type="number" min="1" max="31"
            value={draft.cycle_pay_day ?? ''}
            onChange={(e) => onChange({ ...draft, cycle_pay_day: e.target.value })}
            className={`${input} w-[46px] text-right`}
            aria-label="Paid on day of month"
          />
          <select
            value={draft.cycle_lag_months ?? 0}
            onChange={(e) => onChange({ ...draft, cycle_lag_months: Number(e.target.value) })}
            className="rounded-[2px] border border-hair bg-surface px-[5px] py-[3px] text-[11.5px]"
            aria-label="Which month payment lands"
          >
            <option value={0}>same month</option>
            <option value={1}>next month</option>
            <option value={2}>+2 months</option>
          </select>
        </>
      ) : null}
    </div>
  );
}

export function draftFromParty(p) {
  return {
    credit_type: p?.credit_type ?? 'none',
    credit_days: p?.credit_days ?? '',
    cycle_submit_day: p?.cycle_submit_day ?? '',
    cycle_pay_day: p?.cycle_pay_day ?? '',
    cycle_lag_months: p?.cycle_lag_months ?? 0,
  };
}

/**
 * Builds the column set for the chosen model, and returns null when the draft
 * is incomplete — the schema rejects a half-filled term, so the Save button
 * stays disabled rather than producing a constraint error.
 */
export function termFromDraft(d) {
  if (d.credit_type === 'days') {
    const days = Number(d.credit_days);
    if (!Number.isFinite(days) || d.credit_days === '' || days < 0 || days > 365) return null;
    return { credit_type: 'days', credit_days: days, cycle_submit_day: null, cycle_pay_day: null, cycle_lag_months: 0 };
  }
  if (d.credit_type === 'cycle') {
    const submit = Number(d.cycle_submit_day);
    const pay = Number(d.cycle_pay_day);
    if (!inRange(submit) || !inRange(pay)) return null;
    return {
      credit_type: 'cycle', credit_days: null,
      cycle_submit_day: submit, cycle_pay_day: pay,
      cycle_lag_months: Number(d.cycle_lag_months) || 0,
    };
  }
  return null;
}

/** The columns that take a party back to "no term" (rule 1 honoured). */
export const CLEARED_TERM = {
  credit_type: 'none', credit_days: null, cycle_submit_day: null,
  cycle_pay_day: null, cycle_lag_months: 0, credit_source: 'not_set',
};

function inRange(n) {
  return Number.isFinite(n) && n >= 1 && n <= 31;
}
