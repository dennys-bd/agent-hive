import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import type { CommentsState } from '@/hooks/use-comments';
import { setLanguage } from '@/i18n';
import { DEFAULT_DOCK_LAYOUT, moveTo } from '@/lib/dock-layout';
import { resetViewState } from '@/lib/view-state';
import type { Task, TaskFile, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Two running tasks (A on worker s1, B on worker s2) plus a stopped one with no worker,
// so a click on the board and on empty space each get exercised (#184).
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const taskB: WithWork = { item: { itemId: 'B', id: '2', title: 'Task B', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's2' };
const taskC: Task = { item: { itemId: 'C', id: '3', title: 'Task C', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };
const workerB: Worker = { id: 's2', status: 'working', activityId: activityIdOf('B'), runId: 'W2' };
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 2, workers: [workerA, workerB],
  stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }],
  tasks: [taskA, taskB, taskC], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {},
  syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});

let comments: CommentsState = { kind: 'unsupported' };
vi.mock('@/hooks/use-comments', () => ({ useComments: () => comments }));
let files: TaskFile[] = [];
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => files }));

// The board's own task, not the panel's title nor a chip's truncated copy of the same label text.
const boardTask = (label: string): Element => screen.getAllByText(label).find((el) => el.closest('li'))!;
// toggleRight is Ctrl+Alt+Shift+B under jsdom's platform, which is not macOS (#452, #585)
const rightKey = (): void => { fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, altKey: true, shiftKey: true }); };

// The selection as App holds it (src/ui/App.tsx): one piece of state, threaded through Dashboard down to Flow/DetailPanel.
function Home({ initial, calls, s = state }: { initial?: Selection; calls: (Selection | undefined)[]; s?: State }) {
  const [selected, setSelected] = useState<Selection | undefined>(initial);
  const onSelect = (next?: Selection): void => { calls.push(next); setSelected(next); };
  return <Dashboard state={s} locale="pt-BR" tick={0} selected={selected} onSelect={onSelect} />;
}

const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); comments = { kind: 'unsupported' }; files = []; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const showFlow = (): void => { fireEvent.click(screen.getByRole('radio', { name: /fluxo/ })); }; // the window opens on Atividades (#746)

test('clicking another task switches the panel to it directly, never closing it first (#184)', async () => {
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  render(<Home initial={{ taskId: 'A' }} calls={calls} />);
  showFlow();
  expect(screen.getByRole('heading', { name: '#1 Task A' })).toBeInTheDocument();

  await user.click(boardTask('#2 Task B'));

  expect(screen.getByRole('heading', { name: '#2 Task B' })).toBeInTheDocument();
  expect(calls).toEqual([{ taskId: 'B' }]); // no intermediate onSelect(undefined) from the pointerdown outside
});

test('clicking the already-open task keeps it open, with no close in between (#184)', async () => {
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  render(<Home initial={{ taskId: 'A' }} calls={calls} />);
  showFlow();

  await user.click(boardTask('#1 Task A'));

  expect(screen.getByRole('heading', { name: '#1 Task A' })).toBeInTheDocument();
  expect(calls).toEqual([{ taskId: 'A' }]);
});

test('a click on empty space leaves the panel open: only its X or Escape closes it (#341)', async () => {
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  render(<Home initial={{ taskId: 'A' }} calls={calls} />);

  await user.click(document.body);

  expect(calls).toEqual([]);
  expect(screen.getByRole('heading', { name: '#1 Task A' })).toBeInTheDocument();
});

