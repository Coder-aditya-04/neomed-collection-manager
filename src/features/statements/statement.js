import { formatInr, formatCount, formatDate, formatAge } from '../../lib/format.js';
import { toWhatsAppNumber } from '../registers/Registers.jsx';

/**
 * Party statements for WhatsApp.
 *
 * At month end these were being assembled by hand out of a spreadsheet, one
 * party at a time. The figures here come straight from the snapshot, so the
 * statement says exactly what the book says and cannot drift from it.
 *
 * WhatsApp is plain text — no tables, no bold beyond its own markers — so the
 * layout has to survive being read on a phone in a shop. Bills are listed
 * oldest first, because those are the ones being asked about.
 */

const MAX_BILLS_IN_MESSAGE = 12;

/**
 * The message body. Deliberately short: a wall of eighty bills gets ignored,
 * so beyond a dozen it summarises and offers the full statement on request.
 */
export function buildStatementText(party, bills, { asOf, company = 'Neomed Pharma Agencies' } = {}) {
  const greeting = party.contact_person ? `Dear ${party.contact_person}` : 'Dear Sir/Madam';
  const open = (bills ?? [])
    .filter((b) => Number(b.balance) > 0)
    .sort((a, b) => String(a.bill_date).localeCompare(String(b.bill_date)));

  const lines = [];
  lines.push(`*${company}*`);
  lines.push(`Statement of account as on ${formatDate(asOf)}`);
  lines.push('');
  lines.push(greeting + ',');
  lines.push('');
  lines.push(`Outstanding balance: *${formatInr(party.current_outstanding)}*`);
  lines.push(`Open bills: ${formatCount(party.bill_count)}`);
  if (party.oldest_bill_age_days != null) {
    lines.push(`Oldest bill: ${formatAge(party.oldest_bill_age_days)}`);
  }
  lines.push('');

  if (open.length) {
    lines.push('*Bill details*');
    for (const b of open.slice(0, MAX_BILLS_IN_MESSAGE)) {
      lines.push(`${b.bill_no}  ${formatDate(b.bill_date)}  ${formatInr(b.balance)}`);
    }
    if (open.length > MAX_BILLS_IN_MESSAGE) {
      const rest = open.slice(MAX_BILLS_IN_MESSAGE);
      const restTotal = rest.reduce((a, b) => a + Number(b.balance), 0);
      lines.push(`… and ${formatCount(rest.length)} more totalling ${formatInr(restTotal)}`);
    }
    lines.push('');
  }

  lines.push('Kindly arrange payment or let us know the expected date.');
  lines.push('If any bill above is already settled, please tell us which, so we can update our records.');
  lines.push('');
  lines.push('Thank you,');
  lines.push(company);

  return lines.join('\n');
}

/** wa.me link carrying the statement, ready to send but unsent. */
export function statementWhatsAppLink(party, bills, opts) {
  const n = toWhatsAppNumber(party.phone);
  if (!n) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(buildStatementText(party, bills, opts))}`;
}

/**
 * Everything a batch run needs to know before it starts, including who
 * cannot be sent to. A silent skip would look like a message that went
 * missing, so parties without a number are counted and named.
 */
export function planBatch(parties) {
  const sendable = [];
  const missingNumber = [];
  for (const p of parties) {
    if (toWhatsAppNumber(p.phone)) sendable.push(p);
    else missingNumber.push(p);
  }
  return {
    sendable,
    missingNumber,
    sendableValue: sendable.reduce((a, p) => a + Number(p.current_outstanding), 0),
    missingValue: missingNumber.reduce((a, p) => a + Number(p.current_outstanding), 0),
  };
}
