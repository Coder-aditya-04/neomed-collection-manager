import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { teamQuery, useMe, matchesUser } from '../../lib/useMe.js';
import { formatInr, formatCount, formatDate } from '../../lib/format.js';
import { invalidate } from '../../lib/cache.js';
import { BUCKET_KEYS, BUCKET_LABELS, BUCKET_COLORS } from '../../components/AgeingStrip.jsx';
import { Stars, STAR_MEANINGS } from '../../components/StarRating.jsx';
import UserFilter from '../../components/UserFilter.jsx';
import { FollowupButtons, fetchThreads } from '../../components/FollowupActions.jsx';
import { displayBillNo } from '../statements/StatementDocument.jsx';

/**
 * One ageing band, as a worklist.
 *
 * Clicking the red ₹1.10 Cr on Today lands here: the parties behind it, the
 * invoices behind each party, and the buttons to ring, remark and close —
 * without leaving the page. Filter by whose parties they are, by rating, by
 * status; the figure at the top re-sums to whatever is on screen.
 */
export default function WorkScreen() {
  const [params, setParams] = useSearchParams();
  const bucket = BUCKET_KEYS.includes(params.get('bucket')) ? params.get('bucket') : 'over_180';
  const bucketIndex = BUCKET_KEYS.indexOf(bucket);
  const qc = useQueryClient();
  const { userId } = useMe();
  const { data: team } = useQuery(teamQuery());

  const [search, setSearch] = useState('');
  const [who, setWho] = useState('');
  const [rating, setRating] = useState('');
  const [status, setStatus] = useState('');

  const billsQ = useQuery({
    queryKey: ['work-bucket', bucket],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('fn_bucket_bills', { p_bucket: bucket, p_limit: 6000 });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Group bill rows into parties, keeping the band's share separate from the
  // party's whole balance — the call is about the band, the context is the whole.
  const parties = useMemo(() => {
    const m = new Map();
    for (const r of billsQ.data ?? []) {
      if (!m.has(r.party_id)) {
        m.set(r.party_id, {
          party_id: r.party_id, display_name: r.display_name, phone: r.phone,
          contact_person: r.contact_person, responsible_person: r.responsible_person,
          star_rating: r.star_rating, status: r.status, current_outstanding: r.current_outstanding,
          in_band: 0, bills: [],
        });
      }
      const p = m.get(r.party_id);
      p.in_band += Number(r.balance);
      p.bills.push(r);
    }
    return [...m.values()].sort((a, b) => b.in_band - a.in_band);
  }, [billsQ.data]);

  const ids = useMemo(() => parties.map((p) => p.party_id), [parties]);
  const threadsQ = useQuery({
    queryKey: ['threads', 'bucket', bucket, ids.length],
    enabled: ids.length > 0,
    queryFn: () => fetchThreads(ids),
  });

  const shown = useMemo(() => {
    const q = search.toUpperCase().trim();
    return parties.filter((p) =>
      (!q || p.display_name.toUpperCase().includes(q)) &&
      matchesUser(who, p.responsible_person, userId) &&
      (!rating || (rating === 'unrated' ? !p.star_rating : Number(p.star_rating) === Number(rating))) &&
      (!status || p.status === status)
    );
  }, [parties, search, who, rating, status, userId]);

  const total = shown.reduce((a, p) => a + p.in_band, 0);
  const billCount = shown.reduce((a, p) => a + p.bills.length, 0);
  const names = new Map((team ?? []).map((u) => [u.id, u.full_name]));
  const refresh = () => invalidate(qc, ['threads', 'followups', 'party-activity', 'recovery-activity']);

  return (
    <div className="animate-screen-in px-[18px] pb-[40px] pt-4">
      {/* band picker */}
      <div className="mb-3 flex flex-wrap gap-[6px]">
        {BUCKET_KEYS.map((k, i) => (
          <button key={k} type="button" onClick={() => setParams({ bucket: k })}
                  className={[
                    'flex items-center gap-[6px] rounded-[2px] border px-[10px] py-[4px] text-[11.5px] transition-colors',
                    k === bucket ? 'border-teal bg-teal font-semibold text-onaccent' : 'border-hair bg-surface text-body hover:border-teal',
                  ].join(' ')}>
            <span className="h-[8px] w-[8px] rounded-[2px]" style={{ background: BUCKET_COLORS[i] }} />
            {BUCKET_LABELS[i]}
          </button>
        ))}
      </div>

      <section className="panel panel-lift mb-3 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
            <span className="tnum" style={{ color: BUCKET_COLORS[bucketIndex] }}>{formatInr(total)}</span>{' '}
            {BUCKET_LABELS[bucketIndex].toLowerCase()} · {formatCount(shown.length)} parties · {formatCount(billCount)} invoices
          </h2>
          <span className="text-[11.5px] text-mute">
            Measured against each party's own credit term. Parties with no term are not here — they cannot be called late.
          </span>
        </div>
      </section>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search parties…"
               className="w-[220px] rounded-[2px] border border-hair bg-surface px-[10px] py-[5px] text-[12.5px]" />
        <UserFilter value={who} onChange={setWho} label="Assigned to" />
        <label className="block">
          <span className="kicker mb-1 block">Rating</span>
          <select value={rating} onChange={(e) => setRating(e.target.value)} className="rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]">
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{'★'.repeat(n)} {STAR_MEANINGS[n].short}</option>)}
            <option value="unrated">Not rated</option>
          </select>
        </label>
        <label className="block">
          <span className="kicker mb-1 block">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]">
            <option value="">Any</option>
            {['active', 'in_process', 'legal_notice_sent', 'legal_case_filed', 'dispute'].map((s) => (
              <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>
            ))}
          </select>
        </label>
      </div>

      {billsQ.isLoading ? <p className="text-[12px] text-mute">Loading…</p> : null}
      {billsQ.error ? (
        <div className="panel border-l-[3px] border-l-age-4 p-3 text-[12.5px]">
          {billsQ.error.message}
          <p className="mt-1 text-[11.5px] text-mute">If this names a missing function, the latest SQL has not been applied yet.</p>
        </div>
      ) : null}

      {!billsQ.isLoading && shown.length === 0 ? (
        <p className="panel p-4 text-center text-[12px] text-mute">Nothing in this band matches the filters.</p>
      ) : null}

      <div className="grid gap-3">
        {shown.slice(0, 150).map((p) => {
          const thread = threadsQ.data?.get(p.party_id) ?? null;
          const late = thread?.next_followup_date && thread.next_followup_date < new Date().toISOString().slice(0, 10);
          return (
            <section key={p.party_id} className="panel p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-[8px]">
                    <Link to={`/parties/${p.party_id}`} className="text-[14px] font-semibold text-ink no-underline hover:underline">
                      {p.display_name}
                    </Link>
                    <Stars value={p.star_rating} size={11} />
                    {p.status && p.status !== 'active' ? (
                      <span className="rounded-[2px] border border-[#C9A93E] bg-[#C9A93E]/10 px-[6px] py-[1px] text-[10.5px] text-[#7A6410]">{p.status.replaceAll('_', ' ')}</span>
                    ) : null}
                    <span className="text-[11px] text-faint">
                      {p.responsible_person ? names.get(p.responsible_person) ?? 'assigned' : 'nobody assigned'}
                    </span>
                  </div>
                  <div className="mt-[3px] text-[12px] text-mute">
                    <span className="tnum font-medium text-ink">{formatInr(p.in_band)}</span> in this band ·{' '}
                    <span className="tnum">{formatInr(p.current_outstanding)}</span> outstanding in all · {formatCount(p.bills.length)} invoices here
                  </div>
                  {thread ? (
                    <div className={`mt-[5px] text-[11.5px] ${late ? 'text-age-3' : 'text-body'}`}>
                      <span className="font-medium">Live follow-up:</span>{' '}
                      {thread.outcome || thread.method}
                      {thread.app_users?.full_name ? ` — ${thread.app_users.full_name}` : ''}
                      {thread.next_followup_date ? ` · ${late ? 'was due' : 'next'} ${formatDate(thread.next_followup_date)}` : ''}
                    </div>
                  ) : (
                    <div className="mt-[5px] text-[11.5px] text-faint">No live follow-up.</div>
                  )}
                </div>
                <FollowupButtons party={p} thread={thread} onDone={refresh} />
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-[11.5px] text-mute hover:text-ink">
                  Show the {formatCount(p.bills.length)} invoices
                </summary>
                <table className="mt-2 w-full border-collapse text-[11.5px]">
                  <thead>
                    <tr className="text-[9.5px] uppercase tracking-[0.08em] text-faint">
                      <th className="py-[4px] text-left">Bill</th><th className="py-[4px] text-left">Date</th>
                      <th className="py-[4px] text-right">Days past term</th><th className="py-[4px] text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.bills.map((b, i) => (
                      <tr key={i} className="border-t border-rule">
                        <td className="py-[4px] font-mono">{displayBillNo(b.bill_no)}</td>
                        <td className="py-[4px] text-mute">{formatDate(b.bill_date)}</td>
                        <td className="tnum py-[4px] text-right">{b.overdue_days}</td>
                        <td className="tnum py-[4px] text-right font-medium">{formatInr(b.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
          );
        })}
      </div>
      {shown.length > 150 ? (
        <p className="mt-3 text-center text-[11.5px] text-faint">Showing the first 150 of {formatCount(shown.length)} — narrow it with the filters.</p>
      ) : null}
    </div>
  );
}
