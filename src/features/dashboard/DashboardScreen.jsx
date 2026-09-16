import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  latestSnapshotQuery,
  portfolioAgeingQuery,
  priorityListQuery,
  partiesAgeingQuery,
} from '../../lib/queries.js';
import { formatInr, formatCount, formatAge, formatDate, formatPct } from '../../lib/format.js';
import AgeingStrip, { AgeingStripLarge, bucketsOf, TermBadge } from '../../components/AgeingStrip.jsx';

export default function DashboardScreen() {
  const { data: snapshot, isLoading: loadingSnap } = useQuery(latestSnapshotQuery());
  const { data: portfolio } = useQuery(portfolioAgeingQuery());
  const { data: priority } = useQuery(priorityListQuery(6));
  const { data: parties } = useQuery(partiesAgeingQuery());

  const concentration = useMemo(() => {
    if (!parties?.length) return null;
    const owing = parties
      .filter((p) => Number(p.current_outstanding) > 0)
      .sort((a, b) => Number(b.current_outstanding) - Number(a.current_outstanding));
    const total = owing.reduce((a, p) => a + Number(p.current_outstanding), 0);
    const sum = (n) => owing.slice(0, n).reduce((a, p) => a + Number(p.current_outstanding), 0);
    const small = owing.filter((p) => Number(p.current_outstanding) < 10000);
    return {
      total,
      top20: sum(20),
      top100: sum(100),
      rest: total - sum(100),
      restCount: Math.max(0, owing.length - 100),
      smallCount: small.length,
      smallValue: small.reduce((a, p) => a + Number(p.current_outstanding), 0),
    };
  }, [parties]);

  if (loadingSnap) return <Msg>Loading…</Msg>;

  if (!snapshot) {
    return (
      <div className="animate-screen-in px-[18px] pt-4">
        <div className="panel max-w-[70ch] p-[18px]">
          <div className="kicker">Nothing imported yet</div>
          <h2 className="mt-1 text-[17px] font-semibold tracking-[-0.015em]">
            The book is empty until a Marg export is imported
          </h2>
          <p className="mt-2 text-[12.5px] text-mute text-pretty">
            Every figure in this product traces back to a snapshot, so there is nothing to show
            before the first import. Drop today's outstanding export into the import screen.
          </p>
          <Link to="/import" className="btn btn-primary mt-4 inline-block no-underline">
            Go to import
          </Link>
        </div>
      </div>
    );
  }

  const buckets = portfolio
    ? [portfolio.within_terms, portfolio.over_1_30, portfolio.over_31_60, portfolio.over_60].map(Number)
    : null;
  const judgeable = (buckets ?? []).reduce((a, b) => a + b, 0);

  return (
    <div className="animate-screen-in px-[18px] pb-[34px] pt-4">
      {/* headline figures */}
      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-px border border-hair bg-hair">
        <Figure
          label="Net outstanding"
          value={formatInr(snapshot.net_total)}
          note={`${formatCount(snapshot.bill_count)} open bills · ${formatCount(snapshot.party_count)} parties`}
        />
        <Figure
          label="Owed"
          value={formatInr(snapshot.total_owed)}
          note="positive balances only"
        />
        <Figure
          label="In credit"
          value={formatInr(snapshot.total_credit)}
          color="var(--color-claim)"
          note="advances and credit notes — not debt"
        />
        <Figure
          label="Cannot be judged"
          value={formatInr(portfolio?.unjudgeable_amount)}
          color="var(--color-age-1)"
          note={`${formatCount(portfolio?.unjudgeable_parties)} parties with no credit term`}
        />
      </div>

      {/* portfolio ageing */}
      <section className="panel mb-4 px-4 pb-3 pt-[14px]">
        <div className="mb-[10px] flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Portfolio ageing</h2>
          <span className="font-mono text-[9.5px] uppercase tracking-[0.05em] text-faint">
            Measured against approved terms · money with no term is excluded
          </span>
        </div>

        {judgeable > 0 ? (
          <AgeingStripLarge buckets={buckets} />
        ) : (
          <div className="border-l-[3px] border-l-[#C9A93E] bg-white p-3">
            <div className="kicker text-[#7A6410]">No strip to draw yet</div>
            <p className="mt-1 max-w-[80ch] text-[12.5px] text-pretty">
              Not one party has an approved credit term, so there is no due date to measure any of
              this money against. The ageing strip stays empty rather than showing bill age dressed
              up as lateness.
            </p>
            <Link to="/credit-master" className="btn btn-primary mt-3 inline-block no-underline">
              Set credit terms
            </Link>
          </div>
        )}

        {portfolio?.unjudgeable_amount > 0 && judgeable > 0 ? (
          <p className="mt-3 border-t border-hair pt-2 text-[11.5px] text-mute text-pretty">
            A further <span className="tnum font-medium">{formatInr(portfolio.unjudgeable_amount)}</span>{' '}
            across {formatCount(portfolio.unjudgeable_parties)} parties is not in this strip: those
            parties have no approved term, so their money cannot be called late.{' '}
            <Link to="/credit-master">Fix that →</Link>
          </p>
        ) : null}
      </section>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-4">
        {/* priority list */}
        <section className="panel col-span-full min-w-0 xl:col-span-2">
          <div className="flex flex-wrap items-baseline gap-[10px] border-b border-hair px-4 pb-[9px] pt-3">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Work this first</h2>
            <span className="text-[11px] text-faint">
              amount weighted by how far past term, then by behaviour
            </span>
          </div>

          {priority === undefined ? (
            <p className="px-4 py-3 text-[12px] text-mute">Loading…</p>
          ) : priority.length === 0 ? (
            <div className="px-4 py-4">
              <p className="max-w-[80ch] text-[12.5px] text-pretty">
                Nothing can be ranked yet. The priority list deliberately excludes every party with
                no approved credit term, because without one there is no way to say whether the
                money is late — and a call list built on guesswork is worse than none.
              </p>
              <Link to="/credit-master" className="btn btn-primary mt-3 inline-block no-underline">
                Set credit terms
              </Link>
            </div>
          ) : (
            priority.map((p, i) => (
              <div
                key={p.party_id}
                className="grid items-start gap-3 border-b border-rule px-4 pb-3 pt-[11px] last:border-b-0"
                style={{ gridTemplateColumns: '20px minmax(0,1fr) 110px' }}
              >
                <span className="tnum pt-px text-right text-[14px] font-medium text-[#B4C0C9]">{i + 1}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-semibold">{p.display_name}</span>
                    <TermBadge row={{ ...p, credit_source: p.term_is_assumed ? 'category_default' : 'approved' }} />
                  </div>
                  <p className="mt-[3px] max-w-[78ch] text-[12px] text-[#3E4C58] text-pretty">{p.reason}</p>
                  <div className="mt-[7px] w-[150px]">
                    <AgeingStrip
                      buckets={[p.within_terms, p.over_1_30, p.over_31_60, p.over_60].map(Number)}
                      height={8}
                    />
                  </div>
                </div>
                <div className="text-right">
                  <div className="tnum text-[15px] font-medium">{formatInr(p.current_outstanding)}</div>
                  <div className="tnum mt-[2px] text-[10px] text-faint">
                    {formatAge(p.oldest_bill_age_days)} oldest
                  </div>
                </div>
              </div>
            ))
          )}
          <div className="px-4 py-[9px] text-[11.5px]">
            <Link to="/parties">All {formatCount(snapshot.party_count)} parties →</Link>
          </div>
        </section>

        {/* concentration */}
        <section className="panel min-w-0 px-[15px] pb-[14px] pt-[13px]">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Where the money is</h2>
          <p className="mb-3 mt-[3px] text-[11.5px] text-mute text-pretty">
            Effort spent below the top 100 is effort wasted.
          </p>

          {concentration ? (
            <>
              <Bar label="Top 20 parties" value={concentration.top20} total={concentration.total} color="var(--color-age-3)" />
              <Bar label="Top 100 parties" value={concentration.top100} total={concentration.total} color="var(--color-age-2)" />
              <Bar
                label={`Remaining ${formatCount(concentration.restCount)}`}
                value={concentration.rest}
                total={concentration.total}
                color="#B4C0C9"
              />
              {concentration.smallCount > 0 ? (
                <p className="mt-3 border-t border-hair pt-[10px] text-[11.5px] text-[#3E4C58] text-pretty">
                  {formatCount(concentration.smallCount)} parties owe under ₹10,000 each —{' '}
                  <span className="tnum font-medium">{formatInr(concentration.smallValue)}</span>{' '}
                  between them, {formatPct(concentration.smallValue, concentration.total)} of the
                  book. A write-off batch, not {formatCount(concentration.smallCount)} phone calls.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-[12px] text-mute">Loading…</p>
          )}
        </section>

        {/* import status */}
        <section className="panel min-w-0 px-[15px] pb-[14px] pt-[13px]">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Current snapshot</h2>
          <div className="mt-2 grid gap-[6px] text-[12px]">
            <Row label="Report date" value={formatDate(snapshot.report_date)} />
            <Row label="File" value={snapshot.file_name} mono />
            <Row label="Parties" value={formatCount(snapshot.party_count)} />
            <Row label="Bills" value={formatCount(snapshot.bill_count)} />
            <Row label="Net total" value={formatInr(snapshot.net_total)} strong />
          </div>
          <p className="mt-3 border-t border-hair pt-[10px] text-[11px] text-faint text-pretty">
            Every figure on this screen comes from this snapshot. Snapshots are immutable — to
            correct a number, import a new export.
          </p>
          <Link to="/import" className="btn btn-secondary mt-3 inline-block no-underline">
            Import today's file
          </Link>
        </section>
      </div>
    </div>
  );
}

function Figure({ label, value, note, color }) {
  return (
    <div className="bg-white/[0.74] px-[14px] pb-[13px] pt-3 backdrop-blur">
      <div className="kicker">{label}</div>
      <div
        className="tnum mt-1 whitespace-nowrap text-[26px] font-medium leading-[1.1] tracking-[-0.03em]"
        style={{ color: color ?? 'var(--color-ink)' }}
      >
        {value}
      </div>
      {note ? <div className="mt-[3px] text-[11px] text-mute text-pretty">{note}</div> : null}
    </div>
  );
}

function Bar({ label, value, total, color }) {
  const pct = total ? (Number(value) / total) * 100 : 0;
  return (
    <div className="mb-[10px]">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[11.5px]">
        <span className="text-[#3E4C58]">{label}</span>
        <span className="tnum whitespace-nowrap font-medium">
          {formatInr(value)} · {Math.round(pct)}%
        </span>
      </div>
      <div className="h-[7px] overflow-hidden bg-rule">
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Row({ label, value, strong, mono }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-mute">{label}</span>
      <span className={['truncate', mono ? 'font-mono text-[11px]' : 'tnum', strong ? 'font-semibold' : ''].join(' ')}>
        {value}
      </span>
    </div>
  );
}

function Msg({ children }) {
  return (
    <div className="animate-screen-in px-[18px] pt-4">
      <div className="panel p-[14px] text-[12.5px] text-mute">{children}</div>
    </div>
  );
}
