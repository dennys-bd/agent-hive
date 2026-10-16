import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AgentsContext, DefaultAgentContext, NewRunButton, newRunEntries, openNew, useNewRunKeys } from '@/components/NewRunButton';
import { DiffOpenerContext, RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { ALL_AGENTS } from '../../src/agents';
import type { LaunchOptions } from '../../src/types';
import { bareTask, liveOf, localPairOf, taskPairOf, type WithWork } from '../fixtures/work';

const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt/hive-1-task-1', ...extra,
});
const answer = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => answer({ ok: true }));
const openRun = vi.fn();
// #629: the view model carries the task's live activity, a run target always has one
const liveIn = (c: WithWork) => taskPairOf(c.item.itemId, liveOf(c)).activity;
const wrapped = (c: WithWork) => <RunOpenerContext.Provider value={openRun}><NewRunButton activity={{ kind: 'task', task: bareTask(c), activity: liveIn(c) }} /></RunOpenerContext.Provider>;
const plus = (): HTMLElement => screen.getByRole('button', { name: 'Novo terminal ou sessão' });

// Radix's DropdownMenu opens from the keyboard under jsdom, as the terminal panel's + test does (#292)
async function pick(user: ReturnType<typeof userEvent.setup>, item: string): Promise<void> {
  plus().focus();
  await user.keyboard('{Enter}');
  const names = (await screen.findAllByRole('menuitem')).map((i) => i.textContent?.replace(/(Ctrl\+|Shift\+|Alt\+|⌘|⇧|⌥)+[A-Z]$/, ''));
  expect(names).toEqual(['terminal', 'diff', 'arquivo', 'claudepadrão', 'codex', 'nova sessão…']);
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

test('the + opens a 220px menu titled nova sessão em #1: the tools, arquivo (disabled with no onNewFile), a separator, the agents and nova sessão…, a separator, then how an agent opens (#536, #818, #257)', async () => {
  const user = userEvent.setup();
  render(wrapped(task()));
  plus().focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menu')).toHaveClass('w-[220px]');
  expect(screen.getByText('nova sessão em #1')).toBeInTheDocument();
  expect(screen.getAllByRole('separator')).toHaveLength(2);
  expect(screen.getByRole('menuitem', { name: /^arquivo/ })).toHaveAttribute('data-disabled');
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

function Keys({ c, onNewFile }: { c: WithWork; onNewFile?(): void }) {
  useNewRunKeys({ kind: 'task', task: bareTask(c), activity: liveIn(c) }, onNewFile);
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
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.replace(/(Ctrl\+|Shift\+|Alt\+|⌘|⇧|⌥)+[A-Z]$/, ''))).toEqual(['terminal', 'arquivo', 'claudepadrão', 'codex', 'nova sessão…']);
  await user.click(screen.getByRole('menuitem', { name: /^claude/ }));
  expect(fetchMock).toHaveBeenCalledWith('/activities/local%3Ahive/sessions', expect.objectContaining({ method: 'POST' }));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'L3', kind: 'session', project: 'hive', title: 'hive' }));
});

test('newRunEntries lists terminal, each agent (the default one with newSession\'s key) and the diff on a task\'s activity only, all disabled where the + is (#759, #931)', () => {
  expect(newRunEntries({ kind: 'task', task: bareTask(task()), activity: liveIn(task()) }, 'claude', ALL_AGENTS)).toEqual([
    { kind: 'terminal', label: 'terminal', key: 'newTerminal', disabled: false },
    { kind: 'claude', label: 'claude', key: 'newSession', disabled: false },
    { kind: 'codex', label: 'codex', key: undefined, disabled: false },
    { kind: 'diff', label: 'diff', key: 'openDiff', disabled: false },
  ]);
  const noWorktree = task({ worktree: undefined });
  expect(newRunEntries({ kind: 'task', task: bareTask(noWorktree), activity: liveIn(noWorktree) }, 'claude', ALL_AGENTS).map((e) => [e.kind, e.disabled])).toEqual([
    ['terminal', false], ['claude', false], ['codex', false], ['diff', true],
  ]);
  expect(newRunEntries({ kind: 'local', workspace: 'hive', activity: localPairOf('hive').activity }, 'claude', ALL_AGENTS).map((e) => e.kind)).toEqual(['terminal', 'claude', 'codex']);
  const settingUp = task({ setup: { consoleId: 'C1' } });
  expect(newRunEntries({ kind: 'task', task: bareTask(settingUp), activity: liveIn(settingUp) }, 'claude', ALL_AGENTS).every((e) => e.disabled)).toBe(true);
});

test('the +\'s arquivo is enabled where onNewFile is given, and its pick calls it (#818)', async () => {
  const user = userEvent.setup();
  const onNewFile = vi.fn();
  render(<RunOpenerContext.Provider value={openRun}><NewRunButton activity={{ kind: 'task', task: bareTask(task()), activity: liveIn(task()) }} onNewFile={onNewFile} /></RunOpenerContext.Provider>);
  plus().focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: /^arquivo/ }));
  expect(onNewFile).toHaveBeenCalledTimes(1);
});

test('the + lists codex when boot found it, and its pick posts a codex session to the task\'s /open (#931)', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(answer({ ok: true, ptyId: 'W6' }));
  render(wrapped(task()));
  await pick(user, 'codex');
  expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'codex' }) }));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'W6', kind: 'session', task: 'I1', title: '#1 Task 1' }));
});

