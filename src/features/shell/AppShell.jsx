import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { formatDate } from '../../lib/format.js';

/**
 * The sidebar carries every route in the spec, including the ones later build
 * steps will fill in. Hiding them would misrepresent the shape of the product;
 * each unbuilt one says which step it arrives in, so nobody clicks expecting
 * a screen that is not there yet.
 */
const NAV = [
  { to: '/', label: 'Today', step: null },
  { to: '/parties', label: 'Parties', step: null },
  { to: '/credit-master', label: 'Credit master', step: null },
  { to: '/followups', label: 'Follow-ups', step: 7 },
  { to: '/promises', label: 'Promises', step: 7 },
  { to: '/claims', label: 'Claims', step: 7 },
  { to: '/assistant', label: 'Assistant', step: 9 },
  { to: '/import', label: 'Import', step: null },
  { to: '/settings', label: 'Settings', step: 7 },
];

const TITLES = {
  '/': ['Today', 'The current position across the book'],
  '/parties': ['Parties', 'All parties · sort, filter, search'],
  '/credit-master': ['Credit master', 'Fill the top 100 and most of the book becomes judgeable'],
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
      <nav className="sticky top-0 flex h-screen w-[168px] flex-none flex-col border-r border-hair bg-white/70 backdrop-blur-lg">
        <div className="flex items-center gap-2 border-b border-hair px-3 py-3">
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
                    ? 'bg-teal/[0.07] font-semibold text-teal-deep shadow-[inset_2px_0_0_var(--color-teal)]'
                    : 'text-ink hover:bg-[#f2f6f8]',
                ].join(' ')
              }
            >
              <span className="truncate">{item.label}</span>
              {item.step ? (
                <span className="flex-none font-mono text-[9px] text-faint" title={`Arrives in build step ${item.step}`}>
                  {item.step}
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
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-[14px] border-b border-hair bg-white/[0.72] px-[18px] py-[9px] backdrop-blur-lg">
          <div className="text-[17px] font-semibold leading-[1.1] tracking-[-0.015em]">{title}</div>
          <div className="max-w-[46ch] text-[11.5px] text-mute text-pretty">{subtitle}</div>
          <div className="ml-auto">
            <SnapshotBadge snapshot={snapshot} />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
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
