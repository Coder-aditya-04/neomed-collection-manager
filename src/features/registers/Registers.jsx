import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { partiesAgeingQuery } from '../../lib/queries.js';
import { formatInr, formatCount, formatDate } from '../../lib/format.js';

/**
 * Claims, follow-ups and promises.
 *
 * All three are the same shape — a register grouped by what needs doing —
 * so they share the scaffolding and differ only in their columns and in
 * what closing a record means.
 */


/* ------------------------------------------------------------------ */
/* contacting a party                                                  */
/* ------------------------------------------------------------------ */

/**
 * Indian mobile numbers get typed every which way — with +91, with a leading
 * 0, with spaces or dashes. WhatsApp wants bare digits with the country code.
 */
export function toWhatsAppNumber(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;           // plain mobile
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(1);
  return digits.length >= 10 ? digits : null;
}

/** The message opens pre-written but unsent — nothing is sent on their behalf. */
export function whatsAppLink(phone, party) {
  const n = toWhatsAppNumber(phone);
  if (!n) return null;
  const text =
    `Dear ${party?.contact_person || party?.display_name || 'Sir/Madam'}, ` +
    `this is Neomed Pharma Agencies regarding an outstanding balance of ` +
    `${formatInr(party?.current_outstanding)}. Could you let us know when we may expect payment? Thank you.`;
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

/** Buttons that open the phone's own dialer or WhatsApp. */
function ContactActions({ party, compact }) {
  const wa = whatsAppLink(party?.phone, party);
  const tel = party?.phone ? `tel:${String(party.phone).replace(/[^\d+]/g, '')}` : null;
  const cls = compact
    ? 'rounded-[2px] border px-[7px] py-[2px] text-[10.5px] no-underline whitespace-nowrap'
    : 'rounded-[2px] border px-[9px] py-[3px] text-[11.5px] no-underline whitespace-nowrap';

  if (!party?.phone) {
    return <span className="text-[10.5px] text-faint">no number</span>;
  }
  return (
    <span className="flex items-center gap-[5px]">
      <a href={tel} className={`${cls} border-hair bg-white text-ink hover:bg-[#F2F6F8]`}>Call</a>
      {wa ? (
        <a
          href={wa}
          target="_blank"
          rel="noreferrer"
          className={`${cls} border-[#25D366] bg-[#25D366]/10 text-[#0B7A3E] hover:bg-[#25D366]/20`}
          title="Opens WhatsApp with a draft message — nothing is sent until you press send"
        >
          WhatsApp
        </a>
      ) : null}
    </span>
  );
}

/** Inline editor for a party's number, so it can be added mid-call. */
function PhoneField({ party, onSaved }) {
  const [value, setValue] = useState(party?.phone ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = (value || '') !== (party?.phone || '');

  async function save() {
    setSaving(true);
    const { error } = await supabase.from('parties').update({ phone: value || null }).eq('id', party.party_id);
    setSaving(false);
    if (!error) onSaved?.();
  }

  return (
    <span className="flex items-center gap-[5px]">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="mobile"
        className="tnum w-[120px] rounded-[2px] border border-hair bg-white px-[6px] py-[3px] text-[11.5px]"
      />
      <button
        type="button"
        onClick={save}
        disabled={!dirty || saving}
        className="btn btn-secondary px-[8px] py-[2px] text-[11px]"
      >
        {saving ? '…' : 'Save'}
      </button>
    </span>
  );
}

/* ================================================================== */
/* Claims                                                             */
/* ================================================================== */

const CLAIM_TYPES = ['expiry', 'breakage', 'scheme', 'rate_diff', 'short_supply'];

export function ClaimsScreen() {
  const qc = useQueryClient();
  const { data: parties } = useQuery(partiesAgeingQuery());
  const { data: claims, isLoading } = useQuery({
    queryKey: ['claims'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('claims')
        .select('*, parties(display_name, current_outstanding)')
        .order('raised_on', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const [form, setForm] = useState({ party_id: '', claim_type: 'expiry', claim_value: '', payment_held: '', pending_with: '' });

  const create = useMutation({
    mutationFn: async (row) => {
      const { error } = await supabase.from('claims').insert(row);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries();
      setForm({ party_id: '', claim_type: 'expiry', claim_value: '', payment_held: '', pending_with: '' });
    },
  });

  const settle = useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase
        .from('claims')
        .update({ status: 'settled', settled_on: new Date().toISOString().slice(0, 10) })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries(),
  });

  // Grouped by who owes the internal action — the thing that unblocks money.
  const grouped = useMemo(() => {
    const open = (claims ?? []).filter((c) => c.status === 'open');
    const by = new Map();
    for (const c of open) {
      const k = c.pending_with?.trim() || 'Unassigned';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(c);
    }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [claims]);

  const held = (claims ?? []).filter((c) => c.status === 'open').reduce((a, c) => a + Number(c.payment_held ?? 0), 0);

  return (
    <Screen
      loading={isLoading}
      intro={
        <>
          <strong className="tnum">{formatInr(held)}</strong> is held by our own pending action across{' '}
          {formatCount(grouped.reduce((a, [, v]) => a + v.length, 0))} open claims. These parties are not
          defaulters — they are excluded from the priority list until the claim is settled.
        </>
      }
      form={
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.party_id) return;
            create.mutate({
              party_id: form.party_id,
              claim_type: form.claim_type,
              claim_value: Number(form.claim_value) || 0,
              payment_held: Number(form.payment_held) || 0,
              pending_with: form.pending_with || null,
            });
          }}
        >
          <PartyPicker parties={parties} value={form.party_id} onChange={(v) => setForm({ ...form, party_id: v })} />
          <Field label="Type">
            <select value={form.claim_type} onChange={(e) => setForm({ ...form, claim_type: e.target.value })} className={INPUT}>
              {CLAIM_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace('_', ' ')}</option>
              ))}
            </select>
          </Field>
          <Field label="Claim value">
            <input type="number" value={form.claim_value} onChange={(e) => setForm({ ...form, claim_value: e.target.value })} className={`${INPUT} w-[110px] text-right`} />
          </Field>
          <Field label="Payment held">
            <input type="number" value={form.payment_held} onChange={(e) => setForm({ ...form, payment_held: e.target.value })} className={`${INPUT} w-[110px] text-right`} />
          </Field>
          <Field label="Pending with">
            <input value={form.pending_with} onChange={(e) => setForm({ ...form, pending_with: e.target.value })} placeholder="Returns desk" className={`${INPUT} w-[140px]`} />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={!form.party_id || create.isPending}>Raise claim</button>
        </form>
      }
    >
      {grouped.length === 0 ? (
        <Empty>No claims are open.</Empty>
      ) : (
        grouped.map(([owner, items]) => (
          <Group key={owner} title={owner} count={items.length} total={items.reduce((a, c) => a + Number(c.payment_held ?? 0), 0)}>
            {items.map((c) => (
              <Row
                key={c.id}
                name={c.parties?.display_name ?? '—'}
                amount={formatInr(c.payment_held)}
                meta={`${c.claim_type.replace('_', ' ')} · raised ${formatDate(c.raised_on)} · claim ${formatInr(c.claim_value)}`}
                action={<button type="button" className="btn btn-secondary px-[10px] py-[3px] text-[11.5px]" onClick={() => settle.mutate(c.id)}>Settle</button>}
              />
            ))}
          </Group>
        ))
      )}
    </Screen>
  );
}

