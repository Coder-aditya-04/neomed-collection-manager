import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { latestSnapshotQuery, partiesAgeingQuery } from '../../lib/queries.js';
import { formatInr, formatCount, formatDate } from '../../lib/format.js';
import { buildStatementText, statementWhatsAppLink, planBatch } from './statement.js';
import StatementDocument from './StatementDocument.jsx';
import Overlay from '../../components/Overlay.jsx';

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
      <section className="panel panel-lift mb-3 px-4 py-3">
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
          className="w-[220px] rounded-[2px] border border-hair bg-surface px-[10px] py-[5px] text-[12.5px]"
        />
        <label className="block">
          <span className="kicker mb-1 block">Only above</span>
          <input
            type="number"
            value={minAmount}
            onChange={(e) => setMinAmount(Number(e.target.value) || 0)}
            className="tnum w-[110px] rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-right text-[12px]"
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
        <section className="panel panel-lift mb-3 px-4 py-3">
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
              <tr key={p.party_id} className="border-b border-rule last:border-b-0 hover:bg-surface-2">
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

      {preview ? (
        <PreviewDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onShared={async () => {
            await supabase.from('followups').insert({
              party_id: preview.party.party_id,
              method: 'whatsapp',
              outcome: `Statement sent as image — balance as on ${preview.asOf}`,
            });
            setSentIds((s) => new Set(s).add(preview.party.party_id));
            queryClient.invalidateQueries({ queryKey: ['followups'] });
          }}
        />
      ) : null}
    </div>
  );
}

function StatementActions({ party, snapshot, sent, onPreview, onSent }) {
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    const { bills } = await loadBills(party.party_id, snapshot?.id);
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
    const { bills, truncated } = await loadBills(party.party_id, snapshot?.id);
    setBusy(false);
    onPreview({
      party,
      bills,
      truncated,
      asOf: snapshot?.report_date,
      text: buildStatementText(party, bills, { asOf: snapshot?.report_date }),
    });
  }

  return (
    <span className="flex items-center gap-[5px]">
      <button type="button" onClick={show} disabled={busy}
              className="rounded-[2px] border border-hair bg-surface px-[8px] py-[2px] text-[11px] hover:bg-surface-3">
        Statement
      </button>
      <button type="button" onClick={open} disabled={busy || !party.phone}
              className="rounded-[2px] border border-[#25D366] bg-[#25D366]/10 px-[8px] py-[2px] text-[11px] text-[#0B7A3E] disabled:opacity-40">
        {busy ? '…' : 'Send'}
      </button>
      {sent ? <span className="text-[11px] text-teal-deep">sent</span> : null}
    </span>
  );
}

/*
 * Every open bill goes on the statement, however many there are.
 *
 * An earlier version stopped at 60 to keep it short, which was the wrong
 * instinct: the party is reconciling this against their own ledger, and a
 * statement that silently omits 326 bills cannot be reconciled at all. Marg's
 * own report lists them all, so this does too. The cap that remains is a
 * guard against a runaway query, not an editorial choice.
 */
const STATEMENT_BILL_LIMIT = 2000;

/**
 * Credit notes carry a negative balance and belong on a statement — leaving
 * them out would overstate what is owed.
 */
async function loadBills(partyId, snapshotId) {
  if (!snapshotId) return { bills: [], truncated: 0 };
  const { data, count } = await supabase
    .from('bills')
    .select('bill_no, bill_date, balance, bill_amount, received, bill_age_days', { count: 'exact' })
    .eq('party_id', partyId)
    .eq('snapshot_id', snapshotId)
    .neq('balance', 0)
    .order('bill_date', { ascending: true })
    .limit(STATEMENT_BILL_LIMIT);
  const bills = data ?? [];
  return { bills, truncated: Math.max(0, (count ?? bills.length) - bills.length) };
}

/**
 * The statement itself, as the party will see it.
 *
 * Three ways out, because WhatsApp will not take a file from a web page:
 *   Image    — downloads a PNG to attach. What shops actually send.
 *   Print    — the browser's own Save as PDF, for email or filing.
 *   Text     — the wa.me route: one click, but plain text only.
 */
