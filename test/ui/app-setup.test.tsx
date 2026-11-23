import { renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, expect, test, vi } from 'vitest';
import { closeTabSettings, editorLanguagesOf, useAppSetup } from '@/app-setup';
import { initialState } from '../../src/orchestrator';
import type { SettingsInfo } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// What App and a detached window share (#553): the window opens no Settings, so its notices and its editor have no link there
const INFO: SettingsInfo = { configured: true, home: '/home', language: 'pt', agents: [] };

afterEach(() => vi.unstubAllGlobals());

test('closeTabSettings with no opener has no openSettings, so the notices show no Settings link; with one it opens Settings on execution (#553, #614)', () => {
  expect(closeTabSettings(INFO, vi.fn()).openSettings).toBeUndefined();
  const open = vi.fn();
  closeTabSettings(INFO, vi.fn(), open).openSettings?.();
  expect(open).toHaveBeenCalledWith({ section: 'execution' });
});

test('editorLanguagesOf with no opener leaves openLanguage out, so instalar {server} is hidden (#553, #780)', () => {
  expect(editorLanguagesOf(INFO)).not.toHaveProperty('openLanguage');
  const open = vi.fn();
  editorLanguagesOf(INFO, open).openLanguage?.('typescript');
  expect(open).toHaveBeenCalledWith('typescript');
});

test('useAppSetup hands every theme applyTheme resolves to the bridge, so Windows\' caption buttons follow it; with no bridge (a plain browser) nothing breaks (#648)', () => {
  const themeResolved = vi.fn();
  vi.stubGlobal('hive', { themeResolved });
  // nothing saved: system, which test/ui/setup.ts's matchMedia answers as light
  const { result } = renderHook(() => useAppSetup({ reload: async () => INFO, connected: true }));
  expect(themeResolved).toHaveBeenCalledWith('light');
  expect(result.current.resolvedTheme).toBe('light');
  vi.stubGlobal('hive', undefined);
  expect(() => renderHook(() => useAppSetup({ reload: async () => INFO, connected: true }))).not.toThrow();
});

test('the bar\'s toast shows an account refusal\'s copy and any other error as the state holds it (#953)', () => {
  const info = { ...INFO, language: 'en' as const }; // applied before the toast's effect runs
  renderHook(() => useAppSetup({ info, reload: async () => info, connected: true, state: { ...initialState(0), error: 'account github unreachable' } }));
  expect(toast.error).toHaveBeenCalledWith('could not reach GitHub to check the login chosen in Settings: try again');
  renderHook(() => useAppSetup({ info, reload: async () => info, connected: true, state: { ...initialState(0), error: 'workspace "api" não existe mais' } }));
  expect(toast.error).toHaveBeenCalledWith('workspace "api" não existe mais');
});
