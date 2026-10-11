import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FlowNode } from '@/components/FlowNode';
import type { Dragging } from '@/components/task-drag';
import { setLanguage } from '@/i18n';
import type { Item, Stage, State, Task, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// A node of the flowchart (#134): its header, its executor line, its tasks and the footer that appears only when its list overflows.
const STAGE: Stage = { name: 'Build', from: { board: ['Ready'] }, prompt: '/build', model: 'opus' };
const task = (id: string, extra: Partial<WithWork> = {}): WithWork => ({ item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '' }, stage: 'Build', boardColumn: 'Ready', auto: true, ...extra });
const state = (tasks: WithWork[], workers: Worker[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages: [STAGE], transitions: [], tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
function Node({ s, tasks, onList = () => {}, isTree, collapsed, onToggleGroup }: { s: State; tasks: Task[]; onList?(): void; isTree?: boolean; collapsed?: string[]; onToggleGroup?(key: string): void }) {
  const drag = useRef<Dragging | undefined>(undefined);
  return (
    <FlowNode
      stage={STAGE} state={s} tasks={tasks} order={tasks} shown={tasks.length} filteredOut={0} rules={[]} drag={drag} isListed={false} maxHeight={400}
      onFilter={() => {}} onClearFilter={() => {}} onList={onList} isTree={isTree} collapsed={collapsed} onToggleGroup={onToggleGroup}
    />
  );
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

// #34: I1 lists I2 and I3, I3 lists I4; I5 and I6 are in no tree. The Hive's order mixes them
const linked = (id: string, links: Pick<Item, 'parent' | 'children'>): WithWork => {
  const t = task(id);
  return { ...t, item: { ...t.item, ...links } };
};
const FOREST = [task('5'), linked('4', { parent: 'I3' }), linked('1', { children: ['I2', 'I3'] }), task('6'), linked('2', { parent: 'I1' }), linked('3', { parent: 'I1', children: ['I4'] })];
const cards = (): string[] => screen.getAllByText(/^#\d Task/).map((el) => (el.textContent ?? '').replace('↳', '')); // a child's ↳ sits inside the title
const groupRow = (label: string): HTMLElement => screen.getByText(label).closest('li')!;
const indent = (title: string): string => screen.getByText(title).closest('li')!.style.marginLeft;

test('with the tree on, the root\'s group header counts its cards, its cards follow in tree order indented by depth, and the rest sit under sem árvore (#34)', () => {
  const s = state(FOREST);
  render(<Node s={s} tasks={s.tasks} isTree />);
  expect(cards()).toEqual(['#1 Task 1', '#2 Task 2', '#3 Task 3', '#4 Task 4', '#5 Task 5', '#6 Task 6']);
  expect(within(groupRow('⑂ #1 Task 1')).getByText('4')).toHaveClass('text-muted-foreground');
  expect(within(groupRow('sem árvore')).getByText('2')).toBeInTheDocument();
  expect(['#1 Task 1', '#2 Task 2', '#3 Task 3', '#4 Task 4', '#5 Task 5'].map(indent)).toEqual(['', '', '', '10px', '']);
  expect(within(groupRow('⑂ #1 Task 1')).getByRole('button', { name: 'recolher' })).toHaveAttribute('aria-expanded', 'true');
});

test('with the tree off the node lists its tasks as today, no header and no indent, a child keeping its ↳; with the tree on and no tree task there is no header either (#34)', () => {
  const s = state(FOREST);
  const { unmount } = render(<Node s={s} tasks={s.tasks} />);
  expect(cards()).toEqual(['#5 Task 5', '#4 Task 4', '#1 Task 1', '#6 Task 6', '#2 Task 2', '#3 Task 3']);
  expect(screen.queryByText('⑂ #1 Task 1')).not.toBeInTheDocument();
  expect(screen.queryByText('sem árvore')).not.toBeInTheDocument();
  expect(indent('#4 Task 4')).toBe('');
  expect(within(screen.getByText('#4 Task 4')).getByText('↳')).toBeInTheDocument();
  unmount();
  const loose = state([task('5'), task('6')]);
  render(<Node s={loose} tasks={loose.tasks} isTree />);
  expect(cards()).toEqual(['#5 Task 5', '#6 Task 6']);
  expect(screen.queryByText('sem árvore')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'recolher' })).not.toBeInTheDocument();
});

test('a collapsed group keeps its header, its › and its count and hides its cards; the chevron asks to toggle the group by this stage and its root, or none for sem árvore (#34)', async () => {
  const user = userEvent.setup();
  const onToggleGroup = vi.fn();
  const s = state(FOREST);
  render(<Node s={s} tasks={s.tasks} isTree collapsed={['Build\u0000I1']} onToggleGroup={onToggleGroup} />);
  expect(cards()).toEqual(['#5 Task 5', '#6 Task 6']);
  const header = groupRow('⑂ #1 Task 1');
  expect(within(header).getByText('4')).toBeInTheDocument();
  expect(within(header).getByText('›')).toBeInTheDocument();
  await user.click(within(header).getByRole('button', { name: 'expandir' }));
  expect(onToggleGroup).toHaveBeenLastCalledWith('Build\u0000I1');
  await user.click(within(groupRow('sem árvore')).getByRole('button', { name: 'recolher' }));
  expect(onToggleGroup).toHaveBeenLastCalledWith('Build\u0000none');
});
