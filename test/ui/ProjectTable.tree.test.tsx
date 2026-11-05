import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectTable } from '@/components/ProjectTable';
import { resetViewState } from '@/lib/view-state';
import { flatten } from '../../src/flows';
import type { Flow, ProjectView, Stage, State, Task } from '../../src/types';
import { ALL, fetchMock, jsonRes, numbers, renderTable, resetProjectTest, row, rowOf, state, VIEW } from './project-harness';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

beforeEach(resetProjectTest);
afterEach(() => vi.unstubAllGlobals());

// #584: #12 (Ready) holds #13 (Ready); #20 (Ready) holds #21, which sits in Todo. No Progress value, so the badge counts the children
const TREE: ProjectView = {
  ...VIEW,
  items: [row(12, { status: 'Ready' }), row(13, { status: 'Ready', parent: 12 }), row(20, { status: 'Ready' }), row(21, { status: 'Todo', parent: 20 })],
};
const answerTree = async (input: RequestInfo | URL): Promise<Response> => jsonRes(String(input).endsWith('/project') ? TREE : { ok: true });
const byStatus = (): void => resetViewState({ projectViews: { roadmap: { groupBy: 'status', collapsed: [], columns: ALL } } });
const childMark = (id: string): Element | null => rowOf(id).querySelector('svg.lucide-corner-down-right');
const groupRow = (label: string) => screen.getAllByRole('row').find((r) => r.children.length === 1 && r.textContent?.startsWith(label));

async function openTree(over: Parameters<typeof renderTable>[0] = {}): Promise<void> {
  fetchMock.mockImplementation(answerTree);
  renderTable({ tasks: [], ...over });
  await screen.findByText('4 de 4');
}

test('a parent and its child in one group: the parent folded with its chevron and ⑂ 1 sub-issues · 0/1, the child hidden; a child in another group renders flat and its parent as a plain row; the pill counts the folded child (#584)', async () => {
  byStatus();
  await openTree();
  expect(numbers()).toEqual(['#21', '#12', '#20']);
  const twelve = within(rowOf('#12'));
  expect(twelve.getByRole('button', { name: 'expandir sub-issues' })).toHaveAttribute('aria-expanded', 'false');
  expect(twelve.getByText('1 sub-issues · 0/1')).toBeInTheDocument();
  expect(rowOf('#12').querySelector('svg.lucide-git-fork')).not.toBeNull();
  expect(within(rowOf('#20')).queryByRole('button', { name: /sub-issues/ })).not.toBeInTheDocument();
  expect(within(rowOf('#20')).queryByText(/sub-issues ·/)).not.toBeInTheDocument();
  expect(childMark('#21')).toBeNull();
  expect(screen.getByText('#21').parentElement).toHaveStyle({ paddingLeft: '0px' });
  expect(groupRow('Ready')?.textContent).toContain('Ready3');
});

test('the chevron unfolds the child under its parent, 20px in with ↳, without opening the row; again it folds it (#584)', async () => {
  const user = userEvent.setup();
  const onOpenIssue = vi.fn();
  byStatus();
  await openTree({ onOpenIssue });
  await user.click(within(rowOf('#12')).getByRole('button', { name: 'expandir sub-issues' }));
  expect(onOpenIssue).not.toHaveBeenCalled();
  expect(numbers()).toEqual(['#21', '#12', '#13', '#20']);
  expect(childMark('#13')).not.toBeNull();
  expect(screen.getByText('#13').parentElement).toHaveStyle({ paddingLeft: '20px' });
  await user.click(within(rowOf('#12')).getByRole('button', { name: 'recolher sub-issues' }));
  expect(numbers()).toEqual(['#21', '#12', '#20']);
});

test('a column sort orders the roots and keeps each child under its parent (#584 decision 6)', async () => {
  const user = userEvent.setup();
  byStatus();
  await openTree();
  await user.click(within(rowOf('#12')).getByRole('button', { name: 'expandir sub-issues' }));
  await user.click(screen.getByRole('button', { name: /^issue/ }));
  await user.click(screen.getByRole('button', { name: /^issue/ }));
  expect(numbers()).toEqual(['#21', '#20', '#12', '#13']);
});

test('ungrouped, the single list nests: a parent and its child of different statuses (#584 decision 7)', async () => {
  const user = userEvent.setup();
  await openTree(); // resetProjectTest saves groupBy: null
  expect(numbers()).toEqual(['#12', '#20']);
  await user.click(within(rowOf('#20')).getByRole('button', { name: 'expandir sub-issues' }));
  expect(numbers()).toEqual(['#12', '#20', '#21']);
  expect(childMark('#21')).not.toBeNull();
});

// #584 decisions 7, 9: HIVE-2 (review, the last stage of ship) and HIVE-3 (spec) are HIVE-1's; HIVE-3 sits in another group
const stage = (name: string): Stage => ({ name, from: {}, prompt: 'x' });
const FLOWS: Flow[] = [{ name: 'ship', stages: [stage('spec'), stage('review')], transitions: [] }];
const hiveTask = (n: number, at: string, parent?: number): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '', ...(parent === undefined ? {} : { parent: `local:${parent}` }) },
  stage: at, boardColumn: '', auto: false, created: true,
});
const hiveState = (): State => ({ ...state([hiveTask(1, 'review'), hiveTask(2, 'review', 1), hiveTask(3, 'spec', 1)]), flows: FLOWS, ...flatten(FLOWS) });

test('the hive table nests by the local parent; the badge counts the children of the whole view and the ones at their flow\'s last stage; the chevron does not go to the task (#584)', async () => {
  const user = userEvent.setup();
  const onGoTo = vi.fn();
  resetViewState();
  render(<ProjectTable state={hiveState()} source="hive" onGoTo={onGoTo} onOpenIssue={vi.fn()} />);
  expect(within(rowOf('#HIVE-1')).getByText('2 sub-issues · 1/2')).toBeInTheDocument();
  expect(screen.queryByText('#HIVE-2')).not.toBeInTheDocument();
  expect(childMark('#HIVE-3')).toBeNull(); // its parent is in review, it is in spec
  await user.click(within(rowOf('#HIVE-1')).getByRole('button', { name: 'expandir sub-issues' }));
  expect(onGoTo).not.toHaveBeenCalled();
  expect(childMark('#HIVE-2')).not.toBeNull();
});
