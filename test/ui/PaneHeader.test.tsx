import { render, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import type { LiveRun } from '../../src/task-runs';
import { activityPane, PaneHeader, paneContext } from '@/components/PaneHeader';
import { setLanguage, statusText } from '@/i18n';
import type { Activity } from '@/lib/activities';
import type { Activity as LiveActivity, Task, Stage } from '../../src/types';
import { localPairOf, taskPairOf } from '../fixtures/work';

const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
// #629: the worktree is the task's live activity's
const live: LiveActivity = { id: 'a-I1', kind: 'task', workspace: 'hive', slug: 'hive-1-task-1', worktree: '/wt/hive-1-task-1' };
const STAGE: LiveRun = { ptyId: 'W1', label: 'Claude · abcdef12', kind: 'stage', session: 'abcdef12' };
const SHELL: LiveRun = { ptyId: 'W3', label: 'Terminal', kind: 'terminal' };
const activity: Activity = { kind: 'task', task, runs: [STAGE, SHELL], sessions: [{ run: STAGE, status: 'working' }], status: 'working', worker: true, ...taskPairOf('I1', live) };
const CONTEXT = { model: 'opus', folder: 'hive-1-task-1' };
const header = (): HTMLElement => document.querySelector<HTMLElement>('[data-pane-header]') as HTMLElement;

beforeEach(() => setLanguage('pt'));

test('each pane type\'s header: an agent reads claude, the model and the folder with its status on the right; a terminal its kind and folder; a diff or the console its label alone (#536)', () => {
  const { rerender } = render(<PaneHeader item={{ kind: 'run', ptyId: 'W1' }} label="Claude · abcdef12" activity={activity} context={CONTEXT} />);
  expect(header()).toHaveClass('h-[26px]', 'px-3', 'text-xs', 'text-muted-foreground');
  expect(within(header()).getByText('claude')).toHaveClass('text-foreground');
  expect(within(header()).getByText('opus · hive-1-task-1')).toBeInTheDocument();
  expect(within(header()).getByText(statusText('working'))).toBeInTheDocument();
  rerender(<PaneHeader item={{ kind: 'run', ptyId: 'W1' }} label="Claude · abcdef12" activity={activity} context={{ folder: 'hive-1-task-1' }} />);
  expect(within(header()).getByText('hive-1-task-1')).toBeInTheDocument(); // a stage with no model: the folder alone
  rerender(<PaneHeader item={{ kind: 'run', ptyId: 'W3' }} label="Terminal" activity={activity} context={CONTEXT} />);
  expect(header()).toHaveTextContent(/^terminalhive-1-task-1$/); // no model, no status: a shell reports none (#192)
  rerender(<PaneHeader item={{ kind: 'diff', scope: 'worktree' }} label="diff da worktree" activity={activity} context={CONTEXT} />);
  expect(header()).toHaveTextContent(/^diff#1 Task 1$/); // no branch: left out with its separator (#591)
  rerender(<PaneHeader item={{ kind: 'diff', scope: 'worktree' }} label="diff da worktree" activity={{ ...activity, activity: { ...live, branch: 'hive-1-task-1' } }} context={CONTEXT} />);
  expect(header()).toHaveTextContent(/^diff#1 Task 1·hive-1-task-1$/);
  expect(within(header()).getByText('hive-1-task-1')).toHaveClass('font-mono');
  rerender(<PaneHeader item={{ kind: 'console' }} label="console" activity={activity} context={CONTEXT} />);
  expect(header()).toHaveTextContent(/^console$/);
});

test('paneContext reads the task stage\'s model when it sets one and the worktree\'s folder, or the workspace\'s name on a checkout task (#536)', () => {
  const stages: Stage[] = [{ name: 'dev', from: {}, prompt: 'p', model: 'opus' }, { name: 'spec', from: {}, prompt: 'p' }];
  const state = { stages, workspaces: ['hive'], sourceWorkspaces: {} };
  expect(paneContext(task, live, state)).toEqual({ model: 'opus', folder: 'hive-1-task-1' });
  expect(paneContext({ ...task, stage: 'spec' }, live, state)).toEqual({ folder: 'hive-1-task-1' });
  expect(paneContext({ ...task, stage: 'spec', workspace: 'hive' }, { ...live, local: true, worktree: '/repo' }, state)).toEqual({ folder: 'hive' });
  const bare: Task = { item: task.item, stage: 'spec', boardColumn: 'Ready', auto: true };
  expect(paneContext(bare, undefined, state)).toEqual({}); // no activity: no folder (#629)
});

test('a local activity\'s panes read its workspace as their folder, as a checkout task\'s do; a task activity\'s read paneContext (#590)', () => {
  const state = { stages: [], workspaces: ['hive'], sourceWorkspaces: {} };
  const local: Activity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [STAGE, SHELL], sessions: [{ run: STAGE, status: 'waiting' }], kept: [] };
  expect(activityPane(local, state)).toEqual({ folder: 'hive' });
  expect(activityPane(activity, state)).toEqual(paneContext(task, live, state));
  render(<PaneHeader item={{ kind: 'run', ptyId: 'W1' }} label="Claude · abcdef12" activity={local} context={activityPane(local, state)} />);
  expect(header()).toHaveTextContent(`claudehive${statusText('waiting')}`);
});

test('a held approval run\'s header reads sleeping like its session line, not stopped: its status is empty (#663)', () => {
  const held: Activity = { ...activity, sessions: [{ run: STAGE, status: 'empty' }], status: 'approval' };
  render(<PaneHeader item={{ kind: 'run', ptyId: 'W1' }} label="Claude · abcdef12" activity={held} context={CONTEXT} />);
  expect(within(header()).getByText('dormindo')).toBeInTheDocument();
  expect(within(header()).queryByText('parada')).not.toBeInTheDocument();
});
