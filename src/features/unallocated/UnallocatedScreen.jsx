import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { latestSnapshotQuery } from '../../lib/queries.js';
import { formatInr, formatCount, formatAge, formatDate } from '../../lib/format.js';
import { whatsAppLink } from '../registers/Registers.jsx';
import { displayBillNo, plain } from '../statements/StatementDocument.jsx';
import Overlay from '../../components/Overlay.jsx';

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
  const [open, setOpen] = useState(null);

  const rows = useMemo(() => {
    const q = query.toUpperCase().trim();
    let out = data ?? [];
    if (q) out = out.filter((r) => r.display_name.toUpperCase().includes(q));
    return out;
  }, [data, query]);

  const total = rows.reduce((a, r) => a + Number(r.unallocated), 0);

  if (error) return <Msg tone="error">{error.message}</Msg>;
  if (isLoading) return <Msg>Loading…</Msg>;

  return (
    <div className="animate-screen-in flex h-full min-h-0 flex-col px-[18px] pb-4 pt-4">
      <section className="panel panel-lift mb-3 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
            <span className="tnum">{formatInr(total)}</span> received but not allocated
          </h2>
          <span className="tnum text-[12px] text-mute">
            {formatCount(rows.length)} parties
          </span>
        </div>
        <p className="mt-2 max-w-[100ch] text-[12px] text-pretty">
          Marg holds these receipts against the party's name without them being applied to any
          particular bill — usually a part payment made a day or two after the first. The party's
          balance is already reduced, but the invoices keep ageing as though nothing arrived.
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
          className="w-[240px] rounded-[2px] border border-hair bg-surface px-[10px] py-[5px] text-[12.5px]"
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
              <Th align="right" width="115px">Received, unapplied</Th>
              <Th align="right" width="70px">Receipts</Th>
              <Th align="right" width="110px">Marg balance</Th>
              <Th align="right" width="80px">Bills</Th>
              <Th align="right" width="80px">Oldest</Th>
              <Th width="170px">Contact</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.party_id}
                  onClick={() => setOpen(r)}
                  className="cursor-pointer border-b border-rule last:border-b-0 hover:bg-surface-2">
                <td className="px-[10px] py-[6px]">
                  <span className="font-medium">{r.display_name}</span>
                  {r.contact_person ? (
                    <span className="ml-2 text-[11px] text-faint">{r.contact_person}</span>
                  ) : null}
                </td>
                <td className="tnum px-[10px] py-[6px] text-right font-semibold text-age-2">
                  {formatInr(r.unallocated)}
                </td>
                <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatCount(r.receipt_count)}</td>
                <td className="tnum px-[10px] py-[6px] text-right">{formatInr(r.marg_balance)}</td>
                <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatCount(r.bill_count)}</td>
                <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatAge(r.oldest_bill_age_days)}</td>
                <td className="px-[10px] py-[6px]" onClick={(e) => e.stopPropagation()}>
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

      {open ? <BillsDrawer row={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/**
 * The bills the money could be set against.
 *
 * This is what the call is actually about: the party paid, the payment sits
 * against their name, and somebody has to agree which invoices it clears.
 * Oldest first, because those are the ones that have been ageing while the
 * money sat unapplied.
 */
function BillsDrawer({ row, onClose }) {
  const { data: snapshot } = useQuery(latestSnapshotQuery());
  const { data: bills, isLoading } = useQuery({
    queryKey: ['unallocated-bills', row.party_id, snapshot?.id],
    enabled: Boolean(snapshot?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bills')
        .select('bill_no, bill_date, bill_amount, received, balance, bill_age_days, is_on_account')
        .eq('party_id', row.party_id)
        .eq('snapshot_id', snapshot.id)
        .neq('balance', 0)
        .order('bill_date', { ascending: true })
        .limit(2000);
      if (error) throw error;
      return data ?? [];
    },
  });

  /*
   * Two kinds of row, and the difference is the whole point of the screen:
   * the receipts that arrived and were never applied, and the invoices they
   * could be applied to. The sheet the client works from colours them apart,
   * so this does too.
   */
  const all = bills ?? [];
  const receipts = all.filter((b) => b.is_on_account && Number(b.balance) < 0);
  const invoices = all.filter((b) => !(b.is_on_account && Number(b.balance) < 0));

  // How far the unapplied money reaches against the oldest invoices.
  let remaining = Number(row.unallocated);
  const covered = invoices.map((b) => {
    const bal = Number(b.balance);
    const take = bal > 0 ? Math.max(0, Math.min(remaining, bal)) : 0;
    remaining -= take;
    return { ...b, covers: take };
  });
  const clears = covered.filter((b) => b.covers > 0 && b.covers >= Number(b.balance) - 1).length;

  return (
    <Overlay onClose={onClose} label={row.display_name}>
      <aside className="overlay-panel overlay-drawer flex w-[min(720px,95vw)] flex-col border-l border-hair bg-canvas shadow-[0_0_44px_rgba(15,31,46,.28)]">
        <header className="border-b border-hair bg-surface/85 px-[18px] py-3 backdrop-blur">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[16px] font-semibold tracking-[-0.015em]">{row.display_name}</h2>
              <p className="mt-1 max-w-[70ch] text-[11.5px] text-mute text-pretty">
                They have paid <strong className="tnum">{formatInr(row.unallocated)}</strong> that is
                sitting against their name without being applied to any bill. Agree on the call
                which of these it clears, then enter it in Marg.
              </p>
            </div>
            <button type="button" onClick={onClose} className="btn btn-secondary px-3 py-1 text-[12px]">Close</button>
          </div>

          <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-px bg-hair">
            <Fig label="Received, unapplied" value={formatInr(row.unallocated)} tone="var(--color-age-2)" />
            <Fig label="Receipts" value={formatCount(row.receipt_count)} />
            <Fig label="Marg balance" value={formatInr(row.marg_balance)} />
            <Fig label="Would clear" value={`${formatCount(clears)} bills`} tone="var(--color-teal-deep)" />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-[18px] py-3">
          {isLoading ? (
            <p className="text-[12px] text-mute">Loading bills…</p>
          ) : (
          <>
            {/* The money itself, listed first — it is what the call is about. */}
            <div className="mb-3 border border-age-2/40 bg-age-2/[0.07]">
              <div className="border-b border-age-2/30 px-3 py-[7px] text-[10px] font-semibold uppercase tracking-[0.09em] text-age-2">
                Received, not applied to any bill · {formatCount(receipts.length)}
              </div>
              <table className="w-full border-collapse text-[11.5px]">
                <tbody>
                  {receipts.map((b, i) => (
                    <tr key={`r-${i}`} className="border-t border-age-2/20 first:border-t-0">
                      <td className="px-[9px] py-[5px] font-mono">{displayBillNo(b.bill_no)}</td>
                      <td className="px-[9px] py-[5px] font-mono text-mute">{formatDate(b.bill_date)}</td>
                      <td className="tnum px-[9px] py-[5px] text-right text-mute">
                        {b.bill_age_days != null ? `${b.bill_age_days}d ago` : ''}
                      </td>
                      <td className="tnum px-[9px] py-[5px] text-right font-semibold text-age-2">
                        {plain(-Number(b.balance))}
                      </td>
                    </tr>
                  ))}
                  {receipts.length === 0 ? (
                    <tr><td className="px-[9px] py-[6px] text-[11.5px] text-faint">
                      No unapplied receipts on this snapshot.
                    </td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-mute">
              Open bills it could be set against
            </div>
            <div className="border border-hair bg-surface">
              <table className="w-full border-collapse text-[11.5px]">
                <thead>
                  <tr>
                    <Th2>Bill no.</Th2><Th2>Bill date</Th2>
                    <Th2 align="right">Bill amt.</Th2><Th2 align="right">Received</Th2>
                    <Th2 align="right">Balance</Th2><Th2 align="right">Days</Th2>
                    <Th2 align="right">Covered</Th2>
                  </tr>
                </thead>
                <tbody>
                  {covered.map((b, i) => (
                    <tr key={`${b.bill_no}-${i}`}
                        className={`border-t border-rule ${b.covers > 0 ? 'bg-teal/10' : ''} ${Number(b.balance) < 0 ? 'text-claim' : ''}`}>
                      <td className="px-[9px] py-[5px] font-mono">{displayBillNo(b.bill_no)}</td>
                      <td className="px-[9px] py-[5px] font-mono text-mute">{formatDate(b.bill_date)}</td>
                      <td className="tnum px-[9px] py-[5px] text-right">{plain(b.bill_amount)}</td>
                      <td className="tnum px-[9px] py-[5px] text-right text-mute">{plain(b.received)}</td>
                      <td className="tnum px-[9px] py-[5px] text-right font-semibold">{plain(b.balance)}</td>
                      <td className="tnum px-[9px] py-[5px] text-right text-mute">{b.bill_age_days ?? ''}</td>
                      <td className="tnum px-[9px] py-[5px] text-right text-teal-deep">
                        {b.covers > 0 ? plain(b.covers) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
          )}
          <p className="mt-2 text-[11px] text-faint text-pretty">
            The green rows are how far the unapplied money reaches if it is set against the oldest
            bills first. That is a suggestion for the conversation, not an instruction — the party
            may well have meant it for particular invoices.
          </p>
        </div>
      </aside>
    </Overlay>
  );
}

function Fig({ label, value, tone }) {
  return (
    <div className="bg-surface/85 px-3 py-2">
      <div className="kicker">{label}</div>
      <div className="tnum mt-[2px] text-[14px] font-medium" style={{ color: tone ?? 'inherit' }}>{value}</div>
    </div>
  );
}

function Th2({ children, align = 'left' }) {
  return (
    <th className="sticky top-0 border-b border-hair bg-surface px-[9px] py-[6px] text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mute"
        style={{ textAlign: align }}>{children}</th>
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
         className="rounded-[2px] border border-hair bg-surface px-[7px] py-[2px] text-[10.5px] text-ink no-underline hover:bg-surface-3">
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
    <th className="sticky top-0 z-10 border-b border-hair bg-surface/95 px-[10px] py-[7px] text-[10px] font-semibold uppercase tracking-[0.09em] text-mute backdrop-blur"
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
