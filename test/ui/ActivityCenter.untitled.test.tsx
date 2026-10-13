import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as models from '@/lib/editor-models';
import { jsonResponse } from '../fakes';
import { Center, resetCenterTest, saved, STAGE, strips } from './center-harness';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The +'s untitled file (#818): a buffer with no file, saved through the OS's dialog; the page's count names it, so a test matches any n
const UNTITLED = /^Sem título-\d+$/;
let fileAnswer = (): Response => jsonResponse({ path: 'notes.md', version: 'v1' });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url.endsWith('/tree')) return jsonResponse({ root: '/wt', files: [], marks: {}, folders: [], ignored: { files: [], folders: [] } });
  if (url.endsWith('/tree/file')) return fileAnswer();
  return jsonResponse({ ok: true });
});
const saveDialog = vi.fn(async (_start?: string): Promise<string | undefined> => '/wt/notes.md');

beforeEach(() => {
  resetCenterTest();
  fileAnswer = () => jsonResponse({ path: 'notes.md', version: 'v1' });
  fetchMock.mockClear();
  saveDialog.mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('hive', { saveDialog, onCloseKey: () => () => undefined });
});
afterEach(() => {
  models.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
});

async function newFile(user: ReturnType<typeof userEvent.setup>): Promise<FakeEditor> {
  screen.getByRole('button', { name: 'Novo terminal ou sessão' }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: /^arquivo/ }));
  await waitFor(() => expect(FakeEditor.all).toHaveLength(1));
  return FakeEditor.all[0];
}

test('the +\'s arquivo opens an untitled tab, never stored; ⌘S asks the OS where from the tree\'s root, and the saved tab becomes the file\'s, its buffer clean (#818)', async () => {
  const user = userEvent.setup();
  render(<Center runs={[STAGE]} />);
  const editor = await newFile(user);
  expect(strips()[0][1]).toMatch(UNTITLED);
  expect(JSON.stringify(saved())).not.toContain('untitled');
  act(() => editor.model.type('hello'));
  await act(async () => { editor.onSave(); });
  await waitFor(() => expect(strips()).toEqual([['Claude', 'notes.md']]));
  expect(saveDialog).toHaveBeenCalledWith(expect.stringMatching(/^\/wt\/Sem título-\d+$/));
  const [, init] = fetchMock.mock.calls.find(([url]) => url.endsWith('/tree/file')) ?? [];
  expect(JSON.parse(String(init?.body))).toEqual({ path: '/wt/notes.md', text: 'hello', replace: true });
  expect([models.isDirty('a-I1', 'notes.md'), models.textOf('a-I1', 'notes.md')]).toEqual([false, 'hello']);
});

test('a path outside the tree is refused with a toast: the tab stays untitled and dirty (#818)', async () => {
  fileAnswer = () => jsonResponse({ error: "path outside the task's folder" }, 400);
  saveDialog.mockResolvedValueOnce('/elsewhere/notes.md');
  const user = userEvent.setup();
  render(<Center runs={[STAGE]} />);
  const editor = await newFile(user);
  act(() => editor.model.type('hello'));
  await act(async () => { editor.onSave(); });
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("path outside the task's folder"));
  expect(strips()[0][1]).toMatch(UNTITLED);
  expect(models.anyDirty()).toBe(true);
});

test('closing a dirty untitled tab asks first, as a dirty file\'s does (#818)', async () => {
  const user = userEvent.setup();
  render(<Center runs={[STAGE]} />);
  const editor = await newFile(user);
  act(() => editor.model.type('hello'));
  await user.click(screen.getByRole('button', { name: /^Fechar Sem título-\d+$/ }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('descartar alterações não salvas?');
});