test('an agent boot did not find is listed disabled and named off PATH, claude as codex (#931)', async () => {
  const user = userEvent.setup();
  render(<AgentsContext.Provider value={[{ agent: 'claude', available: false }, { agent: 'codex', available: false }]}>{wrapped(task())}</AgentsContext.Provider>);
  plus().focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menuitem', { name: /^claude · fora do PATH/ })).toHaveAttribute('data-disabled');
  expect(screen.getByRole('menuitem', { name: 'codex · fora do PATH' })).toHaveAttribute('data-disabled');
  const target = { kind: 'task' as const, task: bareTask(task()), activity: liveIn(task()) };
  expect(newRunEntries(target, 'claude', [{ agent: 'claude', available: true }, { agent: 'codex', available: false }]).filter((e) => e.kind === 'claude' || e.kind === 'codex')).toEqual([
    { kind: 'claude', label: 'claude', key: 'newSession', disabled: false },
    { kind: 'codex', label: 'codex · fora do PATH', key: undefined, disabled: true },
  ]);
});

// #257: the center as the + and its keys meet: the + and the dialog useNewRunKeys returns
function Center({ c }: { c: WithWork }) {
  const target = { kind: 'task' as const, task: bareTask(c), activity: liveIn(c) };
  const dialog = useNewRunKeys(target);
  return <><NewRunButton activity={target} />{dialog}</>;
}
const OPTIONS: LaunchOptions = {
  claude: { aliases: [], versions: [], specializedAgents: [], args: [] },
  codex: { aliases: [], versions: [], specializedAgents: [], args: [] },
};

test('every + item has its icon, the agents their mark in their own colour, padrão on the default one; arquivo and nova sessão… show their keys; no PR item (#257)', async () => {
  const user = userEvent.setup();
  render(wrapped(task()));
  plus().focus();
  await user.keyboard('{Enter}');
  const claude = await screen.findByRole('menuitem', { name: /^claude/ });
  expect(claude.textContent).toMatch(/^claudepadrão.*N$/);
  expect(claude.querySelector('svg')).toHaveClass('text-agent-claude');
  expect(screen.getByRole('menuitem', { name: /^codex/ }).querySelector('svg')).toHaveClass('text-agent-codex');
  expect(screen.getByRole('menuitem', { name: /^arquivo/ }).textContent).toMatch(/F$/);
  expect(screen.getByRole('menuitem', { name: /^nova sessão…/ }).textContent).toMatch(/S$/);
  expect(screen.queryByRole('menuitem', { name: /mostrar PR/ })).not.toBeInTheDocument();
  for (const item of screen.getAllByRole('menuitem')) expect(item.querySelector('svg')).not.toBeNull();
});

test('padrão and newSession\'s key follow the default agent (#257)', async () => {
  const user = userEvent.setup();
  render(<DefaultAgentContext.Provider value="codex">{wrapped(task())}</DefaultAgentContext.Provider>);
  plus().focus();
  await user.keyboard('{Enter}');
  expect((await screen.findByRole('menuitem', { name: /^codex/ })).textContent).toMatch(/^codexpadrão.*N$/);
  expect(screen.getByRole('menuitem', { name: /^claude/ }).textContent).toBe('claude');
});

test('newSessionDialog\'s key and nova sessão… open the dialog; its Enter opens the default agent as claude\'s item does (#257)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (path: string) => answer(path.startsWith('/launch-options') ? OPTIONS : { ok: true, ptyId: 'W4' }));
  render(<RunOpenerContext.Provider value={openRun}><Center c={task()} /></RunOpenerContext.Provider>);
  await user.keyboard('{Control>}{Alt>}{Shift>}S{/Shift}{/Alt}{/Control}'); // newSessionDialog off macOS (#585)
  expect(await screen.findByRole('dialog', { name: 'Nova sessão' })).toBeInTheDocument();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'claude' }) })));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'W4', kind: 'session', task: 'I1', title: '#1 Task 1' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  plus().focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: /^nova sessão…/ }));
  expect(await screen.findByRole('dialog', { name: 'Nova sessão' })).toBeInTheDocument();
});

test('the dialog\'s key does nothing where the + is disabled (#257)', async () => {
  const user = userEvent.setup();
  render(<RunOpenerContext.Provider value={openRun}><Center c={task({ setup: { consoleId: 'C1' } })} /></RunOpenerContext.Provider>);
  await user.keyboard('{Control>}{Alt>}{Shift>}S{/Shift}{/Alt}{/Control}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('newFile\'s key opens an untitled file where the center gives one (#257)', async () => {
  const user = userEvent.setup();
  const onNewFile = vi.fn();
  render(<Keys c={task()} onNewFile={onNewFile} />);
  await user.keyboard('{Control>}{Alt>}{Shift>}F{/Shift}{/Alt}{/Control}'); // newFile off macOS (#585)
  expect(onNewFile).toHaveBeenCalledTimes(1);
});

test('openNew spreads the dialog\'s picks into the open\'s body, on a task and in a workspace (#257)', async () => {
  const launch = { model: 'opus', specializedAgent: 'hive:designer', args: ['--verbose'] };
  openNew({ kind: 'task', task: task(), activity: liveIn(task()) }, 'claude', openRun, undefined, undefined, launch);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ body: JSON.stringify({ kind: 'claude', ...launch }) })));
  openNew({ kind: 'local', workspace: 'hive', activity: localPairOf('hive').activity }, 'codex', openRun, undefined, undefined, { model: 'gpt-5.6-terra' });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/activities/local%3Ahive/sessions', expect.objectContaining({ body: JSON.stringify({ kind: 'codex', model: 'gpt-5.6-terra' }) })));
});
