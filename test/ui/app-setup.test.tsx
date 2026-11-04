import { expect, test, vi } from 'vitest';
import { closeTabSettings, editorLanguagesOf } from '@/app-setup';
import type { SettingsInfo } from '../../src/types';

// What App and a detached window share (#553): the window opens no Settings, so its notices and its editor have no link there
const INFO: SettingsInfo = { configured: true, home: '/home', language: 'pt', agents: [] };

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
