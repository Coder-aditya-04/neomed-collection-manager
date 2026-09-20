import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { partiesAgeingQuery } from '../../lib/queries.js';
import { formatInr, formatCount, formatAge, formatPct } from '../../lib/format.js';
import AgeingStrip, { bucketsOf, TermBadge } from '../../components/AgeingStrip.jsx';
import PartyDrawer from './PartyDrawer.jsx';

/** Matches the component sheet in the prototype. */
const ROW_HEIGHT = 27;

const FILTERS = [
  ['all', 'All'],
  ['critical', 'Critical'],
  ['big', '≥ ₹5 L'],
  ['noterm', 'Term not set'],
  ['assumed', 'Assumed term'],
  ['credit', 'Credit balance'],
  ['zero', 'At zero'],
];

const COLUMNS = [
  { id: 'display_name', label: 'Party', align: 'left', width: 'minmax(220px,1fr)' },
  { id: 'term', label: 'Credit term', align: 'left', width: '170px' },
  { id: 'ageing', label: 'Ageing', align: 'left', width: '130px', sortable: false },
  { id: 'current_outstanding', label: 'Outstanding', align: 'right', width: '110px' },
  { id: 'oldest_bill_age_days', label: 'Oldest', align: 'right', width: '80px' },
  { id: 'max_overdue_days', label: 'Overdue', align: 'right', width: '90px' },
  { id: 'bill_count', label: 'Bills', align: 'right', width: '70px' },
];

const GRID = COLUMNS.map((c) => c.width).join(' ');

