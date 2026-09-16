import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { buildPreview, commitImport } from './importPipeline.js';
import { formatCount, formatInr, formatInrDelta, formatDate } from '../../lib/format.js';

const STEPS = ['Drop file', 'Parse preview', 'Confirm', 'Result'];

export default function ImportScreen() {
  const [stage, setStage] = useState('drop'); // drop | preview | running | done
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState({ phase: '', done: 0, total: 0 });
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const queryClient = useQueryClient();

  const stepIndex = { drop: 0, preview: 1, running: 2, done: 3 }[stage];

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    setStage('preview');
    setPreview(null);
    try {
      setPreview(await buildPreview(file));
    } catch (e) {
      setError(e.message ?? String(e));
      setStage('drop');
    }
  }, []);

  const confirm = useCallback(async () => {
    setStage('running');
    setError(null);
    try {
      const outcome = await commitImport(preview, { onProgress: setProgress });
      setResult(outcome);
      setStage('done');
      queryClient.invalidateQueries();
    } catch (e) {
      setError(e.message ?? String(e));
      setStage('preview');
    }
  }, [preview, queryClient]);

  const reset = () => {
    setStage('drop');
    setPreview(null);
    setResult(null);
    setError(null);
    setProgress({ phase: '', done: 0, total: 0 });
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="animate-screen-in px-[18px] pb-[34px] pt-4">
      <ol className="mb-4 flex border border-hair">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={[
              'flex flex-1 flex-col gap-[2px] border-r border-hair px-[13px] py-[9px] last:border-r-0',
              i === stepIndex ? 'bg-white shadow-[inset_0_-2px_0_var(--color-teal)]' : 'bg-[#f7f9fa]',
              i <= stepIndex ? 'opacity-100' : 'opacity-45',
            ].join(' ')}
            aria-current={i === stepIndex ? 'step' : undefined}
          >
            <span className="font-mono text-[10px] text-faint">0{i + 1}</span>
            <span className="text-[12.5px] font-semibold">{label}</span>
          </li>
        ))}
      </ol>

      {error ? (
        <div className="panel mb-4 border-l-[3px] border-l-age-3 p-[14px]">
          <div className="kicker text-age-3">Import stopped</div>
          <p className="mt-1 max-w-[80ch] text-[12.5px] text-pretty">{error}</p>
        </div>
      ) : null}

      {stage === 'drop' ? (
        <DropZone
          dragging={dragging}
          setDragging={setDragging}
          inputRef={inputRef}
          onFile={handleFile}
        />
      ) : null}

      {stage === 'preview' ? (
        preview ? (
          <Preview preview={preview} onConfirm={confirm} onDiscard={reset} />
        ) : (
          <div className="panel p-[14px] text-[12.5px] text-mute">Reading the file…</div>
        )
      ) : null}

      {stage === 'running' ? <Running progress={progress} preview={preview} /> : null}

      {stage === 'done' ? <Result result={result} preview={preview} onAgain={reset} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function DropZone({ dragging, setDragging, inputRef, onFile }) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFile(e.dataTransfer.files?.[0]);
      }}
      className={[
        'panel grid place-items-center px-6 py-[60px] text-center transition-colors',
        dragging ? 'border-teal bg-teal/[0.04]' : '',
      ].join(' ')}
    >
      <div className="max-w-[54ch]">
        <div className="text-[15px] font-semibold">Drop the Marg outstanding export here</div>
        <p className="mt-2 text-[12.5px] text-mute text-pretty">
          The bill-wise outstanding report, exported from Marg as .xls. It is read in your
          browser first — nothing is written to the database until you confirm what it found.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".xls,.xlsx,application/vnd.ms-excel"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button type="button" className="btn btn-primary mt-4" onClick={() => inputRef.current?.click()}>
          Choose file
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Preview({ preview, onConfirm, onDiscard }) {
  const { parsed, stats, warnings, comparison, blocking } = preview;
  const grouped = groupWarnings(warnings);

  return (
    <div className="grid gap-4">
      <section className="panel">
        <div className="flex flex-wrap items-baseline gap-[10px] border-b border-hair px-4 py-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{preview.file.name}</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.05em] text-faint">
            Report date {formatDate(parsed.reportDate)}
            {comparison ? ` · previous ${formatDate(comparison.previous.report_date)}` : ' · first import'}
          </span>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px bg-hair">
          {stats.map((s) => (
            <div key={s.label} className="bg-white/[0.74] px-[14px] py-3">
              <div className="kicker">{s.label}</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-[7px]">
                <span
                  className={[
                    'tnum whitespace-nowrap text-[22px] font-medium leading-[1.1] tracking-[-0.03em]',
                    s.emphasis ? 'text-ink' : 'text-ink',
                  ].join(' ')}
                >
                  {s.money !== undefined ? formatInr(s.money) : formatCount(s.value)}
                </span>
                {s.delta !== null && s.delta !== undefined && s.delta !== 0 ? (
                  <span
                    className={[
                      'tnum px-[5px] py-px text-[10px] font-medium',
                      s.delta > 0 ? 'bg-age-3/10 text-age-3' : 'bg-age-0/10 text-teal-deep',
                    ].join(' ')}
                  >
                    {s.money !== undefined ? formatInrDelta(s.delta) : signedCount(s.delta)}
                  </span>
                ) : null}
              </div>
              {s.note ? <div className="mt-[3px] text-[11px] text-mute text-pretty">{s.note}</div> : null}
            </div>
          ))}
        </div>
      </section>

      <Reconciliation parsed={parsed} grouped={grouped} />

      {comparison ? <Movement comparison={comparison} /> : null}

      {blocking.length > 0 ? (
        <div className="panel border-l-[3px] border-l-age-3 p-[14px]">
          <div className="kicker text-age-3">Cannot import this file</div>
          <ul className="mt-2 list-disc pl-5 text-[12.5px]">
            {blocking.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-[10px]">
        <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={blocking.length > 0}>
          Confirm and write {formatCount(parsed.totals.billCount)} bills
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * The reconciliation panel is the heart of the preview. It shows the gap
 * between the header totals and the bill rows before anything is written,
 * and states plainly which of the two the app is about to believe.
 */
function Reconciliation({ parsed, grouped }) {
  const mismatches = grouped.header_vs_bills_mismatch ?? [];
  const billSum = parsed.parties.reduce((a, p) => a + p.bill_balance_sum, 0);
  const headerSum = parsed.totals.netTotal;
  const gap = billSum - headerSum;

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hair px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Reconciliation</h2>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.05em] text-faint">
          Party totals are taken from the header rows
        </span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-px bg-hair">
        <Figure label="Header rows (used)" value={formatInr(headerSum)} tone="ink" note="what Marg shows the owner" />
        <Figure label="Sum of bill rows" value={formatInr(billSum)} tone="mute" note="not used as the party total" />
        <Figure
          label="Difference"
          value={formatInr(gap)}
          tone={Math.abs(gap) > 1000 ? 'warn' : 'ink'}
          note={`${mismatches.length} ${mismatches.length === 1 ? 'party' : 'parties'} disagree by more than ₹1,000`}
        />
      </div>

      {mismatches.length > 0 ? (
        <div className="max-h-[260px] overflow-y-auto border-t border-hair">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <Th>Party</Th>
                <Th align="right">Header</Th>
                <Th align="right">Bill rows</Th>
                <Th align="right">Gap</Th>
              </tr>
            </thead>
            <tbody>
              {mismatches.map((w, i) => (
                <tr key={`${w.party_name}-${i}`} className="border-b border-rule last:border-b-0">
                  <td className="px-[10px] py-[6px]">{w.party_name}</td>
                  <td className="tnum px-[10px] py-[6px] text-right">{formatInr(w.detail.header_balance)}</td>
                  <td className="tnum px-[10px] py-[6px] text-right text-mute">
                    {formatInr(w.detail.bill_balance_sum)}
                  </td>
                  <td className="tnum px-[10px] py-[6px] text-right text-age-2">{formatInr(w.detail.gap)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <OtherWarnings grouped={grouped} />
    </section>
  );
}

function OtherWarnings({ grouped }) {
  const labels = {
    credit_balance: 'Credit balances — advances or unadjusted credit notes, excluded from collection views',
    duplicate_bill_no: 'Repeated bill numbers — stored under a suffixed key so no row is lost',
    duplicate_party_name: 'Party names that normalise identically — balances and bills merged',
    party_without_bills: 'Parties carrying a balance with no bill rows — cannot be aged',
    orphan_bill_rows: 'Bill rows with no party header above them — not imported',
    header_layout_drift: 'Trailing columns differ from the expected layout',
    marg_due_date_present:
      'Parties where Marg already carries a due date — a recorded credit period, shown for review and NOT applied as a term',
  };
  const rows = Object.entries(grouped).filter(([type]) => type !== 'header_vs_bills_mismatch');
  if (rows.length === 0) return null;

  return (
    <div className="border-t border-hair px-4 py-3">
      <div className="kicker mb-2">Also noted</div>
      <ul className="grid gap-[6px]">
        {rows.map(([type, items]) => (
          <li key={type} className="flex items-baseline gap-[9px] text-[12px]">
            <span className="tnum flex-none font-medium">{formatCount(items.length)}</span>
            <span className="text-mute text-pretty">{labels[type] ?? type}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Movement({ comparison }) {
  return (
    <section className="panel px-4 py-3">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Since the last import</h2>
      <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3 text-[12px]">
        <Movement1 label="New parties" value={formatCount(comparison.newParties.length)} note="no credit term yet" />
        <Movement1
          label="Absent from this file"
          value={formatCount(comparison.disappeared.length)}
          note={`carrying ${formatInr(comparison.disappearedValue)} — settled, or filtered out of the export`}
        />
        <Movement1 label="Bills" value={signedCount(comparison.billDelta)} note="net change" />
        <Movement1 label="Book" value={formatInrDelta(comparison.netDelta)} note="net change" />
      </div>
    </section>
  );
}

function Movement1({ label, value, note }) {
  return (
    <div>
      <div className="kicker">{label}</div>
      <div className="tnum mt-[2px] text-[16px] font-medium">{value}</div>
      <div className="text-[11px] text-mute text-pretty">{note}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Running({ progress, preview }) {
  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const phaseLabel = {
    archiving: 'Archiving the original file',
    snapshot: 'Creating the snapshot',
    parties: 'Writing parties',
    bills: 'Writing bills',
    warnings: 'Recording warnings',
    done: 'Finishing',
  }[progress.phase] ?? 'Starting';

  return (
    <div className="panel p-[18px]">
      <div className="text-[15px] font-semibold tracking-[-0.01em]">{phaseLabel}</div>
      <div className="mt-3 h-[7px] overflow-hidden bg-rule">
        <div
          className="h-full bg-teal transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="tnum mt-2 text-[10px] uppercase tracking-[0.05em] text-mute">
        {formatCount(progress.done)} of {formatCount(progress.total)} · {pct}%
      </div>
      <p className="mt-3 max-w-[70ch] text-[12px] text-mute text-pretty">
        Writing {formatCount(preview?.parsed.totals.billCount ?? 0)} bills for{' '}
        {formatCount(preview?.parsed.totals.partyCount ?? 0)} parties. Snapshots are immutable
        once written, so this runs to completion rather than part way.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Result({ result, preview, onAgain }) {
  const t = preview.parsed.totals;
  return (
    <div className="panel p-[18px]">
      <div className="kicker text-teal-deep">Imported</div>
      <h2 className="mt-1 text-[17px] font-semibold tracking-[-0.015em]">
        Snapshot for {formatDate(result?.snapshot?.report_date)} is live
      </h2>

      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px bg-hair">
        <Figure label="Parties" value={formatCount(t.partyCount)} note={`${t.owingCount} owing · ${t.creditCount} credit · ${t.zeroCount} zero`} />
        <Figure label="Bills" value={formatCount(t.billCount)} />
        <Figure label="Net total" value={formatInr(t.netTotal)} note="the figure Marg shows the owner" />
        <Figure label="Warnings raised" value={formatCount(preview.warnings.length)} note="visible on this snapshot" />
      </div>

      {!result?.storagePath ? (
        <p className="mt-3 max-w-[80ch] text-[12px] text-age-2 text-pretty">
          The original file could not be archived to storage, so this snapshot has no audit copy.
          Check that the <code className="font-mono">marg-imports</code> bucket exists.
        </p>
      ) : null}

      <button type="button" className="btn btn-secondary mt-4" onClick={onAgain}>
        Import another
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Figure({ label, value, note, tone = 'ink' }) {
  const toneClass = { ink: 'text-ink', mute: 'text-mute', warn: 'text-age-2' }[tone];
  return (
    <div className="bg-white/[0.74] px-[14px] py-3">
      <div className="kicker">{label}</div>
      <div className={`tnum mt-1 text-[20px] font-medium tracking-[-0.03em] ${toneClass}`}>{value}</div>
      {note ? <div className="mt-[3px] text-[11px] text-mute text-pretty">{note}</div> : null}
    </div>
  );
}

function Th({ children, align = 'left' }) {
  return (
    <th
      className="sticky top-0 border-b border-hair bg-white/90 px-[10px] py-[7px] text-[10px] font-semibold uppercase tracking-[0.09em] text-mute backdrop-blur"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}

function groupWarnings(warnings) {
  const out = {};
  for (const w of warnings) {
    (out[w.warning_type] ??= []).push(w);
  }
  return out;
}

function signedCount(n) {
  if (n === 0) return '0';
  return n > 0 ? `+${formatCount(n)}` : `−${formatCount(Math.abs(n))}`;
}
