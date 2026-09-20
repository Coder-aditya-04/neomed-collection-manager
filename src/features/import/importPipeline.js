/**
 * The import write path: parse in the browser, show the owner what will
 * happen, and only then write.
 *
 * Nothing reaches Postgres before confirm(). The preview is built entirely
 * from the parsed file plus a read of the previous snapshot, so a file that
 * looks wrong can be discarded without leaving a trace.
 */

import { supabase, IMPORT_BUCKET } from '../../lib/supabase.js';
import { parseMargWorkbook } from '../../lib/margParser.js';

/** Bills per insert. Large enough to keep 8,197 rows quick, small enough
 *  to stay inside PostgREST's request limits. */
const BILL_BATCH = 500;
const PARTY_BATCH = 500;

/* ------------------------------------------------------------------ */
/* step 1 — parse and preview                                          */
/* ------------------------------------------------------------------ */

/**
 * Read the file and compare it against the snapshot already in the database.
 * Returns everything the preview screen needs; writes nothing.
 */
export async function buildPreview(file, { reportDate } = {}) {
  // SheetJS is ~900 kB and only this screen needs it, so it is fetched when a
  // file is actually dropped rather than on first paint of the app.
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const parsed = parseMargWorkbook(buffer, XLSX, {
    reportDate: reportDate ?? inferReportDate(file.name),
  });

  const previous = await fetchPreviousSnapshot();
  const comparison = previous ? await compareWithPrevious(parsed, previous) : null;

  return {
    file,
    buffer,
    parsed,
    previous,
    comparison,
    stats: buildStats(parsed, comparison),
    warnings: parsed.warnings,
    blocking: blockingProblems(parsed),
  };
}

