import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { partiesAgeingQuery, priorityListQuery } from '../../lib/queries.js';
import { formatCount, formatDate } from '../../lib/format.js';

/** Every route in the spec. All of them are built. */
const NAV = [
  { to: '/', label: 'Today', step: null },
  { to: '/parties', label: 'Parties', step: null },
  { to: '/credit-master', label: 'Credit master', step: null },
  { to: '/unallocated', label: 'To allocate', step: null },
  { to: '/recovery', label: 'Recovery desk', step: null },
  { to: '/statements', label: 'Statements', step: null },
  { to: '/followups', label: 'Follow-ups', step: null },
  { to: '/promises', label: 'Promises', step: null },
  { to: '/claims', label: 'Claims', step: null },
  { to: '/assistant', label: 'Assistant', step: null },
  { to: '/import', label: 'Import', step: null },
  { to: '/settings', label: 'Settings', step: null },
];

const TITLES = {
  '/': ['Today', 'The current position across the book'],
  '/parties': ['Parties', 'All parties · sort, filter, search'],
  '/credit-master': ['Credit master', 'Fill the top 100 and most of the book becomes judgeable'],
  '/unallocated': ['To allocate', 'Money received but not yet settled against a bill in Marg'],
  '/recovery': ['Recovery desk', 'Who called whom, what was said, and how it compares with what was committed'],
  '/statements': ['Statements', 'Month-end party statements, composed and ready to send on WhatsApp'],
  '/import': ['Import', 'Marg outstanding bill-wise export · nothing is written before you confirm'],
  '/followups': ['Follow-ups', 'What was missed, what is planned, what the team did'],
  '/promises': ['Promises', 'A promise closes only when a payment supports it'],
  '/claims': ['Claims', 'Money held by our own pending action'],
  '/assistant': ['Assistant', 'Ask about any party, bucket or bill in the current snapshot'],
  '/settings': ['Settings', 'Users, category defaults, thresholds and import history'],
};

export default function AppShell({ session }) {
  const location = useLocation();
  const [title, subtitle] = TITLES[location.pathname] ?? ['Neomed', ''];

  const { data: snapshot } = useQuery({
    queryKey: ['latest-snapshot'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('snapshots')
        .select('report_date, party_count, bill_count, net_total')
        .order('report_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: parties } = useQuery(partiesAgeingQuery());
  const { data: priority } = useQuery(priorityListQuery(50));

  const counts = {
    '/': priority?.length,
    '/parties': parties?.length,
    '/credit-master': parties?.filter((p) => p.needs_credit_term && Number(p.current_outstanding) > 0).length,
  };

  const { data: profile } = useQuery({
    queryKey: ['me', session?.user?.id],
    enabled: Boolean(session?.user?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('app_users')
        .select('full_name, role')
        .eq('id', session.user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="flex min-h-screen">
      <nav className="sticky top-0 flex h-screen w-[168px] flex-none flex-col border-r border-hair bg-white/75 backdrop-blur-xl backdrop-saturate-150">
        <div className="glass-sheen flex items-center gap-2 border-b border-hair px-3 py-3">
          <Mark />
          <div>
            <div className="text-[13px] font-semibold leading-none tracking-[-0.01em]">Neomed</div>
            <div className="mt-[2px] text-[8.5px] uppercase tracking-[0.13em] text-faint">Collections</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-[6px]">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                [
                  'flex h-[30px] w-full items-center justify-between gap-[6px] px-3 text-left text-[12.5px] transition-colors',
                  isActive
                    ? 'nav-glow bg-teal/[0.08] font-semibold text-teal-deep shadow-[inset_2px_0_0_var(--color-teal)]'
                    : 'text-ink hover:bg-[#f2f6f8] hover:pl-[14px]',
                ].join(' ')
              }
            >
              <span className="truncate">{item.label}</span>
              {counts[item.to] !== undefined && counts[item.to] !== null ? (
                <span className="flex-none font-mono text-[9.5px] text-faint">
                  {formatCount(counts[item.to])}
                </span>
              ) : null}
            </NavLink>
          ))}
        </div>

        <div className="flex items-center gap-[7px] border-t border-hair px-3 py-[9px] text-[10.5px] text-mute">
          <span className="grid h-[19px] w-[19px] flex-none place-items-center border border-hair text-[9.5px] font-semibold text-ink">
            {initials(profile?.full_name ?? session?.user?.email)}
          </span>
          <span className="truncate">{profile?.full_name ?? session?.user?.email ?? 'Signed in'}</span>
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-[14px] border-b border-hair bg-white/[0.72] px-[18px] py-[9px] backdrop-blur-lg relative">
          <TypedTitle text={title} />
          <div className="max-w-[46ch] text-[11.5px] text-mute text-pretty">{subtitle}</div>
          <div className="ml-auto flex items-center gap-[10px]">
            <SnapshotBadge snapshot={snapshot} />
            <Link to="/import" className="btn btn-primary whitespace-nowrap px-3 py-[5px] text-[12px] no-underline">
              Import
            </Link>
          </div>
          <div className="rail absolute inset-x-0 bottom-0" aria-hidden />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/**
 * The screen title types itself in when the screen changes.
 *
 * Fast enough to be finished before anyone could be waiting on it — the
 * whole title lands inside a third of a second — and it reserves its own
 * width up front so the subtitle beside it does not jump around while the
 * letters arrive.
 */
function TypedTitle({ text }) {
  const [shown, setShown] = useState(text);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setShown(text);
      return undefined;
    }
    setShown('');
    let i = 0;
    const step = Math.max(14, Math.round(320 / Math.max(text.length, 1)));
    const id = setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, step);
    return () => clearInterval(id);
  }, [text]);

  const done = shown.length >= text.length;

  return (
    <div className="relative text-[17px] font-semibold leading-[1.1] tracking-[-0.015em]">
      {/* Holds the full width so nothing beside it shifts mid-type. */}
      <span aria-hidden className="invisible">{text}</span>
      <span className={`absolute inset-0 ${done ? '' : 'caret'}`}>{shown}</span>
    </div>
  );
}

/**
 * Every screen carries the date of the snapshot it is reading (rule 8). A
 * stale book is a real risk here — the file is exported by hand — so the age
 * is stated rather than left to be inferred from the date.
 */
function SnapshotBadge({ snapshot }) {
  if (!snapshot) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-mute">
        No snapshot imported
      </span>
    );
  }
  const ageDays = Math.max(
    0,
    Math.round((Date.now() - Date.parse(`${snapshot.report_date}T00:00:00Z`)) / 86400000)
  );
  const tone = ageDays <= 1 ? 'bg-age-0' : ageDays <= 4 ? 'bg-age-1' : 'bg-age-3';
  return (
    <span className="flex items-center gap-[6px] font-mono text-[10px] uppercase tracking-[0.04em] text-mute">
      <span className={`h-[6px] w-[6px] flex-none ${tone}`} />
      Marg {formatDate(snapshot.report_date)} · {ageDays === 0 ? 'today' : `${ageDays} days old`}
    </span>
  );
}

function Mark() {
  return (
    <div className="relative h-[15px] w-[15px] flex-none border-[1.5px] border-ink">
      <div className="absolute inset-y-[3px] inset-x-[1.5px] border-x-[1.5px] border-ink" />
    </div>
  );
}

function initials(nameOrEmail) {
  if (!nameOrEmail) return '··';
  const s = String(nameOrEmail).split('@')[0];
  const parts = s.split(/[\s.]+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : s.slice(0, 2)).toUpperCase();
}
