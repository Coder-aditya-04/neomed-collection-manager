import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase.js';

/**
 * Who is signed in, as the team knows them.
 *
 * The session carries an auth id and an email; the name, the role and
 * whether they are still active live on app_users. Screens that filter "my
 * parties" or stamp "closed by" need the latter, and asking for it once here
 * beats every screen joining the two itself.
 */
export function useMe() {
  const q = useQuery({
    queryKey: ['me'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data: s } = await supabase.auth.getSession();
      const userId = s?.session?.user?.id ?? null;
      if (!userId) return { userId: null, me: null };
      const { data, error } = await supabase
        .from('app_users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return { userId, me: data ?? null };
    },
  });
  return {
    userId: q.data?.userId ?? null,
    me: q.data?.me ?? null,
    isOwner: q.data?.me?.role === 'owner',
    isLoading: q.isLoading,
  };
}

/** Every team member, active first, for pickers and filters. */
export function teamQuery() {
  return {
    queryKey: ['app-users'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('app_users')
        .select('*')
        .order('active', { ascending: false })
        .order('full_name');
      if (error) throw error;
      return data ?? [];
    },
  };
}

/**
 * The filter value a "Person" dropdown carries, applied to a row's user id.
 *   ''     everyone
 *   'me'   the signed-in person
 *   'none' nobody assigned
 *   <uuid> that person
 */
export function matchesUser(filter, rowUserId, myId) {
  if (!filter) return true;
  if (filter === 'me') return Boolean(myId) && rowUserId === myId;
  if (filter === 'none') return !rowUserId;
  return rowUserId === filter;
}