/* ================================================================== */
/* Follow-ups                                                         */
/* ================================================================== */

const METHODS = ['call', 'visit', 'whatsapp', 'email'];

export function FollowupsScreen() {
  const qc = useQueryClient();
  const { data: parties } = useQuery(partiesAgeingQuery());
  const { data: rows, isLoading } = useQuery({
    queryKey: ['followups'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('followups')
        .select('*, parties(display_name, current_outstanding)')
        .order('contact_date', { ascending: false })
        .limit(300);
      if (error) throw error;
      return data ?? [];
    },
  });

  const [form, setForm] = useState({ party_id: '', method: 'call', outcome: '', next_followup_date: '' });

  const log = useMutation({
    mutationFn: async (row) => {
      const { error } = await supabase.from('followups').insert(row);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries();
      setForm({ party_id: '', method: 'call', outcome: '', next_followup_date: '' });
    },
  });

  const close = useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('followups').update({ closed: true }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries(),
  });

  const today = new Date().toISOString().slice(0, 10);
  const missed = (rows ?? []).filter((f) => !f.closed && f.next_followup_date && f.next_followup_date < today);
  const planned = (rows ?? []).filter((f) => !f.closed && f.next_followup_date && f.next_followup_date >= today);
  const activity = (rows ?? []).filter((f) => f.closed || !f.next_followup_date).slice(0, 40);

  return (
    <Screen
      loading={isLoading}
      intro={<>Missed first, then what is planned, then what the team has been doing.</>}
      form={
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.party_id) return;
            log.mutate({
              party_id: form.party_id,
              method: form.method,
              outcome: form.outcome || null,
              next_followup_date: form.next_followup_date || null,
            });
          }}
        >
          <PartyPicker parties={parties} value={form.party_id} onChange={(v) => setForm({ ...form, party_id: v })} />
          <Field label="Method">
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className={INPUT}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Outcome">
            <input value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} placeholder="Promised Friday" className={`${INPUT} w-[200px]`} />
          </Field>
          <Field label="Next follow-up">
            <input type="date" value={form.next_followup_date} onChange={(e) => setForm({ ...form, next_followup_date: e.target.value })} className={INPUT} />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={!form.party_id || log.isPending}>Log follow-up</button>
        </form>
      }
    >
      <Group title="Missed" count={missed.length} tone="alert">
        {missed.length === 0 ? <Empty>Nothing committed has been missed.</Empty> : missed.map((f) => (
          <Row key={f.id} name={f.parties?.display_name ?? '—'} amount={formatInr(f.parties?.current_outstanding)}
            meta={`was due ${formatDate(f.next_followup_date)} · ${f.method}${f.outcome ? ` · ${f.outcome}` : ''}`}
            action={
              <span className="flex items-center gap-[6px]">
                <ContactActions party={partyOf(parties, f.party_id)} compact />
                <button type="button" className="btn btn-secondary px-[10px] py-[3px] text-[11.5px]" onClick={() => close.mutate(f.id)}>Close</button>
              </span>
            } />
        ))}
      </Group>

      <Group title="Planned" count={planned.length}>
        {planned.length === 0 ? <Empty>Nothing scheduled.</Empty> : planned.map((f) => (
          <Row key={f.id} name={f.parties?.display_name ?? '—'} amount={formatInr(f.parties?.current_outstanding)}
            meta={`due ${formatDate(f.next_followup_date)} · ${f.method}${f.outcome ? ` · ${f.outcome}` : ''}`}
            action={
              <span className="flex items-center gap-[6px]">
                <ContactActions party={partyOf(parties, f.party_id)} compact />
                <button type="button" className="btn btn-secondary px-[10px] py-[3px] text-[11.5px]" onClick={() => close.mutate(f.id)}>Close</button>
              </span>
            } />
        ))}
      </Group>

      <Group title="Team activity" count={activity.length}>
        {activity.length === 0 ? <Empty>No contact logged yet.</Empty> : activity.map((f) => (
          <Row key={f.id} name={f.parties?.display_name ?? '—'} amount={formatInr(f.parties?.current_outstanding)}
            meta={`${formatDate(f.contact_date)} · ${f.method}${f.outcome ? ` · ${f.outcome}` : ''}`} />
        ))}
      </Group>
    </Screen>
  );
}

