import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { useOpenDiff } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task, Worker } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// Task A runs its stage (W1); task C runs nothing (#458). A task that is no activity offers no diff (TaskMenu, redesign 07).
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const taskC: Task = { item: { itemId: 'C', id: '3', title: 'Task C', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };

// What the task menu's diff items do (#270): hand the task and the scope to the dock's diff opener. The buttons sit in the Detalhes body,
// which stays mounted whatever the center shows.
function DiffOpener({ task }: { task: Task }) {
  const openDiff = useOpenDiff();
  return <button type="button" onClick={() => openDiff?.(task, 'worktree')}>{`diff ${task.item.itemId}`}</button>;
}
function Home() {
  const work = withPointedWork({ tasks: [taskA, taskC], workers: [workerA], terminals: [], activities: [], activityRecords: [] }); // #629: what the runs point at
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[taskA, taskC]} workers={[workerA]} liveActivities={work.activities} activityRecords={work.activityRecords}
      terminals={[]} onSelect={() => {}} detail={() => <DiffOpener task={taskA} />} automation={() => <p>automação</p>}
    >
      <main>fluxo</main>
    </MainDock>
  );
}
const click = (taskId: string): void => { fireEvent.click(screen.getByRole('button', { name: `diff ${taskId}`, hidden: true })); };

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"files":[]}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('a running task\'s diff opens as a tab of its activity\'s center, beside its stage run, Atividades shown (#458)', () => {
  render(<Home />);
  click('A');
  expect(screen.getByRole('region', { name: 'Atividades' })).toBeVisible();
  expect(within(screen.getByRole('tablist', { name: 'abas' })).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]))
    .toEqual([['Claude', 'false'], ['diff da worktree', 'true']]);
  expect(screen.getByRole('region', { name: '#1 Task A · diff da worktree' })).toBeVisible();
  expect(screen.queryByRole('main')).not.toBeInTheDocument();
  // The diff is no session: its tab has no status dot, the run's keeps its own (#591)
  const dot = (name: string): Element | null => screen.getByRole('tab', { name }).querySelector('[aria-hidden="true"]');
  expect(dot('diff da worktree')).toBeNull();
  expect(dot('Claude')).toHaveClass('rounded-full');
});
