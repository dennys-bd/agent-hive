import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { FlowListPanel } from '@/components/FlowListPanel';
import type { Dragging } from '@/components/task-drag';
import { setLanguage } from '@/i18n';
import type { Stage, State, Task, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// The list panel (#134, 1b): every task of a node, filtered by text and by status, closed by × or esc.
const STAGE: Stage = { name: 'Build', from: {}, prompt: '/build' };
const task = (id: string, title: string): WithWork => ({ item: { itemId: `I${id}`, id, title, body: '', url: '' }, stage: 'Build', boardColumn: '', auto: true });
const s = (tasks: WithWork[], workers: Worker[]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages: [STAGE], transitions: [], tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
function Panel({ state, onClose }: { state: State; onClose(): void }) {
  const drag = useRef<Dragging | undefined>(undefined);
  return <FlowListPanel stage={STAGE} state={state} tasks={state.tasks as Task[]} order={state.tasks} drag={drag} onClose={onClose} />;
}
beforeEach(() => setLanguage('pt'));

test('the panel: name, N tarefas and ● for the tasks awaiting you, every task, filtered by text and by status; the footer; × and esc close it (#134)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const state = s([task('1', 'Login page'), task('2', 'Logout'), task('3', 'Reports')], [{ id: 'w', status: 'waiting', activityId: activityIdOf('I3'), runId: 'W' }]);
  render(<Panel state={state} onClose={onClose} />);
  const panel = screen.getByRole('region', { name: 'Build' });
  expect(within(panel).getByText('3 tarefas')).toBeInTheDocument();
  expect(within(panel).getByText('● 1')).toHaveClass('text-waiting');
  expect(within(panel).getByText('esc fecha · o grafo não muda')).toBeInTheDocument();
  await user.type(within(panel).getByRole('textbox', { name: 'filtrar em Build' }), 'log');
  expect(within(panel).getAllByRole('listitem').map((li) => li.querySelector('span')?.textContent)).toEqual(['#1 Login page', '#2 Logout']);
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
  await user.click(within(panel).getByRole('button', { name: 'fechar a lista' }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
