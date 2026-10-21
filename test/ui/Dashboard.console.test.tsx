import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import { readView, resetViewState, writeView } from '@/lib/view-state';
import type { ChannelEntry, ChannelView } from '../../src/console';
import type { State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeTerminal, FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork, withTasks } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

// A task with a worktree whose workspace runs `test` (#300); nothing live on it
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt' };
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [{ id: 's1', status: 'empty' }], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }],
  tasks: [taskA], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: { hive: ['test'] }, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});
const CHANNEL: ChannelEntry = { id: 'command:hive:test', kind: 'command', label: 'hive · test', status: 'done' };
const SETUP: ChannelEntry = { id: 'setup', kind: 'setup', label: 'Setup worktree', status: 'running' }; // every worktree setup's channel (#351)
const SETUP_RUN = 'setup:A'; // task A's run in it
const H1 = '── #1 · 14:03:07 ──\r\n';
const H2 = '── #1 · 14:05:00 ──\r\n';
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// What the daemon holds: the channels GET /console lists and the one channel's view
let channels: ChannelEntry[] = [];
let view: ChannelView = { history: `${H1}ok\r\n`, live: [], status: 'done' };
let setupView: ChannelView = { history: '', live: [], status: 'done' };
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url === '/console') return reply(channels);
  if (url === `/console/${encodeURIComponent(CHANNEL.id)}`) return reply(view);
  if (url === `/console/${encodeURIComponent(SETUP.id)}`) return reply(setupView);
  if (url === '/activities/a-A/run') { // the run starts: the channel now has it live
    view = { history: `${H1}ok\r\n`, live: [{ ptyId: 'W9', header: H2 }], status: 'running' };
    channels = [{ ...CHANNEL, status: 'running' }, SETUP];
    return reply({ ok: true, ptyId: 'W9' });
  }
  if (url === `/console/${encodeURIComponent(CHANNEL.id)}/clear`) {
    view = { history: '', live: view.live, status: 'done' };
    return reply({ ok: true });
  }
  return reply({ ok: true });
});
const dashboard = (selected?: Selection) => <Dashboard state={state} locale="pt-BR" tick={0} selected={selected} onSelect={() => {}} />;

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  channels = [];
  view = { history: `${H1}ok\r\n`, live: [], status: 'done' };
  setupView = { history: '', live: [], status: 'done' };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => { vi.unstubAllGlobals(); store.resetDiagnostics(); });

const footer = (): HTMLElement => screen.getByRole('contentinfo', { hidden: true }); // hidden: a Radix menu closing hides the page a tick longer
const chip = (): HTMLElement => within(footer()).getByRole('button', { name: /^console/, hidden: true });
const drawer = (): HTMLElement | null => screen.queryByRole('region', { name: 'console' });

// Radix's ContextMenu opens once per file under jsdom (#377): this is the only test here that right-clicks a task, kept first.
const showFlow = (): void => { fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); }; // the window opens on Atividades (#746)

test('a command run from executar › switches the footer\'s chip to it, running, and leaves the drawer closed until the chip is clicked (redesign 05)', async () => {
  const user = userEvent.setup();
  channels = [SETUP];
  render(dashboard());
  showFlow();
  await waitFor(() => expect(chip()).toHaveTextContent('console · Setup worktree'));
  // the board task: with its worktree it is an activity too, so the sidebar lists the same title (redesign 03)
  fireEvent.contextMenu(screen.getAllByText('#1 Task A').map((el) => el.closest('li')).find(Boolean)!);
  await user.click(await screen.findByRole('menuitem', { name: 'executar' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'test' }));
  await waitFor(() => expect(chip()).toHaveTextContent('console · test'));
  expect(chip().querySelector('span')).toHaveClass('bg-working');
  expect(drawer()).toBeNull();
  await user.click(chip());
  expect(within(drawer()!).getByRole('status')).toHaveTextContent('executando');
  await waitFor(() => expect(FakeWebSocket.all.map((s) => s.path)).toEqual(['/ptys/W9/pty']));
});

