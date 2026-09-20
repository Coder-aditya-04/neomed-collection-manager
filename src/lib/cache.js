/**
 * What to refetch after a write.
 *
 * Every mutation used to call `invalidateQueries()` with no argument, which
 * marks the entire cache stale — so saving one credit term refetched all 845
 * parties, the priority list, the portfolio totals and the snapshot list,
 * then re-rendered a table of 845 rows. That is the lag: a keystroke's worth
 * of work triggering a page's worth of network.
 *
 * These groups name only what a given write can actually have changed.
 */

export const PARTY_DERIVED = ['priority-list', 'portfolio-ageing', 'needs-credit-term', 'unallocated'];

export const AFTER = {
  // Credit terms move the ageing, so everything derived from it is stale.
  creditTerm: ['parties-ageing', ...PARTY_DERIVED],
  // Contact details and ownership change the party row and nothing else.
  partyDetails: ['parties-ageing', 'unallocated'],
  followup: ['followups', 'party-activity', 'recovery-activity', 'scorecard', 'due-today'],
  promise: ['promises', 'party-activity', 'scorecard'],
  claim: ['claims', 'party-activity', 'priority-list'],
  settings: ['settings', 'priority-list'],
  targets: ['recovery-targets', 'scorecard'],
};

/** Mark just these query families stale. */
export function invalidate(queryClient, keys) {
  for (const key of keys) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * Patch party rows already in the cache instead of refetching them.
 *
 * The credit master saves a row at a time. Refetching 845 parties to learn
 * the one thing we just wrote makes the screen stutter under the typing it is
 * built for, so the change is applied in place and only the small derived
 * queries are refetched.
 */
export function patchParties(queryClient, ids, changes) {
  const wanted = new Set(ids);
  queryClient.setQueriesData({ queryKey: ['parties-ageing'] }, (rows) => {
    if (!Array.isArray(rows)) return rows;
    return rows.map((row) => (wanted.has(row.party_id) ? { ...row, ...changes } : row));
  });
}