/* ================================================================== */
/* Promises                                                           */
/* ================================================================== */

export function PromisesScreen() {
  const qc = useQueryClient();
  const { data: parties } = useQuery(partiesAgeingQuery());
  const { data: rows, isLoading } = useQuery({
    queryKey: ['promises'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('promises')
        .select('*, parties(display_name)')
        .order('due_date', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const [form, setForm] = useState({ party_id: '', due_date: '', promised_amount: '', is_pdc: false, cheque_no: '' });

  const create = useMutation({
    mutationFn: async (row) => {
      const { error } = await supabase.from('promises').insert(row);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries();
      setForm({ party_id: '', due_date: '', promised_amount: '', is_pdc: false, cheque_no: '' });
    },
  });

  // Rule 5: nothing here can mark a promise kept. The database decides, from
  // payments it can actually see.
  const settle = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('fn_settle_promises', { p_grace_days: 3 });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries(),
  });

  const groups = [
    ['open', 'Open'],
    ['kept', 'Kept'],
    ['partial', 'Partly kept'],
    ['broken', 'Broken'],
  ];

  return (
    <Screen
      loading={isLoading}
      intro={
        <>
          A promise closes only when a payment supports it. Nothing on this screen can mark one kept
          by hand — the database matches promises against money that actually arrived between the
          promise and three days past its due date.
        </>
      }
      form={
        <div className="flex flex-wrap items-end gap-2">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!form.party_id || !form.due_date) return;
              create.mutate({
                party_id: form.party_id,
                due_date: form.due_date,
                promised_amount: Number(form.promised_amount) || 0,
                is_pdc: form.is_pdc,
                cheque_no: form.cheque_no || null,
              });
            }}
          >
            <PartyPicker parties={parties} value={form.party_id} onChange={(v) => setForm({ ...form, party_id: v })} />
            <Field label="Amount">
              <input type="number" value={form.promised_amount} onChange={(e) => setForm({ ...form, promised_amount: e.target.value })} className={`${INPUT} w-[110px] text-right`} />
            </Field>
            <Field label="Due">
              <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className={INPUT} />
            </Field>
            <Field label="PDC">
              <label className="flex items-center gap-1 text-[11.5px]">
                <input type="checkbox" checked={form.is_pdc} onChange={(e) => setForm({ ...form, is_pdc: e.target.checked })} />
                cheque
              </label>
            </Field>
            {form.is_pdc ? (
              <Field label="Cheque no">
                <input value={form.cheque_no} onChange={(e) => setForm({ ...form, cheque_no: e.target.value })} className={`${INPUT} w-[120px]`} />
              </Field>
            ) : null}
            <button type="submit" className="btn btn-primary" disabled={!form.party_id || !form.due_date || create.isPending}>Record promise</button>
          </form>
          <button type="button" className="btn btn-secondary" onClick={() => settle.mutate()} disabled={settle.isPending}>
            {settle.isPending ? 'Checking…' : 'Check against payments'}
          </button>
        </div>
      }
    >
      {groups.map(([status, label]) => {
        const items = (rows ?? []).filter((p) => p.status === status);
        return (
          <Group key={status} title={label} count={items.length} tone={status === 'broken' ? 'alert' : undefined}>
            {items.length === 0 ? <Empty>None.</Empty> : items.map((p) => (
              <Row
                key={p.id}
                name={p.parties?.display_name ?? '—'}
                amount={formatInr(p.promised_amount)}
                meta={
                  `due ${formatDate(p.due_date)} · received ${formatInr(p.received_amount)}` +
                  (p.is_pdc ? ` · PDC ${p.cheque_no ?? ''}` : '') +
                  (p.linked_change_ids?.length ? ` · ${p.linked_change_ids.length} payment events` : '')
                }
              />
            ))}
          </Group>
        );
      })}
    </Screen>
  );
}

