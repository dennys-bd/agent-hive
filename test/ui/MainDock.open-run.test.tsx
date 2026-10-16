import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import type { Selection } from '@/components/DetailPanel';
import { type DockLayout, inEveryView } from '@/lib/dock-layout';
import { readView, resetViewState } from '@/lib/view-state';
import { localRunTab, type RunTab, useOpenRun, useOpenStarted } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task, Terminal, Worker } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, localPairs, withPointedWork, type WithWork } from '../fixtures/work';
import { localActivityId } from '../../src/activities';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-task-tree', () => ({ useTaskTree: () => ({ status: 'loading' }) }));

// Task A runs its stage (W1) and a shell (W2); task C runs nothing until a test starts one (#457)
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const taskC: WithWork = { item: { itemId: 'C', id: '3', title: 'Task C', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };
const T0 = '2026-09-27T10:00:00.000Z';
const shellA: Terminal = { terminalId: 'W2', activityId: activityIdOf('A'), startedAt: T0, cwd: '/repo' };
const run = (ptyId: string, task: string, kind: RunTab['kind'] = 'terminal'): RunTab => ({ ptyId, kind, task, title: task === 'A' ? '#1 Task A' : '#3 Task C' });

// What a run's terminal button does inside the Dashboard (focusRun, attachRun): it hands the run to the dock's run opener (#457). The buttons
// sit in the Detalhes body, which stays mounted while an activity replaces the board.
function Opener({ tab }: { tab: RunTab }) {
  const openRun = useOpenRun();
  return <button type="button" onClick={() => openRun?.(tab)}>{`run ${tab.ptyId}`}</button>;
}
const OPENERS = [run('W2', 'A'), run('W3', 'A', 'session'), run('W9', 'C'), localRunTab('P1', 'hive')];
// What Iniciar / Continuar / Reiniciar do once the server took the start (#457): they hand over the task alone, its run not spawned yet
function Starter() {
  const started = useOpenStarted();
  return <button type="button" onClick={() => started?.('C')}>iniciar C</button>;
}
const openers = () => [...OPENERS.map((tab) => <Opener key={tab.ptyId} tab={tab} />), <Starter key="start" />];

function Home({ workers = [workerA], terminals = [shellA], calls = [], c = taskC }: { workers?: Worker[]; terminals?: Terminal[]; calls?: Selection[]; c?: Task }) {
  const work = withPointedWork({ tasks: [taskA, c], workers: workers, terminals: terminals, ...localPairs(['hive']) }); // #629: what the runs point at
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[taskA, c]} workers={workers}
      liveActivities={work.activities} activityRecords={work.activityRecords}
      terminals={terminals} onSelect={(s) => calls.push(s)} detail={openers} automation={() => <p>automação</p>}
      header={() => <header />}
    >
      <main>fluxo</main>
    </MainDock>
  );
}

const click = (ptyId: string): void => { fireEvent.click(screen.getByRole('button', { name: `run ${ptyId}`, hidden: true })); };
const centerTabs = (): [string | null, string | null][] =>
  within(screen.getByRole('tablist', { name: 'abas' })).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]);

