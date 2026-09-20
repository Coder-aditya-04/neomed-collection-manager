import { forwardRef } from 'react';
import { formatDate } from '../../lib/format.js';

/**
 * The party statement, laid out the way Marg prints it.
 *
 * Deliberately close to the report the client already sends: same letterhead,
 * same shaded party row carrying the total, same bill columns. A statement
 * that looks unfamiliar invites an argument about whether the figures are
 * right, and that argument is the thing the collection call cannot afford.
 *
 * Figures are shown as plain grouped numbers rather than the app's Cr/L
 * shorthand. A party checking a statement against their own ledger wants
 * 2,59,761 — not Rs 2.60 L.
 */

export const COMPANY = {
  name: 'NEOMED PHARMA AGENCIES',
  address1: 'SHOP NO.G-16, B WING, SUYOJIT CITY CENTRE',
  address2: 'NEAR SHATABDI HOSPITAL, MUMBAI NAKA, NASHIK-422001',
  phone: 'Phone : 7798031280 / 8530547534 / 9561927849',
};

/** 2,59,761 — Indian grouping, no symbol, no abbreviation. */
export function plain(n) {
  const v = Number(n ?? 0);
  const sign = v < 0 ? '-' : '';
  const s = String(Math.round(Math.abs(v)));
  if (s.length <= 3) return sign + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return `${sign}${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * How a bill number should read to the party.
 *
 * On-account rows with no number of their own are keyed internally as
 * "*~2026-02-23~-12" so they survive the unique index. That key is ours, not
 * theirs, and must never appear on a statement — it looks like a typo and
 * invites a phone call about the wrong thing.
 */
export function displayBillNo(billNo) {
  const s = String(billNo ?? '').trim();
  if (s.startsWith('*~') || s === '*' || s === '#') return 'On account';
  return s;
}

/** DD-MMM-YY, as Marg writes dates. */
function margDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d).padStart(2, '0')}-${months[m - 1]}-${String(y % 100).padStart(2, '0')}`;
}

