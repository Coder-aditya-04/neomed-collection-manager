import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase.js';
import { AFTER, invalidate } from '../lib/cache.js';
import { formatDate, formatInr } from '../lib/format.js';
import Overlay from './Overlay.jsx';

/*
 * The three things a person does to a follow-up thread, from any screen.
 *
 *   Log      — a contact: call, visit, WhatsApp, email. Starts or continues
 *              the thread. The database supersedes any earlier open row for
 *              the party, so there is always exactly one live thread.
 *   Remark   — "rang again, said Friday". A note on the live thread. It
 *              inherits the planned date unless a new one is given, so a
 *              party chased daily keeps one follow-up and a full record.
 *   Close    — the matter is dealt with. Asks why, always; the database
 *              refuses a close without a reason.
 *
 * All three are here, once, because the desk works from four different
 * screens and had to get the same behaviour from each of them.
 */

const METHODS = ['call', 'visit', 'whatsapp', 'email'];
const INPUT = 'rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]';

const CLOSE_REASONS = [
  'Paid in full',
  'Part payment received',
  'Promise taken',
  'Party disputes the bill',
  'Could not reach — number wrong',
  'Handed to legal',
];

/** The buttons, as a cluster. `thread` is the party's live follow-up, if any. */
export function FollowupButtons({ party, thread, onDone, compact, showContact = true }) {
  const [dialog, setDialog] = useState(null);
  const size = compact ? 'px-[8px] py-[2px] text-[10.5px]' : 'px-[10px] py-[3px] text-[11.5px]';

  return (
    <span className="inline-flex flex-wrap items-center gap-[5px]">
      {showContact ? <ContactLinks party={party} compact={compact} /> : null}
      <button type="button" className={`btn btn-primary ${size}`} onClick={() => setDialog('log')}>
        Log follow-up
      </button>
      {thread ? (
        <>
          <button type="button" className={`btn btn-secondary ${size}`} onClick={() => setDialog('remark')}>
            Remark
          </button>
          <button type="button" className={`btn btn-secondary ${size}`} onClick={() => setDialog('close')}>
            Close
          </button>
        </>
      ) : null}

      {dialog === 'log' ? (
        <LogDialog party={party} thread={thread} onCancel={() => setDialog(null)} onDone={() => { setDialog(null); onDone?.(); }} />
      ) : null}
      {dialog === 'remark' && thread ? (
        <RemarkDialog party={party} thread={thread} onCancel={() => setDialog(null)} onDone={() => { setDialog(null); onDone?.(); }} />
      ) : null}
      {dialog === 'close' && thread ? (
        <CloseFollowupDialog followup={{ ...thread, parties: { display_name: party.display_name } }}
                             onCancel={() => setDialog(null)} onDone={() => { setDialog(null); onDone?.(); }} />
      ) : null}
    </span>
  );
}

/** Call and WhatsApp, when there is a number to use. */
export function ContactLinks({ party, compact }) {
  const phone = party?.phone;
  const size = compact ? 'px-[7px] py-[2px] text-[10.5px]' : 'px-[9px] py-[3px] text-[11.5px]';
  if (!phone) return <span className="text-[10.5px] text-faint">no number</span>;
  const digits = String(phone).replace(/\D/g, '');
  const wa = digits.length === 10 ? `91${digits}` : digits.length >= 10 ? digits : null;
  const text = encodeURIComponent(
    `Dear ${party?.contact_person || party?.display_name || 'Sir/Madam'}, this is Neomed Pharma Agencies regarding an outstanding balance of ${formatInr(party?.current_outstanding)}. Could you let us know when we may expect payment? Thank you.`
  );
  return (
    <span className="inline-flex items-center gap-[5px]">
      <a href={`tel:${phone}`} className={`rounded-[2px] border border-hair bg-surface no-underline text-ink hover:bg-surface-3 ${size}`}>Call</a>
      {wa ? (
        <a href={`https://wa.me/${wa}?text=${text}`} target="_blank" rel="noreferrer"
           className={`rounded-[2px] border border-[#25D366] bg-[#25D366]/10 no-underline text-[#0B7A3E] hover:bg-[#25D366]/20 ${size}`}>
          WhatsApp
        </a>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */

function LogDialog({ party, thread, onCancel, onDone }) {
  const qc = useQueryClient();
  const [method, setMethod] = useState('call');
  const [outcome, setOutcome] = useState('');
  const [next, setNext] = useState(thread?.next_followup_date ?? '');

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('followups').insert({
        party_id: party.party_id,
        method,
        outcome: outcome.trim() || null,
        next_followup_date: next || null,
      });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc, AFTER.followup); onDone(); },
  });

  return (
    <Dialog title={`Log a follow-up — ${party.display_name}`} onClose={onCancel}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="kicker mb-1 block">How</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={INPUT}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="block min-w-[220px] flex-1">
          <span className="kicker mb-1 block">What they said</span>
          <input autoFocus value={outcome} onChange={(e) => setOutcome(e.target.value)}
                 placeholder="Promised Friday" className={`${INPUT} w-full`} />
        </label>
        <label className="block">
          <span className="kicker mb-1 block">Next follow-up</span>
          <input type="date" value={next} onChange={(e) => setNext(e.target.value)} className={INPUT} />
        </label>
      </div>
      {thread ? (
        <p className="mt-2 text-[11px] text-faint text-pretty">
          This continues the thread opened {formatDate(thread.contact_date)}
          {thread.outcome ? ` ("${thread.outcome}")` : ''}. The earlier entry stays in the log.
        </p>
      ) : null}
      {save.error ? <p className="mt-2 text-[11.5px] text-age-4">{save.error.message}</p> : null}
      <Buttons onCancel={onCancel} onOk={() => save.mutate()} busy={save.isPending} ok="Save" />
    </Dialog>
  );
}

