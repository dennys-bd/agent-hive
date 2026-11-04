import { expect, test } from 'vitest';
import { chipTab, droppedTab, moveTab, type PanelTab, localRunTab, type RunTab, tabKey } from '@/components/terminal-tabs';

const tab = (ptyId: string): RunTab => ({ ptyId, kind: 'terminal', task: 'I1', title: ptyId });
const keys = (tabs: readonly PanelTab[]): string[] => tabs.map(tabKey);

test('moveTab moves a tab down the list to a later index', () => {
  const tabs = [tab('A'), tab('B'), tab('C')];
  expect(keys(moveTab(tabs, 'A', 2))).toEqual(['B', 'C', 'A']);
});

test('moveTab moves a tab up the list to an earlier index', () => {
  const tabs = [tab('A'), tab('B'), tab('C')];
  expect(keys(moveTab(tabs, 'C', 0))).toEqual(['C', 'A', 'B']);
});

test('moveTab to the index it already sits at returns the same order', () => {
  const tabs = [tab('A'), tab('B'), tab('C')];
  expect(keys(moveTab(tabs, 'B', 1))).toEqual(['A', 'B', 'C']);
});

test('moveTab with an unknown key returns the input unchanged', () => {
  const tabs = [tab('A'), tab('B')];
  expect(keys(moveTab(tabs, 'Z', 0))).toEqual(['A', 'B']);
});

test('moveTab never mutates its input array', () => {
  const tabs = [tab('A'), tab('B'), tab('C')];
  const before = [...tabs];
  moveTab(tabs, 'A', 2);
  expect(tabs).toEqual(before);
});

// A chip's drop payload as a RunTab carries it (#340): the tab plus a label, and a session name an old drag may still carry
const TASK_RUN = { ptyId: 'W1', session: 'hive-1-task-1', kind: 'stage', task: 'I1', title: '#1 Task 1', label: '#1 Task 1 · etapa' };
const SHELL_RUN = { ptyId: 'P1', session: 'project-P1', kind: 'terminal', project: 'hive', title: 'hive', label: 'hive · shell' };

test('chipTab rebuilds a chip\'s run: a project shell as its own tab, a task run with its task, and refuses a tab with both, neither, or an empty one (#400, #340)', () => {
  expect(chipTab(SHELL_RUN)).toEqual(localRunTab('P1', 'hive'));
  expect(chipTab(SHELL_RUN)?.project).toBe('hive');
  expect(chipTab(TASK_RUN)).toEqual({ ptyId: 'W1', kind: 'stage', task: 'I1', title: '#1 Task 1' });
  const { task: _task, ...neither } = TASK_RUN;
  for (const bad of [{ ...TASK_RUN, project: 'hive' }, neither, { ...SHELL_RUN, project: '' }, { ...TASK_RUN, task: 7 }]) {
    expect(chipTab(bad), JSON.stringify(bad)).toBeUndefined();
  }
});

test('droppedTab takes a task run\'s chip only: a project shell\'s payload opens nothing (#400, #340)', () => {
  expect(droppedTab(JSON.stringify(TASK_RUN))?.task).toBe('I1');
  expect(droppedTab(JSON.stringify(SHELL_RUN))).toBeUndefined();
});
