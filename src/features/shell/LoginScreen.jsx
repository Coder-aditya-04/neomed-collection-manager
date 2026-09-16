import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) setError(err.message);
    setBusy(false);
  }

  return (
    <div className="grid min-h-screen place-items-center bg-canvas p-6">
      <form onSubmit={submit} className="w-[320px]">
        <div className="mb-[30px] flex items-center gap-[9px]">
          <div className="relative h-5 w-5 flex-none border-2 border-ink">
            <div className="absolute inset-y-1 inset-x-[2px] border-x-2 border-ink" />
          </div>
          <div>
            <div className="text-[16px] font-semibold leading-none tracking-[-0.01em]">
              Neomed Pharma Agencies
            </div>
            <div className="mt-1 text-[10.5px] uppercase tracking-[0.14em] text-mute">
              Collection Manager
            </div>
          </div>
        </div>

        <label htmlFor="email" className="mb-[5px] block text-[11px] uppercase tracking-[0.08em] text-mute">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-[15px] w-full rounded-[2px] border border-hair bg-white px-[11px] py-[9px] text-[13.5px]"
        />

        <label htmlFor="password" className="mb-[5px] block text-[11px] uppercase tracking-[0.08em] text-mute">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-[22px] w-full rounded-[2px] border border-hair bg-white px-[11px] py-[9px] text-[13.5px]"
        />

        {error ? <p className="mb-3 text-[12px] text-age-3">{error}</p> : null}

        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
