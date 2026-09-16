import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { latestSnapshotQuery, partyBillsQuery } from '../../lib/queries.js';
import { formatInr, formatCount, formatAge, formatDate, formatCreditTerm } from '../../lib/format.js';
import AgeingStrip, { bucketsOf, TermBadge, BUCKET_LABELS } from '../../components/AgeingStrip.jsx';

/**
 * Party detail, as a drawer over the list — the list never navigates away, so
 * you keep your place, your filter and your scroll position.
 */
export default function PartyDrawer({ party, onClose }) {
  const { data: snapshot } = useQuery(latestSnapshotQuery());
  const { data: bills, isLoading } = useQuery(partyBillsQuery(party.party_id, snapshot?.id));

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const buckets = bucketsOf(party);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-ink/40"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={party.display_name}
        className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,92vw)] flex-col border-l border-hair bg-canvas shadow-[0_0_40px_rgba(15,31,46,.22)]"
      >
        <header className="flex items-start gap-3 border-b border-hair bg-white/80 px-[18px] py-3 backdrop-blur">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[16px] font-semibold tracking-[-0.015em]">{party.display_name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <TermBadge row={party} />
              {party.is_credit_balance ? (
                <span className="rounded-[2px] border border-claim/40 bg-claim/10 px-[7px] py-[2px] font-mono text-[9.5px] uppercase tracking-[0.04em] text-claim">
                  Credit balance
                </span>
              ) : null}
              {party.status !== 'active' ? (
                <span className="rounded-[2px] border border-hair bg-white px-[7px] py-[2px] font-mono text-[9.5px] uppercase tracking-[0.04em] text-mute">
                  {party.status}
                </span>
              ) : null}
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn btn-secondary px-3 py-1 text-[12px]">
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-px bg-hair">
            <Fig label="Outstanding" value={formatInr(party.current_outstanding)} />
            <Fig label="Oldest bill" value={formatAge(party.oldest_bill_age_days)} />
            <Fig label="Open bills" value={formatCount(party.bill_count)} />
          </div>

          <Section title="Ageing">
            {buckets ? (
              <>
                <AgeingStrip buckets={buckets} height={22} />
                <div className="mt-2 grid gap-1">
                  {buckets.map((v, i) => (
                    <div key={i} className="flex items-baseline justify-between text-[12px]">
                      <span className="text-mute">{BUCKET_LABELS[i]}</span>
                      <span className="tnum font-medium">{formatInr(v)}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-faint text-pretty">
                  Measured against the expected due date from this party's credit term, and scaled
                  so the four buckets sum to the Marg header total.
                </p>
              </>
            ) : (
              <StopRule party={party} />
            )}
          </Section>

          {Number(party.bill_balance_sum ?? 0) !== Number(party.current_outstanding) ? (
            <Section title="Reconciliation">
              <div className="grid gap-1 text-[12px]">
                <Line label="Marg header total (used)" value={formatInr(party.current_outstanding)} strong />
                <Line label="Sum of bill rows" value={formatInr(party.bill_balance_sum)} muted />
                <Line
                  label="Difference"
                  value={formatInr(Number(party.current_outstanding) - Number(party.bill_balance_sum ?? 0))}
                  tone="warn"
                />
              </div>
              <p className="mt-2 text-[11px] text-faint text-pretty">
                Marg's own header figure is what the owner sees, so it is the one this app reports.
                The bill rows supply only the shape of the ageing.
              </p>
            </Section>
          ) : null}

          <Section title={`Open bills · snapshot ${formatDate(snapshot?.report_date)}`}>
            {isLoading ? (
              <p className="text-[12px] text-mute">Loading bills…</p>
            ) : (
              <div className="max-h-[320px] overflow-auto border border-hair bg-white">
                <table className="w-full border-collapse text-[11.5px]">
                  <thead>
                    <tr>
                      <Th>Bill</Th>
                      <Th>Date</Th>
                      <Th align="right">Age</Th>
                      <Th align="right">Balance</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(bills ?? []).map((b) => (
                      <tr key={b.id} className="border-b border-rule last:border-b-0">
                        <td className="px-[9px] py-[5px]">
                          <span className="font-mono">{b.bill_no}</span>
                          {b.marg_due_date && b.marg_due_date !== b.bill_date ? (
                            <span
                              className="ml-[6px] font-mono text-[9px] uppercase text-[#7A6410]"
                              title={`Marg carries a due date of ${formatDate(b.marg_due_date)} for this bill`}
                            >
                              due {formatDate(b.marg_due_date)}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-[9px] py-[5px] text-mute">{formatDate(b.bill_date)}</td>
                        <td className="tnum px-[9px] py-[5px] text-right">{formatAge(b.bill_age_days)}</td>
                        <td className="tnum px-[9px] py-[5px] text-right font-medium">{formatInr(b.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      </aside>
    </>
  );
}

/**
 * The stop rule, made visible. Where no term is approved the drawer states
 * what it can and cannot say, and asks for the term — it never fills the gap
 * with bill age dressed up as lateness.
 */
function StopRule({ party }) {
  return (
    <div className="border-l-[3px] border-l-[#C9A93E] bg-white p-3">
      <div className="kicker text-[#7A6410]">Cannot be aged</div>
      <p className="mt-1 text-[12.5px] text-pretty">
        {party.display_name} has no approved credit term, so there is no due date to measure
        against and no overdue figure exists.
      </p>
      <p className="mt-2 text-[12px] text-mute text-pretty">
        What is known: {formatInr(party.current_outstanding)} outstanding across{' '}
        {formatCount(party.bill_count)} bills, the oldest{' '}
        {formatAge(party.oldest_bill_age_days)} old. That is an <strong>age</strong>, not
        lateness — the two are only the same thing once a term is recorded.
      </p>
      <p className="mt-2 text-[11px] text-faint text-pretty">
        Set the term in the credit master and this party becomes judgeable.
      </p>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="mt-4">
      <h3 className="mb-2 text-[13px] font-semibold tracking-[-0.01em]">{title}</h3>
      {children}
    </section>
  );
}

function Fig({ label, value }) {
  return (
    <div className="bg-white/80 px-3 py-2">
      <div className="kicker">{label}</div>
      <div className="tnum mt-[2px] text-[17px] font-medium tracking-[-0.02em]">{value}</div>
    </div>
  );
}

function Line({ label, value, strong, muted, tone }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={muted ? 'text-faint' : 'text-mute'}>{label}</span>
      <span
        className={['tnum', strong ? 'font-semibold' : '', tone === 'warn' ? 'text-age-2' : ''].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

function Th({ children, align = 'left' }) {
  return (
    <th
      className="sticky top-0 border-b border-hair bg-white px-[9px] py-[6px] text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mute"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}

export { formatCreditTerm };
