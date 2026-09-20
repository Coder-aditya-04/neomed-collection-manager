/**
 * Renders the real StatementDocument with live data, so a PDF preview is
 * exactly what the app produces rather than a mock-up of it.
 *
 *   npx esbuild scripts/render-statement.jsx --bundle --platform=node \
 *     --format=esm --jsx=automatic --outfile=/tmp/render.mjs && node /tmp/render.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import StatementDocument from '../src/features/statements/StatementDocument.jsx';

async function main() {
  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const q = async (p) => (await fetch(URL + '/rest/v1/' + p, { headers: H })).json();

  const snap = (await q('snapshots?select=id,report_date&order=report_date.desc&limit=1'))[0];
  const parties = await q('v_party_ageing?select=*&order=current_outstanding.desc&limit=3');
  const party = parties[Number(process.env.PARTY_INDEX ?? 0)];
  const bills = await q(
    `bills?select=bill_no,bill_date,balance,bill_amount,received,bill_age_days` +
    `&party_id=eq.${party.party_id}&snapshot_id=eq.${snap.id}&order=bill_date.asc&limit=2000`
  );

  process.stdout.write(renderToStaticMarkup(
    React.createElement(StatementDocument, {
      party: { ...party, contact_person: party.contact_person || 'Purchase Department' },
      bills,
      asOf: snap.report_date,
      truncated: Math.max(0, (party.bill_count ?? bills.length) - bills.length),
    })
  ));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
