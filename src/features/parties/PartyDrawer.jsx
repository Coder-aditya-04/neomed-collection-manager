import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { whatsAppLink } from '../registers/Registers.jsx';
import { useNavigate } from 'react-router-dom';
import { latestSnapshotQuery, partyBillsQuery, partyActivityQuery } from '../../lib/queries.js';
import { formatInr, formatCount, formatAge, formatDate, formatCreditTerm } from '../../lib/format.js';
import AgeingStrip, { bucketsOf, TermBadge, BUCKET_LABELS } from '../../components/AgeingStrip.jsx';
import Overlay from '../../components/Overlay.jsx';
import { AFTER, invalidate } from '../../lib/cache.js';

/**
 * Party detail, as a drawer over the list — the list never navigates away, so
 * you keep your place, your filter and your scroll position.
 */
export default function PartyDrawer({ party, onClose }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: snapshot } = useQuery(latestSnapshotQuery());
  const { data: bills, isLoading } = useQuery(partyBillsQuery(party.party_id, snapshot?.id));
  const { data: activity } = useQuery(partyActivityQuery(party.party_id));

  const buckets = bucketsOf(party);

  return (
    <Overlay onClose={onClose} label={party.display_name}>
      <aside className="overlay-panel overlay-drawer flex w-[min(560px,92vw)] flex-col border-l border-hair bg-canvas shadow-[0_0_40px_rgba(15,31,46,.22)]">
        <header className="flex items-start gap-3 border-b border-hair bg-surface/80 px-[18px] py-3 backdrop-blur">
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
                <span className="rounded-[2px] border border-hair bg-surface px-[7px] py-[2px] font-mono text-[9.5px] uppercase tracking-[0.04em] text-mute">
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

          <Section title="Contact">
            <Contact party={party} onSaved={() => invalidate(queryClient, AFTER.partyDetails)} />
          </Section>

          <Section title="Assigned to">
            <Assignment party={party} onSaved={() => invalidate(queryClient, AFTER.partyDetails)} />
          </Section>

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
              <div className="max-h-[320px] overflow-auto border border-hair bg-surface">
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

          <Section title="Activity">
            <Timeline activity={activity} party={party} />
          </Section>
        </div>

        <footer className="flex flex-wrap gap-2 border-t border-hair bg-surface/90 px-[18px] py-3 backdrop-blur">
          <LogFollowUp party={party} onSaved={() => invalidate(queryClient, AFTER.followup)} />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate('/assistant', { state: { question: `What is the payment history of ${party.display_name}?` } })}
          >
            Ask the assistant
          </button>
        </footer>
      </aside>
    </Overlay>
  );
}

/**
 * What the team did and what the money did, on one spine and in one order.
 * Payment events are derived from snapshot comparison, so they only appear
 * once two days' files exist — the empty state says as much rather than
 * leaving a blank panel.
 */
