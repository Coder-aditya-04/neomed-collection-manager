import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { formatInr, formatCount, formatDate } from '../../lib/format.js';

/**
 * Users and roles, the thresholds the rules read, the category defaults, and
 * the import history with its warnings.
 */
export default function SettingsScreen() {
  const qc = useQueryClient();

  const { data: users } = useQuery({
    queryKey: ['app-users'],
    queryFn: async () => {
      const { data, error } = await supabase.from('app_users').select('*').order('full_name');
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data, error } = await supabase.from('settings').select('*');
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: snapshots } = useQuery({
    queryKey: ['snapshots-all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('snapshots')
        .select('*')
        .order('report_date', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const latest = snapshots?.[0];

  const { data: warnings } = useQuery({
    queryKey: ['warnings', latest?.id],
    enabled: Boolean(latest?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('import_warnings')
        .select('warning_type, detail')
        .eq('snapshot_id', latest.id)
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const threshold = settings?.find((s) => s.key === 'small_balance_threshold')?.value ?? 10000;
  const categoryDefaults = settings?.find((s) => s.key === 'category_defaults')?.value ?? {};
  const [draft, setDraft] = useState(null);

  const saveThreshold = useMutation({
    mutationFn: async (v) => {
      const { error } = await supabase.from('settings').update({ value: Number(v) }).eq('key', 'small_balance_threshold');
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries();
      setDraft(null);
    },
  });

  const warningCounts = (warnings ?? []).reduce((acc, w) => {
    acc[w.warning_type] = (acc[w.warning_type] ?? 0) + 1;
    return acc;
  }, {});

  const WARNING_LABELS = {
    header_vs_bills_mismatch: 'Header total disagrees with the sum of bill rows — the header figure was used',
    credit_balance: 'Credit balances — advances or unadjusted credit notes, excluded from collection',
    party_without_bills: 'Carries a balance but has no bill rows, so cannot be aged',
    marg_due_date_present: 'Marg already carries a due date — a recorded credit period, shown for review, NOT applied',
    duplicate_bill_no: 'Repeated bill number, stored under a suffixed key so no row is lost',
    duplicate_party_name: 'Two spellings normalise to the same name; balances and bills merged',
    orphan_bill_rows: 'Bill rows with no party header above them — not imported',
    original_not_archived: 'The original export was not saved to storage, so this snapshot has no audit copy',
  };

  return (
    <div className="animate-screen-in grid gap-4 px-[18px] pb-[34px] pt-4">
      <Section title="Team">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th>Name</Th><Th>Role</Th><Th>Can write</Th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id} className="border-b border-rule last:border-b-0">
                <td className="px-[10px] py-[6px] font-medium">{u.full_name}</td>
                <td className="px-[10px] py-[6px]">{u.role}</td>
                <td className="px-[10px] py-[6px] text-mute">
                  {u.role === 'owner'
                    ? 'everything, including settings and roles'
                    : u.role === 'accounts'
                      ? 'credit terms, claims, follow-ups, promises, imports'
                      : 'follow-ups and promises only'}
                </td>
              </tr>
            ))}
            {!users?.length ? <tr><td colSpan={3} className="px-[10px] py-3 text-faint">No users yet.</td></tr> : null}
          </tbody>
        </table>
        <p className="mt-2 px-[10px] text-[11px] text-faint text-pretty">
          Roles are enforced by the database, not by the interface. A salesperson cannot write a
          credit term even if they reach the API directly.
        </p>
      </Section>

      <Section title="Thresholds">
        <div className="flex flex-wrap items-end gap-3 px-[10px] py-2">
          <label className="block">
            <span className="kicker mb-1 block">Small balance threshold</span>
            <input
              type="number"
              value={draft ?? threshold}
              onChange={(e) => setDraft(e.target.value)}
              className="tnum w-[130px] rounded-[2px] border border-hair bg-white px-[8px] py-[4px] text-right text-[12px]"
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={draft === null || Number(draft) === Number(threshold) || saveThreshold.isPending}
            onClick={() => saveThreshold.mutate(draft)}
          >
            Save
          </button>
          <p className="max-w-[60ch] text-[11.5px] text-mute text-pretty">
            Parties owing less than {formatInr(threshold)} are left out of the priority list. Chasing
            them costs more than they are worth.
          </p>
        </div>
      </Section>

      <Section title="Category defaults">
        <p className="px-[10px] pb-2 pt-1 text-[11.5px] text-mute text-pretty">
          These are assumptions, never approved terms. Applying one records the party as
          <em> category default</em>, and every screen that shows it says so.
        </p>
        <table className="w-full border-collapse text-[12px]">
          <thead><tr><Th>Category</Th><Th>Model</Th><Th>Terms</Th></tr></thead>
          <tbody>
            {Object.entries(categoryDefaults).map(([cat, d]) => (
              <tr key={cat} className="border-b border-rule last:border-b-0">
                <td className="px-[10px] py-[6px] font-medium">{cat}</td>
                <td className="px-[10px] py-[6px]">{d.credit_type}</td>
                <td className="px-[10px] py-[6px] text-mute">
                  {d.credit_type === 'days'
                    ? `${d.credit_days} days from bill date`
                    : `submit by ${d.cycle_submit_day}, paid ${d.cycle_pay_day}, ${d.cycle_lag_months === 0 ? 'same month' : 'next month'}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Import history">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th>Report date</Th><Th>File</Th><Th align="right">Parties</Th>
              <Th align="right">Bills</Th><Th align="right">Net</Th><Th>Archived</Th>
            </tr>
          </thead>
          <tbody>
            {(snapshots ?? []).map((s) => (
              <tr key={s.id} className="border-b border-rule last:border-b-0">
                <td className="px-[10px] py-[6px] font-medium">{formatDate(s.report_date)}</td>
                <td className="px-[10px] py-[6px] font-mono text-[11px] text-mute">{s.file_name}</td>
                <td className="tnum px-[10px] py-[6px] text-right">{formatCount(s.party_count)}</td>
                <td className="tnum px-[10px] py-[6px] text-right">{formatCount(s.bill_count)}</td>
                <td className="tnum px-[10px] py-[6px] text-right font-medium">{formatInr(s.net_total)}</td>
                <td className="px-[10px] py-[6px] text-[11px]">
                  {s.storage_path ? <span className="text-teal-deep">yes</span> : <span className="text-age-2">no audit copy</span>}
                </td>
              </tr>
            ))}
            {!snapshots?.length ? <tr><td colSpan={6} className="px-[10px] py-3 text-faint">Nothing imported yet.</td></tr> : null}
          </tbody>
        </table>
        <p className="mt-2 px-[10px] text-[11px] text-faint text-pretty">
          Snapshots are immutable. Correcting a figure means importing a new export, never editing
          an old one.
        </p>
      </Section>

      <Section title={`Warnings from the ${formatDate(latest?.report_date)} import`}>
        {Object.keys(warningCounts).length === 0 ? (
          <p className="px-[10px] py-2 text-[12px] text-faint">No warnings.</p>
        ) : (
          <ul className="grid gap-[6px] px-[10px] py-2">
            {Object.entries(warningCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <li key={type} className="flex items-baseline gap-[10px] text-[12px]">
                  <span className="tnum w-[42px] flex-none text-right font-medium">{formatCount(count)}</span>
                  <span className="text-mute text-pretty">{WARNING_LABELS[type] ?? type}</span>
                </li>
              ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="panel">
      <div className="border-b border-hair px-4 py-[9px]">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h2>
      </div>
      <div className="py-1">{children}</div>
    </section>
  );
}

function Th({ children, align = 'left' }) {
  return (
    <th
      className="border-b border-hair px-[10px] py-[7px] text-[10px] font-semibold uppercase tracking-[0.09em] text-mute"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}
