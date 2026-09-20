import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { formatInr, formatCount, formatAge } from '../../lib/format.js';
import { whatsAppLink } from '../registers/Registers.jsx';

/**
 * Money received but not yet settled against a bill.
 *
 * A party buys for 50,000 and pays 30,000, then 20,000 two days later.
 * Marg reduces their ledger balance by the whole amount, but the 20,000 was
 * never pointed at a particular invoice — so the party's header total and the
 * sum of their bill rows disagree by exactly that much.
 *
 * That gap is not a discrepancy to investigate. It is cash already banked,
 * waiting for someone to ring the party, agree which bills it clears, and
 * enter the allocation in Marg. Until that happens those bills keep ageing as
 * though nothing was paid.
 */
export default function UnallocatedScreen() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['unallocated'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_unallocated_receipts')
        .select('*')
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.toUpperCase().trim();
    let out = (data ?? []).filter((r) => r.gap_type === 'receipt_unallocated');
    if (q) out = out.filter((r) => r.display_name.toUpperCase().includes(q));
    return out;
  }, [data, query]);

  const reverse = (data ?? []).filter((r) => r.gap_type === 'bills_short');
  const total = rows.reduce((a, r) => a + Number(r.unallocated), 0);

  if (error) return <Msg tone="error">{error.message}</Msg>;
  if (isLoading) return <Msg>Loading…</Msg>;

  return (
    <div className="animate-screen-in flex h-full min-h-0 flex-col px-[18px] pb-4 pt-4">
      <section className="panel mb-3 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
            <span className="tnum">{formatInr(total)}</span> received but not allocated
          </h2>
          <span className="tnum text-[12px] text-mute">
            {formatCount(rows.length)} parties
          </span>
        </div>
        <p className="mt-2 max-w-[100ch] text-[12px] text-pretty">
          These parties have paid money that Marg has credited to their ledger but that was never
          settled against particular bills — usually a part payment made a day or two after the
          first. Their balance is already reduced, but the bills keep ageing as though nothing
          arrived.
        </p>
        <p className="mt-1 max-w-[100ch] text-[11.5px] text-mute text-pretty">
          <strong>What to do:</strong> ring the party, agree which bills the money clears, and enter
          the allocation in Marg. The gap disappears from this list on the next import.
        </p>
      </section>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search parties…"
          className="w-[240px] rounded-[2px] border border-hair bg-white px-[10px] py-[5px] text-[12.5px]"
        />
        <span className="tnum ml-auto text-[11.5px] text-mute">
          {formatCount(rows.length)} shown
        </span>
      </div>

      <div className="panel min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th>Party</Th>
              <Th align="right" width="110px">To allocate</Th>
              <Th align="right" width="110px">Marg balance</Th>
              <Th align="right" width="110px">Bills total</Th>
              <Th align="right" width="80px">Bills</Th>
              <Th align="right" width="80px">Oldest</Th>
              <Th width="170px">Contact</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.party_id} className="border-b border-rule last:border-b-0 hover:bg-[#F7FAFB]">
                <td className="px-[10px] py-[6px]">
                  <span className="font-medium">{r.display_name}</span>
                  {r.contact_person ? (
                    <span className="ml-2 text-[11px] text-faint">{r.contact_person}</span>
                  ) : null}
                </td>
                <td className="tnum px-[10px] py-[6px] text-right font-semibold text-age-2">
                  {formatInr(r.unallocated)}
                </td>
                <td className="tnum px-[10px] py-[6px] text-right">{formatInr(r.marg_balance)}</td>
                <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatInr(r.bills_total)}</td>
                <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatCount(r.bill_count)}</td>
                <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatAge(r.oldest_bill_age_days)}</td>
                <td className="px-[10px] py-[6px]">
                  <Contact row={r} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-[10px] py-4 text-center text-[12px] text-faint">
                Nothing unallocated. Every party's bills add up to their Marg balance.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {reverse.length > 0 ? (
        <section className="panel mt-3 border-l-[3px] border-l-[#C9A93E] px-4 py-3">
          <div className="kicker text-[#7A6410]">The other direction — {formatCount(reverse.length)} parties</div>
          <p className="mt-1 max-w-[100ch] text-[12px] text-pretty">
            Here the bills add up to <em>less</em> than the Marg balance, which is the opposite
            problem: the ledger carries more than the open bills account for. Worth a look from
            accounts rather than a call to the party.
          </p>
          <ul className="mt-2 grid gap-[3px]">
            {reverse.slice(0, 8).map((r) => (
              <li key={r.party_id} className="flex items-baseline justify-between gap-3 text-[12px]">
                <span className="truncate">{r.display_name}</span>
                <span className="tnum flex-none font-medium">{formatInr(Math.abs(r.unallocated))}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Contact({ row }) {
  const wa = whatsAppLink(row.phone, {
    display_name: row.display_name,
    contact_person: row.contact_person,
    current_outstanding: row.marg_balance,
  });
  if (!row.phone) return <span className="text-[10.5px] text-faint">no number</span>;
  return (
    <span className="flex items-center gap-[5px]">
      <a href={`tel:${String(row.phone).replace(/[^\d+]/g, '')}`}
         className="rounded-[2px] border border-hair bg-white px-[7px] py-[2px] text-[10.5px] text-ink no-underline hover:bg-[#F2F6F8]">
        Call
      </a>
      {wa ? (
        <a href={wa} target="_blank" rel="noreferrer"
           className="rounded-[2px] border border-[#25D366] bg-[#25D366]/10 px-[7px] py-[2px] text-[10.5px] text-[#0B7A3E] no-underline hover:bg-[#25D366]/20">
          WhatsApp
        </a>
      ) : null}
    </span>
  );
}

function Th({ children, align = 'left', width }) {
  return (
    <th className="sticky top-0 z-10 border-b border-hair bg-white/95 px-[10px] py-[7px] text-[10px] font-semibold uppercase tracking-[0.09em] text-mute backdrop-blur"
        style={{ textAlign: align, width }}>
      {children}
    </th>
  );
}

function Msg({ children, tone }) {
  return (
    <div className="animate-screen-in px-[18px] pt-4">
      <div className={`panel p-[14px] text-[12.5px] ${tone === 'error' ? 'border-l-[3px] border-l-age-3' : 'text-mute'}`}>
        {children}
      </div>
    </div>
  );
}