test('the chip reads console with no channel yet, else the newest command with its status dot; a click opens the drawer over the board, read-only, and Escape, esc or the chip close it (redesign 05)', async () => {
  const user = userEvent.setup();
  const empty = render(dashboard());
  expect(chip()).toHaveTextContent(/^console$/);
  await user.click(chip());
  expect(within(drawer()!).getByText('Nenhum comando executado ainda.')).toBeInTheDocument();
  empty.unmount();
  channels = [{ ...CHANNEL, status: 'failed' }, SETUP];
  render(dashboard());
  showFlow();
  await waitFor(() => expect(chip()).toHaveTextContent('console · test'));
  expect(chip().querySelector('span')).toHaveClass('bg-destructive');
  expect(chip()).toHaveAttribute('aria-expanded', 'false');
  await user.click(chip());
  expect(screen.getByRole('main').parentElement!.parentElement).toContainElement(drawer()); // over the center column, the board under fluxo
  expect(within(drawer()!).getByRole('status')).toHaveTextContent('falhou');
  expect(within(drawer()!).getByRole('combobox', { name: 'canal' })).toHaveTextContent('hive · test');
  expect(within(drawer()!).getByRole('button', { name: 'abrir como aba' })).toBeDisabled(); // no activity's grid to land in
  await waitFor(() => expect(FakeTerminal.all.at(-1)?.written).toEqual([`${H1}ok\r\n`]));
  expect(FakeTerminal.all.at(-1)?.options.disableStdin).toBe(true);
  await user.keyboard('{Escape}');
  expect(drawer()).toBeNull();
  await user.click(chip());
  await user.click(within(drawer()!).getByRole('button', { name: 'fechar o console' }));
  expect(drawer()).toBeNull();
  await user.click(chip());
  await user.click(chip());
  expect(drawer()).toBeNull();
});

test('limpar posts the channel\'s clear and reads it again, now without its finished runs (redesign 05)', async () => {
  const user = userEvent.setup();
  channels = [CHANNEL];
  render(dashboard());
  await user.click(await within(footer()).findByRole('button', { name: 'console · test' }));
  await waitFor(() => expect(FakeTerminal.all.at(-1)?.written).toEqual([`${H1}ok\r\n`]));
  await user.click(within(drawer()!).getByRole('button', { name: 'limpar' }));
  expect(fetchMock).toHaveBeenCalledWith(`/console/${encodeURIComponent(CHANNEL.id)}/clear`, expect.objectContaining({ method: 'POST' }));
  await waitFor(() => expect(FakeTerminal.all.at(-1)?.written).toEqual([]));
});

test('a task running its worktree setup shows iniciando with no ver log icon on its card (#290)', () => {
  channels = [CHANNEL, SETUP];
  const setting: State = withTasks(state, [{ ...taskA, setup: { consoleId: SETUP_RUN, rows: [] } }]);
  render(<Dashboard state={setting} locale="pt-BR" tick={0} onSelect={() => {}} />);
  showFlow();
  expect(screen.getByText('iniciando')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'ver log' })).not.toBeInTheDocument();
});

