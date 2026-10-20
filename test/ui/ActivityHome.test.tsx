import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivityHome } from '@/components/ActivityHome';
import { DiffOpenerContext, RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage, statusText } from '@/i18n';
import type { Activity, LocalActivity, TaskActivity } from '@/lib/activities';
import type { LiveRun } from '../../src/task-runs';
import type { Activity as LiveActivity, Session, Task } from '../../src/types';
import { localPairOf, taskPairOf } from '../fixtures/work';

const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const at = (day: number, hour: number, minute = 0): string => new Date(2026, 9, day, hour, minute).toISOString();
const S1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const S2 = 'b1b2c3d4-0000-4000-8000-000000000002';
const asleep: Session = { id: S1, startedAt: at(5, 9), stages: ['spec', 'dev'], agent: 'claude' as const, lastUsedAt: at(5, 10) };
const held: Session = { id: S2, startedAt: at(6, 4), stages: ['dev'], agent: 'claude' as const, lastUsedAt: at(6, 4, 46) };
const W2: LiveRun = { ptyId: 'W2', label: 'Claude · b1b2c3d4', kind: 'session', session: 'b1b2c3d4' };
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: 'hive' };
// Task 1: a sleeping session, a session its live run works in, a live terminal and a sleeping one
const taskActivity = (extra: Partial<TaskActivity> = {}, work: Partial<LiveActivity> = { worktree: '/w/1' }): TaskActivity => ({
  kind: 'task', ...taskPairOf('I1', work, { sessions: [asleep, held] }), task, runs: [W2], status: 'working', worker: false,
  sessions: [{ session: asleep, status: 'empty' }, { session: held, run: W2, status: 'working' }],
  terminals: [{ terminalId: 'T2', label: 'Terminal 2', n: 2, asleep: true }, { terminalId: 'T1', label: 'Terminal 1', n: 1, asleep: false }],
  ...extra,
});

// Every open and wake route answers the run it started (#249, #696)
const answer = (url: string): unknown => (/\/(open|wake|sessions)$/.test(url) ? { ok: true, ptyId: 'W9' } : { ok: true });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(answer(url)), { status: 200, headers: { 'content-type': 'application/json' } }));
const openRun = vi.fn();
const openDiff = vi.fn();
const onOpenRun = vi.fn();
const view = (activity: Activity) => (
  <RunOpenerContext.Provider value={openRun}>
    <DiffOpenerContext.Provider value={openDiff}><ActivityHome activity={activity} onOpenRun={onOpenRun} /></DiffOpenerContext.Provider>
  </RunOpenerContext.Provider>
);
const rowsOf = (block: string): HTMLElement[] => within(screen.getByRole('region', { name: block })).getAllByRole('button');
const newRun = (reference = '#1'): HTMLElement => screen.getByRole('region', { name: `nova sessão em ${reference}` });