test('the detail docks in the frame\'s right group, between the header and the workers bar, which spans the whole width; its X closes that panel and keeps the selection, the same task there when the panel opens again (#341, #342, #452)', async () => {
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  render(<Home initial={{ taskId: 'A' }} calls={calls} />);
  showFlow();
  const panel = screen.getByRole('complementary', { name: 'detalhe' });
  const group = panel.closest<HTMLElement>('[data-dock]')!;
  expect(group).toHaveAttribute('data-dock', 'right');
  const frame = group.parentElement as HTMLElement;
  expect(frame).toContainElement(screen.getByRole('main'));
  expect(group).toContainElement(screen.getByRole('separator', { name: 'redimensionar o painel da direita' }));
  expect(frame.lastElementChild).toBe(group);
  expect(frame).not.toContainElement(screen.getByRole('contentinfo')); // the workers bar
  expect(within(group).getByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');

  await user.click(within(group).getByRole('button', { name: 'Fechar painel' })); // the right panel's X, not the left one's (#456)

  expect(calls).toEqual([]);
  expect(screen.getByRole('complementary', { name: 'detalhe', hidden: true })).not.toBeVisible(); // collapsed, the task kept
  expect(screen.queryByRole('separator', { name: 'redimensionar o painel da direita' })).not.toBeInTheDocument();
  rightKey();
  expect(screen.getByRole('heading', { name: '#1 Task A' })).toBeVisible();
});

test('no board task or worker chip carries the #184 data-keeps-detail marker any more: nothing closes the panel on an outside click (#341)', () => {
  render(<Home initial={{ taskId: 'A' }} calls={[]} />);
  expect(document.querySelector('[data-keeps-detail]')).toBeNull();
});

test('with no selection the Detalhes tab is still there, its body the empty state, once its panel opens (#452)', () => {
  render(<Home calls={[]} />);
  showFlow();
  expect(screen.queryByRole('tab', { name: 'Detalhes', hidden: true })).not.toBeInTheDocument(); // the right panel starts closed
  rightKey();
  expect(screen.getByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('Nenhuma tarefa selecionada')).toBeVisible();
});

test('Escape closes the detail\'s panel and keeps the selection; with Detalhes behind another tab, or its panel closed, Escape does nothing (#426, #452)', async () => {
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  resetViewState({ dockLayout: moveTo(DEFAULT_DOCK_LAYOUT, 'detail', 'left') }); // Detalhes docked left, beside Automação and Atividades
  render(<Home initial={{ taskId: 'A' }} calls={calls} />);
  await user.click(screen.getByRole('tab', { name: 'Automação' }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('tab', { name: 'Automação' })).toHaveAttribute('aria-selected', 'true'); // still open
  await user.click(screen.getByRole('tab', { name: 'Detalhes' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('tab', { name: 'Detalhes' })).not.toBeInTheDocument(); // the left panel closed
  expect(screen.queryByRole('tab', { name: 'Automação' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}'); // closed: no listener, nothing more
  expect(calls).toEqual([]);
  fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, shiftKey: true }); // toggleLeft opens the left panel again (#452)
  expect(screen.getByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('heading', { name: '#1 Task A' })).toBeVisible();
});

// #36: A lists B, so the details of either hold the tree section
const TREE: State = withPointedWork({
  ...state, tasks: [{ ...taskA, item: { ...taskA.item, children: ['B'] } }, { ...taskB, item: { ...taskB.item, parent: 'A' } }, taskC],
});
// The flow's own card, by its task id: the outline's rows carry the same label
const card = (itemId: string): HTMLElement => document.querySelector<HTMLElement>(`li[data-task-id="${itemId}"]`)!;

test('hovering a row of the details\' tree lights its card in the flow until the pointer leaves, and a click opens that task as the flow\'s click does (#36)', async () => {
  resetViewState();
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  render(<Home initial={{ taskId: 'A' }} calls={calls} s={TREE} />);
  showFlow();
  const section = screen.getByRole('region', { name: 'árvore' });
  await user.hover(within(section).getByText('#2 Task B'));
  expect(card('B')).toHaveClass('border-foreground', 'ring-foreground/25');
  expect(card('A')).not.toHaveClass('border-foreground');
  await user.unhover(within(section).getByText('#2 Task B'));
  expect(card('B')).not.toHaveClass('border-foreground');
  await user.click(within(section).getByText('#2 Task B'));
  expect(calls).toEqual([{ taskId: 'B' }]);
  expect(screen.getByRole('heading', { name: '#2 Task B' })).toBeInTheDocument();
});
