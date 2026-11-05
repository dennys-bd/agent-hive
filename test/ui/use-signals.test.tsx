import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SignalsContext, signalsSaver, useSignalEdit } from '@/hooks/use-signals';
import { setLanguage, t } from '@/i18n';
import type { SignalSettings } from '../../src/types';
import { SIGNALS_DEFAULTS } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true }));
const CLAMPED = { ...SIGNALS_DEFAULTS, yellow: { ...SIGNALS_DEFAULTS.yellow, workerless: false }, red: { ...SIGNALS_DEFAULTS.red, workerless: false } };

beforeEach(() => { setLanguage('en'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); vi.mocked(toast.error).mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('signalsSaver posts the prefix and the table to /settings, then reloads the settings info (#573)', async () => {
  const reload = vi.fn(async () => undefined);
  await signalsSaver('HIVE', reload)(SIGNALS_DEFAULTS);
  expect(fetchMock).toHaveBeenCalledWith('/settings', expect.objectContaining({ method: 'POST', body: JSON.stringify({ prefix: 'HIVE', signals: SIGNALS_DEFAULTS }) }));
  expect(reload).toHaveBeenCalledOnce();
});

test('a refused save rejects and reloads nothing (#573)', async () => {
  fetchMock.mockResolvedValueOnce(json({ error: 'hive.config.json: "signals" must keep green ≥ yellow ≥ red' }, 400));
  const reload = vi.fn(async () => undefined);
  await expect(signalsSaver('HIVE', reload)(SIGNALS_DEFAULTS)).rejects.toThrow(/signals/);
  expect(reload).not.toHaveBeenCalled();
});

test('useSignalEdit saves the patched table with the rows below clamped; a failure is the i18n toast, the raw error goes to console.error (#573)', async () => {
  const save = vi.fn(async (_signals: SignalSettings) => {});
  const wrapper = ({ children }: { children: ReactNode }) => <SignalsContext.Provider value={{ save }}>{children}</SignalsContext.Provider>;
  const { result } = renderHook(() => useSignalEdit(), { wrapper });
  result.current(SIGNALS_DEFAULTS, 'yellow', { workerless: false });
  expect(save).toHaveBeenCalledWith(CLAMPED);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failure = new Error('raw server text');
  save.mockRejectedValueOnce(failure);
  result.current(SIGNALS_DEFAULTS, 'red', { started: 'continueOnly' });
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('tasks.automation.notSaved')));
  expect(errorSpy).toHaveBeenCalledWith(expect.any(String), failure);
  expect(toast.error).not.toHaveBeenCalledWith('raw server text');
  errorSpy.mockRestore();
});

test('outside App the save rejects: an edit is the toast, never a write (#573)', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() => useSignalEdit());
  result.current(SIGNALS_DEFAULTS, 'yellow', { workerless: false });
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('tasks.automation.notSaved')));
  expect(fetchMock).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});