const StatementDocument = forwardRef(function StatementDocument(
  { party, bills, asOf, showAgeing = true, truncated = 0 },
  ref
) {
  const open = (bills ?? [])
    .filter((b) => Number(b.balance) !== 0)
    .sort((a, b) => String(a.bill_date).localeCompare(String(b.bill_date)));

  let running = 0;
  const rows = open.map((b) => {
    running += Number(b.balance);
    return { ...b, cumulative: running };
  });

  /*
   * Three different numbers have to be kept apart here, and conflating any
   * two of them puts a wrong figure in front of a customer:
   *
   *   listed      what the rows above add up to
   *   notListed   bills that exist but were left off to keep this readable
   *   unallocated money received and credited to the party, never applied to
   *               any particular bill — the thing we actually want them to
   *               resolve on the call
   *
   * bill_balance_sum is every bill the party has, listed or not, so the
   * unallocated amount is the gap between that and the ledger balance. An
   * earlier version folded truncation into that gap and told the party we
   * were "carrying a balance in our ledger", which was simply untrue.
   */
  const listed = rows.reduce((a, b) => a + Number(b.balance), 0);
  const allBills = party.bill_balance_sum != null ? Number(party.bill_balance_sum) : listed;
  const notListed = allBills - listed;
  const unallocated = Number(party.current_outstanding) - allBills;
  const hasNotListed = Math.abs(notListed) > 1;
  const hasUnallocated = Math.abs(unallocated) > 1;

  // Age bands are from the bill date, and labelled as age — not as lateness.
  const bands = [0, 0, 0, 0];
  for (const b of rows) {
    const d = b.bill_age_days ?? 0;
    const i = d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3;
    bands[i] += Number(b.balance);
  }
  const bandLabels = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'];

  return (
    <div
      ref={ref}
      style={{
        width: 780,
        background: '#fff',
        color: '#0F1F2E',
        fontFamily: '"Archivo", system-ui, sans-serif',
        fontSize: 12,
        padding: '28px 30px 26px',
        boxSizing: 'border-box',
      }}
    >
      {/* letterhead */}
      <div style={{ textAlign: 'center', borderBottom: '2px solid #0F1F2E', paddingBottom: 10 }}>
        <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '.02em' }}>{COMPANY.name}</div>
        <div style={{ fontSize: 11, color: '#5C6B78', marginTop: 3 }}>{COMPANY.address1}</div>
        <div style={{ fontSize: 11, color: '#5C6B78' }}>{COMPANY.address2}</div>
        <div style={{ fontSize: 10.5, color: '#5C6B78', marginTop: 2 }}>{COMPANY.phone}</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase' }}>
          Statement of Account
        </div>
        <div style={{ fontSize: 11, color: '#5C6B78' }}>As on {formatDate(asOf)}</div>
      </div>

      {/* party */}
      <div style={{ marginTop: 10, border: '1px solid #DCE4EA' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                      background: '#EDF1F4', padding: '8px 11px', borderBottom: '1px solid #DCE4EA' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{party.display_name}</div>
            {party.contact_person ? (
              <div style={{ fontSize: 10.5, color: '#5C6B78', marginTop: 1 }}>
                Kind attn: {party.contact_person}
              </div>
            ) : null}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: '#5C6B78' }}>
              Total outstanding
            </div>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 17, fontWeight: 600, marginTop: 1 }}>
              {plain(party.current_outstanding)}
            </div>
          </div>
        </div>

        {/* bills */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: '#F7F9FA' }}>
              <Th w="18%">Bill No.</Th>
              <Th w="13%">Bill Date</Th>
              <Th w="15%" right>Bill Amt.</Th>
              <Th w="13%" right>Received</Th>
              <Th w="15%" right>Balance</Th>
              <Th w="14%" right>Cumulative</Th>
              <Th w="12%" right>Days</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b, i) => (
              <tr key={`${b.bill_no}-${i}`} style={{ borderTop: '1px solid #EFF2F5' }}>
                <Td mono>{displayBillNo(b.bill_no)}</Td>
                <Td mono>{margDate(b.bill_date)}</Td>
                <Td mono right>{plain(b.bill_amount ?? b.balance)}</Td>
                <Td mono right>{plain(b.received ?? 0)}</Td>
                <Td mono right bold>{plain(b.balance)}</Td>
                <Td mono right muted>{plain(b.cumulative)}</Td>
                <Td mono right muted>{b.bill_age_days ?? ''}</Td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><Td colSpan={7}>No open bills.</Td></tr>
            ) : null}
            {truncated ? (
              <tr style={{ borderTop: '1px solid #EFF2F5' }}>
                <Td colSpan={7} muted>
                  … and {truncated} older bill(s) not listed here. Full statement on request.
                </Td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '1px solid #0F1F2E', background: '#F7F9FA' }}>
              <Td bold>Total of bills listed</Td>
              <Td /><Td /><Td />
              <Td mono right bold>{plain(listed)}</Td>
              <Td /><Td />
            </tr>
            {hasNotListed ? (
              <tr>
                <Td colSpan={4} muted>
                  Add: {truncated ? `${truncated} further bill(s)` : 'further bills'} not listed above
                </Td>
                <Td mono right>{plain(notListed)}</Td>
                <Td /><Td />
              </tr>
            ) : null}
            {hasUnallocated ? (
              <tr style={{ background: '#FFFDF5' }}>
                <Td colSpan={4}>
                  {unallocated < 0
                    ? 'Less: payments received from you, not yet applied to a bill'
                    : 'Add: other adjustments in our ledger'}
                </Td>
                <Td mono right bold>{plain(unallocated)}</Td>
                <Td /><Td />
              </tr>
            ) : null}
            <tr style={{ borderTop: '2px solid #0F1F2E', background: '#EDF1F4' }}>
              <Td bold>Net outstanding</Td>
              <Td /><Td /><Td />
              <Td mono right bold>{plain(party.current_outstanding)}</Td>
              <Td /><Td />
            </tr>
          </tfoot>
        </table>
      </div>

      {showAgeing && rows.length > 0 ? (
        <div style={{ marginTop: 12, border: '1px solid #DCE4EA' }}>
          <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: '#5C6B78',
                        padding: '6px 11px', borderBottom: '1px solid #DCE4EA', background: '#F7F9FA' }}>
            Age of outstanding (from bill date)
          </div>
          <div style={{ display: 'flex' }}>
            {bands.map((v, i) => (
              <div key={i} style={{ flex: 1, padding: '7px 11px',
                                    borderRight: i < 3 ? '1px solid #EFF2F5' : 'none' }}>
                <div style={{ fontSize: 10, color: '#5C6B78' }}>{bandLabels[i]}</div>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 13, fontWeight: 600, marginTop: 2 }}>
                  {plain(v)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 14, fontSize: 11, lineHeight: 1.6 }}>
        <p style={{ margin: 0 }}>
          Kindly arrange payment at your earliest, or let us know the expected date.
        </p>
        <p style={{ margin: '4px 0 0' }}>
          {hasUnallocated && unallocated < 0
            ? `We show ${plain(Math.abs(unallocated))} received from you that is not yet applied to any ` +
              'particular bill. Kindly confirm which bills it should be set against, so our records ' +
              'match yours.'
            : 'If any bill shown above is already settled, please tell us which — so we can apply the ' +
              'receipt against the correct bill in our records.'}
        </p>
      </div>

      <div style={{ marginTop: 16, paddingTop: 8, borderTop: '1px solid #DCE4EA',
                    fontSize: 9.5, color: '#8A98A4', display: 'flex', justifyContent: 'space-between' }}>
        <span>This is a computer-generated statement and needs no signature.</span>
        <span>Generated {formatDate(new Date().toISOString().slice(0, 10))}</span>
      </div>
    </div>
  );
});

function Th({ children, w, right }) {
  return (
    <th style={{
      width: w, textAlign: right ? 'right' : 'left', padding: '6px 9px',
      fontSize: 9.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase',
      color: '#5C6B78', borderBottom: '1px solid #DCE4EA', whiteSpace: 'nowrap',
    }}>{children}</th>
  );
}

function Td({ children, right, mono, bold, muted, colSpan }) {
  return (
    <td colSpan={colSpan} style={{
      padding: '5px 9px',
      textAlign: right ? 'right' : 'left',
      fontFamily: mono ? '"IBM Plex Mono", monospace' : 'inherit',
      fontWeight: bold ? 600 : 400,
      color: muted ? '#5C6B78' : 'inherit',
      whiteSpace: 'nowrap',
    }}>{children}</td>
  );
}

export default StatementDocument;
