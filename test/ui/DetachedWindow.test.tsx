vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);
vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/use-hive-state', async () => ({ useHiveState: (await import('./detached-state')).hiveState }));
vi.mock('@/hooks/use-settings-info', async () => ({ useSettingsInfo: (await import('./detached-state')).settingsInfo }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { t } from '@/i18n';
import * as models from '@/lib/editor-models';
import { VIEW_WRITE_DELAY_MS } from '@/lib/view-state';
import type { CenterTabRef } from '../../src/tab-carry';
import { strips } from './center-harness';
import { arrive, type Bridge, fetchMock, ID, mount, resetDetachedTest, setUpDetachedTest } from './detached-harness';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { FakeTerminal } from './xterm-fakes';

const FILE: CenterTabRef = { kind: 'file', path: 'src/a.ts' };
const DIFF: CenterTabRef = { kind: 'diff', scope: 'worktree' };
const CARRY = { text: 'mine\n', base: 'v1' };
let bridge: Bridge;

beforeEach(() => { bridge = setUpDetachedTest(); vi.mocked(toast.error).mockClear(); });
afterEach(() => { models.closeExcept(new Set()); resetMonacoFakes(); resetDetachedTest(); });

test('the window shows the activity\'s strip, takes its title, and has no side panel, rail, drawer or footer; a layout change posts no view state (#553)', async () => {
  mount();
  expect(await screen.findByRole('banner')).toHaveTextContent('#1 Task 1');
  expect(document.title).toBe('#1 Task 1');
  for (const gone of [screen.queryByRole('complementary'), screen.queryByRole('contentinfo'), screen.queryByRole('button', { name: 'tarefas' }), screen.queryByRole('region', { name: 'Atividades' }), screen.queryByLabelText(t('console.close'))]) {
    expect(gone).toBeNull();
  }
  await arrive(bridge, { activity: 'I1', ref: DIFF });
  await new Promise((resolve) => setTimeout(resolve, VIEW_WRITE_DELAY_MS + 50));
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/view-state/') && init?.method === 'POST')).toEqual([]);
});

test('a file tab arriving with a dirty carry opens its editor on the carried text, its tab dirty (#553, #551)', async () => {
  mount();
  await arrive(bridge, { activity: 'I1', ref: FILE, carry: CARRY });
  await waitFor(() => expect(FakeEditor.all).toHaveLength(1));
  expect(models.textOf(ID, 'src/a.ts')).toBe('mine\n');
  expect(screen.getByRole('tab', { name: 'a.ts' }).closest('[data-tab-key]')?.querySelector('[data-dirty]')).not.toBeNull();
});

test('a run tab arriving attaches its terminal under the run\'s pane header; a diff tab shows the diff pane (#553, #536)', async () => {
  mount();
  await arrive(bridge, { activity: 'I1', ref: { kind: 'run', ptyId: 'W1' } });
  await waitFor(() => expect(FakeTerminal.all).toHaveLength(1));
  expect(document.querySelector('[data-pane-header]')).toHaveTextContent(/claude/i);
  await arrive(bridge, { activity: 'I1', ref: DIFF });
  expect(await screen.findByRole('region', { name: '#1 Task 1 · diff da worktree' })).toBeInTheDocument();
});

test('a console tab arriving shows its channel through the window\'s console channels; a design tab lays its pane in the design layer over its slot (#553, #755, #533)', async () => {
  mount();
  await arrive(bridge, { activity: 'I1', ref: { kind: 'console', channel: 'command:hive:test' } });
  expect(await screen.findByRole('combobox', { name: t('console.channel') })).toHaveTextContent('hive · test');
  await arrive(bridge, { activity: 'I1', ref: { kind: 'design', path: 'design/Landing.hv.html' } });
  const frame = await screen.findByTitle('Landing.hv.html');
  expect(frame.closest('[data-design-layer]')).not.toBeNull();
});

test('tabsChanged gets the open refs after each open and each close (#553, #552)', async () => {
  const user = userEvent.setup();
  mount();
  await arrive(bridge, { activity: 'I1', ref: DIFF });
  await waitFor(() => expect(bridge.tabsChanged).toHaveBeenLastCalledWith([DIFF]));
  await arrive(bridge, { activity: 'I1', ref: FILE });
  await waitFor(() => expect(bridge.tabsChanged).toHaveBeenLastCalledWith([DIFF, FILE]));
  await user.click(screen.getByRole('button', { name: 'Fechar diff da worktree' }));
  await waitFor(() => expect(bridge.tabsChanged).toHaveBeenLastCalledWith([FILE]));
});

test('the strip\'s back button on a dirty file whose dock is refused keeps the tab dirty and shows the toast (#553)', async () => {
  const user = userEvent.setup();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  bridge.dock.mockRejectedValueOnce(new Error('aba inválida'));
  mount();
  await arrive(bridge, { activity: 'I1', ref: FILE, carry: CARRY });
  await user.click(await screen.findByRole('button', { name: 'Voltar para a janela principal' }));
  expect(bridge.dock).toHaveBeenCalledWith({ activity: 'I1', ref: FILE, carry: expect.objectContaining(CARRY) });
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível voltar a aba para a janela principal'));
  expect([strips(), models.isDirty(ID, 'src/a.ts')]).toEqual([[['a.ts']], true]);
});

test('a task reference in a run\'s terminal asks the main window to open the task (#553, #588)', async () => {
  mount();
  await arrive(bridge, { activity: 'I1', ref: { kind: 'run', ptyId: 'W1' } });
  await waitFor(() => expect(FakeTerminal.all).toHaveLength(1));
  const [term] = FakeTerminal.all;
  term.lines = ['see #7'];
  for (const provider of term.providers) provider.provideLinks(1, (links) => { for (const link of links ?? []) link.activate(); });
  await waitFor(() => expect(bridge.openTask).toHaveBeenCalledWith('board:I7'));
});

test('the +\'s new file opens an untitled tab in the window (#553, #818)', async () => {
  const user = userEvent.setup();
  mount();
  await arrive(bridge, { activity: 'I1', ref: DIFF });
  screen.getByRole('button', { name: 'Novo terminal ou sessão' }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: /^arquivo/ }));
  await waitFor(() => expect(strips()[0]).toEqual(['diff da worktree', expect.stringMatching(/^Sem título-\d+$/)]));
});

test('the strip\'s back button on a dirty file docks it with its carry, and once main took it the tab and its buffer are gone (#553)', async () => {
  const user = userEvent.setup();
  mount();
  await arrive(bridge, { activity: 'I1', ref: FILE, carry: CARRY });
  await user.click(await screen.findByRole('button', { name: 'Voltar para a janela principal' }));
  await waitFor(() => expect(strips()).toEqual([]));
  expect(bridge.dock).toHaveBeenCalledWith({ activity: 'I1', ref: FILE, carry: expect.objectContaining(CARRY) });
  expect(models.baseOf(ID, 'src/a.ts')).toBeUndefined();
});
