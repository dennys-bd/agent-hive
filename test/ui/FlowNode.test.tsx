import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FlowNode } from '@/components/FlowNode';
import type { Dragging } from '@/components/task-drag';
import { setLanguage } from '@/i18n';
import type { Stage, State, Task, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// A node of the flowchart (#134): its header, its executor line, its tasks and the footer that appears only when its list overflows.
const STAGE: Stage = { name: 'Build', from: { board: ['Ready'] }, prompt: '/build', model: 'opus' };
const task = (id: string, extra: Partial<WithWork> = {}): WithWork => ({ item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '' }, stage: 'Build', boardColumn: 'Ready', auto: true, ...extra });
const state = (tasks: WithWork[], workers: Worker[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages: [STAGE], transitions: [], tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
function Node({ s, tasks, onList = () => {} }: { s: State; tasks: Task[]; onList?(): void }) {
  const drag = useRef<Dragging | undefined>(undefined);
  return <FlowNode stage={STAGE} state={s} tasks={tasks} order={tasks} shown={tasks.length} filteredOut={0} rules={[]} drag={drag} isListed={false} maxHeight={400} onFilter={() => {}} onClearFilter={() => {}} onList={onList} />;
}
// jsdom keeps the box metrics on Element.prototype, all zeros: an overflowing list is stubbed there
const overflow = (scrollHeight: number, clientHeight: number) => {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
};
beforeEach(() => setLanguage('pt'));
afterEach(() => vi.restoreAllMocks());

test('the header shows the name, the count and ● N in waiting for the tasks awaiting the user; the executor line names the agent and the model (#134)', () => {
  const since = '2026-10-09T10:00:00.000Z';
  const tasks = [task('1', { approval: { since } }), task('2'), task('3', { workerId: 'w' })];
  const s = state(tasks, [{ id: 'w', status: 'waiting', activityId: activityIdOf('I3'), runId: 'W' }]);
  render(<Node s={s} tasks={s.tasks} />);
  const header = screen.getByRole('heading', { level: 3, name: 'Build' }).parentElement as HTMLElement;
  expect(within(header).getByText('3')).toBeInTheDocument();
  expect(within(header).getByText('● 2')).toHaveClass('text-waiting');
  expect(screen.getByText('claude · opus')).toHaveClass('truncate');
  expect(within(header).queryByText('auto')).not.toBeInTheDocument();
});

test('the node is 220px wide, the width the chart lays it out at (#54)', () => {
  const { container } = render(<Node s={state([])} tasks={[]} />);
  expect(container.querySelector<HTMLElement>('[data-stage="Build"]')!.style.width).toBe('220px');
});

test('the footer appears only when the list overflows: rola para ver N and lista ›, which opens the list (#134)', async () => {
  const user = userEvent.setup();
  const s = state([task('1'), task('2'), task('3'), task('4')]);
  const { unmount } = render(<Node s={s} tasks={s.tasks} />);
  expect(screen.queryByText(/rola para ver/)).not.toBeInTheDocument();
  unmount();
  overflow(400, 200);
  const onList = vi.fn();
  render(<Node s={s} tasks={s.tasks} onList={onList} />);
  expect(screen.getByText('rola para ver 2')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'lista ›' }));
  expect(onList).toHaveBeenCalledOnce();
});

test('the header counts the tasks out of tries in a destructive ● N beside the waiting one; none without them (#913)', () => {
  const since = '2026-10-09T10:00:00.000Z';
  const tasks = [task('1', { stopped: true, error: 'tries out: verdict:failed · 3' }), task('2', { approval: { since } }), task('3', { approval: { since } })];
  const s = state(tasks);
  const { unmount } = render(<Node s={s} tasks={s.tasks} />);
  const header = screen.getByRole('heading', { level: 3, name: 'Build' }).parentElement as HTMLElement;
  expect(within(header).getByText('● 1')).toHaveClass('text-destructive');
  expect(within(header).getByText('● 1')).toHaveAttribute('title', '1 com tentativas esgotadas');
  expect(within(header).getByText('● 2')).toHaveClass('text-waiting');
  unmount();
  const calm = state([task('2', { approval: { since } })]);
  render(<Node s={calm} tasks={calm.tasks} />);
  expect(document.querySelector('.text-destructive')).toBeNull();
});
