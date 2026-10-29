import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { formatInr, formatCount, formatDate } from '../../lib/format.js';
import { Link } from 'react-router-dom';
import { invalidate, AFTER, PARTY_DERIVED } from '../../lib/cache.js';
import Overlay from '../../components/Overlay.jsx';
import { Stars } from '../../components/StarRating.jsx';

/**
 * The jobs that keep the party list honest, shown inside the Parties screen.
 *
 * An operator renames a party in Marg, the next import treats it as new, and
 * somebody has to notice and put it right. New parties and possible
 * duplicates are the two sides of that, so they live beside the list they
 * correct rather than on a screen of their own.
 */
/* ------------------------------------------------------------------ */

export function NewParties() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['new-parties'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_new_parties').select('*').limit(300);
      if (error) throw error;
      return data ?? [];
    },
  });

  if (error) return <Panel><Err error={error} /></Panel>;
  if (isLoading) return <Panel><p className="text-[12px] text-mute">Loading…</p></Panel>;

  return (
    <Panel
      title="Parties first seen in the last 30 days"
      sub="A party arrives here the first time it appears in an import. Some are genuinely new customers that need a credit term and an owner. Some are a party you already had, renamed in Marg — check the duplicates tab before setting one up, because merging keeps the history and a fresh setup does not."
    >
      {data.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-mute">
          No new parties in the last 30 days of imports.
        </p>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-hair text-[9.5px] uppercase tracking-[0.08em] text-faint">
              <th className="py-[6px] text-left">Party</th>
              <th className="py-[6px] text-left">First seen</th>
              <th className="py-[6px] text-right">Outstanding</th>
              <th className="py-[6px] text-right">Bills</th>
              <th className="py-[6px] text-left">Needs</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.party_id} className="border-b border-rule last:border-b-0">
                <td className="py-[6px] pr-2">
                  <span className="flex items-center gap-[6px]">
                    <Link to={`/parties/${r.party_id}`} className="text-ink no-underline hover:underline">{r.display_name}</Link>
                    <Stars value={r.star_rating} size={10} />
                  </span>
                </td>
                <td className="py-[6px] pr-2 text-mute">{formatDate(r.first_seen_on)}</td>
                <td className="tnum py-[6px] text-right">{formatInr(r.current_outstanding)}</td>
                <td className="tnum py-[6px] text-right text-mute">{formatCount(r.bill_count)}</td>
                <td className="py-[6px] pl-2 text-[11.5px]">
                  {[
                    r.needs_credit_term ? 'credit term' : null,
                    !r.phone ? 'phone number' : null,
                    !r.category ? 'category' : null,
                    !r.responsible_person ? 'an owner' : null,
                  ].filter(Boolean).join(', ') || <span className="text-teal-deep">set up</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The rename problem.
 *
 * An operator edits a party's name in Marg. The next export carries a name
 * this system has never seen, so it creates a second party with a second
 * ledger — and the original's payment history, calls and promises stay
 * stranded on a name nobody uses any more. Deleting the old one destroys
 * that history permanently; it was derived over weeks of imports and cannot
 * be re-created from any single file.
 *
 * Merging moves all of it onto the surviving party and keeps the old name as
 * an alias, so a later export under the old spelling is recognised rather
 * than starting the problem again.
 */
export function Duplicates() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(null);
  const [result, setResult] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['possible-duplicates'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('fn_possible_duplicates', { p_limit: 60 });
      if (error) throw error;
      return data ?? [];
    },
  });

  const merge = useMutation({
    mutationFn: async ({ source, target }) => {
      const { data, error } = await supabase.rpc('fn_merge_parties', {
        p_source: source,
        p_target: target,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      setResult(data);
      setConfirm(null);
      invalidate(qc, ['parties-ageing', 'possible-duplicates', 'new-parties', ...PARTY_DERIVED]);
    },
  });

  if (error) return <Panel><Err error={error} /></Panel>;
  if (isLoading) return <Panel><p className="text-[12px] text-mute">Looking for pairs…</p></Panel>;

  return (
    <>
      <Panel
        title="Pairs that may be the same party twice"
        sub="Matched on how alike the names are — CHETNA and CHETANA, KRH PHARMA and KRH PHARMA NSK. A shortlist for you to judge, never an automatic merge: two genuinely different parties can have similar names. Read both rows before merging anything."
      >
        {result ? (
          <div className="mb-3 border-l-[3px] border-l-age-0 bg-teal/[0.06] p-3 text-[12px]">
            <strong>{result.merged_from}</strong> was merged into <strong>{result.merged_into}</strong>.
            {' '}{formatCount(result.bills_moved)} bills, {formatCount(result.payment_events_moved)} payment
            events, {formatCount(result.followups_moved)} follow-ups and {formatCount(result.promises_moved)} promises
            moved across.
            {result.duplicate_bills_dropped > 0
              ? ` ${formatCount(result.duplicate_bills_dropped)} bills were held by both and were kept once.`
              : ''}
            {' '}The name "{result.alias_kept}" is kept as an alias, so a future export using it lands here.
          </div>
        ) : null}

        {data.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-mute">
            No pairs share an opening. Nothing here looks like the same party twice.
          </p>
        ) : (
          <div className="grid gap-2">
            {data.map((d, i) => (
              <div key={i} className="grid items-center gap-3 border border-hair bg-surface p-[10px]"
                   style={{ gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)' }}>
                <Side name={d.a_name} out={d.a_outstanding} bills={d.a_bills} seen={d.a_first_seen} />
                <div className="grid gap-[4px]">
                  <button type="button" className="btn btn-secondary px-[9px] py-[3px] text-[11px]"
                          onClick={() => setConfirm({ source: d.a_party_id, target: d.b_party_id, from: d.a_name, into: d.b_name })}>
                    Merge left → right
                  </button>
                  <button type="button" className="btn btn-secondary px-[9px] py-[3px] text-[11px]"
                          onClick={() => setConfirm({ source: d.b_party_id, target: d.a_party_id, from: d.b_name, into: d.a_name })}>
                    Merge right → left
                  </button>
                </div>
                <Side name={d.b_name} out={d.b_outstanding} bills={d.b_bills} seen={d.b_first_seen} align="right" />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {confirm ? (
        <Overlay onClose={() => setConfirm(null)} label="Confirm merge">
          <div className="overlay-center">
            <div className="panel w-[470px] max-w-[94vw] p-[18px]">
              <h2 className="text-[14.5px] font-semibold">Merge these two parties?</h2>
              <p className="mt-2 text-[12.5px] text-pretty">
                Everything belonging to <strong>{confirm.from}</strong> — its bills, derived payment
                history, calls, promises and claims — moves onto <strong>{confirm.into}</strong>.
                The name "{confirm.from}" is kept as an alias so a future import under it is
                recognised, and then that party record is removed.
              </p>
              <p className="mt-2 text-[11.5px] text-mute text-pretty">
                Nothing is discarded except a bill held by both parties in the same import, which is
                the same bill twice and is kept once. <strong>This cannot be undone</strong> — if the
                two are not the same party, close this.
              </p>
              {merge.error ? <p className="mt-2 text-[11.5px] text-age-4">{merge.error.message}</p> : null}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="btn btn-secondary" onClick={() => setConfirm(null)}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={merge.isPending}
                        onClick={() => merge.mutate(confirm)}>
                  {merge.isPending ? 'Merging…' : `Merge into ${confirm.into}`}
                </button>
              </div>
            </div>
          </div>
        </Overlay>
      ) : null}
    </>
  );
}

function Side({ name, out, bills, seen, align }) {
  return (
    <div className={`min-w-0 ${align === 'right' ? 'text-right' : ''}`}>
      <div className="truncate text-[12.5px] font-medium">{name}</div>
      <div className="tnum text-[11px] text-mute">
        {formatInr(out)} · {formatCount(bills)} bills in the latest import
      </div>
      <div className="text-[10.5px] text-faint">
        {seen ? `first seen ${formatDate(seen)}` : 'first seen date unknown'}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

function Panel({ title, sub, children }) {
  return (
    <section className="panel p-4">
      {title ? <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h2> : null}
      {sub ? <p className="mb-3 mt-1 max-w-[105ch] text-[12px] text-mute text-pretty">{sub}</p> : null}
      {children}
    </section>
  );
}

function Err({ error }) {
  return (
    <div className="border-l-[3px] border-l-age-4 p-2 text-[12.5px]">
      {error.message}
      <p className="mt-1 text-[11.5px] text-mute">
        If this names a missing table or function, the latest SQL has not been applied yet.
      </p>
    </div>
  );
}
