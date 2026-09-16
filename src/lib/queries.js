import { supabase } from './supabase.js';

/**
 * Every read the screens make. All the arithmetic happens in Postgres — these
 * only fetch — so the dashboard, the parties list and (later) the assistant
 * cannot drift from one another.
 */

export function latestSnapshotQuery() {
  return {
    queryKey: ['latest-snapshot'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('snapshots')
        .select('*')
        .order('report_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}

export function portfolioAgeingQuery() {
  return {
    queryKey: ['portfolio-ageing'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_portfolio_ageing').select('*').maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}

/**
 * All parties for the latest snapshot.
 *
 * 819 rows is small enough to hold in memory and filter instantly, which is
 * what makes the list feel like a spreadsheet rather than a web page. Paged
 * explicitly because PostgREST caps a response at 1,000 rows by default.
 */
export function partiesAgeingQuery() {
  return {
    queryKey: ['parties-ageing'],
    queryFn: async () => {
      const PAGE = 1000;
      let from = 0;
      const all = [];
      for (;;) {
        const { data, error } = await supabase
          .from('v_party_ageing')
          .select('*')
          .order('current_outstanding', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        all.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
      return all;
    },
  };
}

export function priorityListQuery(limit = 6) {
  return {
    queryKey: ['priority-list', limit],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('fn_priority_list', { p_limit: limit });
      if (error) throw error;
      return data ?? [];
    },
  };
}

export function needsCreditTermQuery(limit = 100) {
  return {
    queryKey: ['needs-credit-term', limit],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('fn_needs_credit_term', { p_limit: limit });
      if (error) throw error;
      return data ?? [];
    },
  };
}

/** Open bills for one party, newest first. */
export function partyBillsQuery(partyId, snapshotId) {
  return {
    queryKey: ['party-bills', partyId, snapshotId],
    enabled: Boolean(partyId && snapshotId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bills')
        .select('*')
        .eq('party_id', partyId)
        .eq('snapshot_id', snapshotId)
        .order('bill_date', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  };
}

/** Warnings raised by the import that produced the current snapshot. */
export function snapshotWarningsQuery(snapshotId) {
  return {
    queryKey: ['snapshot-warnings', snapshotId],
    enabled: Boolean(snapshotId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('import_warnings')
        .select('warning_type, detail, party_id')
        .eq('snapshot_id', snapshotId)
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  };
}
