import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.js';
import { teamQuery, useMe } from '../../lib/useMe.js';
import { createLogin, lookupLogin } from '../../lib/adminAuth.js';
import { formatCount } from '../../lib/format.js';

/**
 * The team, and their logins — managed by the owner from inside the app.
 *
 * Two ideas, kept apart on purpose:
 *   a PERSON  is somebody who can be assigned parties and shows up in the
 *             activity reports. Adding one takes a name and a role.
 *   a LOGIN   is an email and password that signs in as that person.
 *
 * Most of this desk needs the first; only some need the second. A person
 * can be added today and given a login next month without losing a single
 * assignment, because the link is made by moving their id, not by creating
 * a second person.
 */
const ROLES = [
  ['sales', 'Recovery', 'logs calls, remarks, promises, follow-ups'],
  ['accounts', 'Accounts', 'everything except settings and roles — imports, credit terms, claims'],
  ['owner', 'Owner', 'everything, including users and settings'],
];

export default function Users() {
  const qc = useQueryClient();
  const { isOwner, userId } = useMe();
  const { data: team, isLoading } = useQuery(teamQuery());
  const [mode, setMode] = useState(null); // 'person' | 'login' | {link: user}
  const refresh = () => invalidate(qc);

  if (!isOwner) {
    return (
      <p className="px-[10px] py-3 text-[12px] text-mute text-pretty">
        Only the owner can add people or change roles. The team is listed below.
        <TeamTable team={team} isLoading={isLoading} readOnly userId={userId} />
      </p>
    );
  }

  return (
    <div className="px-[10px] py-2">
      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" className={`btn ${mode === 'login' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode(mode === 'login' ? null : 'login')}>
          Add a person with a login
        </button>
        <button type="button" className={`btn ${mode === 'person' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode(mode === 'person' ? null : 'person')}>
          Add a person (no login)
        </button>
      </div>

      {mode === 'login' ? <NewLoginForm onDone={() => { setMode(null); refresh(); }} /> : null}
      {mode === 'person' ? <NewPersonForm onDone={() => { setMode(null); refresh(); }} /> : null}
      {mode && typeof mode === 'object' && mode.link ? (
        <LinkLoginForm user={mode.link} onDone={() => { setMode(null); refresh(); }} onCancel={() => setMode(null)} />
      ) : null}

      <TeamTable team={team} isLoading={isLoading} userId={userId}
                 onLink={(u) => setMode({ link: u })} onChanged={refresh} />

      <p className="mt-3 text-[11px] text-faint text-pretty">
        Logins are created with the project's ordinary sign-up, which needs two switches in
        Supabase → Authentication → Providers → Email: <strong>Allow new users to sign up</strong> on,
        and <strong>Confirm email</strong> off. A session alone grants nothing — only people in this
        list can read or write anything.
      </p>
    </div>
  );
}

function invalidate(qc) {
  qc.invalidateQueries({ queryKey: ['app-users'] });
  qc.invalidateQueries({ queryKey: ['me'] });
}

/* ------------------------------------------------------------------ */

function TeamTable({ team, isLoading, readOnly, userId, onLink, onChanged }) {
  if (isLoading) return <p className="text-[12px] text-mute">Loading…</p>;
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="border-b border-hair text-[9.5px] uppercase tracking-[0.08em] text-faint">
          <th className="py-[6px] text-left">Name</th>
          <th className="py-[6px] text-left">Role</th>
          <th className="py-[6px] text-left">Login</th>
          <th className="py-[6px] text-right">Parties</th>
          <th className="py-[6px] text-right">Status</th>
        </tr>
      </thead>
      <tbody>
        {(team ?? []).map((u) => (
          <UserRow key={u.id} user={u} readOnly={readOnly} isMe={u.id === userId} onLink={onLink} onChanged={onChanged} />
        ))}
        {!team?.length ? <tr><td colSpan={5} className="py-3 text-faint">Nobody yet.</td></tr> : null}
      </tbody>
    </table>
  );
}

function UserRow({ user, readOnly, isMe, onLink, onChanged }) {
  const { data: owned } = useQuery({
    queryKey: ['owned-count', user.id],
    queryFn: async () => {
      const { count, error } = await supabase.from('parties').select('id', { count: 'exact', head: true }).eq('responsible_person', user.id);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const update = useMutation({
    mutationFn: async (patch) => {
      const { error } = await supabase.from('app_users').update(patch).eq('id', user.id);
      if (error) throw error;
    },
    onSuccess: onChanged,
  });

  return (
    <tr className={`border-b border-rule last:border-b-0 ${user.active === false ? 'opacity-55' : ''}`}>
      <td className="py-[6px] font-medium">{user.full_name}{isMe ? <span className="ml-1 text-[10.5px] text-faint">(you)</span> : null}</td>
      <td className="py-[6px]">
        {readOnly || isMe ? (
          <span className="text-mute">{ROLES.find(([v]) => v === user.role)?.[1] ?? user.role}</span>
        ) : (
          <select value={user.role} onChange={(e) => update.mutate({ role: e.target.value })}
                  className="rounded-[2px] border border-hair bg-surface px-[6px] py-[2px] text-[11.5px]">
            {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
      </td>
      <td className="py-[6px] text-mute">
        {user.email ? user.email : isMe ? <span className="text-faint">this login</span> : (
          readOnly ? <span className="text-faint">none</span> : (
            <button type="button" onClick={() => onLink?.(user)} className="text-[11.5px] text-teal-deep hover:underline">
              Give a login
            </button>
          )
        )}
      </td>
      <td className="tnum py-[6px] text-right">{formatCount(owned ?? 0)}</td>
      <td className="py-[6px] text-right">
        {readOnly || isMe ? (
          <span className="text-[11.5px] text-mute">{user.active === false ? 'Inactive' : 'Active'}</span>
        ) : (
          <button type="button" onClick={() => update.mutate({ active: user.active === false })}
                  className={`text-[11.5px] ${user.active === false ? 'text-faint' : 'text-teal-deep'} hover:underline`}>
            {user.active === false ? 'Inactive — reactivate' : 'Active'}
          </button>
        )}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */

const INPUT = 'rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]';

function NewPersonForm({ onDone }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('sales');
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('app_users').insert({ full_name: name.trim(), role });
      if (error) throw error;
    },
    onSuccess: onDone,
  });
  return (
    <Form title="Add a person" onSubmit={() => add.mutate()} busy={add.isPending} error={add.error} disabled={!name.trim()} ok="Add">
      <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Prajwal" className={`${INPUT} w-[200px]`} /></Field>
      <RoleField value={role} onChange={setRole} />
      <p className="w-full text-[11px] text-faint">They can be assigned parties and appear in reports straight away. A login can be added later.</p>
    </Form>
  );
}

function NewLoginForm({ onDone }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('sales');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [warn, setWarn] = useState(null);

  const add = useMutation({
    mutationFn: async () => {
      const { id, needsConfirmation } = await createLogin({ email: email.trim(), password, fullName: name.trim() });
      const { error } = await supabase.from('app_users').insert({ id, full_name: name.trim(), role, email: email.trim() });
      if (error) throw new Error(`The login was created but the person could not be added: ${error.message}`);
      return needsConfirmation;
    },
    onSuccess: (needsConfirmation) => {
      if (needsConfirmation) {
        setWarn('Created — but "Confirm email" is still on in Supabase, so they must click the confirmation mail before they can sign in. Turn it off under Authentication → Providers → Email to skip that in future.');
      }
      onDone();
    },
  });

  return (
    <Form title="Add a person with a login" onSubmit={() => add.mutate()} busy={add.isPending} error={add.error}
          disabled={!name.trim() || !email.trim() || password.length < 6} ok="Create login">
      <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Prajwal Patil" className={`${INPUT} w-[180px]`} /></Field>
      <RoleField value={role} onChange={setRole} />
      <Field label="Email (their sign-in)"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prajwal@neomed.in" className={`${INPUT} w-[200px]`} /></Field>
      <Field label="Password (6+ characters)"><input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Give them this" className={`${INPUT} w-[160px]`} /></Field>
      {warn ? <p className="w-full text-[11.5px] text-age-2 text-pretty">{warn}</p> : null}
      <p className="w-full text-[11px] text-faint text-pretty">
        Write the password down for them — it is not stored anywhere readable. They can be told to change it later.
      </p>
    </Form>
  );
}

/**
 * A person added by name gets a login: either a new one is created, or one
 * they already have is attached. Either way their id becomes the login's id
 * and every assignment and log entry follows it.
 */
function LinkLoginForm({ user, onDone, onCancel }) {
  const [email, setEmail] = useState(user.email ?? '');
  const [password, setPassword] = useState('');
  const [existing, setExisting] = useState(false);

  const link = useMutation({
    mutationFn: async () => {
      const newId = existing
        ? await lookupLogin({ email: email.trim(), password })
        : (await createLogin({ email: email.trim(), password, fullName: user.full_name })).id;
      const { error } = await supabase.rpc('fn_relink_user', { p_old: user.id, p_new: newId });
      if (error) throw error;
      const { error: e2 } = await supabase.from('app_users').update({ email: email.trim() }).eq('id', newId);
      if (e2) throw e2;
    },
    onSuccess: onDone,
  });

  return (
    <Form title={`Give ${user.full_name} a login`} onSubmit={() => link.mutate()} busy={link.isPending} error={link.error}
          disabled={!email.trim() || password.length < 6} ok={existing ? 'Link login' : 'Create and link'} onCancel={onCancel}>
      <label className="flex w-full items-center gap-2 text-[12px]">
        <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} />
        They already have a login — attach it (needs their password)
      </label>
      <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${INPUT} w-[220px]`} /></Field>
      <Field label={existing ? 'Their password' : 'New password (6+ characters)'}>
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className={`${INPUT} w-[170px]`} />
      </Field>
      <p className="w-full text-[11px] text-faint text-pretty">
        Everything already recorded against {user.full_name} — assigned parties, calls, remarks — moves with them.
      </p>
    </Form>
  );
}

/* ------------------------------------------------------------------ */

function Form({ title, children, onSubmit, busy, error, disabled, ok, onCancel }) {
  return (
    <form className="mb-4 border border-hair bg-surface p-3" onSubmit={(e) => { e.preventDefault(); if (!disabled && !busy) onSubmit(); }}>
      <div className="kicker mb-2">{title}</div>
      <div className="flex flex-wrap items-end gap-2">
        {children}
        <button type="submit" className="btn btn-primary px-3 py-[4px] text-[12px]" disabled={disabled || busy}>
          {busy ? 'Working…' : ok}
        </button>
        {onCancel ? <button type="button" className="btn btn-secondary px-3 py-[4px] text-[12px]" onClick={onCancel}>Cancel</button> : null}
      </div>
      {error ? <p className="mt-2 text-[11.5px] text-age-4 text-pretty">{error.message}</p> : null}
    </form>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="kicker mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function RoleField({ value, onChange }) {
  return (
    <Field label="Role">
      <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
        {ROLES.map(([v, l, hint]) => <option key={v} value={v}>{l} — {hint}</option>)}
      </select>
    </Field>
  );
}
