import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { supabase } from './lib/supabase.js';
import AppShell from './features/shell/AppShell.jsx';
import LoginScreen from './features/shell/LoginScreen.jsx';
import ImportScreen from './features/import/ImportScreen.jsx';
import DashboardScreen from './features/dashboard/DashboardScreen.jsx';
import PartiesScreen from './features/parties/PartiesScreen.jsx';
import CreditMasterScreen from './features/credit/CreditMasterScreen.jsx';
import AssistantScreen from './features/assistant/AssistantScreen.jsx';
import SettingsScreen from './features/settings/SettingsScreen.jsx';
import { ClaimsScreen, FollowupsScreen, PromisesScreen } from './features/registers/Registers.jsx';

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
        <Route index element={<DashboardScreen />} />
        <Route path="parties" element={<PartiesScreen />} />
        <Route path="credit-master" element={<CreditMasterScreen />} />
        <Route path="import" element={<ImportScreen />} />
        <Route path="followups" element={<FollowupsScreen />} />
        <Route path="promises" element={<PromisesScreen />} />
        <Route path="claims" element={<ClaimsScreen />} />
        <Route path="assistant" element={<AssistantScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