test('under atividades with an activity picked, abrir como aba moves the console into a tab of its grid and closes the drawer (redesign 05)', async () => {
  const user = userEvent.setup();
  channels = [CHANNEL];
  const running: State = withTasks({ ...state, workers: [{ id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1', startedAt: '2026-09-27T10:00:00.000Z' }] }, [{ ...taskA, workerId: 's1' }]); // #629: the run is the activity's
  render(<Dashboard state={running} locale="pt-BR" tick={0} onSelect={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'atividades' })); // the rail's view (#220)
  await user.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByText('#1 Task A'));
  await user.click(await within(footer()).findByRole('button', { name: 'console · test' }));
  await user.click(within(drawer()!).getByRole('button', { name: 'abrir como aba' }));
  expect(drawer()).toBeNull();
  const tab = within(screen.getByRole('tablist', { name: 'abas' })).getByRole('tab', { name: 'console' });
  expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(readView('centerLayouts')).toMatchObject({ A: { root: { tabs: expect.arrayContaining([{ kind: 'console', channel: CHANNEL.id }]) } } }); // #755: the drawer's channel
  const section = screen.getByRole('tablist', { name: 'abas' }).closest('section')!;
  expect(within(section).getByRole('combobox', { name: 'canal' })).toHaveTextContent('hive · test');
  expect(section.querySelector('[data-pane-header]')).toBeNull(); // the console's own line is its only header (#755)
});

test('Cmd+J opens and closes the drawer; its top handle resizes it between 120px and 70% of the center, a double click puts back 260px, and the height is kept in the view state (redesign 05, #484)', async () => {
  const user = userEvent.setup();
  channels = [CHANNEL];
  const { unmount } = render(dashboard());
  showFlow();
  fireEvent.keyDown(document.body, { key: 'J', ctrlKey: true, shiftKey: true });
  expect(drawer()).toHaveStyle({ height: '260px' });
  const center = screen.getByRole('main').parentElement!.parentElement!;
  vi.spyOn(center, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600)); // 70%: 420px
  const handle = within(drawer()!).getByRole('separator', { name: 'redimensionar o console' });
  handle.focus();
  await user.keyboard('{ArrowUp}');
  expect(drawer()).toHaveStyle({ height: '276px' });
  for (let i = 0; i < 20; i += 1) await user.keyboard('{ArrowUp}');
  expect(drawer()).toHaveStyle({ height: '420px' });
  for (let i = 0; i < 40; i += 1) await user.keyboard('{ArrowDown}');
  expect(drawer()).toHaveStyle({ height: '120px' });
  expect(readView('consoleHeight')).toBe(120);
  fireEvent.doubleClick(handle);
  expect(drawer()).toHaveStyle({ height: '260px' });
  fireEvent.keyDown(document.body, { key: 'J', ctrlKey: true, shiftKey: true });
  expect(drawer()).toBeNull();
  writeView('consoleHeight', 300); // what another session of this window left
  unmount();
  render(dashboard());
  fireEvent.keyDown(document.body, { key: 'J', ctrlKey: true, shiftKey: true });
  expect(drawer()).toHaveStyle({ height: '300px' });
});

test('a stored console height that is no number, or one under 120, reads as the default 260 (#484)', () => {
  channels = [CHANNEL];
  for (const stored of ['300', 50, null]) {
    resetViewState({ consoleHeight: stored });
    const { unmount } = render(dashboard());
    fireEvent.keyDown(document.body, { key: 'J', ctrlKey: true, shiftKey: true });
    expect(drawer()).toHaveStyle({ height: '260px' });
    unmount();
  }
});

test('a console tab keeps its own channel: a pick in the drawer leaves it, and its own pick leaves the drawer and is saved with the layout (#755)', async () => {
  const user = userEvent.setup();
  const LINT: ChannelEntry = { id: 'command:hive:lint', kind: 'command', label: 'hive · lint', status: 'done' };
  channels = [CHANNEL, LINT, SETUP];
  const running: State = withTasks({ ...state, workers: [{ id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1', startedAt: '2026-09-27T10:00:00.000Z' }] }, [{ ...taskA, workerId: 's1' }]);
  render(<Dashboard state={running} locale="pt-BR" tick={0} onSelect={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'atividades' }));
  await user.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByText('#1 Task A'));
  await user.click(await within(footer()).findByRole('button', { name: 'console · test' }));
  await user.click(within(drawer()!).getByRole('button', { name: 'abrir como aba' }));
  const tabChannel = (): HTMLElement => within(screen.getByRole('tablist', { name: 'abas' }).closest('section')!).getByRole('combobox', { name: 'canal' });
  expect(tabChannel()).toHaveTextContent('hive · test');
  await user.click(chip());
  fireEvent.click(within(drawer()!).getByRole('combobox', { name: 'canal' }));
  fireEvent.click(await screen.findByRole('option', { name: 'hive · lint' }));
  await waitFor(() => expect(chip()).toHaveTextContent('console · lint'));
  expect(tabChannel()).toHaveTextContent('hive · test');
  await user.keyboard('{Escape}');
  fireEvent.click(tabChannel());
  fireEvent.click(await screen.findByRole('option', { name: 'Setup worktree' }));
  await waitFor(() => expect(tabChannel()).toHaveTextContent('Setup worktree'));
  expect(chip()).toHaveTextContent('console · lint');
  expect(readView('centerLayouts')).toMatchObject({ A: { root: { tabs: expect.arrayContaining([{ kind: 'console', channel: SETUP.id }]) } } });
});

test('the footer\'s checkers follow the focused file tab of the activity the center shows, its problems button counts every activity without one, and ⌘⇧M opens the drawer on problemas (#225, #295)', async () => {
  const user = userEvent.setup();
  writeView('centerLayouts', { A: { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'console' }, { kind: 'file', path: 'a.py' }], active: 1 }, focused: 'g1' } });
  render(dashboard());
  act(() => {
    store.setCheck(activityIdOf('A'), 'tsc', { state: 'failed', reason: 'exit code 2' }, '');
    store.bindChecks(activityIdOf('A'), 'a.py', ['tsc']);
    store.setCheck(activityIdOf('A'), 'mypy', { state: 'done', scope: 'file', diagnostics: [{ path: 'a.py', line: 1, column: 1, severity: 'error', message: 'bad' }] }, 'a.py');
  });
  showFlow();
  expect(within(footer()).queryByText('tsc falhou')).not.toBeInTheDocument();
  expect(within(footer()).getByRole('button', { name: 'problemas', hidden: true })).toHaveTextContent(/^1$/);
  await user.click(screen.getByRole('button', { name: 'atividades' }));
  await user.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByText('#1 Task A'));
  expect(within(footer()).getByText('tsc falhou')).toHaveAttribute('title', 'exit code 2');
  await user.click(within(screen.getByRole('tablist', { name: 'abas' })).getAllByRole('tab')[0]); // back on a console tab: no checkers
  expect(within(footer()).queryByText('tsc falhou')).not.toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: 'M', ctrlKey: true, shiftKey: true });
  expect(within(drawer()!).getByRole('radio', { name: 'problemas' })).toHaveAttribute('aria-checked', 'true');
  expect(within(drawer()!).getByText('bad')).toBeInTheDocument();
});