/* ================================================================== */
/* shared                                                             */
/* ================================================================== */

const INPUT = 'rounded-[2px] border border-hair bg-white px-[8px] py-[4px] text-[12px]';

function Screen({ children, intro, form, loading }) {
  return (
    <div className="animate-screen-in px-[18px] pb-[34px] pt-4">
      {intro ? (
        <p className="panel mb-3 max-w-[90ch] px-4 py-3 text-[12px] text-pretty">{intro}</p>
      ) : null}
      {form ? <div className="panel mb-4 px-4 py-3">{form}</div> : null}
      {loading ? <p className="text-[12px] text-mute">Loading…</p> : <div className="grid gap-4">{children}</div>}
    </div>
  );
}

function Group({ title, count, total, children, tone }) {
  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-hair px-4 py-[9px]">
        <h2 className={`text-[14px] font-semibold tracking-[-0.01em] ${tone === 'alert' ? 'text-age-3' : ''}`}>{title}</h2>
        <span className="tnum text-[11px] text-faint">{formatCount(count)}</span>
        {total ? <span className="tnum ml-auto text-[12px] font-medium">{formatInr(total)}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ name, amount, meta, action }) {
  return (
    <div className="grid items-center gap-3 border-b border-rule px-4 py-2 last:border-b-0" style={{ gridTemplateColumns: 'minmax(0,1fr) 110px auto' }}>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium">{name}</div>
        {meta ? <div className="mt-[2px] truncate text-[11px] text-mute">{meta}</div> : null}
      </div>
      <div className="tnum text-right text-[12.5px] font-medium">{amount}</div>
      <div>{action}</div>
    </div>
  );
}