beforeEach(() => {
  setLanguage('pt');
  vi.useFakeTimers({ toFake: ['Date'] }); // the meta's HH:MM reads today against the clock; the timers user-event waits on stay real
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', fetchMock);
  for (const mock of [fetchMock, openRun, openDiff, onOpenRun]) mock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the title, the subtitle, then sessões and terminais, each row with its meta, its status and its action word (#759)', () => {
  render(view(taskActivity()));
  expect(screen.getByRole('heading', { name: 'Nenhuma aba aberta' })).toBeInTheDocument();
  expect(screen.getByText('fechar uma aba não encerra a sessão. abra uma sessão desta atividade ou comece outra.')).toBeInTheDocument();
  expect(rowsOf('sessões · 2').map((row) => row.textContent)).toEqual([
    `claudeb1b2c3d4 · dev · 04:46${statusText('working')}abrir`, 'claudea1b2c3d4 · dev · ontemdormindocontinuar',
  ]);
  expect(rowsOf('terminais · 2').map((row) => row.textContent)).toEqual(['$terminal 1abrir', '$terminal 2dormindoacordar']);
});

test('a block with no row is left out (#759)', () => {
  const { rerender } = render(view(taskActivity({ sessions: [], terminals: [] })));
  expect(screen.queryByRole('region', { name: /^sessões/ })).toBeNull();
  expect(screen.queryByRole('region', { name: /^terminais/ })).toBeNull();
  rerender(view(taskActivity({ sessions: [] })));
  expect(screen.queryByRole('region', { name: /^sessões/ })).toBeNull();
  expect(rowsOf('terminais · 2')).toHaveLength(2);
});

test('a held approval run reads sleeping and opens its run; a sleeping session continues through the task\'s open route, its run attached in the activity (#759)', async () => {
  const user = userEvent.setup();
  render(view(taskActivity({ sessions: [{ session: asleep, status: 'empty' }, { session: held, run: W2, status: 'empty' }] })));
  const [approval, sleeping] = rowsOf('sessões · 2');
  expect(approval).toHaveTextContent(/dormindoabrir$/);
  await user.click(approval);
  expect(onOpenRun).toHaveBeenCalledWith('W2');
  await user.click(sleeping);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/activities/a-I1/sessions/${S1}/open`, expect.objectContaining({ method: 'POST' })));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith(expect.objectContaining({ ptyId: 'W9', task: 'I1', kind: 'session' })));
});

test('the first row holds the focus on mount; ↑ ↓ move it across both blocks and ↵ runs the focused row: a live terminal opens, a sleeping one wakes then opens (#759)', async () => {
  const user = userEvent.setup();
  render(view(taskActivity()));
  const rows = [...rowsOf('sessões · 2'), ...rowsOf('terminais · 2')];
  expect(rows[0]).toHaveFocus();
  await user.keyboard('{ArrowDown}{ArrowDown}');
  expect(rows[2]).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(onOpenRun).toHaveBeenCalledWith('T1');
  await user.keyboard('{ArrowDown}{ArrowDown}'); // the last row keeps it
  expect(rows[3]).toHaveFocus();
  await user.keyboard('{ArrowUp}');
  expect(rows[2]).toHaveFocus();
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/terminals/T2/wake', expect.objectContaining({ method: 'POST' })));
  await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith('W9'));
});

test('rows that arrive after the mount take the focus while nothing else holds it, never from an element the user is on (#759)', () => {
  const { rerender, unmount } = render(view(taskActivity({ sessions: [], terminals: [] })));
  rerender(view(taskActivity()));
  expect(document.activeElement).toBe(rowsOf('sessões · 2')[0]);
  unmount();
  const outside = document.createElement('button');
  document.body.append(outside);
  const second = render(view(taskActivity({ sessions: [], terminals: [] })));
  outside.focus();
  second.rerender(view(taskActivity()));
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

test('on a local activity a kept session goes through openLocalSession and a live run not kept yet opens its tab; the new-run row has no diff (#759)', async () => {
  const user = userEvent.setup();
  const W5: LiveRun = { ptyId: 'W5', label: 'Claude', kind: 'session' };
  const local: LocalActivity = {
    kind: 'local', ...localPairOf('hive', [asleep]), workspace: 'hive', runs: [W5],
    sessions: [{ run: W5, status: 'waiting' }], kept: [{ session: { ...asleep, stages: [] }, status: 'empty' }],
  };
  render(view(local));
  const [live, sleeping] = rowsOf('sessões · 2');
  await user.click(live);
  expect(onOpenRun).toHaveBeenCalledWith('W5');
  await user.click(sleeping);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/activities/local%3Ahive/sessions/${S1}/open`, expect.objectContaining({ method: 'POST' })));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'W9', kind: 'session', project: 'hive', title: 'hive' }));
  expect(within(newRun('hive')).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.firstChild?.textContent)).toEqual(['terminal', 'claude', 'codex']);
});

test('the new-run row: terminal and claude post the task\'s /open as the + does, diff opens the worktree\'s diff (#759)', async () => {
  const user = userEvent.setup();
  render(view(taskActivity()));
  const row = within(newRun());
  await user.click(row.getByRole('button', { name: 'terminal' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ body: JSON.stringify({ kind: 'terminal' }) })));
  await user.click(row.getByRole('button', { name: 'claude' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ body: JSON.stringify({ kind: 'claude' }) })));
  await user.click(row.getByRole('button', { name: 'diff' }));
  expect(openDiff).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ itemId: 'I1' }) }), 'worktree');
});

test('diff is disabled with no worktree to diff, and every new-run button while no run may open in the activity (#759)', () => {
  const { rerender } = render(view(taskActivity({}, {})));
  expect(within(newRun()).getByRole('button', { name: 'diff' })).toBeDisabled();
  expect(within(newRun()).getByRole('button', { name: 'terminal' })).toBeEnabled();
  rerender(view(taskActivity({}, { worktree: '/w/1', setup: { consoleId: 'C1', rows: [] } })));
  for (const button of within(newRun()).getAllByRole('button')) expect(button).toBeDisabled();
});