/** Marg names its exports like outstanding__9_SEP_26.xls. */
export function inferReportDate(fileName) {
  const m = /(\d{1,2})[_\-\s]?([A-Za-z]{3})[_\-\s]?(\d{2,4})/.exec(String(fileName ?? ''));
  if (!m) return new Date().toISOString().slice(0, 10);
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const month = months[m[2].toLowerCase()];
  if (!month) return new Date().toISOString().slice(0, 10);
  let year = Number.parseInt(m[3], 10);
  if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
  const day = Number.parseInt(m[1], 10);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function fetchPreviousSnapshot() {
  const { data, error } = await supabase
    .from('snapshots')
    .select('id, report_date, party_count, bill_count, total_owed, total_credit, net_total')
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function compareWithPrevious(parsed, previous) {
  const { data, error } = await supabase
    .from('parties')
    .select('normalised_name, current_outstanding')
    .eq('last_snapshot_id', previous.id);
  if (error) throw error;

  const before = new Map((data ?? []).map((p) => [p.normalised_name, Number(p.current_outstanding)]));
  const now = new Map(parsed.parties.map((p) => [p.normalised_name, p.current_outstanding]));

  const newParties = [...now.keys()].filter((n) => !before.has(n));
  const disappeared = [...before.keys()].filter((n) => !now.has(n));
  const disappearedValue = disappeared.reduce((a, n) => a + (before.get(n) ?? 0), 0);

  return {
    previous,
    newParties,
    disappeared,
    disappearedValue,
    partyDelta: parsed.totals.partyCount - previous.party_count,
    billDelta: parsed.totals.billCount - previous.bill_count,
    netDelta: parsed.totals.netTotal - Number(previous.net_total),
  };
}

function buildStats(parsed, comparison) {
  const t = parsed.totals;
  return [
    { label: 'Parties found', value: t.partyCount, delta: comparison?.partyDelta ?? null,
      note: `${t.owingCount} owing · ${t.creditCount} in credit · ${t.zeroCount} at zero` },
    { label: 'Bills found', value: t.billCount, delta: comparison?.billDelta ?? null, note: null },
    { label: 'Total owed', money: t.totalOwed, note: 'sum of positive party balances' },
    { label: 'Credit balances', money: t.totalCredit,
      note: `${t.creditCount} parties · not debt` },
    { label: 'Net total', money: t.netTotal, delta: comparison?.netDelta ?? null,
      note: 'the figure Marg shows the owner', emphasis: true },
  ];
}

/**
 * Problems that should stop an import rather than be noted in passing. A
 * reconciliation gap is expected and informational; an empty file or a file
 * already imported for that date is not.
 */
function blockingProblems(parsed) {
  const problems = [];
  if (parsed.totals.partyCount === 0) {
    problems.push('No party rows were found. This file has the right columns but no data.');
  }
  if (parsed.totals.billCount === 0) {
    problems.push('No bill rows were found.');
  }
  if (!parsed.reportDate) {
    problems.push('The report date could not be determined from the file name. Set it manually.');
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* step 2 — commit                                                     */
/* ------------------------------------------------------------------ */

/**
 * Write the previewed import.
 *
 * Order matters: the file is archived first, then the snapshot row, then
 * parties (so bills have something to reference), then bills, then warnings.
 * `onProgress({phase, done, total})` drives the progress bar.
 */
export async function commitImport(preview, { onProgress = () => {} } = {}) {
  const { parsed, file, buffer } = preview;

  onProgress({ phase: 'archiving', done: 0, total: 1 });
  const storagePath = await archiveOriginal(file, buffer, parsed.reportDate);

  onProgress({ phase: 'snapshot', done: 0, total: 1 });
  const snapshot = await insertSnapshot(parsed, file, storagePath);

  onProgress({ phase: 'parties', done: 0, total: parsed.parties.length });
  const partyIds = await upsertParties(parsed.parties, snapshot.id, onProgress);

  onProgress({ phase: 'bills', done: 0, total: parsed.bills.length });
  await insertBills(parsed.bills, snapshot.id, partyIds, onProgress);

  onProgress({ phase: 'warnings', done: 0, total: parsed.warnings.length });
  await insertWarnings(parsed.warnings, snapshot.id, partyIds, storagePath);

  onProgress({ phase: 'deriving', done: 0, total: 1 });
  const derived = await deriveHistory();

  onProgress({ phase: 'done', done: 1, total: 1 });
  return { snapshot, storagePath, derived };
}

/**
 * Work out what moved, now that there is a newer file to compare against.
 *
 * This used to be three SQL statements someone had to remember to run after
 * every import. Forgetting them did not break anything visibly — it just
 * meant the payment history quietly stopped growing, which is the worst kind
 * of failure: silent, and only noticed weeks later when the behaviour
 * ratings are still empty.
 *
 * A failure here must not fail the import. The snapshot is already written
 * and is the valuable part; the derivation can be re-run at any time because
 * all three functions are idempotent.
 */
async function deriveHistory() {
  const out = { events: 0, profiles: 0, promises: 0, error: null };
  try {
    const { data: events, error: e1 } = await supabase.rpc('fn_diff_latest');
    if (e1) throw e1;
    out.events = events ?? 0;

    const { data: profiles, error: e2 } = await supabase.rpc('fn_compute_profiles');
    if (e2) throw e2;
    out.profiles = profiles ?? 0;

    const { data: promises, error: e3 } = await supabase.rpc('fn_settle_promises', { p_grace_days: 3 });
    if (e3) throw e3;
    out.promises = promises ?? 0;
  } catch (e) {
    out.error = e.message ?? String(e);
  }
  return out;
}

/**
 * Keep the original file. If the bucket is missing the import still goes
 * ahead — losing the whole day's figures over an archiving problem would be
 * the worse outcome — but the gap is recorded as a warning, not swallowed.
 */
async function archiveOriginal(file, buffer, reportDate) {
  const path = `${reportDate}/${Date.now()}-${file.name}`;
  const { error } = await supabase.storage
    .from(IMPORT_BUCKET)
    .upload(path, buffer, { contentType: file.type || 'application/vnd.ms-excel', upsert: false });
  if (error) {
    console.warn('Original file was not archived:', error.message);
    return null;
  }
  return path;
}

async function insertSnapshot(parsed, file, storagePath) {
  const { data: user } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('snapshots')
    .insert({
      report_date: parsed.reportDate,
      uploaded_by: user?.user?.id ?? null,
      file_name: file.name,
      storage_path: storagePath,
      party_count: parsed.totals.partyCount,
      bill_count: parsed.totals.billCount,
      total_owed: parsed.totals.totalOwed,
      total_credit: parsed.totals.totalCredit,
      net_total: parsed.totals.netTotal,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        `A snapshot for ${parsed.reportDate} has already been imported. ` +
          'Snapshots are immutable, so the existing one cannot be overwritten — ' +
          'import a different day, or have the existing snapshot removed first.'
      );
    }
    throw error;
  }
  return data;
}

/**
 * Upsert on normalised_name.
 *
 * The payload deliberately carries no credit-term columns. PostgREST builds
 * its ON CONFLICT UPDATE from the keys present, so omitting them means an
 * import can never overwrite a term someone approved — which is rule 1 held
 * up at the write path rather than trusted to a convention.
 */
async function upsertParties(parties, snapshotId, onProgress) {
  let done = 0;
  for (let i = 0; i < parties.length; i += PARTY_BATCH) {
    const batch = parties.slice(i, i + PARTY_BATCH).map((p) => ({
      display_name: p.display_name,
      normalised_name: p.normalised_name,
      current_outstanding: p.current_outstanding,
      oldest_bill_age_days: p.oldest_bill_age_days,
      last_snapshot_id: snapshotId,
    }));
    const { error } = await supabase
      .from('parties')
      .upsert(batch, { onConflict: 'normalised_name', ignoreDuplicates: false });
    if (error) throw error;
    done += batch.length;
    onProgress({ phase: 'parties', done, total: parties.length });
  }

  // Read the ids back; bills reference parties by id.
  const ids = new Map();
  const names = parties.map((p) => p.normalised_name);
  for (let i = 0; i < names.length; i += PARTY_BATCH) {
    const { data, error } = await supabase
      .from('parties')
      .select('id, normalised_name')
      .in('normalised_name', names.slice(i, i + PARTY_BATCH));
    if (error) throw error;
    for (const row of data ?? []) ids.set(row.normalised_name, row.id);
  }
  return ids;
}

async function insertBills(bills, snapshotId, partyIds, onProgress) {
  let done = 0;
  for (let i = 0; i < bills.length; i += BILL_BATCH) {
    const batch = bills.slice(i, i + BILL_BATCH).map((b) => ({
      snapshot_id: snapshotId,
      party_id: partyIds.get(b.normalised_name),
      bill_no: b.bill_no,
      bill_type: b.bill_type,
      bill_date: b.bill_date,
      bill_amount: b.bill_amount,
      received: b.received,
      balance: b.balance,
      bill_age_days: b.bill_age_days,
      is_on_account: b.is_on_account,
      marg_due_date: b.marg_due_date,
      days_past_due: b.days_past_due,
    }));

    const orphan = batch.find((b) => !b.party_id);
    if (orphan) {
      throw new Error(`Bill ${orphan.bill_no} could not be attached to a party. Import aborted.`);
    }

    const { error } = await supabase.from('bills').insert(batch);
    if (error) throw error;
    done += batch.length;
    onProgress({ phase: 'bills', done, total: bills.length });
  }
}

async function insertWarnings(warnings, snapshotId, partyIds, storagePath) {
  const rows = warnings.map((w) => ({
    snapshot_id: snapshotId,
    party_id: w.party_name ? partyIds.get(normalise(w.party_name)) ?? null : null,
    warning_type: w.warning_type,
    detail: { ...w.detail, party_name: w.party_name ?? null },
  }));

  if (!storagePath) {
    rows.push({
      snapshot_id: snapshotId,
      party_id: null,
      warning_type: 'original_not_archived',
      detail: {
        message:
          'The original export could not be saved to storage, so this snapshot has no ' +
          'audit copy. Check that the marg-imports bucket exists.',
      },
    });
  }

  for (let i = 0; i < rows.length; i += BILL_BATCH) {
    const { error } = await supabase.from('import_warnings').insert(rows.slice(i, i + BILL_BATCH));
    if (error) throw error;
  }
}

// Mirrors normaliseName in the parser; kept local to avoid a circular import.
function normalise(raw) {
  return String(raw ?? '').toUpperCase().replace(/\s+/g, ' ').trim().replace(/[.,;:\-/\\'"]+$/g, '').trim();
}
