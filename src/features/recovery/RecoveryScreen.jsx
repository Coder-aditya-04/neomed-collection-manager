import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { formatInr, formatCount, formatDate } from '../../lib/format.js';

/**
 * The recovery desk: who called whom, how much they got through, and how
 * that compares with what they committed to.
 *
 * Efficiency here is commitments met against commitments due — not calls
 * against a target, because a target is a number someone typed and a
 * commitment is a promise the person made to themselves. Where nothing was
 * committed it shows a dash rather than 100%, which would flatter whoever
 * planned the least.
 */

const RANGES = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
];

function rangeFor(key) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (key === 'today') return [iso(today), iso(today)];
  if (key === 'week') {
    const d = new Date(today);
    const dow = (d.getDay() + 6) % 7;      // Monday-based
    d.setDate(d.getDate() - dow);
    return [iso(d), iso(today)];
  }
  const d = new Date(today.getFullYear(), today.getMonth(), 1);
  return [iso(d), iso(today)];
}

export default function RecoveryScreen() {
  const [range, setRange] = useState('week');
  const [from, to] = rangeFor(range);

  const { data: scores, isLoading } = useQuery({
    queryKey: ['scorecard', from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('fn_recovery_scorecard', { p_from: from, p_to: to });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: activity } = useQuery({
    queryKey: ['recovery-activity', from, to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_recovery_activity')
        .select('*')
        .gte('contact_date', from)
        .lte('contact_date', to)
        .order('contact_date', { ascending: false })
        .limit(300);
      if (error) throw error;
      return data ?? [];
    },
  });

  /*
   * Every contact in the window, as thin rows, for the per-day tally.
   *
   * Separate from the `activity` query above because that one is capped at
   * 300 for display — counting off a truncated list would quietly understate
   * a busy week, and an activity report that undercounts is worse than none.
   */
  const { data: tally } = useQuery({
    queryKey: ['recovery-tally', from, to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_recovery_activity')
        .select('contact_date, by_name, method')
        .gte('contact_date', from)
        .lte('contact_date', to)
        .limit(5000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const { data: dueToday } = useQuery({
    queryKey: ['due-today', today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_recovery_activity')
        .select('*')
        .eq('closed', false)
        .lte('next_followup_date', today)
        .order('next_followup_date', { ascending: true })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const totals = useMemo(() => {
    const s = scores ?? [];
    return {
      contacts: s.reduce((a, r) => a + r.total_contacts, 0),
      calls: s.reduce((a, r) => a + r.calls, 0),
      whatsapps: s.reduce((a, r) => a + r.whatsapps, 0),
      due: s.reduce((a, r) => a + r.due_in_window, 0),
      done: s.reduce((a, r) => a + r.done_in_window, 0),
      promised: s.reduce((a, r) => a + Number(r.promised_amount), 0),
      collected: s.reduce((a, r) => a + Number(r.collected_amount), 0),
    };
  }, [scores]);

  if (isLoading) return <Msg>Loading…</Msg>;

  const overdue = (dueToday ?? []).filter((f) => f.next_followup_date < today);

  return (
    <div className="animate-screen-in px-[18px] pb-[34px] pt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {RANGES.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setRange(k)}
                  className={['rounded-[2px] border px-[10px] py-[4px] text-[11.5px]',
                    range === k ? 'border-teal bg-teal font-semibold text-onaccent' : 'border-hair bg-surface text-body'].join(' ')}>
            {label}
          </button>
        ))}
        <span className="tnum ml-auto text-[11.5px] text-mute">
          {formatDate(from)} – {formatDate(to)}
        </span>
      </div>

      <div className="stagger mb-4 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px border border-hair bg-hair">
        <Fig label="Contacts made" value={formatCount(totals.contacts)}
             note={`${formatCount(totals.calls)} calls · ${formatCount(totals.whatsapps)} WhatsApp`} />
        <Fig label="Commitments due" value={formatCount(totals.due)}
             note={`${formatCount(totals.done)} followed through`} />
        <Fig label="Efficiency" value={totals.due ? `${Math.round((totals.done / totals.due) * 100)}%` : '—'}
             note={totals.due ? 'met against due' : 'nothing was committed'} />
        <Fig label="Promised" value={formatInr(totals.promised)}
             note={`${formatInr(totals.collected)} arrived`} />
      </div>

      {overdue.length > 0 ? (
        <section className="panel mb-4 border-l-[3px] border-l-age-3">
          <div className="flex flex-wrap items-baseline gap-3 border-b border-hair px-4 py-[9px]">
            <h2 className="text-[14px] font-semibold text-age-3">Follow-ups past their date</h2>
            <span className="tnum text-[11px] text-faint">{formatCount(overdue.length)}</span>
          </div>
          {overdue.slice(0, 12).map((f) => (
            <div key={f.id} className="grid items-center gap-3 border-b border-rule px-4 py-2 last:border-b-0"
                 style={{ gridTemplateColumns: 'minmax(0,1fr) 120px 110px 90px' }}>
              <span className="truncate text-[12.5px] font-medium">{f.party_name}</span>
              <span className="truncate text-[11.5px] text-mute">{f.by_name ?? 'unassigned'}</span>
              <span className="tnum text-right text-[12px]">{formatInr(f.current_outstanding)}</span>
              <span className="tnum text-right text-[11px] text-age-3">due {formatDate(f.next_followup_date)}</span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="panel panel-lift mb-4">
        <div className="border-b border-hair px-4 py-[9px]">
          <h2 className="text-[14px] font-semibold tracking-[-0.01em]">By person</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <Th>Person</Th><Th>Role</Th>
                <Th align="right">Calls</Th><Th align="right">WhatsApp</Th>
                <Th align="right">Visits</Th><Th align="right">Parties</Th>
                <Th align="right">Due</Th><Th align="right">Met</Th>
                <Th align="right">Efficiency</Th>
                <Th align="right">Target</Th>
                <Th align="right">Promised</Th><Th align="right">Collected</Th>
              </tr>
            </thead>
            <tbody>
              {(scores ?? []).map((r) => (
                <tr key={r.user_id} className="border-b border-rule last:border-b-0">
                  <td className="px-[10px] py-[6px] font-medium">{r.full_name}</td>
                  <td className="px-[10px] py-[6px] text-mute">{r.role}</td>
                  <td className="tnum px-[10px] py-[6px] text-right">{formatCount(r.calls)}</td>
                  <td className="tnum px-[10px] py-[6px] text-right">{formatCount(r.whatsapps)}</td>
                  <td className="tnum px-[10px] py-[6px] text-right">{formatCount(r.visits)}</td>
                  <td className="tnum px-[10px] py-[6px] text-right">{formatCount(r.parties_touched)}</td>
                  <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatCount(r.due_in_window)}</td>
                  <td className="tnum px-[10px] py-[6px] text-right">{formatCount(r.done_in_window)}</td>
                  <td className="tnum px-[10px] py-[6px] text-right font-medium"
                      style={{ color: effColor(r.efficiency_pct) }}>
                    {r.efficiency_pct == null ? '—' : `${r.efficiency_pct}%`}
                  </td>
                  <td className="tnum px-[10px] py-[6px] text-right text-mute">
                    {r.call_target ? formatCount(r.call_target) : '—'}
                  </td>
                  <td className="tnum px-[10px] py-[6px] text-right">{formatInr(r.promised_amount)}</td>
                  <td className="tnum px-[10px] py-[6px] text-right font-medium">{formatInr(r.collected_amount)}</td>
                </tr>
              ))}
              {!scores?.length ? (
                <tr><td colSpan={12} className="px-[10px] py-4 text-center text-[12px] text-faint">
                  No one on the team yet. Add users in Settings.
                </td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="border-t border-hair px-4 py-2 text-[11px] text-faint text-pretty">
          Efficiency is commitments met against commitments due in the window. A dash means nothing
          was committed — not that nothing was achieved, and not a perfect score.
        </p>
      </section>

      <DailyCalls rows={tally} from={from} to={to} />

      <section className="panel">
        <div className="border-b border-hair px-4 py-[9px]">
          <h2 className="text-[14px] font-semibold tracking-[-0.01em]">What was said</h2>
        </div>
        {(activity ?? []).length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-faint">Nothing logged in this period.</p>
        ) : (
          (activity ?? []).slice(0, 60).map((f) => (
            <div key={f.id} className="grid items-start gap-3 border-b border-rule px-4 py-2 last:border-b-0"
                 style={{ gridTemplateColumns: '80px 110px minmax(0,1fr) 110px' }}>
              <span className="tnum text-[11px] text-mute">{formatDate(f.contact_date)}</span>
              <span className="truncate text-[11.5px]">{f.by_name ?? 'unassigned'}</span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium">{f.party_name}</span>
                <span className="block text-[11.5px] text-mute text-pretty">
                  <em>{f.method}</em>{f.outcome ? ` — ${f.outcome}` : ''}
                </span>
              </span>
              <span className="tnum text-right text-[12px]">{formatInr(f.current_outstanding)}</span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function effColor(pct) {
  if (pct == null) return 'var(--color-faint)';
  if (pct >= 80) return 'var(--color-teal-deep)';
  if (pct >= 50) return 'var(--color-age-1)';
  return 'var(--color-age-3)';
}

function Fig({ label, value, note }) {
  return (
    <div className="bg-surface/60 px-[14px] pb-[13px] pt-3 backdrop-blur-sm transition-colors duration-200 hover:bg-surface/80">
      <div className="kicker">{label}</div>
      <div className="tnum mt-1 text-[24px] font-medium leading-[1.1] tracking-[-0.03em]">{value}</div>
      {note ? <div className="mt-[3px] text-[11px] text-mute text-pretty">{note}</div> : null}
    </div>
  );
}

function Th({ children, align = 'left' }) {
  return (
    <th className="border-b border-hair px-[10px] py-[7px] text-[10px] font-semibold uppercase tracking-[0.09em] text-mute"
        style={{ textAlign: align }}>
      {children}
    </th>
  );
}

function Msg({ children }) {
  return (
    <div className="animate-screen-in px-[18px] pt-4">
      <div className="panel p-[14px] text-[12.5px] text-mute">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Calls per person, per day.
 *
 * The desk reported the old summary as the wrong interpretation, and they
 * were right: a total over a week answers "how much was done" but not "who
 * worked which day", which is the question a supervisor is actually asking.
 * One row per person, one column per day, the count in the cell.
 *
 * Shaded in a single hue, light to dark, because the cells encode magnitude
 * rather than identity — and the number is printed in every cell, so the
 * shade is a second reading of the same fact, never the only one.
 */
function DailyCalls({ rows, from, to }) {
  const days = [];
  for (let d = new Date(from + 'T00:00:00'); d <= new Date(to + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  if (days.length > 45) days.splice(0, days.length - 45);

  const people = new Map();
  for (const r of rows ?? []) {
    const name = r.by_name ?? 'Unassigned';
    if (!people.has(name)) people.set(name, { name, byDay: new Map(), calls: 0, whatsapps: 0, total: 0 });
    const p = people.get(name);
    p.byDay.set(r.contact_date, (p.byDay.get(r.contact_date) ?? 0) + 1);
    p.total += 1;
    if (r.method === 'call') p.calls += 1;
    if (r.method === 'whatsapp') p.whatsapps += 1;
  }
  const list = [...people.values()].sort((a, b) => b.total - a.total);
  const busiest = Math.max(1, ...list.flatMap((p) => [...p.byDay.values()]));

  return (
    <section className="panel mb-3">
      <div className="border-b border-hair px-4 py-[9px]">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">Who worked which day</h2>
        <p className="mt-[2px] text-[11.5px] text-mute text-pretty">
          Every contact logged, counted per person per day. A blank cell is a day with nothing
          logged — which may mean a quiet day or an unlogged one, and those are not the same thing.
        </p>
      </div>

      {list.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-faint">Nothing logged in this period.</p>
      ) : (
        <div className="overflow-x-auto px-4 py-3">
          <table className="border-collapse text-[11px]">
            <thead>
              <tr>
                <th className="sticky left-0 bg-surface pr-3 text-left text-[9.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                  Person
                </th>
                {days.map((d) => (
                  <th key={d} className="px-[2px] pb-[5px] text-center text-[9px] font-normal text-faint">
                    {Number(d.slice(8, 10))}
                  </th>
                ))}
                <th className="pl-3 text-right text-[9.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                  Calls
                </th>
                <th className="pl-3 text-right text-[9.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                  WhatsApp
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.name}>
                  <td className="sticky left-0 whitespace-nowrap bg-surface pr-3 text-[12px]">{p.name}</td>
                  {days.map((d) => {
                    const n = p.byDay.get(d) ?? 0;
                    return (
                      <td key={d} className="p-[1px]">
                        <div
                          title={`${p.name} · ${formatDate(d)} · ${n} contact${n === 1 ? '' : 's'}`}
                          className="grid h-[20px] w-[20px] place-items-center rounded-[2px] text-[10px] tabular-nums"
                          style={{
                            background: n === 0 ? 'var(--color-surface-3)' : 'var(--color-teal)',
                            opacity: n === 0 ? 1 : 0.28 + 0.72 * (n / busiest),
                            color: n === 0 ? 'var(--color-faint)' : 'var(--color-onaccent)',
                          }}
                        >
                          {n || ''}
                        </div>
                      </td>
                    );
                  })}
                  <td className="tnum pl-3 text-right text-[12px] font-medium">{formatCount(p.calls)}</td>
                  <td className="tnum pl-3 text-right text-[12px]">{formatCount(p.whatsapps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
