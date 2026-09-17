import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Dashboard } from '@/components/Dashboard';
import { Setup } from '@/components/setup/Setup';
import { useHiveState } from '@/hooks/use-hive-state';
import { useSetupInfo } from '@/hooks/use-setup-info';
import { LOCALE, setLanguage, t } from '@/i18n';
import type { Language, SetupResult } from '../types';

type Mode = 'dashboard' | 'setup';

export function App() {
  const { info, error: setupError, reload } = useSetupInfo();
  const { state, connected, tick } = useHiveState();
  const [language, setLanguageState] = useState<Language>();
  const [mode, setMode] = useState<Mode>('dashboard');
  const [selectedSlotId, setSelectedSlotId] = useState<string>();

  useEffect(() => { // before the first content render: neither the form nor the dashboard ever shows the wrong language
    if (!info) return;
    setLanguage(info.language);
    setLanguageState(info.language);
    if (!info.configured) setMode('setup');
  }, [info]);
  useEffect(() => { if (language) document.documentElement.lang = LOCALE[language]; }, [language]);
  useEffect(() => { if (state?.error) toast.error(state.error); }, [state?.error]);
  useEffect(() => { if (!connected) toast.error(t('error.disconnected')); }, [connected]);

  if (setupError) return <p className="p-4 text-destructive">{setupError}</p>;
  if (!info || !language) return null;

  async function onSaved(result: SetupResult): Promise<void> {
    const next = await reload();
    setLanguage(next.language);
    setLanguageState(next.language);
    setMode('dashboard');
    if (result.restartForPort) toast(t('notice.restartPort', { port: result.restartForPort }));
  }

  return (
    <>
      {mode === 'setup'
        ? <Setup info={info} state={state} onSaved={onSaved} onCancel={info.configured ? () => setMode('dashboard') : undefined} />
        : <Dashboard state={state} selectedSlotId={selectedSlotId} locale={LOCALE[language]} tick={tick} onSelect={setSelectedSlotId} onConfigure={() => setMode('setup')} />}
      <Toaster theme="dark" />
    </>
  );
}
