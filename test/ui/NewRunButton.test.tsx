import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NewRunButton, newRunEntries, openNew, useNewRunKeys } from '@/components/NewRunButton';
import { DiffOpenerContext, PrOpenerContext, RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { ActivityRecord } from '../../src/types';
import { bareTask, liveOf, localPairOf, taskPairOf, type WithWork } from '../fixtures/work';

const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt/hive-1-task-1', ...extra,
});
const answer = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async () => answer({ ok: true }));
const openRun = vi.fn();
// #629: the view model carries the task's live activity, a run target always has one
const liveIn = (c: WithWork) => taskPairOf(c.item.itemId, liveOf(c)).activity;
const wrapped = (c: WithWork, records?: ActivityRecord[]) => <RunOpenerContext.Provider value={openRun}><NewRunButton activity={{ kind: 'task', task: bareTask(c), activity: liveIn(c), ...(records ? { records } : {}) }} /></RunOpenerContext.Provider>;
const plus = (): HTMLElement => screen.getByRole('button', { name: 'Novo terminal ou sessão' });

// Radix's DropdownMenu opens from the keyboard under jsdom, as the terminal panel's + test does (#292)
async function pick(user: ReturnType<typeof userEvent.setup>, item: string): Promise<void> {
  plus().focus();
  await user.keyboard('{Enter}');
  const names = (await screen.findAllByRole('menuitem')).map((i) => i.textContent?.replace(/(Ctrl\+|Shift\+|Alt\+|⌘|⇧|⌥)+[A-Z]$/, ''));
  expect(names).toEqual(['terminal', 'claude', 'diff', 'mostrar PR', 'arquivo']);
  await user.click(screen.getByRole('menuitem', { name: new RegExp(`^${item}`) }));
}

beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => answer({ ok: true }));
  openRun.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('the + is disabled while the task sets up, is being cleaned or is gone from the board, and enabled on a blocked task (#491)', () => {
  const { rerender } = render(wrapped(task({ setup: { consoleId: 'C1' } })));
  expect(plus()).toBeDisabled();
  const refused: Partial<WithWork>[] = [{ deleting: true }, { missing: true }];
  for (const extra of refused) {
    rerender(wrapped(task(extra)));
    expect(plus()).toBeDisabled();
  }
  rerender(wrapped(task({ item: { ...task().item, blockedBy: ['9'] } })));
  expect(plus()).toBeEnabled();
});

test('Terminal posts a terminal to the task\'s /open at once, and the run it answered reaches the run opener as the task\'s terminal (#491)', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(answer({ ok: true, ptyId: 'W9' }));
  render(wrapped(task()));
  await pick(user, 'terminal');
  expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'terminal' }) }));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'W9', kind: 'terminal', task: 'I1', title: '#1 Task 1' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('Claude posts a new claude session to the task\'s /open, with no resume, and the run it answered reaches the run opener as a session (#491)', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(answer({ ok: true, ptyId: 'W8' }));
  render(wrapped(task()));
  await pick(user, 'claude');
  expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'claude' }) }));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'W8', kind: 'session', task: 'I1', title: '#1 Task 1' }));
});

test('an answer with no ptyId (a spawn failure) opens nothing (#491)', async () => {
  const user = userEvent.setup();
  render(wrapped(task()));
  await pick(user, 'claude');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 0)); // past the answer's then
  expect(openRun).not.toHaveBeenCalled();
});

test('the + opens a 220px menu titled nova sessão em #1: terminal, each agent, a separator, then arquivo, disabled with no onNewFile (#536, #818)', async () => {
  const user = userEvent.setup();
  render(wrapped(task()));
  plus().focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menu')).toHaveClass('w-[220px]');
  expect(screen.getByText('nova sessão em #1')).toBeInTheDocument();
  expect(screen.getAllByRole('separator')).toHaveLength(1);
  expect(screen.getByRole('menuitem', { name: 'arquivo' })).toHaveAttribute('data-disabled');
  expect(screen.getByRole('menuitem', { name: /^terminal/ })).not.toHaveAttribute('data-disabled');
});

test('terminal shows the newTerminal key; diff is enabled while the task has a worktree, with or without the stage\'s start (#536, #591)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(wrapped(task({ worktree: undefined })));
  plus().focus();
  await user.keyboard('{Enter}');
  expect((await screen.findByRole('menuitem', { name: /^terminal/ })).textContent).toMatch(/T$/);
  expect(screen.getByRole('menuitem', { name: /^diff/ })).toHaveAttribute('data-disabled');
  unmount();
  render(wrapped(task()));
  plus().focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menuitem', { name: /^diff/ })).not.toHaveAttribute('data-disabled');
});

