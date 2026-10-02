import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { formatInr, formatCount, formatDate, formatPct } from '../../lib/format.js';
import { AgeingStripLarge, bucketsFromRow } from '../../components/AgeingStrip.jsx';
import { TimeLine, Columns, RankedBars } from './charts.jsx';

/**
 * Analytics — the screen that is supposed to change a decision.
 *
 * The rule it works to: every figure here is measured from data already
 * recorded, and anything that cannot be measured yet says so instead of
 * being filled in. No projections, no smoothing, no trend line drawn
 * through one point. A chart that implies knowledge the imports do not
 * contain is worse than no chart, because it will be believed.
 *
 * The prompts at the bottom are not predictions either. Each one is a
 * threshold crossed by a number on this page, and each says which number,
 * so the owner can disagree with it.
 */

const CATEGORY_LABELS = {
  hospital: 'Hospitals',
  retailer: 'Retailers',
  wholesaler: 'Wholesalers',
  doctor: 'Doctors',
  customer: 'Customers',
  institution: 'Institutions',
  cash: 'Cash',
  uncategorised: 'Not categorised',
};

export default function AnalyticsScreen() {
  const trend = useQuery({
    queryKey: ['book-trend'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_book_trend').select('*');
      if (error) throw error;
      return data ?? [];
    },
  });

  const collections = useQuery({
    queryKey: ['collection-trend'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_collection_trend').select('*');
      if (error) throw error;
      return data ?? [];
    },
  });

  const portfolio = useQuery({
    queryKey: ['portfolio-ageing'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_portfolio_ageing').select('*').maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const categories = useQuery({
    queryKey: ['category-exposure'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_category_exposure').select('*');
      if (error) throw error;
      return data ?? [];
    },
  });

  const cycle = useQuery({
    queryKey: ['collection-cycle'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('fn_collection_cycle');
      if (error) throw error;
      return data?.[0] ?? null;
    },
  });

  const behaviour = useQuery({
    queryKey: ['payment-behaviour'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('fn_payment_behaviour', { p_limit: 40 });
      if (error) throw error;
      return data ?? [];
    },
  });

  const unapplied = useQuery({
    queryKey: ['unallocated'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_unallocated_receipts').select('*').limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const error = trend.error || collections.error || portfolio.error || categories.error;
  if (error) {
    return (
      <div className="animate-screen-in px-[18px] pt-4">
        <div className="panel border-l-[3px] border-l-age-4 p-[14px] text-[12.5px]">
          {error.message}
          <p className="mt-2 text-[11.5px] text-mute">
            If this names a missing table, migration 0010 has not been applied to this database yet.
          </p>
        </div>
      </div>
    );
  }

  const book = trend.data ?? [];
  const latest = book[book.length - 1];
  const first = book[0];

  const linePoints = book.map((r) => ({
    date: r.report_date,
    value: Number(r.net_total),
    label: shortDate(r.report_date),
    note: r.change_from_previous == null
      ? 'first import'
      : `${Number(r.change_from_previous) < 0 ? 'down' : 'up'} ${formatInr(Math.abs(Number(r.change_from_previous)))} over ${r.days_since_previous} days`,
  }));

  const collectionBars = (collections.data ?? []).map((r) => ({
    label: shortDate(r.on_date),
    value: Number(r.collected ?? 0),
    note: `${formatCount(r.bills_cleared)} bills cleared · ${formatCount(r.paying_parties)} parties paid`,
  }));

  const observed = collectionBars.reduce((a, b) => a + b.value, 0);

  const categoryRows = (categories.data ?? [])
    .filter((c) => Number(c.owed) > 0)
    .map((c) => ({
      name: CATEGORY_LABELS[c.category] ?? c.category,
      value: Number(c.owed),
      meta: `${formatCount(c.party_count)} parties${c.without_term > 0 ? ` · ${formatCount(c.without_term)} with no term` : ''}`,
    }));

  /*
   * Plain functions, not useMemo. These sit below an early return for the
   * error case, and a hook after a conditional return changes the hook count
   * between renders — React throws "rendered fewer hooks than expected" the
   * first time a query fails. The lists are tens of rows; there is nothing
   * here worth memoising anyway.
   */
  const slowest = (() => {
    return (behaviour.data ?? [])
      .filter((r) => r.days_beyond_term != null && Number(r.days_beyond_term) > 0)
      .sort((a, b) => Number(b.days_beyond_term) - Number(a.days_beyond_term))
      .slice(0, 10)
      .map((r) => ({
        name: r.display_name,
        value: Number(r.actual_payment_days),
        suffix: 'd',
        meta: `${formatInr(r.current_outstanding)} open · term ${r.expected_days}d · ${formatCount(r.days_beyond_term)}d beyond`,
        color: 'var(--color-age-4)',
      }));
  })();

  const prompts = buildPrompts({
    book,
    portfolio: portfolio.data,
    behaviour: behaviour.data,
    unapplied: unapplied.data,
    cycle: cycle.data,
  });

  const buckets = portfolio.data ? bucketsFromRow(portfolio.data) : null;
  const netChange = first && latest ? Number(latest.net_total) - Number(first.net_total) : null;

  return (
    <div className="animate-screen-in px-[18px] pb-[34px] pt-4">
      <section className="panel panel-lift mb-3 px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">How the business is actually doing</h2>
        <p className="mt-1 max-w-[100ch] text-[12.5px] text-mute text-pretty">
          Every figure here is measured from the files already imported. Where there is not enough
          history to say something, the chart says so rather than drawing a line through one point.
        </p>
      </section>

      <div className="stagger mb-3 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-px border border-hair bg-hair">
        <Stat
          label="Book today"
          value={latest ? formatInr(latest.net_total) : '—'}
          note={latest ? `${formatCount(latest.party_count)} parties · ${formatDate(latest.report_date)}` : 'nothing imported'}
        />
        <Stat
          label={netChange != null && netChange < 0 ? 'Down since first import' : 'Up since first import'}
          value={netChange != null ? formatInr(Math.abs(netChange)) : '—'}
          tone={netChange != null && netChange < 0 ? 'var(--color-teal-deep)' : 'var(--color-age-3)'}
          note={book.length > 1 ? `over ${formatCount(book.length)} imports` : 'needs a second import'}
        />
        <Stat
          label="Collected (observed)"
          value={observed > 0 ? formatInr(observed) : '—'}
          note="money seen arriving between imports"
        />
        <Stat
          label="Typical collection cycle"
          value={cycle.data?.median_days != null ? `${Math.round(cycle.data.median_days)} days` : '—'}
          note={
            cycle.data?.settled_bills > 0
              ? `median of ${formatCount(cycle.data.settled_bills)} settled bills`
              : 'needs settled bills to measure'
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="The book, import by import"
          sub="Net outstanding on each export. Points sit at their real dates, so a fortnight's gap looks like one."
        >
          <TimeLine points={linePoints} valueLabel="Net outstanding over time" />
        </Panel>

        <Panel
          title="Money seen arriving"
          sub="Derived by comparing consecutive exports. A bill paid and re-billed between two files nets to nothing, so this is what the exports reveal rather than every rupee banked."
        >
          <Columns
            bars={collectionBars}
            empty="Nothing to show until two exports have been compared. Import the next file and this fills in."
          />
        </Panel>

        <Panel
          title="Where the money sits in the ageing"
          sub="Measured against each party's own credit term. Money with no recorded term is excluded, not assumed on time."
        >
          {buckets && buckets.some((b) => b > 0) ? (
            <div className="pt-1">
              <AgeingStripLarge buckets={buckets} />
              {Number(portfolio.data?.unjudgeable_amount) > 0 ? (
                <p className="mt-3 text-[11.5px] text-mute text-pretty">
                  A further {formatInr(portfolio.data.unjudgeable_amount)} across{' '}
                  {formatCount(portfolio.data.unjudgeable_parties)} parties is not in this strip —{' '}
                  <Link to="/credit-master" className="text-teal-deep underline">set their terms</Link> and it joins.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="py-6 text-center text-[12px] text-mute">
              No party has an approved credit term yet, so there is no due date to measure against.
            </p>
          )}
        </Panel>

        <Panel title="Exposure by trade category" sub="Where the outstanding actually sits.">
          <RankedBars rows={categoryRows} empty="Nothing imported yet." />
          {/*
            * One bar marked "Not categorised" is a true answer and a useless
            * chart. Say what would make it useful instead of leaving the
            * reader to work out why the panel is empty of information.
            */}
          {categoryRows.length <= 1 && categoryRows[0]?.name === CATEGORY_LABELS.uncategorised ? (
            <p className="mt-3 text-[11.5px] text-mute text-pretty">
              No party has a trade category yet, so there is nothing to compare. Open any party and
              set Hospital, Retailer, Wholesaler, Doctor or Customer — this chart then shows which
              kind of customer the money is actually tied up in, and each category also carries a
              default credit term you can approve or override.
            </p>
          ) : null}
        </Panel>

        <Panel
          title="Who takes longest to pay"
          sub="Measured from bills actually settled, against the term that party was given. Only parties with at least three settled bills appear — two is an anecdote."
        >
          <RankedBars
            rows={slowest}
            unit="days"
            empty="Not enough settled history yet. A party needs three settled bills before its payment behaviour means anything."
          />
        </Panel>

        <Panel title="What this suggests" sub="Each one is a threshold crossed by a figure on this page, with the figure named.">
          {prompts.length ? (
            <ul className="grid gap-[9px]">
              {prompts.map((p, i) => (
                <li key={i} className="border-l-[3px] pl-[10px]" style={{ borderColor: p.tone }}>
                  <div className="text-[12.5px] font-medium">{p.headline}</div>
                  <p className="mt-[2px] text-[11.5px] text-mute text-pretty">{p.detail}</p>
                  {p.to ? (
                    <Link to={p.to} className="mt-[3px] inline-block text-[11.5px] text-teal-deep hover:underline">
                      {p.action} →
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-[12px] text-mute">
              Nothing has crossed a threshold worth raising. That is a real answer, not an empty screen.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The suggestions.
 *
 * Deliberately rule-based and deliberately few. Each prompt names the figure
 * that triggered it, so the owner can look at the same number and disagree —
 * which they cannot do with a recommendation that arrives without its
 * reasoning. Nothing here predicts; everything here reports a threshold.
 */
function buildPrompts({ book, portfolio, behaviour, unapplied, cycle }) {
  const out = [];

  if (book?.length >= 2) {
    const first = Number(book[0].net_total);
    const last = Number(book[book.length - 1].net_total);
    const delta = last - first;
    if (Math.abs(delta) / Math.max(first, 1) > 0.02) {
      out.push(
        delta < 0
          ? {
              tone: 'var(--color-age-0)',
              headline: `The book is down ${formatInr(Math.abs(delta))} since the first import`,
              detail: `From ${formatInr(first)} on ${formatDate(book[0].report_date)} to ${formatInr(last)} on ${formatDate(book[book.length - 1].report_date)}. Collection is outrunning new billing.`,
            }
          : {
              tone: 'var(--color-age-3)',
              headline: `The book has grown ${formatInr(delta)} since the first import`,
              detail: `New billing is outrunning collection. Worth checking whether that is sales growth or slipping recovery — the "money seen arriving" chart separates the two.`,
            }
      );
    }
  }

  const over60 = Number(portfolio?.over_60 ?? 0);
  const judgeable =
    Number(portfolio?.within_terms ?? 0) + Number(portfolio?.over_1_30 ?? 0) +
    Number(portfolio?.over_31_60 ?? 0) + over60;
  if (judgeable > 0 && over60 / judgeable > 0.2) {
    out.push({
      tone: 'var(--color-age-5)',
      headline: `${formatPct(over60, judgeable)} of judgeable money is more than 60 days past term`,
      detail: `${formatInr(over60)} of ${formatInr(judgeable)}. Past 60 days beyond an agreed term, a balance usually needs a different conversation than another reminder call.`,
      to: '/parties',
      action: 'Open the parties list',
    });
  }

  const noTerm = Number(portfolio?.unjudgeable_amount ?? 0);
  if (noTerm > 0 && portfolio?.unjudgeable_parties > 0) {
    out.push({
      tone: 'var(--color-age-1)',
      headline: `${formatInr(noTerm)} cannot be judged at all`,
      detail: `${formatCount(portfolio.unjudgeable_parties)} parties have no recorded credit term, so none of that money can be called late or on time. It is the single largest blind spot on this page.`,
      to: '/credit-master',
      action: 'Set credit terms',
    });
  }

  const unappliedTotal = (unapplied ?? []).reduce((a, r) => a + Number(r.unallocated ?? 0), 0);
  if (unappliedTotal > 0) {
    out.push({
      tone: 'var(--color-claim)',
      headline: `${formatInr(unappliedTotal)} has been received but never applied to a bill`,
      detail: `Across ${formatCount(unapplied.length)} parties. Their balance is already reduced, but the invoices keep ageing as though nothing arrived — so these parties look worse than they are.`,
      to: '/unallocated',
      action: 'Open To allocate',
    });
  }

  const slipping = (behaviour ?? []).filter(
    (r) => r.days_beyond_term != null && Number(r.days_beyond_term) > 30
  );
  if (slipping.length) {
    const worst = [...slipping].sort((a, b) => Number(b.current_outstanding) - Number(a.current_outstanding))[0];
    out.push({
      tone: 'var(--color-age-4)',
      headline: `${formatCount(slipping.length)} parties habitually pay more than a month beyond their term`,
      detail: `Largest is ${worst.display_name}: settles in about ${worst.actual_payment_days} days against a ${worst.expected_days}-day term, with ${formatInr(worst.current_outstanding)} open. Either the term is wrong or it is not being enforced.`,
      to: '/credit-master',
      action: 'Review their terms',
    });
  }

  if (cycle?.median_days != null && cycle?.mean_days != null) {
    const med = Number(cycle.median_days);
    const mean = Number(cycle.mean_days);
    if (mean > med * 1.5) {
      out.push({
        tone: 'var(--color-age-2)',
        headline: `The average collection cycle is being dragged by a long tail`,
        detail: `Half of all bills settle within ${Math.round(med)} days, but the average is ${Math.round(mean)} — a few very old bills are doing that. Judge performance on the median; chase the tail separately.`,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */

function Panel({ title, sub, children }) {
  return (
    <section className="panel p-4">
      <h3 className="text-[13.5px] font-semibold tracking-[-0.01em]">{title}</h3>
      {sub ? <p className="mb-3 mt-[3px] max-w-[72ch] text-[11.5px] text-mute text-pretty">{sub}</p> : null}
      {children}
    </section>
  );
}

function Stat({ label, value, note, tone }) {
  return (
    <div className="bg-surface px-[14px] py-[11px]">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">{label}</div>
      <div className="tnum mt-[3px] text-[21px] font-medium tracking-[-0.02em]" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {note ? <div className="mt-[2px] text-[11px] text-mute">{note}</div> : null}
    </div>
  );
}

function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = String(iso).slice(0, 10).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1]}`;
}
