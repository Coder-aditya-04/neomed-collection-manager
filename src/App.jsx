import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { supabase } from './lib/supabase.js';
import AppShell from './features/shell/AppShell.jsx';
import LoginScreen from './features/shell/LoginScreen.jsx';
import NotBuiltYet from './features/shell/NotBuiltYet.jsx';
import ImportScreen from './features/import/ImportScreen.jsx';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return <div className="grid min-h-screen place-items-center text-[12.5px] text-mute">Loading…</div>;
  }

  if (!session) return <LoginScreen />;

  return (
    <Routes>
      <Route element={<AppShell session={session} />}>
        <Route
          index
          element={
            <NotBuiltYet
              title="Today"
              step={6}
              what="Headline figures, the portfolio ageing strip, the priority list, concentration, and missed follow-ups. The SQL behind it — v_party_ageing, v_portfolio_ageing and fn_priority_list — is already built and tested."
            />
          }
        />
        <Route path="import" element={<ImportScreen />} />
        <Route
          path="parties"
          element={
            <NotBuiltYet
              title="Parties"
              step={4}
              what="The full virtualised list at 27px rows, sortable and filterable, with the party detail drawer over it."
            />
          }
        />
        <Route
          path="credit-master"
          element={
            <NotBuiltYet
              title="Credit master"
              step={5}
              what="The bulk term editor: days or monthly cycle per row, multi-row apply, keyboard-only entry, autosave, and progress against the top 100."
            />
          }
        />
        <Route
          path="followups"
          element={<NotBuiltYet title="Follow-ups" step={7} what="Missed first, then planned, then team activity." />}
        />
        <Route
          path="promises"
          element={<NotBuiltYet title="Promises" step={7} what="Open, kept, partial and broken — a promise closes only when a bill_change supports it." />}
        />
        <Route
          path="claims"
          element={<NotBuiltYet title="Claims" step={7} what="Grouped by who owes the internal action." />}
        />
        <Route
          path="assistant"
          element={
            <NotBuiltYet
              title="Assistant"
              step={9}
              what="The deterministic intent router. Not started before the credit master has approved terms for the top 100 parties — until then it has nothing reliable to reason about."
            />
          }
        />
        <Route
          path="settings"
          element={<NotBuiltYet title="Settings" step={7} what="Users and roles, category defaults, thresholds, and import history." />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