test('agente abre como shows chat and terminal, locked on terminal (#536)', async () => {
  const user = userEvent.setup();
  render(wrapped(task()));
  plus().focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByText('agente abre como · em breve')).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: 'terminal' })).toBeChecked();
  expect(screen.getByRole('menuitemradio', { name: 'chat' })).toHaveAttribute('data-disabled');
  await user.click(screen.getByRole('menuitemradio', { name: 'chat' }));
  expect(screen.getByRole('menuitemradio', { name: 'terminal' })).toBeChecked();
});

test('openNew hands the answered run\'s worker id to its callback once the run is opened; a spawn failure calls neither (#536)', async () => {
  const onRun = vi.fn();
  fetchMock.mockResolvedValueOnce(answer({ ok: true, ptyId: 'W7' }));
  openNew({ kind: 'task', task: task(), activity: liveIn(task()) }, 'terminal', openRun, onRun);
  await waitFor(() => expect(onRun).toHaveBeenCalledWith('W7'));
  expect(openRun).toHaveBeenCalledWith({ ptyId: 'W7', kind: 'terminal', task: 'I1', title: '#1 Task 1' });
  onRun.mockClear();
  openNew({ kind: 'task', task: task(), activity: liveIn(task()) }, 'claude', openRun, onRun); // the default answer carries no ptyId
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 0)); // past the answer's then
  expect(onRun).not.toHaveBeenCalled();
});

test('claude, the default agent, shows the newSession key and diff the openDiff key (#536)', async () => {
  const user = userEvent.setup();
  render(wrapped(task({ stageStart: { stage: 'dev', commit: 'abc' } })));
  plus().focus();
  await user.keyboard('{Enter}');
  expect((await screen.findByRole('menuitem', { name: /^claude/ })).textContent).toMatch(/N$/);
  expect(screen.getByRole('menuitem', { name: /^diff/ }).textContent).toMatch(/G$/); // Ctrl+Shift+G off macOS (#585)
});

test('with no stage start the + diff and its key open the worktree\'s diff; with no worktree the item is disabled (#591)', async () => {
  const user = userEvent.setup();
  const openDiff = vi.fn();
  const { rerender } = render(<DiffOpenerContext.Provider value={openDiff}>{wrapped(task())}</DiffOpenerContext.Provider>);
  plus().focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: /^diff/ }));
  expect(openDiff).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ itemId: 'I1' }) }), 'worktree');
  rerender(<DiffOpenerContext.Provider value={openDiff}>{wrapped(task({ worktree: undefined }))}</DiffOpenerContext.Provider>);
  plus().focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menuitem', { name: /^diff/ })).toHaveAttribute('data-disabled');
});

test('the openDiff key opens the worktree\'s diff when the stage has no start (#591)', async () => {
  const user = userEvent.setup();
  const openDiff = vi.fn();
  render(<DiffOpenerContext.Provider value={openDiff}><Keys c={task()} /></DiffOpenerContext.Provider>);
  await user.keyboard('{Control>}{Shift>}G{/Shift}{/Control}'); // openDiff off macOS (#585)
  expect(openDiff).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ itemId: 'I1' }) }), 'worktree');
});

function Keys({ c }: { c: WithWork }) {
  useNewRunKeys({ kind: 'task', task: bareTask(c), activity: liveIn(c) });
  return null;
}

test('newSession opens the default agent in the shown activity and openDiff its stage diff; nothing where the item is disabled (#536)', async () => {
  const user = userEvent.setup();
  const openDiff = vi.fn();
  fetchMock.mockResolvedValueOnce(answer({ ok: true, ptyId: 'W5' }));
  const keys = (c: WithWork) => (
    <RunOpenerContext.Provider value={openRun}><DiffOpenerContext.Provider value={openDiff}><Keys c={c} /></DiffOpenerContext.Provider></RunOpenerContext.Provider>
  );
  const { rerender } = render(keys(task({ stageStart: { stage: 'dev', commit: 'abc' } })));
  await user.keyboard('{Control>}{Alt>}{Shift>}N{/Shift}{/Alt}{/Control}'); // newSession off macOS (#585)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ body: JSON.stringify({ kind: 'claude' }) })));
  await user.keyboard('{Control>}{Shift>}G{/Shift}{/Control}'); // openDiff off macOS (#585)
  expect(openDiff).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ itemId: 'I1' }) }), 'stage');
  openDiff.mockClear();
  fetchMock.mockClear();
  rerender(keys(task({ setup: { consoleId: 'C1' }, worktree: undefined })));
  await user.keyboard('{Control>}{Alt>}{Shift>}N{/Shift}{/Alt}{/Control}'); // newSession off macOS (#585)
  await user.keyboard('{Control>}{Shift>}G{/Shift}{/Control}'); // openDiff off macOS (#585)
  expect(fetchMock).not.toHaveBeenCalled();
  expect(openDiff).not.toHaveBeenCalled();
});