beforeEach(() => {
  resetViewState(); // the dock layout a test leaves (a closed left side, #612) would carry over to the next
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('a task\'s run opened from the UI selects its activity, shows the Atividades tab and that run\'s tab in the center (#457)', () => {
  const calls: Selection[] = [];
  render(<Home calls={calls} />);
  click('W2');
  expect(screen.getByRole('region', { name: 'Atividades' })).toBeVisible();
  expect(screen.getByText('automação')).not.toBeVisible(); // Automação stays hidden: the left side shows Atividades
  expect(screen.queryByRole('main')).not.toBeInTheDocument();
  expect(centerTabs()).toEqual([['Claude', 'false'], ['Terminal', 'true']]);
  expect(screen.getByRole('region', { name: '#1 Task A · terminal' })).toBeVisible();
  expect(calls).toEqual([{ taskId: 'A', fromActivity: true }]); // Detalhes follows without being forced open
});

test('a run not yet in the state keeps its task requested: Home until the run appears, then its tab, once gone, Home again, and a later run does not bring it back (#457, #458)', () => {
  const home = (): HTMLElement => screen.getByRole('heading', { name: 'Nenhuma atividade aberta' });
  const { rerender } = render(<Home />);
  click('W9');
  expect(home()).toBeInTheDocument(); // task C runs nothing yet; the center is Atividades' now
  rerender(<Home />); // a broadcast without the run: the request holds
  rerender(<Home terminals={[shellA, { terminalId: 'W9', activityId: activityIdOf('C'), startedAt: T0, cwd: '/repo' }]} />);
  expect(centerTabs()).toEqual([['Terminal', 'true']]);
  rerender(<Home />);
  expect(home()).toBeInTheDocument();
  rerender(<Home terminals={[shellA, { terminalId: 'W9', activityId: activityIdOf('C'), startedAt: T0, cwd: '/repo' }]} />);
  expect(home()).toBeInTheDocument(); // the pick went with the run
});

test('a new run on the activity already shown leaves its tabs as they are until the run appears, then lands shown in the focused group (#457, #458)', () => {
  const { rerender } = render(<Home />);
  click('W2');
  click('W3');
  expect(centerTabs()).toEqual([['Claude', 'false'], ['Terminal', 'true']]);
  rerender(<Home />);
  expect(centerTabs()).toEqual([['Claude', 'false'], ['Terminal', 'true']]);
  rerender(<Home workers={[workerA, { id: 's2', status: 'working', activityId: activityIdOf('A'), runId: 'W3', freeSession: true }]} />); // a free session
  expect(centerTabs()).toEqual([['Claude', 'false'], ['Terminal', 'false'], ['Claude', 'true']]);
});

test('a workspace\'s terminal opened from the UI goes to its local activity\'s center and selects no task, with no window of its own; a docked-back task run goes to its activity (#590)', () => {
  let docked: (tab: unknown) => void = () => {};
  const detach = vi.fn(async (_tab: unknown) => undefined);
  vi.stubGlobal('hive', { detach, onCloseKey: vi.fn(), onDock: (callback: (tab: unknown) => void) => { docked = callback; } });
  const calls: Selection[] = [];
  const { rerender } = render(<Home calls={calls} />);
  click('P1');
  expect(detach).not.toHaveBeenCalled();
  rerender(<Home calls={calls} terminals={[shellA, { terminalId: 'P1', activityId: localActivityId('hive'), startedAt: T0, cwd: '/repo' }]} />);
  expect(centerTabs()).toEqual([['Terminal', 'true']]);
  expect(screen.getByRole('region', { name: 'hive · terminal' })).toBeVisible();
  expect(calls).toEqual([]);
  act(() => docked(run('W2', 'A')));
  expect(screen.getByRole('region', { name: '#1 Task A · terminal' })).toBeVisible();
});

// Task C's runs once its start spawned: a free session listed first, then the stage run the start asked for
const sessionC: Worker = { id: 's3', status: 'working', activityId: activityIdOf('C'), runId: 'W7', freeSession: true };
const stageC: Worker = { id: 's4', status: 'working', activityId: activityIdOf('C'), runId: 'W8' };
const startC = (): void => { fireEvent.click(screen.getByRole('button', { name: 'iniciar C', hidden: true })); };

test('a started task waits unselected until its run appears, then becomes the activity with its stage run alone in the center (#457, #458)', () => {
  const calls: Selection[] = [];
  const { rerender } = render(<Home calls={calls} />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the board is the center (#746)
  startC();
  rerender(<Home calls={calls} />);
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Atividades' })).not.toBeVisible();
  expect(calls).toEqual([]);
  rerender(<Home calls={calls} workers={[workerA, sessionC, stageC]} />);
  expect(screen.getByRole('region', { name: 'Atividades' })).toBeVisible();
  expect(centerTabs()).toEqual([['Claude', 'true']]); // runs the user did not ask for open no tab (#458)
  expect(calls).toEqual([{ taskId: 'C', fromActivity: true }]);
});

test('a started task with its worktree already listed still waits for its run before taking the center (redesign 03)', () => {
  const calls: Selection[] = [];
  const withWorktree: WithWork = { ...taskC, worktree: '/w/c' };
  const { rerender } = render(<Home calls={calls} c={withWorktree} />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the board is the center (#746)
  startC();
  rerender(<Home calls={calls} c={withWorktree} />);
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(calls).toEqual([]);
  rerender(<Home calls={calls} c={withWorktree} workers={[workerA, stageC]} />);
  expect(screen.getByRole('region', { name: 'Atividades' })).toBeVisible();
  expect(calls).toEqual([{ taskId: 'C', fromActivity: true }]);
});

test('a pending start gives way to what the user did since: another opened run, or the Automação tab, which keeps the board as the center (#457, #458)', () => {
  const { rerender } = render(<Home />);
  startC();
  click('W2');
  rerender(<Home workers={[workerA, stageC]} />);
  expect(screen.getByRole('region', { name: '#1 Task A · terminal' })).toBeVisible(); // still task A's
  rerender(<Home />);
  startC();
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' }));
  rerender(<Home workers={[workerA, stageC]} />);
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Atividades' })).not.toBeVisible();
});

// The Activities panel's lines (#492): task A's runs are W1, its stage run (`Claude`: no session id yet), and W2, its shell (`Terminal`)
// The activity's agent session (redesign 03): the Claude mark, the agent's name; terminals have no line
const session = (): HTMLElement =>
  within(screen.getByRole('navigation', { name: 'Atividades', hidden: true })).getByRole('button', { name: /^claude/, hidden: true });

test('a session under an activity shows its run\'s tab in the activity\'s center, marked while the focused group shows it; Automação clears the mark; a terminal has no line (#492, redesign 03)', () => {
  render(<Home />);
  fireEvent.click(screen.getByRole('button', { name: 'atividades' }));
  expect(within(screen.getByRole('navigation', { name: 'Atividades' })).queryByRole('button', { name: /Terminal/ })).not.toBeInTheDocument();
  fireEvent.click(session());
  expect(centerTabs()).toEqual([['Claude', 'true']]);
  expect(session()).toHaveAttribute('aria-current', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' }));
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(session()).not.toHaveAttribute('aria-current'); // the pick stays (#458), but the board is the center now
});

const CLOSED_LEFT: DockLayout = { docks: { automation: 'left', activities: 'left', plugins: 'left', detail: 'right' }, sizes: inEveryView({ left: 30, right: 30 }), open: inEveryView({ left: false, right: false }) };
const isLeftOpen = (): boolean | undefined => (readView('dockLayout') as DockLayout | undefined)?.open.activities.left;
const toggleLeft = (): void => { fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, shiftKey: true }); }; // off macOS (#585)

test('a run opened with the left side closed leaves it closed and shows the run in the center; reopened, the side shows Atividades (#612)', () => {
  resetViewState({ dockLayout: CLOSED_LEFT });
  render(<Home />);
  click('W2');
  expect(isLeftOpen()).toBe(false);
  expect(screen.getByRole('region', { name: 'Atividades' })).not.toBeVisible();
  expect(screen.getByRole('region', { name: '#1 Task A · terminal' })).toBeVisible();
  toggleLeft();
  expect(screen.getByRole('region', { name: 'Atividades' })).toBeVisible();
});

test('a deferred start whose run appears takes the center but leaves a closed left side closed (#612)', () => {
  resetViewState({ dockLayout: CLOSED_LEFT });
  const { rerender } = render(<Home />);
  startC();
  rerender(<Home workers={[workerA, sessionC, stageC]} />);
  expect(centerTabs()).toEqual([['Claude', 'true']]);
  expect(isLeftOpen()).toBe(false);
  expect(screen.getByRole('region', { name: 'Atividades' })).not.toBeVisible();
});
