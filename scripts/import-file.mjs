/**
 * Import a Marg export straight into Supabase from the command line.
 *
 * Uses exactly the payloads the browser import screen builds, so running it
 * proves the schema accepts real parsed data — column types, constraints,
 * batch sizes and all — without needing a browser session.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *     node scripts/import-file.mjs "outstanding_ 9 SEP 26.xls"
 *
 * The service key is read from the environment and never stored in the repo.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as XLSX from 'xlsx';
import { parseMargWorkbook, normaliseName } from '../src/lib/margParser.js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const FILE = process.argv[2];

if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  process.exit(1);
}
if (!FILE) {
  console.error('Usage: node scripts/import-file.mjs <path to .xls>');
  process.exit(1);
}

const BATCH = 500;

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function inferReportDate(fileName) {
  const m = /(\d{1,2})[_\-\s]?([A-Za-z]{3})[_\-\s]?(\d{2,4})/.exec(fileName);
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  if (!m || !months[m[2].toLowerCase()]) return new Date().toISOString().slice(0, 10);
  let y = Number.parseInt(m[3], 10);
  if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
  return `${y}-${String(months[m[2].toLowerCase()]).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

const buf = readFileSync(FILE);
const reportDate = inferReportDate(basename(FILE));
const parsed = parseMargWorkbook(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  XLSX,
  { reportDate }
);

console.log(`file        ${basename(FILE)}`);
console.log(`report date ${parsed.reportDate}`);
console.log(`parties     ${parsed.totals.partyCount}`);
console.log(`bills       ${parsed.totals.billCount}`);
console.log(`net total   ${parsed.totals.netTotal}`);
console.log('');

const existing = await rest(`snapshots?report_date=eq.${parsed.reportDate}&select=id`);
const RESUME = process.argv.includes('--resume');
if (existing.length && !RESUME) {
  console.error(
    `A snapshot for ${parsed.reportDate} already exists (${existing[0].id}). ` +
      'Snapshots are immutable; pass --resume to continue writing into it, or delete it first.'
  );
  process.exit(1);
}

console.log(existing.length ? 'resuming into existing snapshot…' : 'writing snapshot…');
const [snapshot] = existing.length ? existing : await rest('snapshots', {
  method: 'POST',
  prefer: 'return=representation',
  body: [
    {
      report_date: parsed.reportDate,
      file_name: basename(FILE),
      storage_path: null,
      party_count: parsed.totals.partyCount,
      bill_count: parsed.totals.billCount,
      total_owed: parsed.totals.totalOwed,
      total_credit: parsed.totals.totalCredit,
      net_total: parsed.totals.netTotal,
    },
  ],
});
console.log(`  snapshot ${snapshot.id}`);

// No credit-term columns in the payload: an import must never overwrite an
// approved term (rule 1).
console.log('writing parties…');
for (let i = 0; i < parsed.parties.length; i += BATCH) {
  const batch = parsed.parties.slice(i, i + BATCH).map((p) => ({
    display_name: p.display_name,
    normalised_name: p.normalised_name,
    current_outstanding: p.current_outstanding,
    oldest_bill_age_days: p.oldest_bill_age_days,
    last_snapshot_id: snapshot.id,
  }));
  await rest('parties?on_conflict=normalised_name', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: batch,
  });
  process.stdout.write(`  ${Math.min(i + BATCH, parsed.parties.length)}/${parsed.parties.length}\r`);
}
console.log('');

// Paged plainly rather than filtered with in.(...): a 500-name filter makes a
// URL that PostgREST echoes back in Content-Location, overflowing the client's
// header limit. Reading the whole table is smaller and simpler.
const ids = new Map();
for (let from = 0; ; from += 1000) {
  const rows = await rest(`parties?select=id,normalised_name&order=normalised_name&offset=${from}&limit=1000`);
  for (const r of rows) ids.set(r.normalised_name, r.id);
  if (rows.length < 1000) break;
}
console.log(`  resolved ${ids.size} party ids`);

console.log('writing bills…');
for (let i = 0; i < parsed.bills.length; i += BATCH) {
  const batch = parsed.bills.slice(i, i + BATCH).map((b) => ({
    snapshot_id: snapshot.id,
    party_id: ids.get(b.normalised_name),
    bill_no: b.bill_no,
    bill_type: b.bill_type,
    bill_date: b.bill_date,
    bill_amount: b.bill_amount,
    received: b.received,
    balance: b.balance,
    bill_age_days: b.bill_age_days,
    marg_due_date: b.marg_due_date,
    days_past_due: b.days_past_due,
  }));
  const orphan = batch.find((b) => !b.party_id);
  if (orphan) throw new Error(`bill ${orphan.bill_no} has no party id`);
  await rest('bills', { method: 'POST', prefer: 'return=minimal', body: batch });
  process.stdout.write(`  ${Math.min(i + BATCH, parsed.bills.length)}/${parsed.bills.length}\r`);
}
console.log('');

console.log('writing warnings…');
const warnRows = parsed.warnings.map((w) => ({
  snapshot_id: snapshot.id,
  party_id: w.party_name ? ids.get(normaliseName(w.party_name)) ?? null : null,
  warning_type: w.warning_type,
  detail: { ...w.detail, party_name: w.party_name ?? null },
}));
for (let i = 0; i < warnRows.length; i += BATCH) {
  await rest('import_warnings', { method: 'POST', prefer: 'return=minimal', body: warnRows.slice(i, i + BATCH) });
}
console.log(`  ${warnRows.length} warnings`);

console.log('\ndone.');
