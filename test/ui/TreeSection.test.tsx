import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TreeSection } from '@/components/TreeSection';
import { TreeHoverContext } from '@/components/tree-hover';
import { setLanguage } from '@/i18n';
import { readFlowView } from '@/lib/flow-view';
import { resetViewState } from '@/lib/view-state';
import type { Item, Stage, State, Task, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] } }, { name: 'done', from: { board: ['Done'] } }];
type Links = Pick<Item, 'parent' | 'children' | 'closedChildren'>;
const node = (id: string, links: Links = {}, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...links }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
// 1 lists 2, 3 and 9; 2 lists 4 and 5; 9 has no task and GitHub closed it. 3 waits for the user, 4 sits in the last stage, 5 ran out of
// tries; 7 is in no tree
const TREE = [
  node('1', { children: ['I2', 'I3', 'I9'], closedChildren: ['I9'] }),
  node('2', { parent: 'I1', children: ['I4', 'I5'] }),
  node('3', { parent: 'I1' }, { workerId: 's1' }),
  node('4', { parent: 'I2' }, { stage: 'done' }),
  node('5', { parent: 'I2' }, { stopped: true, error: 'tries out: verdict:failed · 3' }),
  node('7'),
];
const WAITING: Worker = { id: 's1', status: 'waiting', activityId: activityIdOf('I3'), runId: 'W1' };
const state = (tasks: WithWork[] = TREE, workers: Worker[] = [WAITING]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
// withPointedWork splits each fixture, so the section gets the state's own task
const taskOf = (s: State, itemId: string): Task => s.tasks.find((c) => c.item.itemId === itemId)!;
const section = (): HTMLElement => screen.getByRole('region', { name: 'árvore' });
const rows = (): HTMLElement[] => within(section()).getAllByRole('listitem');
const labels = (): string[] => rows().map((li) => within(li).getByText(/^#\d Task \d$/).textContent ?? '');
function Section({ s = state(), open, onOpenTask = () => {} }: { s?: State; open: string; onOpenTask?(itemId: string): void }) {
  return <TreeSection task={taskOf(s, open)} state={s} onOpenTask={onOpenTask} />;
}
beforeEach(() => { setLanguage('pt'); resetViewState(); });
afterEach(() => resetViewState()); // also drops toggleOutline's pending post

test('on a leaf the outline lists the tree from the root, depth first, the leaf marked; each row reads its stage and its status word, indented by depth; the bar draws every node below the root (#36)', () => {
  render(<Section open="I4" />);
  expect(labels()).toEqual(['#1 Task 1', '#2 Task 2', '#4 Task 4', '#5 Task 5', '#3 Task 3']);
  expect(rows().map((li) => li.style.paddingLeft)).toEqual(['8px', '24px', '40px', '40px', '24px']);
  expect(within(section()).getByText('#4 Task 4').closest('button')).toHaveAttribute('aria-current', 'true');
  expect(within(section()).getByText('#1 Task 1').closest('button')).not.toHaveAttribute('aria-current');
  expect(rows()[2]).toHaveClass('bg-muted', 'text-foreground');
  expect(rows()[0]).toHaveClass('text-foreground/85');
  expect(within(rows()[2]).getByText('done')).toHaveClass('text-muted-foreground'); // the stage's outline badge
  expect(within(rows()[4]).getByText('esperando você')).toHaveClass('text-waiting');
  expect(within(rows()[3]).getByText('vazio')).toHaveClass('text-muted-foreground');
  const segments = [...section().querySelectorAll('[data-tree-bar] > span')];
  expect(segments.map((s) => s.className.match(/bg-[a-z-]+/)?.[0])).toEqual(['bg-empty', 'bg-muted-foreground', 'bg-empty', 'bg-waiting', 'bg-muted-foreground']);
  expect(within(section()).getByText('clicar numa linha abre os detalhes dela · passar o mouse marca no grafo')).toHaveClass('text-muted-foreground');
});

test('the header reads N tarefas · done/N done over every node below the root, then ● N for the tasks waiting for you and ● N for those out of tries, each only when non-zero (#36)', () => {
  const { rerender } = render(<Section open="I1" />);
  expect(within(section()).getByText('árvore')).toHaveClass('font-medium', 'text-foreground');
  expect(within(section()).getByText('5 tarefas · 2/5 done')).toHaveClass('truncate', 'text-muted-foreground');
  expect(within(section()).getByTitle('esperando você')).toHaveTextContent('● 1');
  expect(within(section()).getByTitle('esperando você')).toHaveClass('text-waiting');
  expect(within(section()).getByTitle('tentativas esgotadas')).toHaveTextContent('● 1');
  expect(within(section()).getByTitle('tentativas esgotadas')).toHaveClass('text-destructive');
  // The same tree with nobody waiting and no task out of tries
  const calm = TREE.map((c) => node(c.item.id, { parent: c.item.parent, children: c.item.children, closedChildren: c.item.closedChildren }, { stage: c.stage }));
  rerender(<Section s={state(calm, [])} open="I1" />);
  expect(within(section()).getByText('5 tarefas · 2/5 done')).toBeInTheDocument();
  expect(within(section()).queryByTitle('esperando você')).not.toBeInTheDocument();
  expect(within(section()).queryByTitle('tentativas esgotadas')).not.toBeInTheDocument();
});

test('a task outside any tree renders no section at all (#36)', () => {
  const { container } = render(<Section open="I7" />);
  expect(container).toBeEmptyDOMElement();
});

test('a click on a row opens that task and hovering it names the task to TreeHoverContext until the pointer leaves; ⌄ hides that subtree through flowView, the header and the bar whole, and the collapse survives a remount (#36)', async () => {
  const user = userEvent.setup();
  const onOpenTask = vi.fn();
  const setHoveredId = vi.fn();
  const view = () => <TreeHoverContext.Provider value={{ setHoveredId }}><Section open="I4" onOpenTask={onOpenTask} /></TreeHoverContext.Provider>;
  const { unmount } = render(view());
  await user.click(within(section()).getByText('#3 Task 3'));
  expect(onOpenTask).toHaveBeenCalledWith('I3');
  expect(setHoveredId).toHaveBeenLastCalledWith('I3');
  await user.unhover(within(section()).getByText('#3 Task 3'));
  expect(setHoveredId).toHaveBeenLastCalledWith(undefined);
  await user.click(within(section()).getByRole('button', { name: 'recolher #2 Task 2' }));
  expect(labels()).toEqual(['#1 Task 1', '#2 Task 2', '#3 Task 3']);
  expect(within(section()).getByRole('button', { name: 'expandir #2 Task 2' })).toHaveAttribute('aria-expanded', 'false');
  expect(within(section()).getByText('5 tarefas · 2/5 done')).toBeInTheDocument();
  expect(section().querySelectorAll('[data-tree-bar] > span')).toHaveLength(5);
  expect(readFlowView().outline).toEqual(['I2']);
  await user.hover(within(section()).getByText('#1 Task 1'));
  expect(setHoveredId).toHaveBeenLastCalledWith('I1');
  unmount();
  expect(setHoveredId).toHaveBeenLastCalledWith(undefined); // a row gone under the pointer leaves no card lit
  render(view());
  expect(labels()).toEqual(['#1 Task 1', '#2 Task 2', '#3 Task 3']);
});

test('the outline keeps the handoff row: no gap between rows, the list run 6px past the sides, 2px 6px around each row and the stage as a plain bordered span (#116)', () => {
  render(<Section open="I4" />);
  const list = within(section()).getByRole('list');
  expect(list).not.toHaveClass('gap-0.5');
  expect(list).toHaveClass('mt-0.5', '-mx-1.5');
  expect(rows()[0]).toHaveClass('py-0.5', 'pr-1.5');
  const stage = within(rows()[2]).getByText('done');
  expect(stage).not.toHaveAttribute('data-slot', 'badge');
  expect(stage).toHaveClass('rounded', 'border', 'px-1.5', 'leading-[18px]');
  expect(stage.parentElement).toHaveClass('gap-2');
});