/** The ageing row carries the party id; the number lives on the party. */
function partyOf(parties, id) {
  return parties?.find((p) => p.party_id === id) ?? null;
}

function Empty({ children }) {
  return <div className="px-4 py-3 text-[12px] text-faint">{children}</div>;
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="kicker mb-1 block">{label}</span>
      {children}
    </label>
  );
}

/**
 * 819 parties is too many for a select, so this is a filter plus a list.
 */
function PartyPicker({ parties, value, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    if (!parties) return [];
    const n = q.toUpperCase().trim();
    if (!n) return parties.slice(0, 10);
    return parties.filter((p) => p.display_name.toUpperCase().includes(n)).slice(0, 8);
  }, [parties, q]);
  const chosen = parties?.find((p) => p.party_id === value);

  return (
    <Field label="Party">
      {chosen ? (
        <div className="flex items-center gap-2">
          <span className="max-w-[220px] truncate rounded-[2px] border border-hair bg-white px-[8px] py-[4px] text-[12px]">
            {chosen.display_name}
          </span>
          <button type="button" onClick={() => { onChange(''); setQ(''); }} className="text-[11px] text-mute underline">change</button>
        </div>
      ) : (
        <div className="relative">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder={parties ? `Search ${parties.length} parties…` : 'Loading parties…'}
            className={`${INPUT} w-[220px]`}
          />
          {/* Opens on focus, not only once something is typed — otherwise the
              field looks broken to anyone who does not know to start typing. */}
          {open && matches.length > 0 ? (
            <div className="absolute z-20 mt-1 max-h-[220px] w-[280px] overflow-auto border border-hair bg-white shadow-lg">
              {matches.map((p) => (
                <button
                  key={p.party_id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onChange(p.party_id); setQ(''); setOpen(false); }}
                  className="block w-full px-[8px] py-[5px] text-left text-[12px] hover:bg-[#F2F6F8]"
                >
                  <span className="block truncate">{p.display_name}</span>
                  <span className="tnum block text-[10px] text-faint">{formatInr(p.current_outstanding)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {open && parties && matches.length === 0 ? (
            <div className="absolute z-20 mt-1 w-[280px] border border-hair bg-white px-[8px] py-[6px] text-[11.5px] text-faint shadow-lg">
              No party matches "{q}".
            </div>
          ) : null}
        </div>
      )}
    </Field>
  );
}
