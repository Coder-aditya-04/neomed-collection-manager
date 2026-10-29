/**
 * Concatenates the numbered migrations into _all_in_one.sql, which is what
 * gets pasted into the Supabase SQL editor. Run after editing any migration.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const files = readdirSync(dir).filter((f) => /^0\d{3}_.*\.sql$/.test(f)).sort();
const out = [
  '-- ===================================================================',
  '-- Neomed Collection Manager — complete schema.',
  '-- Paste into the Supabase SQL editor. Safe to re-run.',
  '-- ===================================================================',
  '',
];
for (const f of files) {
  out.push(`\n-- ############ ${f} ############\n`);
  out.push(readFileSync(join(dir, f), 'utf8').trimEnd() + '\n');
}
writeFileSync(join(dir, '_all_in_one.sql'), out.join('\n'));
console.log(files.join(', '));
