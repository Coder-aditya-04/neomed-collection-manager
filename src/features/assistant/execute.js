import { supabase } from '../../lib/supabase.js';
import { formatInr, formatCount, formatAge, formatPct, formatDate } from '../../lib/format.js';

/**
 * Turns a routed intent into an answer.
 *
 * Every figure comes back from Postgres. Nothing is computed here beyond
 * choosing which sentence frames it, and no sentence contains a number that
 * was not read from the database.
 *
 * An answer is a typed object, not a string, so the UI can render an ageing
 * strip, a ranked list or a table rather than a paragraph.
 */

const SMALL_BALANCE = 10000;

export async function executeIntent({ intent, params }, context = {}) {
  const run = HANDLERS[intent];
  if (!run) return unmatched(params.question);
  try {
    return await run(params, context);
  } catch (e) {
    return { kind: 'error', text: `That query failed: ${e.message}` };
  }
}

/* ------------------------------------------------------------------ */

const HANDLERS = {
  async summary() {
    const { data, error } = await supabase.from('v_portfolio_ageing').select('*').maybeSingle();
    if (error) throw error;
    const snap = await latestSnapshot();
    if (!data || !snap) return { kind: 'text', text: 'Nothing is imported yet, so there is no position to report.' };

    const judgeable = num(data.within_terms) + num(data.over_1_30) + num(data.over_31_60) + num(data.over_60);
    return {
      kind: 'answer',
      text:
        `${formatInr(snap.net_total)} is outstanding across ${formatCount(snap.party_count)} parties and ` +
        `${formatCount(snap.bill_count)} open bills. ${formatInr(data.total_owed)} is owed and ` +
        `${formatInr(Math.abs(num(data.total_credit)))} sits in credit.` +
        (judgeable > 0
          ? ''
          : ` None of it can be aged yet: no party has an approved credit term, so there is no due date to measure against.`),
      strip: judgeable > 0 ? bucketsFrom(data) : null,
      kv: [
        { k: 'Owed', v: formatInr(data.total_owed) },
        { k: 'In credit', v: formatInr(data.total_credit) },
        { k: 'Net', v: formatInr(data.net_total) },
        { k: 'Cannot be judged', v: formatInr(data.unjudgeable_amount) },
      ],
      source: `Snapshot ${formatDate(snap.report_date)}`,
    };
  },

  async ageing_breakdown() {
    const { data, error } = await supabase.from('v_portfolio_ageing').select('*').maybeSingle();
    if (error) throw error;
    const judgeable = num(data?.within_terms) + num(data?.over_1_30) + num(data?.over_31_60) + num(data?.over_60);

    if (judgeable <= 0) {
      return blocked(
        `The book cannot be aged yet. All ${formatCount(data?.unjudgeable_parties)} parties — ` +
          `${formatInr(data?.unjudgeable_amount)} — have no approved credit term, so no bill has a due date ` +
          'to be measured against.',
        'Bill age is not the same thing as being overdue. I can tell you how old the money is, but not whether it is late.',
        { label: 'Open credit master', to: '/credit-master' }
      );
    }
    return {
      kind: 'answer',
      text: `${formatInr(judgeable)} can be aged against approved terms.`,
      strip: bucketsFrom(data),
      source: 'Portfolio ageing',
    };
  },

  async party_lookup({ partyId, partyName, alternatives }) {
    const { data, error } = await supabase
      .from('v_party_ageing')
      .select('*')
      .eq('party_id', partyId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'text', text: `I could not find ${partyName}.` };

    const alt = alternatives?.length
      ? ` (I read that as ${data.display_name}; you might have meant ${alternatives.map((a) => a.display_name).join(' or ')}.)`
      : '';

    if (data.needs_credit_term) {
      // THE STOP RULE.
      return blocked(
        `${data.display_name} has no approved credit term, so I cannot tell you how overdue it is — only how old it is.` + alt,
        `${formatInr(data.current_outstanding)} outstanding across ${formatCount(data.bill_count)} bills, the oldest ` +
          `${formatAge(data.oldest_bill_age_days)} old. That is an age, not lateness. Set the term and I will answer this properly.`,
        { label: 'Set the term', to: '/credit-master' },
        [
          { k: 'Outstanding', v: formatInr(data.current_outstanding) },
          { k: 'Oldest bill', v: formatAge(data.oldest_bill_age_days) },
          { k: 'Open bills', v: formatCount(data.bill_count) },
          { k: 'Credit term', v: 'not set' },
        ]
      );
    }

    const over = num(data.over_1_30) + num(data.over_31_60) + num(data.over_60);
    return {
      kind: 'answer',
      text:
        `${data.display_name} owes ${formatInr(data.current_outstanding)} across ${formatCount(data.bill_count)} bills.` +
        (over > 0
          ? ` ${formatInr(over)} of it is past term, the worst by ${formatCount(data.max_overdue_days)} days.`
          : ' All of it is within terms.') +
        (data.term_is_assumed ? ' Note the term is a category default, not an approved one.' : '') +
        alt,
      strip: bucketsFrom(data),
      kv: [
        { k: 'Outstanding', v: formatInr(data.current_outstanding) },
        { k: 'Oldest bill', v: formatAge(data.oldest_bill_age_days) },
        { k: 'Worst overdue', v: data.max_overdue_days > 0 ? `${formatCount(data.max_overdue_days)}d` : 'within terms' },
        { k: 'Open bills', v: formatCount(data.bill_count) },
      ],
      source: `Party record · ${data.display_name}`,
    };
  },

  async top_parties({ limit }) {
    const rows = await parties({ order: 'current_outstanding.desc', limit, gt: 0 });
    const all = await parties({ order: 'current_outstanding.desc', limit: 1000, gt: 0 });
    const total = all.reduce((a, p) => a + num(p.current_outstanding), 0);
    const top = rows.reduce((a, p) => a + num(p.current_outstanding), 0);
    return {
      kind: 'answer',
      text: `The top ${rows.length} parties hold ${formatInr(top)} — ${formatPct(top, total)} of everything outstanding.`,
      list: rows.map(toListItem),
      source: `Ranked by outstanding · ${formatCount(all.length)} parties owing`,
    };
  },

  async above_amount({ amount }) {
    const rows = await parties({ order: 'current_outstanding.desc', limit: 200, gte: amount });
    const sum = rows.reduce((a, p) => a + num(p.current_outstanding), 0);
    return {
      kind: 'answer',
      text: rows.length
        ? `${formatCount(rows.length)} parties owe ${formatInr(amount)} or more, ${formatInr(sum)} between them.`
        : `No party owes ${formatInr(amount)} or more.`,
      list: rows.slice(0, 25).map(toListItem),
      source: `Threshold ${formatInr(amount)}`,
    };
  },

  async older_than({ days }) {
    const { data, error } = await supabase
      .from('v_party_ageing')
      .select('*')
      .gte('oldest_bill_age_days', days)
      .gt('current_outstanding', 0)
      .order('current_outstanding', { ascending: false })
      .limit(200);
    if (error) throw error;
    const sum = (data ?? []).reduce((a, p) => a + num(p.current_outstanding), 0);
    return {
      kind: 'answer',
      text:
        `${formatCount(data?.length ?? 0)} parties have a bill at least ${formatCount(days)} days old, ` +
        `carrying ${formatInr(sum)} in total. That is bill age — whether it is late depends on each party's term.`,
      list: (data ?? []).slice(0, 25).map(toListItem),
      source: `Bill age ≥ ${formatCount(days)} days`,
    };
  },

  async who_to_call({ limit }) {
    const { data, error } = await supabase.rpc('fn_priority_list', { p_limit: limit });
    if (error) throw error;

    if (!data?.length) {
      const { data: pf } = await supabase.from('v_portfolio_ageing').select('*').maybeSingle();
      // The stop rule in its most important form: offer exposure and age, but
      // say plainly that it is a starting point and not a call list.
      const fallback = await parties({ order: 'current_outstanding.desc', limit: 10, gt: 0 });
      return blocked(
        `I cannot give you a call list. Every party is excluded — ${formatCount(pf?.unjudgeable_parties)} of them ` +
          `because no credit term is recorded, which means nothing can be called overdue.`,
        'What I can offer instead is a ranking by exposure and bill age. Treat it as a starting point, not a call list: ' +
          'the order reflects how much money is sitting there and how long, not whether anyone is actually late.',
        { label: 'Set credit terms', to: '/credit-master' },
        null,
        fallback.map(toListItem)
      );
    }

    return {
      kind: 'answer',
      text: `${data.length} parties are worth working first, ranked by money at risk.`,
      list: data.map((p) => ({
        name: p.display_name,
        amount: formatInr(p.current_outstanding),
        meta: p.reason,
        buckets: [p.within_terms, p.over_1_30, p.over_31_60, p.over_60].map(num),
      })),
      source: 'Priority ranking · claim-blocked, disputed and term-less parties excluded',
    };
  },

  async needs_credit_term({ limit }) {
    const { data, error } = await supabase.rpc('fn_needs_credit_term', { p_limit: limit });
    if (error) throw error;
    const { data: pf } = await supabase.from('v_portfolio_ageing').select('*').maybeSingle();
    const topSum = (data ?? []).reduce((a, p) => a + num(p.current_outstanding), 0);
    return {
      kind: 'answer',
      text:
        `${formatCount(pf?.unjudgeable_parties)} parties have no approved credit term, holding ` +
        `${formatInr(pf?.unjudgeable_amount)}. I can tell you how old that money is, but not whether it is overdue. ` +
        `The largest ${formatCount(data?.length ?? 0)} of them are ${formatInr(topSum)} — fill those first.`,
      list: (data ?? []).map((p) => ({
        name: p.display_name,
        amount: formatInr(p.current_outstanding),
        meta: `oldest bill ${formatAge(p.oldest_bill_age_days)} · ${formatCount(p.bill_count)} bills`,
      })),
      action: { label: 'Open credit master', to: '/credit-master' },
      source: 'Parties blocking classification',
    };
  },

  async credit_balance_parties() {
    const { data, error } = await supabase
      .from('v_party_ageing')
      .select('*')
      .lt('current_outstanding', 0)
      .order('current_outstanding', { ascending: true })
      .limit(200);
    if (error) throw error;
    const sum = (data ?? []).reduce((a, p) => a + num(p.current_outstanding), 0);
    return {
      kind: 'answer',
      text:
        `${formatCount(data?.length ?? 0)} parties carry a credit balance totalling ${formatInr(sum)}. ` +
        'These are advances or unadjusted credit notes — not debt, and excluded from every collection view.',
      list: (data ?? []).slice(0, 25).map(toListItem),
      source: 'Negative balances',
    };
  },

  async small_accounts() {
    const { data, error } = await supabase
      .from('v_party_ageing')
      .select('*')
      .gt('current_outstanding', 0)
      .lt('current_outstanding', SMALL_BALANCE)
      .order('current_outstanding', { ascending: false })
      .limit(500);
    if (error) throw error;
    const sum = (data ?? []).reduce((a, p) => a + num(p.current_outstanding), 0);
    const all = await parties({ order: 'current_outstanding.desc', limit: 1000, gt: 0 });
    const total = all.reduce((a, p) => a + num(p.current_outstanding), 0);
    return {
      kind: 'answer',
      text:
        `${formatCount(data?.length ?? 0)} parties owe under ${formatInr(SMALL_BALANCE)} each — ` +
        `${formatInr(sum)} between them, ${formatPct(sum, total)} of the book. ` +
        `A write-off batch, not ${formatCount(data?.length ?? 0)} phone calls.`,
      kv: [
        { k: 'Parties', v: formatCount(data?.length ?? 0) },
        { k: 'Total', v: formatInr(sum) },
        { k: 'Share of book', v: formatPct(sum, total) },
      ],
      source: `Below ${formatInr(SMALL_BALANCE)}`,
    };
  },

  async claim_blocked() {
    const { data, error } = await supabase
      .from('claims')
      .select('*, parties(display_name, current_outstanding)')
      .eq('status', 'open')
      .order('payment_held', { ascending: false })
      .limit(100);
    if (error) throw error;
    if (!data?.length) {
      return { kind: 'text', text: 'No claims are open, so nothing is blocked by our own pending action.' };
    }
    const held = data.reduce((a, c) => a + num(c.payment_held), 0);
    return {
      kind: 'answer',
      text: `${formatCount(data.length)} parties are held by an open claim, covering ${formatInr(held)}. These are not defaulters — the next action is ours.`,
      list: data.map((c) => ({
        name: c.parties?.display_name ?? 'Unknown party',
        amount: formatInr(c.payment_held),
        meta: `${c.claim_type.replace('_', ' ')} · raised ${formatDate(c.raised_on)} · with ${c.pending_with ?? 'unassigned'}`,
      })),
      source: 'Open claims',
    };
  },

  async broken_promises() {
    const { data, error } = await supabase
      .from('promises')
      .select('*, parties(display_name)')
      .in('status', ['broken', 'partial'])
      .order('due_date', { ascending: true })
      .limit(100);
    if (error) throw error;
    if (!data?.length) return { kind: 'text', text: 'No promise has been broken.' };
    const broken = data.filter((p) => p.status === 'broken');
    return {
      kind: 'answer',
      text: `${formatCount(broken.length)} promises are broken and ${formatCount(data.length - broken.length)} were only partly kept. A promise closes only when a payment supports it.`,
      list: data.map((p) => ({
        name: p.parties?.display_name ?? 'Unknown party',
        amount: formatInr(p.promised_amount),
        meta: `${p.status} · due ${formatDate(p.due_date)} · received ${formatInr(p.received_amount)}`,
      })),
      source: 'Promise register',
    };
  },

  async missed_followups() {
    const { data, error } = await supabase
      .from('followups')
      .select('*, parties(display_name, current_outstanding)')
      .eq('closed', false)
      .lt('next_followup_date', new Date().toISOString().slice(0, 10))
      .order('next_followup_date', { ascending: true })
      .limit(100);
    if (error) throw error;
    if (!data?.length) return { kind: 'text', text: 'Nothing committed has been missed.' };
    return {
      kind: 'answer',
      text: `${formatCount(data.length)} follow-ups were committed to and have passed their date.`,
      list: data.map((f) => ({
        name: f.parties?.display_name ?? 'Unknown party',
        amount: formatInr(f.parties?.current_outstanding),
        meta: `due ${formatDate(f.next_followup_date)} · last contact by ${f.method}`,
      })),
      source: 'Follow-up register',
    };
  },

  async what_changed() {
    const { data, error } = await supabase.rpc('fn_what_changed');
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.to_date) {
      return {
        kind: 'text',
        text: 'Only one snapshot has been imported, so there is nothing to compare it against. Import tomorrow\'s file and I can tell you what moved.',
      };
    }
    const received = num(row.payments_value) + num(row.settled_value);
    return {
      kind: 'answer',
      text:
        `Between ${formatDate(row.from_date)} and ${formatDate(row.to_date)}, ${formatInr(received)} arrived across ` +
        `${formatCount(row.payments_count + row.settled_count)} bills, and ${formatInr(row.new_bill_value)} of new billing landed.`,
      kv: [
        { k: 'Payments', v: formatInr(row.payments_value) },
        { k: 'Settled in full', v: formatInr(row.settled_value) },
        { k: 'New bills', v: formatInr(row.new_bill_value) },
        { k: 'Net change', v: formatInr(row.net_change) },
      ],
      source: `${formatDate(row.from_date)} → ${formatDate(row.to_date)}`,
    };
  },

  async party_count() {
    const snap = await latestSnapshot();
    if (!snap) return { kind: 'text', text: 'Nothing is imported yet.' };
    const { data } = await supabase.from('v_portfolio_ageing').select('*').maybeSingle();
    return {
      kind: 'answer',
      text: `${formatCount(snap.party_count)} parties and ${formatCount(snap.bill_count)} open bills in the ${formatDate(snap.report_date)} snapshot.`,
      kv: [
        { k: 'Parties', v: formatCount(snap.party_count) },
        { k: 'Bills', v: formatCount(snap.bill_count) },
        { k: 'Without a term', v: formatCount(data?.unjudgeable_parties) },
      ],
      source: `Snapshot ${formatDate(snap.report_date)}`,
    };
  },

  async help() {
    return { kind: 'help' };
  },

  async unmatched({ question }) {
    return unmatched(question);
  },
};

