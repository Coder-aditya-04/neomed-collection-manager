import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { partiesAgeingQuery } from '../../lib/queries.js';
import { formatInr, formatCount, formatAge, formatPct } from '../../lib/format.js';
import { TermBadge } from '../../components/AgeingStrip.jsx';
import { TermEditor, draftFromParty, termFromDraft, CLEARED_TERM } from '../../components/TermEditor.jsx';
import { Link } from 'react-router-dom';
import { AFTER, PARTY_DERIVED, invalidate, patchParties } from '../../lib/cache.js';

/**
 * The credit master.
 *
 * This is a data-entry problem, not a browsing problem: the client already
 * knows these terms, so everything here is arranged to get them typed in
 * fast. Sorted by outstanding descending, because the first hundred rows
 * carry most of the money and that makes the work finite.
 *
 * Two models, because retailers and hospitals are paid differently:
 *   days  — a plain number of days from the bill date
 *   cycle — submit by the Nth, paid on the Nth, same month or later
 */
export default function CreditMasterScreen() {
  const { data: parties, isLoading } = useQuery(partiesAgeingQuery());
  const queryClient = useQueryClient();
  const [toast, setToast] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState({ credit_type: 'cycle', credit_days: 60, cycle_submit_day: 5, cycle_pay_day: 25, cycle_lag_months: 1 });
  const [query, setQuery] = useState('');
  const [onlyUnset, setOnlyUnset] = useState(false);
  // Rendering 700-odd rows of live inputs at once makes typing sluggish, so
  // the list grows on demand rather than being capped at an arbitrary number.
  const [limit, setLimit] = useState(150);
  const toastTimer = useRef(null);

  const owing = useMemo(() => {
    if (!parties) return [];
    return parties
      .filter((p) => Number(p.current_outstanding) > 0)
      .sort((a, b) => Number(b.current_outstanding) - Number(a.current_outstanding));
  }, [parties]);

  const rows = useMemo(() => {
    let out = owing;
    if (onlyUnset) out = out.filter((p) => p.credit_source === 'not_set');
    const q = query.toUpperCase().trim();
    if (q) out = out.filter((p) => p.display_name.toUpperCase().includes(q));
    return out;
  }, [owing, onlyUnset, query]);

  const progress = useMemo(() => {
    const top100 = owing.slice(0, 100);
    const done = top100.filter((p) => p.credit_source === 'approved').length;
    const total = owing.reduce((a, p) => a + Number(p.current_outstanding), 0);
    const classifiable = owing
      .filter((p) => p.credit_source === 'approved')
      .reduce((a, p) => a + Number(p.current_outstanding), 0);
    return { done, top100Count: top100.length, total, classifiable };
  }, [owing]);

  function flash(message) {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  const save = useMutation({
    mutationFn: async ({ ids, term }) => {
      const { error } = await supabase
        .from('parties')
        .update({ ...term, credit_source: 'approved' })
        .in('id', ids);
      if (error) throw error;
      return ids.length;
    },
    onSuccess: (n, { ids, term }) => {
      // Applied straight to the cached rows, so the table updates on the
      // keystroke rather than after a round trip for 845 parties.
      patchParties(queryClient, ids, { ...term, credit_source: 'approved' });
      invalidate(queryClient, PARTY_DERIVED);
      flash(n === 1 ? 'Credit term saved — approved' : `Credit term applied to ${n} parties — approved`);
    },
    onError: (e) => flash(`Not saved: ${e.message}`),
  });

  const clear = useMutation({
    mutationFn: async (ids) => {
      const { error } = await supabase
        .from('parties')
        .update(CLEARED_TERM)
        .in('id', ids);
      if (error) throw error;
      return ids.length;
    },
    onSuccess: (n, ids) => {
      patchParties(queryClient, ids, CLEARED_TERM);
      invalidate(queryClient, PARTY_DERIVED);
      flash(`Term cleared on ${n} ${n === 1 ? 'party' : 'parties'}`);
    },
    onError: (e) => flash(`Not saved: ${e.message}`),
  });

  if (isLoading) return <Msg>Loading…</Msg>;
  if (!rows.length) return <Msg>Nothing to classify yet — import a Marg export first.</Msg>;

  const bulkTerm = termFromDraft(bulk);

  return (
    <div className="animate-screen-in flex h-full min-h-0 flex-col px-[18px] pb-4 pt-4">
      {/* progress — makes the work feel finite */}
      <section className="panel panel-lift mb-3 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
            {progress.done} of the top {progress.top100Count} have approved terms
          </h2>
          <span className="flex items-center gap-3">
            <span className="tnum text-[12px] text-mute">
              {formatPct(progress.classifiable, progress.total)} of the book is now judgeable ·{' '}
              {formatInr(progress.classifiable)}
            </span>
            <ExportButton parties={parties} />
          </span>
        </div>
        <div className="mt-2 h-[7px] overflow-hidden bg-rule">
          <div
            className="h-full bg-teal transition-[width] duration-300"
            style={{ width: `${Math.round((progress.done / Math.max(progress.top100Count, 1)) * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-faint text-pretty">
          Sorted by outstanding, largest first. Nothing here is guessed: a term exists only once
          someone types it, and every term saved from this screen is recorded as approved.
        </p>
      </section>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setLimit(150); }}
          placeholder={`Search ${formatCount(owing.length)} parties…`}
          className="w-[240px] rounded-[2px] border border-hair bg-surface px-[10px] py-[5px] text-[12.5px]"
        />
        <label className="flex items-center gap-[6px] text-[12px]">
          <input type="checkbox" checked={onlyUnset} onChange={(e) => { setOnlyUnset(e.target.checked); setLimit(150); }} />
          Only those without a term
        </label>
        <span className="tnum ml-auto text-[11.5px] text-mute">
          {formatCount(rows.length)} shown of {formatCount(owing.length)}
        </span>
      </div>

      {/* bulk apply */}
      <section className="panel panel-lift mb-3 px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="kicker mb-1">Apply to {selected.size} selected</div>
            <TermEditor draft={bulk} onChange={setBulk} />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.size === 0 || !bulkTerm || save.isPending}
            onClick={() => save.mutate({ ids: [...selected], term: bulkTerm })}
          >
            Apply to {selected.size}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
          <p className="ml-auto max-w-[44ch] text-[11px] text-faint text-pretty">
            Most hospitals share one cycle, so select a run of them and set it once.
          </p>
        </div>
      </section>

      <div className="panel min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th width="34px">
                <input
                  type="checkbox"
                  aria-label="Select the top 100"
                  checked={selected.size > 0 && selected.size === Math.min(100, rows.length)}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(rows.slice(0, 100).map((p) => p.party_id)) : new Set())
                  }
                />
              </Th>
              <Th width="40px" align="right">#</Th>
              <Th>Party</Th>
              <Th align="right" width="110px">Outstanding</Th>
              <Th align="right" width="80px">Oldest</Th>
              <Th width="330px">Credit term</Th>
              <Th width="150px">State</Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((p, i) => (
              <PartyRow
                key={p.party_id}
                party={p}
                index={i}
                checked={selected.has(p.party_id)}
                onCheck={(on) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(p.party_id);
                    else next.delete(p.party_id);
                    return next;
                  })
                }
                onSave={(term) => save.mutate({ ids: [p.party_id], term })}
                onClear={() => clear.mutate([p.party_id])}
              />
            ))}
          </tbody>
        </table>
        {rows.length > limit ? (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="text-[11.5px] text-faint">
              Showing {formatCount(limit)} of {formatCount(rows.length)} — these carry{' '}
              {formatPct(rows.slice(0, limit).reduce((a, p) => a + Number(p.current_outstanding), 0), progress.total)} of the book.
            </span>
            <button type="button" className="btn btn-secondary px-3 py-[4px] text-[12px]" onClick={() => setLimit(limit + 250)}>
              Show 250 more
            </button>
            <button type="button" className="btn btn-secondary px-3 py-[4px] text-[12px]" onClick={() => setLimit(rows.length)}>
              Show all {formatCount(rows.length)}
            </button>
          </div>
        ) : (
          <p className="px-4 py-3 text-[11.5px] text-faint">
            All {formatCount(rows.length)} shown.
          </p>
        )}
      </div>

      {toast ? (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-[3px] bg-ink px-4 py-2 text-[12.5px] text-onaccent shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function PartyRow({ party, index, checked, onCheck, onSave, onClear }) {
  const [draft, setDraft] = useState(() => draftFromParty(party));
  const term = termFromDraft(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromParty(party));

  return (
    <tr className="border-b border-rule last:border-b-0 hover:bg-surface-2">
      <td className="px-[10px] py-[5px]">
        <input
          type="checkbox"
          aria-label={`Select ${party.display_name}`}
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
        />
      </td>
      <td className="tnum px-[6px] py-[5px] text-right text-faint">{index + 1}</td>
      <td className="px-[10px] py-[5px]">
        <Link to={`/parties/${party.party_id}`} className="font-medium text-ink no-underline hover:underline">{party.display_name}</Link>
      </td>
      <td className="tnum px-[10px] py-[5px] text-right font-medium">{formatInr(party.current_outstanding)}</td>
      <td className="tnum px-[10px] py-[5px] text-right text-mute">{formatAge(party.oldest_bill_age_days)}</td>
      <td className="px-[10px] py-[5px]">
        <div className="flex items-center gap-2">
          <TermEditor draft={draft} onChange={setDraft} compact />
          <button
            type="button"
            className="btn btn-primary px-[10px] py-[3px] text-[11.5px]"
            disabled={!dirty || !term}
            onClick={() => onSave(term)}
          >
            Save
          </button>
        </div>
      </td>
      <td className="px-[10px] py-[5px]">
        <div className="flex items-center gap-2">
          <TermBadge row={party} />
          {party.credit_source !== 'not_set' ? (
            <button
              type="button"
              onClick={onClear}
              className="text-[10.5px] text-mute underline underline-offset-2 hover:text-age-3"
              title="Remove the term — this party becomes unjudgeable again"
            >
              clear
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function Th({ children, align = 'left', width }) {
  return (
    <th
      className="sticky top-0 z-10 border-b border-hair bg-surface/95 px-[10px] py-[7px] text-[10px] font-semibold uppercase tracking-[0.09em] text-mute backdrop-blur"
      style={{ textAlign: align, width }}
    >
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

/**
 * The credit master as a spreadsheet.
 *
 * Two sheets: every party with its term and ageing, and a summary counting
 * parties and money per credit term — which is the question the client
 * actually asked ("how many parties are on 30 days, how many on 60"). Figures
 * go out as numbers, not as "₹52.03 L", because the point of a spreadsheet is
 * that it can be summed and sorted.
 */
function ExportButton({ parties }) {
  const [state, setState] = useState('idle');

  async function run() {
    setState('working');
    try {
      const { exportCreditMaster } = await import('../../lib/exportExcel.js');
      await exportCreditMaster(parties ?? []);
      setState('done');
      setTimeout(() => setState('idle'), 2500);
    } catch (e) {
      console.error('Export failed:', e);
      setState('failed');
      setTimeout(() => setState('idle'), 4000);
    }
  }

  return (
    <button
      type="button"
      className="btn btn-secondary px-[10px] py-[4px] text-[11.5px]"
      onClick={run}
      disabled={state === 'working' || !parties?.length}
      title="Downloads an .xlsx with every party's credit term, plus a summary by term"
    >
      {state === 'working' ? 'Building…'
        : state === 'done' ? 'Downloaded'
        : state === 'failed' ? 'Export failed — see console'
        : 'Export to Excel'}
    </button>
  );
}
