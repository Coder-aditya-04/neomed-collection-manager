import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { latestSnapshotQuery, partiesAgeingQuery } from '../../lib/queries.js';
import { formatInr, formatCount, formatDate } from '../../lib/format.js';
import { buildStatementText, statementWhatsAppLink, planBatch } from './statement.js';

/**
 * Month-end statements.
 *
 * The job this replaces: picking parties out of a spreadsheet one at a time,
 * typing the figures into WhatsApp, and sending. Here the figures come from
 * the snapshot and the message is composed for you; you still press send on
 * each one, because WhatsApp has no way for software to send on your behalf
 * and pretending otherwise would be a lie.
 *
 * What it removes is the assembling, the copying, and the arithmetic.
 */
export default function StatementsScreen() {
  const { data: parties, isLoading } = useQuery(partiesAgeingQuery());
  const { data: snapshot } = useQuery(latestSnapshotQuery());
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const [minAmount, setMinAmount] = useState(10000);
  const [selected, setSelected] = useState(() => new Set());
  const [preview, setPreview] = useState(null);
  const [sentIds, setSentIds] = useState(() => new Set());

  const candidates = useMemo(() => {
    if (!parties) return [];
    const q = query.toUpperCase().trim();
    return parties
      .filter((p) => Number(p.current_outstanding) >= minAmount)
      .filter((p) => (q ? p.display_name.toUpperCase().includes(q) : true))
      .sort((a, b) => Number(b.current_outstanding) - Number(a.current_outstanding));
  }, [parties, query, minAmount]);

  const chosen = candidates.filter((p) => selected.has(p.party_id));
  const plan = useMemo(() => planBatch(chosen), [chosen]);

  if (isLoading) return <Msg>Loading…</Msg>;
  if (!parties?.length) return <Msg>Import a Marg export first.</Msg>;

  return (
    <div className="animate-screen-in flex h-full min-h-0 flex-col px-[18px] pb-4 pt-4">
      <section className="panel mb-3 px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Send statements on WhatsApp</h2>
        <p className="mt-1 max-w-[100ch] text-[12px] text-mute text-pretty">
          Pick the parties, check the message, and send. Every figure comes from the{' '}
          {formatDate(snapshot?.report_date)} snapshot, so a statement can never disagree with the
          book. WhatsApp opens with the message written; you press send.
        </p>
      </section>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search parties…"
          className="w-[220px] rounded-[2px] border border-hair bg-white px-[10px] py-[5px] text-[12.5px]"
        />
        <label className="block">
          <span className="kicker mb-1 block">Only above</span>
          <input
            type="number"
            value={minAmount}
            onChange={(e) => setMinAmount(Number(e.target.value) || 0)}
            className="tnum w-[110px] rounded-[2px] border border-hair bg-white px-[8px] py-[4px] text-right text-[12px]"
          />
        </label>
        <button type="button" className="btn btn-secondary"
                onClick={() => setSelected(new Set(candidates.slice(0, 50).map((p) => p.party_id)))}>
          Select top 50
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setSelected(new Set())}>
          Clear
        </button>
        <span className="tnum ml-auto text-[11.5px] text-mute">
          {formatCount(candidates.length)} parties · {formatCount(selected.size)} selected
        </span>
      </div>

      {selected.size > 0 ? (
        <section className="panel mb-3 px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-4">
            <span className="text-[13px] font-semibold">
              {formatCount(plan.sendable.length)} ready to send · {formatInr(plan.sendableValue)}
            </span>
            {plan.missingNumber.length > 0 ? (
              <span className="text-[12px] text-age-2">
                {formatCount(plan.missingNumber.length)} have no mobile number ({formatInr(plan.missingValue)}) — add
                one from the party drawer
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-[11px] text-faint text-pretty">
            Each opens WhatsApp in a new tab. Browsers block a burst of tabs opened at once, so send
            them one at a time down the list — the tick records that you did.
          </p>
        </section>
      ) : null}

      <div className="panel min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th width="34px" />
              <Th>Party</Th>
              <Th align="right" width="110px">Outstanding</Th>
              <Th align="right" width="70px">Bills</Th>
              <Th width="120px">Mobile</Th>
              <Th width="210px">Statement</Th>
            </tr>
          </thead>
          <tbody>
            {candidates.slice(0, 250).map((p) => (
              <tr key={p.party_id} className="border-b border-rule last:border-b-0 hover:bg-[#F7FAFB]">
                <td className="px-[10px] py-[6px]">
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.display_name}`}
                    checked={selected.has(p.party_id)}
                    onChange={(e) => setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(p.party_id); else next.delete(p.party_id);
                      return next;
                    })}
                  />
                </td>
                <td className="px-[10px] py-[6px] font-medium">{p.display_name}</td>
                <td className="tnum px-[10px] py-[6px] text-right font-medium">{formatInr(p.current_outstanding)}</td>
                <td className="tnum px-[10px] py-[6px] text-right text-mute">{formatCount(p.bill_count)}</td>
                <td className="tnum px-[10px] py-[6px] text-[11px]">
                  {p.phone || <span className="text-faint">not set</span>}
                </td>
                <td className="px-[10px] py-[6px]">
                  <StatementActions
                    party={p}
                    snapshot={snapshot}
                    sent={sentIds.has(p.party_id)}
                    onPreview={setPreview}
                    onSent={() => {
                      setSentIds((s) => new Set(s).add(p.party_id));
                      queryClient.invalidateQueries({ queryKey: ['followups'] });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview ? <PreviewDialog preview={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

function StatementActions({ party, snapshot, sent, onPreview, onSent }) {
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    const bills = await loadBills(party.party_id, snapshot?.id);
    const link = statementWhatsAppLink(party, bills, { asOf: snapshot?.report_date });
    setBusy(false);
    if (!link) return;
    window.open(link, '_blank', 'noopener');
    // Sending a statement is a contact, so it belongs in the follow-up log
    // like any other — that is what makes "how many WhatsApps has this party
    // had" answerable later.
    await supabase.from('followups').insert({
      party_id: party.party_id,
      method: 'whatsapp',
      outcome: `Statement sent — ${party.bill_count} bills, balance as on ${snapshot?.report_date}`,
    });
    onSent();
  }

  async function show() {
    setBusy(true);
    const bills = await loadBills(party.party_id, snapshot?.id);
    setBusy(false);
    onPreview({
      party,
      text: buildStatementText(party, bills, { asOf: snapshot?.report_date }),
    });
  }

  return (
    <span className="flex items-center gap-[5px]">
      <button type="button" onClick={show} disabled={busy}
              className="rounded-[2px] border border-hair bg-white px-[8px] py-[2px] text-[11px] hover:bg-[#F2F6F8]">
        Preview
      </button>
      <button type="button" onClick={open} disabled={busy || !party.phone}
              className="rounded-[2px] border border-[#25D366] bg-[#25D366]/10 px-[8px] py-[2px] text-[11px] text-[#0B7A3E] disabled:opacity-40">
        {busy ? '…' : 'Send'}
      </button>
      {sent ? <span className="text-[11px] text-teal-deep">sent</span> : null}
    </span>
  );
}

async function loadBills(partyId, snapshotId) {
  if (!snapshotId) return [];
  const { data } = await supabase
    .from('bills')
    .select('bill_no, bill_date, balance')
    .eq('party_id', partyId)
    .eq('snapshot_id', snapshotId)
    .gt('balance', 0)
    .order('bill_date', { ascending: true })
    .limit(200);
  return data ?? [];
}

function PreviewDialog({ preview, onClose }) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/40" onClick={onClose} aria-hidden />
      <div role="dialog" aria-label="Statement preview"
           className="fixed left-1/2 top-1/2 z-50 w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 border border-hair bg-white shadow-[0_0_40px_rgba(15,31,46,.25)]">
        <div className="flex items-center justify-between border-b border-hair px-4 py-3">
          <h3 className="truncate text-[14px] font-semibold">{preview.party.display_name}</h3>
          <button type="button" className="btn btn-secondary px-3 py-1 text-[12px]" onClick={onClose}>Close</button>
        </div>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11.5px] leading-[1.6]">
{preview.text}
        </pre>
        <div className="flex gap-2 border-t border-hair px-4 py-3">
          <button type="button" className="btn btn-secondary"
                  onClick={() => navigator.clipboard?.writeText(preview.text)}>
            Copy text
          </button>
        </div>
      </div>
    </>
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

function Msg({ children }) {
  return (
    <div className="animate-screen-in px-[18px] pt-4">
      <div className="panel p-[14px] text-[12.5px] text-mute">{children}</div>
    </div>
  );
}