test('the + of a local activity is titled with its workspace and offers terminal and each agent, no diff; a pick posts the workspace\'s /open and opens the run there (#590)', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(answer({ ok: true, ptyId: 'L3' }));
  render(<RunOpenerContext.Provider value={openRun}><NewRunButton activity={{ kind: 'local', workspace: 'hive', activity: localPairOf('hive').activity }} /></RunOpenerContext.Provider>);
  expect(plus()).toBeEnabled();
  plus().focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByText('nova sessão em hive')).toBeInTheDocument();
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.replace(/(Ctrl\+|Shift\+|Alt\+|⌘|⇧|⌥)+[A-Z]$/, ''))).toEqual(['terminal', 'claude', 'arquivo']);
  await user.click(screen.getByRole('menuitem', { name: /^claude/ }));
  expect(fetchMock).toHaveBeenCalledWith('/activities/local%3Ahive/sessions', expect.objectContaining({ method: 'POST' }));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'L3', kind: 'session', project: 'hive', title: 'hive' }));
});

test('mostrar PR opens the page of the task\'s next PR, and is disabled while it has none (#592, #758)', async () => {
  const user = userEvent.setup();
  const openPr = vi.fn();
  const prs = [{ url: 'https://github.com/acme/app/pull/7', state: 'merged' as const }, { url: 'https://github.com/acme/app/pull/8', state: 'open' as const }];
  const { rerender } = render(<PrOpenerContext.Provider value={openPr}>{wrapped(task(), [{ id: 'a-I1', taskIds: ['I1'], sessions: [], prs }])}</PrOpenerContext.Provider>);
  plus().focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'mostrar PR' }));
  expect(openPr).toHaveBeenCalledWith(prs[1].url);
  rerender(<PrOpenerContext.Provider value={openPr}>{wrapped(task())}</PrOpenerContext.Provider>);
  plus().focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menuitem', { name: 'mostrar PR' })).toHaveAttribute('data-disabled');
});

test('newRunEntries lists terminal, each agent (the default one with newSession\'s key) and the diff on a task\'s activity only, all disabled where the + is (#759)', () => {
  expect(newRunEntries({ kind: 'task', task: bareTask(task()), activity: liveIn(task()) }, 'claude')).toEqual([
    { kind: 'terminal', label: 'terminal', key: 'newTerminal', disabled: false },
    { kind: 'claude', label: 'claude', key: 'newSession', disabled: false },
    { kind: 'diff', label: 'diff', key: 'openDiff', disabled: false },
  ]);
  const noWorktree = task({ worktree: undefined });
  expect(newRunEntries({ kind: 'task', task: bareTask(noWorktree), activity: liveIn(noWorktree) }, 'claude').map((e) => [e.kind, e.disabled])).toEqual([
    ['terminal', false], ['claude', false], ['diff', true],
  ]);
  expect(newRunEntries({ kind: 'local', workspace: 'hive', activity: localPairOf('hive').activity }, 'claude').map((e) => e.kind)).toEqual(['terminal', 'claude']);
  const settingUp = task({ setup: { consoleId: 'C1' } });
  expect(newRunEntries({ kind: 'task', task: bareTask(settingUp), activity: liveIn(settingUp) }, 'claude').every((e) => e.disabled)).toBe(true);
});

test('the +\'s arquivo is enabled where onNewFile is given, and its pick calls it (#818)', async () => {
  const user = userEvent.setup();
  const onNewFile = vi.fn();
  render(<RunOpenerContext.Provider value={openRun}><NewRunButton activity={{ kind: 'task', task: bareTask(task()), activity: liveIn(task()) }} onNewFile={onNewFile} /></RunOpenerContext.Provider>);
  plus().focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'arquivo' }));
  expect(onNewFile).toHaveBeenCalledTimes(1);
});

test('the + lists no agent that cannot open a free session, the default one included: codex waits for #931 (#927)', () => {
  expect(newRunEntries({ kind: 'task', task: bareTask(task()), activity: liveIn(task()) }, 'codex').map((e) => e.kind)).toEqual(['terminal', 'claude', 'diff']);
});
