// The tasks sidebar's write of the signal table (#573): App holds the prefix and the settings info's reload, so it provides the write in a
// context instead of a prop drilled through Dashboard → AutomationPanel → TasksSidebar. No optimism: the rows keep rendering state.signals,
// which the server pushes after the save, so a failure leaves the old value on screen.
import { createContext, useContext } from 'react';
import { toast } from 'sonner';
import { patchedSignals } from '../../signals.js';
import type { SettingsResult, Signal, SignalBehaviour, SignalSettings } from '../../types.js';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';

/** The `signals` write as App provides it. */
export interface SignalsSettings { save(signals: SignalSettings): Promise<void> }

// Outside App (the tests' harness) a write fails, as ReviewerContext's does, so no component test posts a save it did not wire
export const SignalsContext = createContext<SignalsSettings>({
  save: () => Promise.reject(new Error('the signal settings are written only inside App')),
});

/** The write as reviewerSaver makes it: the prefix, which configFrom has no fallback for, and the key; configFrom keeps every omitted key.
 * Then the settings info is reloaded, so Settings opens on the saved table. A refusal throws. */
export function signalsSaver(prefix: string | undefined, reload: () => Promise<unknown>): SignalsSettings['save'] {
  return async (signals) => {
    await postJson<SettingsResult>('/settings', { prefix, signals });
    await reload();
  };
}

/** One row's edit: the table patched with the stricter rows clamped (the order parseConfig demands), then saved. A failure is a toast in
 * the user's language; the raw error goes to the console, never to the toast (m-11). */
export function useSignalEdit(): (signals: SignalSettings, signal: Signal, patch: Partial<SignalBehaviour>) => void {
  const { save } = useContext(SignalsContext);
  return (signals, signal, patch) => {
    save(patchedSignals(signals, signal, patch)).catch((err: unknown) => {
      console.error('signals: the signal settings were not saved', err);
      toast.error(t('tasks.automation.notSaved'));
    });
  };
}