/* ------------------------------------------------------------------ */

function unmatched(question) {
  return {
    kind: 'unmatched',
    text:
      `I could not match "${String(question ?? '').slice(0, 120)}" to anything I know how to answer. ` +
      'I would rather say so than guess at what you meant and hand you a confident wrong number.',
  };
}

function blocked(text, detail, action, kv, list) {
  return { kind: 'blocked', text, detail, action, kv, list };
}

async function latestSnapshot() {
  const { data } = await supabase
    .from('snapshots')
    .select('*')
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function parties({ order, limit, gt, gte }) {
  let q = supabase.from('v_party_ageing').select('*');
  if (gt !== undefined) q = q.gt('current_outstanding', gt);
  if (gte !== undefined) q = q.gte('current_outstanding', gte);
  const [col, dir] = order.split('.');
  const { data, error } = await q.order(col, { ascending: dir === 'asc' }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

function toListItem(p) {
  return {
    name: p.display_name,
    amount: formatInr(p.current_outstanding),
    meta: p.needs_credit_term
      ? `no credit term · oldest bill ${formatAge(p.oldest_bill_age_days)}`
      : `oldest bill ${formatAge(p.oldest_bill_age_days)} · ${formatCount(p.bill_count)} bills`,
    buckets: p.needs_credit_term ? null : bucketsFrom(p),
  };
}

function bucketsFrom(r) {
  return [num(r.within_terms), num(r.over_1_30), num(r.over_31_60), num(r.over_60)];
}

function num(v) {
  return Number(v ?? 0);
}