function Timeline({ activity, party }) {
  if (!activity) return <p className="text-[12px] text-mute">Loading…</p>;

  const events = [
    ...activity.followups.map((f) => ({
      date: f.contact_date,
      tone: f.closed ? 'done' : 'plain',
      title: `${f.method.charAt(0).toUpperCase() + f.method.slice(1)}${f.outcome ? '' : ' logged'}`,
      detail: [f.outcome, f.next_followup_date ? `Next follow-up ${formatDate(f.next_followup_date)}` : null]
        .filter(Boolean).join(' · '),
    })),
    ...activity.promises.map((p) => ({
      date: p.promised_on,
      tone: p.status === 'broken' ? 'bad' : p.status === 'kept' ? 'good' : 'warn',
      title: 'Promise recorded',
      detail: `${formatInr(p.promised_amount)} by ${formatDate(p.due_date)} — ${p.status}` +
        (p.status === 'open' ? ', no supporting payment yet' : `, received ${formatInr(p.received_amount)}`),
    })),
    ...activity.claims.map((c) => ({
      date: c.raised_on,
      tone: c.status === 'open' ? 'claim' : 'done',
      title: `Claim · ${c.claim_type.replace('_', ' ')}`,
      detail: `${formatInr(c.payment_held)} held${c.pending_with ? ` · with ${c.pending_with}` : ''} — ${c.status}`,
    })),
    ...activity.changes.map((b) => ({
      date: b.detected_to,
      tone: 'good',
      title: b.change_type === 'settled' ? 'Bill cleared' : 'Part payment',
      detail: `${formatInr(b.delta)} against ${b.bill_no}`,
    })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  if (events.length === 0) {
    return (
      <div className="border border-hair bg-surface p-3">
        <p className="text-[12px] text-mute text-pretty">
          Nothing recorded for {party.display_name} yet. Follow-ups, promises and claims appear here
          as they are logged.
        </p>
        <p className="mt-2 text-[11px] text-faint text-pretty">
          Payments appear on their own, worked out by comparing one day's export against the next —
          so they start showing once a second file has been imported.
        </p>
      </div>
    );
  }

  const dot = {
    good: 'var(--color-age-0)', warn: '#D8A21A', bad: 'var(--color-age-3)',
    claim: 'var(--color-claim)', done: '#B4C0C9', plain: '#8A98A4',
  };

  return (
    <div className="border border-hair bg-surface">
      {events.slice(0, 25).map((e, i) => (
        <div key={i} className="grid gap-[10px] border-b border-rule px-3 py-[9px] last:border-b-0"
             style={{ gridTemplateColumns: '58px 10px minmax(0,1fr)' }}>
          <span className="tnum pt-[2px] text-[11px] text-mute">{shortDate(e.date)}</span>
          <span className="mt-[6px] h-[7px] w-[7px] flex-none" style={{ background: dot[e.tone] }} />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-semibold">{e.title}</span>
            {e.detail ? <span className="mt-[1px] block text-[11.5px] text-mute text-pretty">{e.detail}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function shortDate(iso) {
  const full = formatDate(iso);
  return full === '—' ? full : full.split(' ').slice(0, 2).join(' ');
}

/** Logging a call without leaving the party you are looking at. */
function LogFollowUp({ party, onSaved }) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState('call');
  const [outcome, setOutcome] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const { error } = await supabase.from('followups').insert({
      party_id: party.party_id,
      method,
      outcome: outcome || null,
      next_followup_date: next || null,
    });
    setSaving(false);
    if (!error) {
      setOpen(false); setOutcome(''); setNext('');
      onSaved?.();
    }
  }

  if (!open) {
    return <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Log follow-up</button>;
  }

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="kicker mb-1 block">Method</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)}
                  className="rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]">
            {['call', 'visit', 'whatsapp', 'email'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="block flex-1 min-w-[180px]">
          <span className="kicker mb-1 block">Outcome</span>
          <input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Promised Friday"
                 className="w-full rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]" />
        </label>
        <label className="block">
          <span className="kicker mb-1 block">Next follow-up</span>
          <input type="date" value={next} onChange={(e) => setNext(e.target.value)}
                 className="rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]" />
        </label>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * The stop rule, made visible. Where no term is approved the drawer states
 * what it can and cannot say, and asks for the term — it never fills the gap
 * with bill age dressed up as lateness.
 */
function StopRule({ party }) {
  return (
    <div className="border-l-[3px] border-l-[#C9A93E] bg-surface p-3">
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

/**
 * Who owns chasing this party. Allocation is per party rather than per task,
 * because a party is what a person actually carries — the calls, the promises
 * and the claims all follow from it.
 */
function Assignment({ party, onSaved }) {
  const { data: team } = useQuery({
    queryKey: ['app-users'],
    queryFn: async () => {
      const { data, error } = await supabase.from('app_users').select('id, full_name, role').order('full_name');
      if (error) throw error;
      return data ?? [];
    },
  });
  const [saving, setSaving] = useState(false);

  async function assign(userId) {
    setSaving(true);
    await supabase.from('parties').update({ responsible_person: userId || null }).eq('id', party.party_id);
    setSaving(false);
    onSaved?.();
  }

  const current = team?.find((u) => u.id === party.responsible_person);

  return (
    <div className="flex flex-wrap items-center gap-2 border border-hair bg-surface p-3">
      <select
        value={party.responsible_person ?? ''}
        onChange={(e) => assign(e.target.value)}
        disabled={saving}
        className="rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]"
      >
        <option value="">Nobody assigned</option>
        {(team ?? []).map((u) => (
          <option key={u.id} value={u.id}>{u.full_name} · {u.role}</option>
        ))}
      </select>
      <span className="text-[11px] text-faint text-pretty">
        {current
          ? `${current.full_name} is responsible for chasing this party.`
          : 'Unassigned parties still appear on the call list, but nobody owns them.'}
      </span>
    </div>
  );
}

/**
 * The number is entered here and nowhere else. Marg's export carries no
 * contact details and the import payload never includes them, so nothing a
 * daily file does can overwrite what is typed in.
 */
function Contact({ party, onSaved }) {
  const [value, setValue] = useState(party.phone ?? '');
  const [person, setPerson] = useState(party.contact_person ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = (value || '') !== (party.phone || '') || (person || '') !== (party.contact_person || '');
  const wa = whatsAppLink(value, { ...party, contact_person: person });

  async function save() {
    setSaving(true);
    await supabase
      .from('parties')
      .update({ phone: value || null, contact_person: person || null })
      .eq('id', party.party_id);
    setSaving(false);
    onSaved?.();
  }

  return (
    <div className="border border-hair bg-surface p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="kicker mb-1 block">Mobile</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="98765 43210"
            className="tnum w-[140px] rounded-[2px] border border-hair px-[8px] py-[4px] text-[12px]"
          />
        </label>
        <label className="block">
          <span className="kicker mb-1 block">Contact person</span>
          <input
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            placeholder="Dr Kulkarni"
            className="w-[150px] rounded-[2px] border border-hair px-[8px] py-[4px] text-[12px]"
          />
        </label>
        <button type="button" className="btn btn-primary px-3 py-[4px] text-[12px]" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {value ? (
        <div className="mt-3 flex items-center gap-2">
          <a
            href={`tel:${String(value).replace(/[^\d+]/g, '')}`}
            className="rounded-[2px] border border-hair bg-surface px-[10px] py-[4px] text-[12px] no-underline text-ink hover:bg-surface-3"
          >
            Call
          </a>
          {wa ? (
            <a
              href={wa}
              target="_blank"
              rel="noreferrer"
              className="rounded-[2px] border border-[#25D366] bg-[#25D366]/10 px-[10px] py-[4px] text-[12px] no-underline text-[#0B7A3E] hover:bg-[#25D366]/20"
            >
              WhatsApp
            </a>
          ) : null}
          <span className="text-[10.5px] text-faint text-pretty">
            WhatsApp opens with a draft naming the balance — nothing is sent until you press send.
          </span>
        </div>
      ) : null}
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
    <div className="bg-surface/80 px-3 py-2">
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
      className="sticky top-0 border-b border-hair bg-surface px-[9px] py-[6px] text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mute"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}

export { formatCreditTerm };
