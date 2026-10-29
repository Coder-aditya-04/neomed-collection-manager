import { createClient } from '@supabase/supabase-js';

/*
 * Creating a login from inside the app, without the service key.
 *
 * The service role key can never go in a browser — anyone could read it out
 * of the bundle and own the database. So this does not use it. It uses the
 * ordinary sign-up endpoint, which the public key is allowed to call, on a
 * SECOND client that keeps no session: signing up on the main client would
 * log the owner out and log the new person in, which is the opposite of what
 * an admin screen is for.
 *
 * What stops a stranger doing the same? Nothing stops them creating an auth
 * user — but a session alone grants nothing. Every read policy now requires
 * the person to be in app_users (migration 0012), and only the owner can
 * write that table. A login created here is immediately followed by the
 * app_users row that gives it a role; one created by anyone else is a key
 * to a door with nothing behind it.
 *
 * REQUIRES, once, in Supabase → Authentication → Providers → Email:
 * "Confirm email" switched OFF. With it on, the new person is sent a
 * confirmation mail and cannot sign in until they click it.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let side = null;
function sideClient() {
  if (!side) {
    side = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return side;
}

/**
 * Creates the auth user and returns its id. Throws with a readable message
 * when the project is not set up for it.
 */
export async function createLogin({ email, password, fullName }) {
  const { data, error } = await sideClient().auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });
  if (error) {
    if (/signups? not allowed|disabled/i.test(error.message)) {
      throw new Error(
        'Sign-ups are switched off for this project. In Supabase → Authentication → Providers → ' +
        'Email, turn on "Allow new users to sign up", then try again.'
      );
    }
    throw error;
  }
  const user = data?.user;
  if (!user?.id) throw new Error('Supabase did not return the new user. Try again.');

  /*
   * identities is empty when an account with this email already exists and
   * Supabase is hiding that fact (its default against enumeration). Say so,
   * rather than returning an id that belongs to somebody else.
   */
  if (Array.isArray(user.identities) && user.identities.length === 0) {
    throw new Error('A login with that email already exists. Use "Link an existing login" instead.');
  }

  return {
    id: user.id,
    // null confirmed_at means email confirmation is still on in the project.
    needsConfirmation: !user.confirmed_at && !user.email_confirmed_at && !data.session,
  };
}

/**
 * Finds the auth id for an email the person has already signed up with, by
 * signing them in on the side client. Used to link an existing login to a
 * team member who was added by name. Needs their password, typed by them.
 */
export async function lookupLogin({ email, password }) {
  const c = sideClient();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const id = data?.user?.id;
  await c.auth.signOut().catch(() => {});
  if (!id) throw new Error('Could not read that login.');
  return id;
}
