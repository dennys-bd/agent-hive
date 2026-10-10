import { expect, test } from 'vitest';
import { dockedTab, droppedTab, moveTab, openedFile, type PanelTab, localRunTab, type RunTab, tabKey } from '@/components/terminal-tabs';

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

// window:dock payloads as main sends them back (#252): the tab plus the window's label, and the session name a window opened before #378 still carries
const TASK_RUN = { ptyId: 'W1', session: 'hive-1-task-1', kind: 'stage', task: 'I1', title: '#1 Task 1', label: '#1 Task 1 · etapa' };
const SHELL_RUN = { ptyId: 'P1', session: 'project-P1', kind: 'terminal', project: 'hive', title: 'hive', label: 'hive · shell' };

test('dockedTab rebuilds a project shell as its own tab and a task run with its task, and refuses a tab with both, neither, or an empty one (#400, #252)', () => {
  expect(dockedTab(SHELL_RUN)).toEqual(localRunTab('P1', 'hive'));
  expect(dockedTab(SHELL_RUN)?.project).toBe('hive');
  expect(dockedTab(TASK_RUN)).toEqual({ ptyId: 'W1', kind: 'stage', task: 'I1', title: '#1 Task 1' });
  const { task: _task, ...neither } = TASK_RUN;
  for (const bad of [{ ...TASK_RUN, project: 'hive' }, neither, { ...SHELL_RUN, project: '' }, { ...TASK_RUN, task: 7 }]) {
    expect(dockedTab(bad), JSON.stringify(bad)).toBeUndefined();
  }
});

test('droppedTab takes a task run\'s chip only: a project shell\'s payload opens nothing (#400, #340)', () => {
  expect(droppedTab(JSON.stringify(TASK_RUN))?.task).toBe('I1');
  expect(droppedTab(JSON.stringify(SHELL_RUN))).toBeUndefined();
});

test('openedFile reads a detached window\'s file link: a task\'s by its item id, a workspace\'s by its local key, the line and column when positive; anything else is none (#717)', () => {
  expect(openedFile({ task: 'I1', path: 'src/a.ts', line: 12, col: 3 })).toEqual({ key: 'I1', path: 'src/a.ts', at: { line: 12, col: 3 } });
  expect(openedFile({ project: 'my site', path: '/x/README.md', line: 0 })).toEqual({ key: 'local/my site', path: '/x/README.md' });
  for (const bad of [undefined, 'a.ts', { path: 'a.ts' }, { task: 'I1', path: '' }, { task: '', path: 'a.ts' }]) expect(openedFile(bad)).toBeUndefined();
});
