import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { Editable } from '@/components/Editable';
import { IssueCommentBox } from '@/components/IssueCommentBox';
import { type MessageKey, PLATFORM_KEYS, setLanguage, t, tIn } from '@/i18n';

const act = vi.hoisted(() => vi.fn());
vi.mock('@/components/actions', () => ({ act }));

const MAC = 'MacIntel';
const OFF_MAC = ['Win32', 'Linux x86_64'];
const META_ENTER = '{Meta>}{Enter}{/Meta}';
const CTRL_ENTER = '{Control>}{Enter}{/Control}';

const onPlatform = (platform: string): void => { vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform); };

afterEach(() => {
  vi.restoreAllMocks();
  act.mockReset();
  setLanguage('pt');
});

async function commentWith(keys: string): Promise<number> {
  cleanup();
  act.mockReset();
  act.mockResolvedValue({});
  const user = userEvent.setup();
  render(<IssueCommentBox path="/x/comments" repository="acme/site" onPosted={async () => {}} />);
  await user.type(screen.getByRole('textbox'), 'hi');
  await user.keyboard(keys);
  return act.mock.calls.length;
}

async function saveWith(keys: string): Promise<number> {
  cleanup();
  const onSave = vi.fn().mockResolvedValue('saved');
  const user = userEvent.setup();
  render(<Editable label="body" value="a" updatedAt="u" isMultiline changed="c" onSave={onSave}><p>a</p></Editable>);
  await user.click(screen.getByRole('button'));
  await user.keyboard(keys);
  return onSave.mock.calls.length;
}

test.each(OFF_MAC)('off macOS (%s) Ctrl+Enter posts a comment and Meta+Enter does not', async (platform) => {
  onPlatform(platform);
  expect(await commentWith(META_ENTER)).toBe(0);
  expect(await commentWith(CTRL_ENTER)).toBe(1);
});

test('on macOS Meta+Enter posts a comment and Ctrl+Enter does not', async () => {
  onPlatform(MAC);
  expect(await commentWith(CTRL_ENTER)).toBe(0);
  expect(await commentWith(META_ENTER)).toBe(1);
});

test.each(OFF_MAC)('off macOS (%s) Ctrl+Enter saves an edit and Meta+Enter does not', async (platform) => {
  onPlatform(platform);
  expect(await saveWith(META_ENTER)).toBe(0);
  expect(await saveWith(CTRL_ENTER)).toBe(1);
});

test('on macOS Meta+Enter saves an edit and Ctrl+Enter does not', async () => {
  onPlatform(MAC);
  expect(await saveWith(CTRL_ENTER)).toBe(0);
  expect(await saveWith(META_ENTER)).toBe(1);
});

test('the comment button shows the platform modifier', () => {
  onPlatform('Win32');
  render(<IssueCommentBox path="/x/comments" repository="acme/site" onPosted={async () => {}} />);
  expect(screen.getByRole('button').textContent).toContain('Ctrl+↵');
});

const MAC_WORDS = /Finder|⌘|menu bar|barra de menu/;

test.each(OFF_MAC)('off macOS (%s) no platform key shows Finder, ⌘ or menu bar, in either language', (platform) => {
  onPlatform(platform);
  for (const key of Object.keys(PLATFORM_KEYS) as MessageKey[]) {
    expect(tIn('en', key)).not.toMatch(MAC_WORDS);
    expect(tIn('pt', key)).not.toMatch(MAC_WORDS);
  }
});

test('on macOS the platform keys keep their macOS text', () => {
  onPlatform(MAC);
  setLanguage('en');
  expect(t('files.reveal')).toBe('reveal in Finder');
  expect(t('settings.group.window')).toBe('window and menu bar');
});

test('Windows and Linux each read their own wording', () => {
  setLanguage('en');
  onPlatform('Win32');
  expect(t('files.reveal')).toBe('reveal in File Explorer');
  expect(t('settings.group.window')).toBe('window and notification area');
  vi.restoreAllMocks();
  onPlatform('Linux x86_64');
  expect(t('files.reveal')).toBe('reveal in file manager');
  expect(t('settings.group.window')).toBe('window and system tray');
});