/**
 * The remark. Different from a close in the one way that matters: the
 * thread stays open. Different from a log in that nothing was promised and
 * no new contact method applies — somebody is recording what was said.
 */
export function RemarkDialog({ party, thread, onCancel, onDone }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('followups').insert({
        party_id: party.party_id,
        method: 'remark',
        outcome: note.trim(),
        // Empty means "keep the planned date" — the database inherits it.
        next_followup_date: next || null,
      });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc, AFTER.followup); onDone(); },
  });

  return (
    <Dialog title={`Remark — ${party.display_name}`} onClose={onCancel}>
      <p className="text-[12px] text-mute text-pretty">
        The follow-up stays open{thread?.next_followup_date ? `, planned for ${formatDate(thread.next_followup_date)}` : ''}.
        What you write here goes into the party's log with today's date and your name.
      </p>
      <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                placeholder="Rang again — accountant on leave, said call Monday"
                className={`${INPUT} mt-2 w-full`} />
      <label className="mt-2 block">
        <span className="kicker mb-1 block">Move the next follow-up (optional)</span>
        <input type="date" value={next} onChange={(e) => setNext(e.target.value)} className={INPUT} />
      </label>
      {save.error ? <p className="mt-2 text-[11.5px] text-age-4">{save.error.message}</p> : null}
      <Buttons onCancel={onCancel} onOk={() => save.mutate()} busy={save.isPending}
               disabled={!note.trim()} ok="Add remark" />
    </Dialog>
  );
}

/**
 * Closing asks why and will not proceed without an answer. The database
 * enforces the same rule, so this is the form side of a constraint, not a
 * nicety — without it the button simply fails and nothing says why.
 */
export function CloseFollowupDialog({ followup, onCancel, onDone }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();

  const close = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('followups')
        .update({ closed: true, close_reason: trimmed })
        .eq('id', followup.id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc, AFTER.followup); onDone(); },
  });

  return (
    <Dialog title="Why is this being closed?" onClose={onCancel}>
      <p className="text-[12px] text-mute text-pretty">
        {followup.parties?.display_name ?? 'This party'} — whoever picks this party up next will
        read what you write here before they ring.
      </p>
      <div className="mt-3 flex flex-wrap gap-[6px]">
        {CLOSE_REASONS.map((r) => (
          <button key={r} type="button" onClick={() => setReason(r)}
                  className={[
                    'rounded-[2px] border px-[9px] py-[4px] text-[11.5px] transition-colors',
                    reason === r ? 'border-teal bg-teal font-medium text-onaccent' : 'border-hair bg-surface text-body hover:border-teal',
                  ].join(' ')}>
            {r}
          </button>
        ))}
      </div>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                placeholder="Or write what happened…" className={`${INPUT} mt-3 w-full`} />
      {close.error ? <p className="mt-2 text-[11.5px] text-age-4">{close.error.message}</p> : null}
      <Buttons onCancel={onCancel} onOk={() => close.mutate()} busy={close.isPending}
               disabled={!trimmed} ok="Close follow-up" />
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

function Dialog({ title, onClose, children }) {
  return (
    <Overlay onClose={onClose} label={title}>
      <div className="overlay-center">
        <div className="panel w-[500px] max-w-[94vw] p-[18px]">
          <h2 className="text-[14.5px] font-semibold tracking-[-0.01em]">{title}</h2>
          <div className="mt-2">{children}</div>
        </div>
      </div>
    </Overlay>
  );
}

function Buttons({ onCancel, onOk, busy, disabled, ok }) {
  return (
    <div className="mt-3 flex items-center justify-end gap-2">
      <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={disabled || busy} onClick={onOk}>
        {busy ? 'Saving…' : ok}
      </button>
    </div>
  );
}

/**
 * The live thread for a set of parties — one open follow-up per party, which
 * the database now guarantees. Returned as a map by party id.
 */
export async function fetchThreads(partyIds) {
  if (!partyIds?.length) return new Map();
  const { data, error } = await supabase
    .from('followups')
    .select('*, app_users(full_name)')
    .in('party_id', partyIds)
    .eq('closed', false)
    .order('contact_date', { ascending: false });
  if (error) throw error;
  const m = new Map();
  for (const f of data ?? []) if (!m.has(f.party_id)) m.set(f.party_id, f);
  return m;
}
