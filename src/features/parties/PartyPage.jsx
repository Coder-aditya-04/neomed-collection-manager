import { useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { latestSnapshotQuery, partiesAgeingQuery, partyActivityQuery } from '../../lib/queries.js';
import Overlay from '../../components/Overlay.jsx';
import { teamQuery } from '../../lib/useMe.js';
import { formatInr, formatCount, formatAge, formatDate } from '../../lib/format.js';
import { AFTER, PARTY_DERIVED, invalidate, patchParties } from '../../lib/cache.js';
import AgeingStrip, { bucketsOf, TermBadge, BUCKET_LABELS } from '../../components/AgeingStrip.jsx';
import { Stars } from '../../components/StarRating.jsx';
import { TermEditor, draftFromParty, termFromDraft, CLEARED_TERM } from '../../components/TermEditor.jsx';
import { FollowupButtons, fetchThreads } from '../../components/FollowupActions.jsx';
import { Assignment, Contact, Standing, Behaviour, StopRule } from './PartyDrawer.jsx';
import { displayBillNo } from '../statements/StatementDocument.jsx';

/**
 * One party, on one page.
 *
 * The desk asked for this instead of the drawer, and for a reason beyond
 * screen space: they were entering details in two places. The credit term
 * lived only in the credit master; the category, status, rating and contact
 * lived only in the drawer. So everything a person records about a party is
 * here, and the credit master keeps its one real advantage — setting a term
 * on fifty hospitals at once.
 *
 * The timeline at the bottom is the answer to "who did what": every contact,
 * every remark, every close with its reason, every change to the record, and
 * every payment the exports revealed, on one spine with names against them.
 */
export default function PartyPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const partyQ = useQuery({
    queryKey: ['party-board-one', id],
    queryFn: async () => {
      // Same fallback as the list: new code can be live before the SQL is run.
      let r = await supabase.from('v_party_board').select('*').eq('party_id', id).maybeSingle();
      if (r.error && /v_party_board/.test(r.error.message)) {
        r = await supabase.from('v_party_ageing').select('*').eq('party_id', id).maybeSingle();
      }
      if (r.error) throw r.error;
      return r.data;
    },
  });
  const party = partyQ.data;

  const { data: snapshot } = useQuery(latestSnapshotQuery());
  const { data: team } = useQuery(teamQuery());
  const { data: activity } = useQuery(partyActivityQuery(id));

  const billsQ = useQuery({
    queryKey: ['party-bills-full', id, snapshot?.id],
    enabled: Boolean(snapshot?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bills')
        .select('*')
        .eq('party_id', id)
        .eq('snapshot_id', snapshot.id)
        .neq('balance', 0)
        .order('bill_date', { ascending: true })
        .limit(2000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const auditQ = useQuery({
    queryKey: ['audit', 'party', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_log')
        .select('*')
        .eq('entity', 'party')
        .eq('entity_id', id)
        .order('at', { ascending: false })
        .limit(100);
      if (error) {
        // Before migration 0012 there is no audit log; the page still works.
        if (/audit_log/.test(error.message)) return [];
        throw error;
      }
      return data ?? [];
    },
  });

  const threadQ = useQuery({
    queryKey: ['threads', 'party', id],
    queryFn: async () => (await fetchThreads([id])).get(id) ?? null,
  });

  const [merging, setMerging] = useState(false);

  function refresh() {
    invalidate(qc, ['party-board-one', 'party-activity', 'threads', 'audit', 'parties-ageing', ...PARTY_DERIVED]);
  }

  if (partyQ.isLoading) return <Msg>Loading…</Msg>;
  if (partyQ.error) return <Msg tone="error">{partyQ.error.message}</Msg>;
  if (!party) {
    return (
      <Msg>
        No party with that id. It may have been merged into another —{' '}
        <Link to="/parties">back to the list</Link>.
      </Msg>
    );
  }

  const buckets = bucketsOf(party);
  const names = new Map((team ?? []).map((u) => [u.id, u.full_name]));
  const thread = threadQ.data;

  return (
    <div className="animate-screen-in px-[18px] pb-[40px] pt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
        <button type="button" onClick={() => navigate(-1)} className="text-mute hover:underline">← Back</button>
        <span className="text-faint">·</span>
        <Link to="/parties" className="text-mute hover:underline">All parties</Link>
      </div>

      <header className="panel panel-lift mb-3 px-[18px] py-[14px]">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-[9px] text-[20px] font-semibold tracking-[-0.02em]">
              <span>{party.display_name}</span>
              <Stars value={party.star_rating} size={15} showLabel />
            </h1>
            <div className="mt-[6px] flex flex-wrap items-center gap-2">
              <TermBadge row={party} />
              {party.category ? <Badge>{party.category}</Badge> : null}
              {party.status && party.status !== 'active' ? <Badge tone="warn">{party.status.replaceAll('_', ' ')}</Badge> : null}
              {party.is_credit_balance ? <Badge tone="claim">Credit balance</Badge> : null}
              {party.statement_mode === 'physical' ? <Badge tone="warn">Physical statement</Badge> : null}
              {party.statement_mode === 'do_not_send' ? <Badge tone="bad">Do not send statements</Badge> : null}
              {snapshot && Number(party.bill_count) === 0 ? (
                <Badge tone="faint" title="Marg lists only parties with something outstanding, so a party that is not in the file has paid off. Its history is kept.">
                  Not in the latest Marg file
                </Badge>
              ) : null}
              {party.responsible_name ? <Badge>Owner: {party.responsible_name}</Badge> : <Badge tone="faint">Nobody assigned</Badge>}
              {party.aliases?.length ? (
                <span className="text-[11px] text-faint" title={party.aliases.join(', ')}>
                  also known as {party.aliases.slice(0, 2).join(', ')}{party.aliases.length > 2 ? '…' : ''}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FollowupButtons party={party} thread={thread} onDone={refresh} />
            <button type="button" className="btn btn-secondary"
                    onClick={() => navigate('/assistant', { state: { question: `What is the payment history of ${party.display_name}?` } })}>
              Ask the assistant
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setMerging(true)}>
              Merge…
            </button>
          </div>
        </div>
        {merging ? <MergeDialog party={party} onClose={() => setMerging(false)} /> : null}

        <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-px bg-hair">
          <Fig label="Outstanding" value={formatInr(party.current_outstanding)} />
          <Fig label="Oldest bill" value={formatAge(party.oldest_bill_age_days)} />
          <Fig label="Open bills" value={formatCount(party.bill_count)} />
          <Fig label="Past term" value={party.needs_credit_term ? '—' : party.max_overdue_days > 0 ? `${formatCount(party.max_overdue_days)}d` : 'in terms'}
               tone={party.max_overdue_days > 60 ? 'var(--color-age-4)' : undefined} />
          <Fig label="Live follow-up" value={thread ? (thread.next_followup_date ? formatDate(thread.next_followup_date) : 'open') : 'none'}
               tone={thread?.next_followup_date && thread.next_followup_date < today() ? 'var(--color-age-3)' : undefined} />
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* ---- what a person records ---- */}
        <div className="grid content-start gap-3">
          <Panel title="Credit term">
            <CreditTerm party={party} onSaved={refresh} />
          </Panel>
          <Panel title="Category, status and rating">
            <Standing party={party} onSaved={refresh} />
          </Panel>
          <Panel title="Contact">
            <Contact party={party} onSaved={refresh} />
          </Panel>
          <Panel title="Assigned to">
            <Assignment party={party} onSaved={refresh} />
          </Panel>
          <Panel title="Statements">
            <StatementMode party={party} onSaved={refresh} />
          </Panel>
          <Panel title="How this party pays">
            <Behaviour party={party} />
          </Panel>
        </div>

        {/* ---- what the ledger shows ---- */}
        <div className="grid content-start gap-3">
          <Panel title="Ageing">
            {buckets ? (
              <>
                <AgeingStrip buckets={buckets} height={22} />
                <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
                  {buckets.map((v, i) => (
                    <div key={i} className="flex items-baseline justify-between text-[12px]">
                      <span className="text-mute">{BUCKET_LABELS[i]}</span>
                      <span className="tnum font-medium">{formatInr(v)}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-faint text-pretty">
                  Measured against the expected due date from this party's credit term, and scaled so
                  the buckets sum to the Marg header total.
                </p>
              </>
            ) : <StopRule party={party} />}
          </Panel>

          <Panel title={`Open bills · as on ${formatDate(snapshot?.report_date)}`}
                 right={<span className="tnum text-[11.5px] text-mute">{formatCount(billsQ.data?.length ?? 0)} bills</span>}>
            {billsQ.isLoading ? <p className="text-[12px] text-mute">Loading bills…</p> : (
              <div className="max-h-[560px] overflow-auto border border-hair bg-surface">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>
                      <Th>Bill</Th><Th>Date</Th><Th align="right">Age</Th>
                      <Th align="right">Bill amt</Th><Th align="right">Received</Th><Th align="right">Balance</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(billsQ.data ?? []).map((b) => (
                      <tr key={b.id} className={`border-b border-rule last:border-b-0 ${Number(b.balance) < 0 ? 'text-claim' : ''}`}>
                        <td className="px-[10px] py-[6px] font-mono">{displayBillNo(b.bill_no)}</td>
                        <td className="px-[10px] py-[6px] text-mute">{formatDate(b.bill_date)}</td>
                        <td className="tnum px-[10px] py-[6px] text-right">{formatAge(b.bill_age_days)}</td>
                        <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatInr(b.bill_amount)}</td>
                        <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatInr(b.received)}</td>
                        <td className="tnum px-[10px] py-[6px] text-right font-medium">{formatInr(b.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Timeline — who did what" right={<Link to="/followups" className="text-[11.5px]">All follow-ups →</Link>}>
            <Timeline activity={activity} audit={auditQ.data} names={names} party={party} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The credit term, editable here as well as in the credit master. Saving from
 * either place records the term as approved, because a person typed it.
 */
function CreditTerm({ party, onSaved }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(() => draftFromParty(party));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const term = termFromDraft(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromParty(party));

  async function save(patch) {
    setBusy(true); setError(null);
    const { error: e } = await supabase.from('parties').update(patch).eq('id', party.party_id);
    setBusy(false);
    if (e) { setError(e.message); return; }
    patchParties(qc, [party.party_id], patch);
    invalidate(qc, AFTER.creditTerm);
    onSaved?.();
  }

  return (
    <div className="border border-hair bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <TermEditor draft={draft} onChange={setDraft} compact />
        <button type="button" className="btn btn-primary px-3 py-[4px] text-[12px]"
                disabled={!dirty || !term || busy}
                onClick={() => save({ ...term, credit_source: 'approved' })}>
          {busy ? 'Saving…' : 'Save as approved'}
        </button>
        {party.credit_source !== 'not_set' ? (
          <button type="button" className="text-[11px] text-mute underline underline-offset-2 hover:text-age-3"
                  disabled={busy} onClick={() => { setDraft(draftFromParty({ credit_type: 'none' })); save(CLEARED_TERM); }}>
            clear
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] text-faint text-pretty">
        {party.credit_source === 'not_set'
          ? 'No term is recorded, so nothing here can be called late — only old. Set the term and the ageing above fills in.'
          : party.credit_source === 'category_default'
            ? 'This term is a category default, an assumption. Saving it here makes it approved.'
            : 'Approved. The same term can be set on many parties at once from the credit master.'}
      </p>
      {error ? <p className="mt-2 text-[11.5px] text-age-4">{error}</p> : null}
    </div>
  );
}

/**
 * How this party gets its statement. Some insist on paper; some must not be
 * sent anything on WhatsApp at all. Recorded on the party, read by the
 * statements screen.
 */
function StatementMode({ party, onSaved }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const value = party.statement_mode ?? 'whatsapp';

  async function set(mode) {
    setBusy(true);
    const { error } = await supabase.from('parties').update({ statement_mode: mode }).eq('id', party.party_id);
    setBusy(false);
    if (!error) { patchParties(qc, [party.party_id], { statement_mode: mode }); onSaved?.(); }
  }

  const OPTIONS = [
    ['whatsapp', 'WhatsApp', 'Sent from the statements screen like everyone else.'],
    ['physical', 'Physical statement compulsory', 'They want paper. Print it; the screen marks them.'],
    ['do_not_send', 'Do not send', 'Nothing goes out to this party, on any channel.'],
  ];

  return (
    <div className="border border-hair bg-surface p-3">
      <div className="grid gap-[5px]">
        {OPTIONS.map(([v, label, hint]) => (
          <label key={v} className={`flex cursor-pointer items-start gap-[8px] rounded-[3px] border px-[9px] py-[6px] text-[12px] ${value === v ? 'border-teal bg-teal/[0.08]' : 'border-hair'}`}>
            <input type="radio" name="statement_mode" checked={value === v} disabled={busy} onChange={() => set(v)} className="mt-[3px]" />
            <span>
              <span className="block font-medium">{label}</span>
              <span className="block text-[11px] text-mute">{hint}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const AUDIT_LABELS = {
  display_name: 'name', category: 'category', status: 'collection status', status_note: 'status note',
  star_rating: 'rating', credit_type: 'credit model', credit_days: 'credit days',
  cycle_submit_day: 'submit-by day', cycle_pay_day: 'pay day', cycle_lag_months: 'cycle lag',
  credit_source: 'term state', responsible_person: 'owner', phone: 'mobile',
  contact_person: 'contact person', statement_mode: 'statement delivery',
};

/**
 * Every kind of event on one spine, newest first.
 *
 * Follow-ups show who logged them and, where one was closed, why — including
 * the automatic "superseded" closes, shown quietly, because they are how a
 * thread continues rather than something somebody decided. Record changes
 * come from the audit log; payments from the import comparison.
 */
function Timeline({ activity, audit, names, party }) {
  const events = useMemo(() => {
    if (!activity) return null;
    const who = (id) => (id ? names.get(id) ?? 'someone' : null);
    const out = [];

    for (const f of activity.followups) {
      const superseded = /^Superseded by/.test(f.close_reason ?? '');
      out.push({
        at: f.created_at ?? f.contact_date,
        date: f.contact_date,
        tone: f.method === 'remark' ? 'plain' : f.closed && !superseded ? 'done' : 'contact',
        title: f.method === 'remark' ? 'Remark' : `${cap(f.method)}${f.outcome ? '' : ' logged'}`,
        by: who(f.by_user),
        detail: [
          f.outcome,
          f.next_followup_date && !f.closed ? `next ${formatDate(f.next_followup_date)}` : null,
          f.closed && !superseded ? `closed: ${f.close_reason}` : null,
        ].filter(Boolean).join(' · '),
        faint: superseded ? 'continued by a later entry' : null,
      });
    }
    for (const a of audit ?? []) {
      const d = a.detail ?? {};
      if (a.action === 'merged') {
        out.push({ at: a.at, date: a.at, tone: 'plain', title: 'Merged', by: who(a.by_user),
          detail: `${d.merged_from} was merged into this party — ${d.bills_moved} bills and ${d.followups_moved} follow-ups moved across.` });
        continue;
      }
      const parts = Object.entries(d).map(([k, v]) => {
        const label = AUDIT_LABELS[k] ?? k;
        const to = k === 'responsible_person' ? who(v.to) ?? 'nobody' : v.to ?? '—';
        const from = k === 'responsible_person' ? who(v.from) ?? 'nobody' : v.from ?? '—';
        return `${label}: ${from} → ${to}`;
      });
      if (parts.length) out.push({ at: a.at, date: a.at, tone: 'edit', title: 'Record changed', by: who(a.by_user), detail: parts.join(' · ') });
    }
    for (const p of activity.promises) {
      out.push({ at: p.created_at ?? p.promised_on, date: p.promised_on,
        tone: p.status === 'broken' ? 'bad' : p.status === 'kept' ? 'good' : 'warn',
        title: 'Promise recorded',
        detail: `${formatInr(p.promised_amount)} by ${formatDate(p.due_date)} — ${p.status}` });
    }
    for (const c of activity.claims) {
      out.push({ at: c.created_at ?? c.raised_on, date: c.raised_on, tone: c.status === 'open' ? 'claim' : 'done',
        title: `Claim · ${c.claim_type.replace('_', ' ')}`,
        detail: `${formatInr(c.payment_held)} held${c.pending_with ? ` · with ${c.pending_with}` : ''} — ${c.status}` });
    }
    for (const b of activity.changes) {
      out.push({ at: b.detected_to, date: b.detected_to, tone: 'good',
        title: b.change_type === 'settled' ? 'Bill cleared' : 'Part payment',
        detail: `${formatInr(b.delta)} against ${displayBillNo(b.bill_no)} — seen in the ${formatDate(b.detected_to)} import` });
    }
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }, [activity, audit, names]);

  if (!events) return <p className="text-[12px] text-mute">Loading…</p>;
  if (events.length === 0) {
    return (
      <div className="border border-hair bg-surface p-3 text-[12px] text-mute text-pretty">
        Nothing recorded for {party.display_name} yet. Follow-ups, remarks, record changes and
        payments appear here as they happen.
      </div>
    );
  }

  const dot = {
    good: 'var(--color-age-0)', warn: 'var(--color-age-1)', bad: 'var(--color-age-4)',
    claim: 'var(--color-claim)', done: '#B4C0C9', plain: '#8A98A4', contact: 'var(--color-teal)', edit: '#C9A93E',
  };

  return (
    <div className="max-h-[640px] overflow-auto border border-hair bg-surface">
      {events.slice(0, 120).map((e, i) => (
        <div key={i} className="grid gap-[10px] border-b border-rule px-3 py-[8px] last:border-b-0"
             style={{ gridTemplateColumns: '64px 10px minmax(0,1fr)' }}>
          <span className="tnum pt-[2px] text-[11px] text-mute">{formatDate(e.date).split(' ').slice(0, 2).join(' ')}</span>
          <span className="mt-[6px] h-[7px] w-[7px] flex-none rounded-full" style={{ background: dot[e.tone] }} />
          <span className="min-w-0">
            <span className="block text-[12.5px]">
              <span className="font-semibold">{e.title}</span>
              {e.by ? <span className="text-mute"> — {e.by}</span> : null}
            </span>
            {e.detail ? <span className="mt-[1px] block text-[11.5px] text-body text-pretty">{e.detail}</span> : null}
            {e.faint ? <span className="mt-[1px] block text-[10.5px] text-faint">{e.faint}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Merge this party with any other.
 *
 * The duplicates shortlist only offers pairs whose names look alike. The
 * desk also meets the other case: two names that are plainly different in
 * Marg and plainly the same account in life — a hospital and its institute,
 * a shop and its proprietor. Those are merged from here. Either name can be
 * the one that survives; everything the other carries moves across and its
 * name is kept as an alias.
 */
function MergeDialog({ party, onClose }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: parties } = useQuery(partiesAgeingQuery());
  const [q, setQ] = useState('');
  const [other, setOther] = useState(null);

  const matches = useMemo(() => {
    const n = q.toUpperCase().trim();
    if (!parties || n.length < 2) return [];
    return parties
      .filter((p) => p.party_id !== party.party_id && p.display_name.toUpperCase().includes(n))
      .slice(0, 8);
  }, [parties, q, party.party_id]);

  const merge = useMutation({
    mutationFn: async ({ source, target }) => {
      const { data, error } = await supabase.rpc('fn_merge_parties', { p_source: source, p_target: target });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, { target }) => {
      invalidate(qc, ['parties-ageing', 'party-board-one', 'possible-duplicates', 'new-parties',
                      'party-activity', 'audit', 'threads', 'party-bills-full', 'work-bucket', ...PARTY_DERIVED]);
      onClose();
      navigate(`/parties/${target}`, { replace: true });
    },
  });

  const INPUT = 'rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]';

  return (
    <Overlay onClose={onClose} label="Merge parties">
      <div className="overlay-center">
        <div className="panel w-[560px] max-w-[94vw] p-[18px]">
          <h2 className="text-[14.5px] font-semibold tracking-[-0.01em]">Merge {party.display_name} with another party</h2>
          <p className="mt-1 text-[12px] text-mute text-pretty">
            For two names Marg treats as different that are one account in life. Everything the
            removed party carries — bills, payment history, calls, promises, claims, rating — moves
            onto the one that stays, and its name is kept as an alias so the next import still lands
            here.
          </p>

          {!other ? (
            <div className="relative mt-3">
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder={parties ? `Search ${formatCount(parties.length)} parties…` : 'Loading parties…'}
                     className={`${INPUT} w-full`} />
              {matches.length > 0 ? (
                <div className="absolute z-20 mt-1 max-h-[240px] w-full overflow-auto border border-hair bg-surface shadow-lg">
                  {matches.map((p) => (
                    <button key={p.party_id} type="button" onClick={() => setOther(p)}
                            className="block w-full px-[8px] py-[5px] text-left text-[12px] hover:bg-surface-3">
                      <span className="block truncate">{p.display_name}</span>
                      <span className="tnum block text-[10px] text-faint">
                        {formatInr(p.current_outstanding)} · {formatCount(p.bill_count)} bills
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {q.trim().length >= 2 && parties && matches.length === 0 ? (
                <p className="mt-2 text-[11.5px] text-faint">No other party matches "{q}".</p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="mt-3 grid gap-px bg-hair sm:grid-cols-2">
                <MergeSide label="This party" p={party} />
                <MergeSide label="The other party" p={other} onChange={() => setOther(null)} />
              </div>
              <p className="mt-3 text-[12px] text-pretty">Which name should survive?</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <button type="button" className="btn btn-primary text-left" disabled={merge.isPending}
                        onClick={() => merge.mutate({ source: party.party_id, target: other.party_id })}>
                  Keep <strong>{other.display_name}</strong>; fold this one into it
                </button>
                <button type="button" className="btn btn-primary text-left" disabled={merge.isPending}
                        onClick={() => merge.mutate({ source: other.party_id, target: party.party_id })}>
                  Keep <strong>{party.display_name}</strong>; fold the other into it
                </button>
              </div>
              <p className="mt-2 text-[11px] text-mute text-pretty">
                Nothing is discarded except a bill held by both in the same import, which is the same
                bill twice and is kept once. <strong>This cannot be undone.</strong>
              </p>
            </>
          )}

          {merge.error ? <p className="mt-2 text-[11.5px] text-age-4">{merge.error.message}</p> : null}
          <div className="mt-3 flex justify-end">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={merge.isPending}>
              {merge.isPending ? 'Merging…' : 'Cancel'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function MergeSide({ label, p, onChange }) {
  return (
    <div className="bg-surface p-[10px]">
      <div className="kicker">{label}</div>
      <div className="mt-[2px] truncate text-[12.5px] font-medium">{p.display_name}</div>
      <div className="tnum text-[11px] text-mute">
        {formatInr(p.current_outstanding)} · {formatCount(p.bill_count)} bills in the latest import
        {p.first_seen_on ? ` · first seen ${formatDate(p.first_seen_on)}` : ''}
      </div>
      {onChange ? <button type="button" onClick={onChange} className="mt-1 text-[11px] text-mute underline">change</button> : null}
    </div>
  );
}

function Panel({ title, right, children }) {
  return (
    <section className="panel p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[13.5px] font-semibold tracking-[-0.01em]">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Fig({ label, value, tone }) {
  return (
    <div className="bg-surface/80 px-3 py-2">
      <div className="kicker">{label}</div>
      <div className="tnum mt-[2px] text-[17px] font-medium tracking-[-0.02em]" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

function Badge({ children, tone, title }) {
  const cls = {
    warn: 'border-[#C9A93E] bg-[#C9A93E]/10 text-[#7A6410]',
    bad: 'border-age-4/50 bg-age-4/10 text-age-4',
    claim: 'border-claim/40 bg-claim/10 text-claim',
    faint: 'border-hair bg-surface text-faint',
  }[tone] ?? 'border-hair bg-surface text-mute';
  return <span title={title} className={`rounded-[2px] border px-[7px] py-[2px] text-[10.5px] ${cls}`}>{children}</span>;
}

function Th({ children, align = 'left' }) {
  return (
    <th className="sticky top-0 border-b border-hair bg-surface px-[10px] py-[6px] text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mute"
        style={{ textAlign: align }}>{children}</th>
  );
}

function Msg({ children, tone }) {
  return (
    <div className="animate-screen-in px-[18px] pt-4">
      <div className={`panel p-[14px] text-[12.5px] ${tone === 'error' ? 'border-l-[3px] border-l-age-4' : 'text-mute'}`}>{children}</div>
    </div>
  );
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function today() { return new Date().toISOString().slice(0, 10); }