function PreviewDialog({ preview, onClose, onShared }) {
  const docRef = useRef(null);
  const [busy, setBusy] = useState(null);
  // A statement is 780px wide and can run to several pages. Fitting it to the
  // dialog is what makes it reviewable at a glance instead of by scrolling.
  const [fit, setFit] = useState(true);

  /**
   * Hand the image to the phone's own share sheet, which lists WhatsApp.
   *
   * This is the only way a web page can put a FILE into WhatsApp, and it
   * exists only on phones — desktop browsers do not implement file sharing.
   * So: share sheet where it works, download where it does not, and say
   * which is happening rather than leaving a button that quietly does
   * something different depending on the device.
   */
  async function makePng() {
    const { toPng } = await import('html-to-image');
    const url = await toPng(docRef.current, { pixelRatio: 2, backgroundColor: '#ffffff' });
    const blob = await (await fetch(url)).blob();
    const name = `${preview.party.display_name.replace(/[^A-Za-z0-9]+/g, '_')}_statement.png`;
    return { url, file: new File([blob], name, { type: 'image/png' }), name };
  }

  const canShareFiles =
    typeof navigator !== 'undefined' &&
    navigator.canShare &&
    navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] });

  async function shareToWhatsApp() {
    setBusy('share');
    try {
      const { file } = await makePng();
      await navigator.share({
        files: [file],
        title: `Statement — ${preview.party.display_name}`,
        text: preview.text,
      });
      onShared?.();
    } catch (e) {
      // A cancelled share sheet is not a failure worth shouting about.
      if (e?.name !== 'AbortError') console.warn(e);
    } finally {
      setBusy(null);
    }
  }

  async function downloadImage() {
    setBusy('image');
    try {
      const { url, name } = await makePng();
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
    } finally {
      setBusy(null);
    }
  }

  function print() {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(
      // An empty title keeps the browser from stamping the party's name into
      // its own print header on every page. The date and page number are the
      // browser's and can only be removed by the person printing, so the
      // dialog says so.
      `<!doctype html><html><head><title> </title>` +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap">' +
      '<style>@page{size:A4;margin:12mm}body{margin:0}</style></head><body>' +
      docRef.current.outerHTML +
      '</body></html>'
    );
    w.document.close();
    setTimeout(() => w.print(), 600);
  }

  return (
    <Overlay onClose={onClose} label="Statement">
      <div className="overlay-panel overlay-center flex max-h-[92vh] w-[min(860px,94vw)] flex-col border border-hair bg-canvas shadow-[0_0_50px_rgba(15,31,46,.3)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-hair bg-surface px-4 py-3">
          <h3 className="mr-auto truncate text-[14px] font-semibold">{preview.party.display_name}</h3>
          {canShareFiles ? (
            <button type="button" className="btn btn-primary px-3 py-[5px] text-[12px]"
                    onClick={shareToWhatsApp} disabled={busy === 'share'}>
              {busy === 'share' ? 'Preparing…' : 'Send on WhatsApp'}
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary px-3 py-[5px] text-[12px]"
                  onClick={downloadImage} disabled={busy === 'image'}>
            {busy === 'image' ? 'Making image…' : 'Download image'}
          </button>
          <button type="button" className="btn btn-secondary px-3 py-[5px] text-[12px]" onClick={print}>
            Print / PDF
          </button>
          <button type="button" className="btn btn-secondary px-3 py-[5px] text-[12px]"
                  onClick={() => navigator.clipboard?.writeText(preview.text)}>
            Copy text
          </button>
          <button type="button" className="btn btn-secondary px-3 py-[5px] text-[12px]"
                  onClick={() => setFit((f) => !f)}>
            {fit ? 'Actual size' : 'Fit to window'}
          </button>
          <button type="button" className="btn btn-secondary px-3 py-[5px] text-[12px]" onClick={onClose}>
            Close
          </button>
        </div>

        {/*
          * `zoom` rather than `transform: scale()`. A transform on a subtree
          * this tall creates one enormous composite layer that the browser
          * repaints whole on every scroll; zoom reflows once and then scrolls
          * like ordinary content. `contain` keeps the work inside this box.
          */}
        <div className="min-h-0 flex-1 overflow-auto bg-canvas p-5"
             style={{ contain: 'content' }}>
          <div
            className="mx-auto shadow-[0_2px_14px_rgba(15,31,46,.18)]"
            style={{ width: 780, zoom: fit ? 0.8 : 1 }}
          >
            <StatementDocument
              ref={docRef}
              party={preview.party}
              bills={preview.bills}
              asOf={preview.asOf}
              truncated={preview.truncated ?? 0}
            />
          </div>
        </div>

        <div className="border-t border-hair bg-surface px-4 py-2 text-[11px] text-faint text-pretty">
          {canShareFiles
            ? 'Send on WhatsApp opens your phone\'s share sheet with the statement attached — pick WhatsApp, pick the contact, send.'
            : 'On a computer, browsers will not hand a file to WhatsApp. Download the image and attach it, or open this page on your phone, where Send on WhatsApp attaches it directly. When printing, untick “Headers and footers” in the print dialog to drop the browser\'s own date and page stamp.'}
        </div>
      </div>
    </Overlay>
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

function Msg({ children }) {
  return (
    <div className="animate-screen-in px-[18px] pt-4">
      <div className="panel p-[14px] text-[12.5px] text-mute">{children}</div>
    </div>
  );
}
