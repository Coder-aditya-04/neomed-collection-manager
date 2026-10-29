import { useQuery } from '@tanstack/react-query';
import { teamQuery, useMe } from '../lib/useMe.js';

/**
 * "Whose?" — the same dropdown on every screen that can be split by person.
 *
 * Values are documented on matchesUser(): '' everyone, 'me', 'none', or a
 * user id. "Me" is first because it is the one a recovery person reaches for
 * ten times a day; the owner reaches for a name.
 */
export default function UserFilter({ value, onChange, label = 'Person', includeNone = true, className = '' }) {
  const { data: team } = useQuery(teamQuery());
  const { userId } = useMe();

  return (
    <label className={`block ${className}`}>
      {label ? <span className="kicker mb-1 block">{label}</span> : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[2px] border border-hair bg-surface px-[8px] py-[4px] text-[12px]"
      >
        <option value="">Everyone</option>
        {userId ? <option value="me">Me</option> : null}
        {includeNone ? <option value="none">Nobody assigned</option> : null}
        {(team ?? []).filter((u) => u.active !== false).map((u) => (
          <option key={u.id} value={u.id}>{u.full_name}</option>
        ))}
      </select>
    </label>
  );
}