export default function PartiesScreen() {
  const { data: parties, isLoading, error } = useQuery(partiesAgeingQuery());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sortCol, setSortCol] = useState('current_outstanding');
  const [sortDir, setSortDir] = useState('desc');
  const [selected, setSelected] = useState(null);
  const scrollRef = useRef(null);

  const rows = useMemo(() => {
    if (!parties) return [];
    const q = normalise(query);
    let out = parties;

    if (q) out = out.filter((p) => normalise(p.display_name).includes(q));

    const predicate = {
      critical: (p) => Number(p.over_60 ?? 0) > 0 && Number(p.current_outstanding) > 100000,
      big: (p) => Number(p.current_outstanding) >= 500000,
      noterm: (p) => p.needs_credit_term && Number(p.current_outstanding) > 0,
      assumed: (p) => p.term_is_assumed,
      credit: (p) => p.is_credit_balance,
      zero: (p) => Number(p.current_outstanding) === 0,
    }[filter];
    if (predicate) out = out.filter(predicate);

    const dir = sortDir === 'desc' ? -1 : 1;
    return [...out].sort((a, b) => {
      let x = a[sortCol];
      let y = b[sortCol];
      if (sortCol === 'term') {
        x = termRank(a);
        y = termRank(b);
      }
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'string') return x.localeCompare(y) * dir;
      return (Number(x) - Number(y)) * dir;
    });
  }, [parties, query, filter, sortCol, sortDir]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 18,
  });

  const shownTotal = rows.reduce((a, p) => a + Number(p.current_outstanding), 0);

  function sortBy(id) {
    if (id === sortCol) setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    else {
      setSortCol(id);
      setSortDir(id === 'display_name' ? 'asc' : 'desc');
    }
  }

  if (error) return <Message tone="error">{error.message}</Message>;
  if (isLoading) return <Message>Loading parties…</Message>;
  if (!parties?.length) {
    return (
      <Message>
        No parties yet. Import a Marg export first — the list is built from the latest snapshot.
      </Message>
    );
  }

  return (
    <div className="animate-screen-in flex h-full min-h-0 flex-col px-[18px] pb-4 pt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search parties…"
          className="w-[230px] rounded-[2px] border border-hair bg-surface px-[10px] py-[5px] text-[12.5px]"
        />
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={[
              'rounded-[2px] border px-[10px] py-[4px] text-[11.5px] transition-colors',
              filter === id
                ? 'border-teal bg-teal font-semibold text-onaccent'
                : 'border-hair bg-surface text-body hover:border-teal',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
        <span className="tnum ml-auto text-[11.5px] text-mute">
          {formatCount(rows.length)} parties · {formatInr(shownTotal)}
        </span>
      </div>

      <div className="panel flex min-h-0 flex-1 flex-col">
        <div
          className="grid border-b border-hair bg-surface/90 px-3 py-[7px] text-[10px] font-semibold uppercase tracking-[0.09em] text-mute"
          style={{ gridTemplateColumns: GRID, gap: 12 }}
        >
          {COLUMNS.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={c.sortable === false}
              onClick={() => sortBy(c.id)}
              className={[
                'truncate uppercase tracking-[0.09em]',
                c.align === 'right' ? 'text-right' : 'text-left',
                c.sortable === false ? 'cursor-default' : 'cursor-pointer hover:text-ink',
              ].join(' ')}
            >
              {c.label}
              {sortCol === c.id ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
            </button>
          ))}
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <div className="grid place-items-center p-10 text-center">
              <div>
                <div className="text-[13px] font-semibold">Nothing matches</div>
                <button
                  type="button"
                  className="btn btn-secondary mt-3"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  Clear search and filters
                </button>
              </div>
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const p = rows[item.index];
                return (
                  <Row
                    key={p.party_id}
                    party={p}
                    top={item.start}
                    onOpen={() => setSelected(p)}
                    selected={selected?.party_id === p.party_id}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="tnum border-t border-hair px-3 py-[5px] text-[9.5px] uppercase tracking-[0.05em] text-faint">
          Virtualised · {ROW_HEIGHT}px rows · showing{' '}
          {formatCount(virtualizer.getVirtualItems().length)} of {formatCount(rows.length)}
        </div>
      </div>

      {selected ? <PartyDrawer party={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function Row({ party, top, onOpen, selected }) {
  const buckets = bucketsOf(party);
  const overdue = party.max_overdue_days;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={[
        'absolute left-0 grid w-full cursor-pointer items-center border-b border-rule px-3 text-[12px] transition-colors hover:bg-surface-2',
        selected ? 'bg-[rgba(0,133,122,.06)]' : '',
        party.is_credit_balance ? 'bg-[rgba(109,91,184,.045)] shadow-[inset_3px_0_0_var(--color-claim)]' : '',
      ].join(' ')}
      style={{ top, height: ROW_HEIGHT, gridTemplateColumns: GRID, gap: 12 }}
    >
      <span className="truncate font-medium">{party.display_name}</span>
      <span className="truncate">
        <TermBadge row={party} />
      </span>
      <span className="pr-2">
        <AgeingStrip buckets={buckets} height={8} />
      </span>
      <span className="tnum text-right font-medium">{formatInr(party.current_outstanding)}</span>
      <span className="tnum text-right" style={{ color: ageColor(party.oldest_bill_age_days) }}>
        {formatAge(party.oldest_bill_age_days)}
      </span>
      <span className="tnum text-right">
        {party.needs_credit_term ? (
          <span className="text-faint" title="No credit term, so lateness cannot be judged">—</span>
        ) : overdue > 0 ? (
          <span style={{ color: overdueColor(overdue) }}>{formatCount(overdue)}d</span>
        ) : (
          <span className="text-teal-deep">in terms</span>
        )}
      </span>
      <span className="tnum text-right text-mute">{formatCount(party.bill_count)}</span>
    </div>
  );
}

function Message({ children, tone }) {
  return (
    <div className="animate-screen-in px-[18px] pt-4">
      <div className={`panel p-[14px] text-[12.5px] ${tone === 'error' ? 'border-l-[3px] border-l-age-3' : 'text-mute'}`}>
        {children}
      </div>
    </div>
  );
}

function normalise(s) {
  return String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/** not_set last, so the sort surfaces what is judgeable first. */
function termRank(p) {
  if (p.credit_source === 'approved') return 0;
  if (p.credit_source === 'category_default') return 1;
  return 2;
}

function ageColor(d) {
  if (d == null) return 'var(--color-faint)';
  if (d > 90) return 'var(--color-age-3)';
  if (d > 60) return 'var(--color-age-2)';
  if (d > 30) return 'var(--color-age-1)';
  return 'var(--color-ink)';
}

function overdueColor(d) {
  if (d > 60) return 'var(--color-age-3)';
  if (d > 30) return 'var(--color-age-2)';
  return 'var(--color-age-1)';
}

export { formatPct };
