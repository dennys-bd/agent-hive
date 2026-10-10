import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { DiffOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task, DiffScope, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file (#270): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx), so the menu is opened once and
// every state below arrives through rerender. The dock's diff opener is a spy (#458): where it opens the diff is MainDock.open-diff.test.tsx's.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const START = { stage: 'dev', commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' };
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const workers: Worker[] = [{ id: 's1', status: 'empty' }];
// live: the task runs a plain terminal, which makes it an activity, the only place a diff opens since redesign 07
const state = (c: Task, live = true): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: live ? [{ terminalId: 'W1', activityId: activityIdOf('I1'), startedAt: '2026-01-01T00:00:00Z', cwd: '/repo' }] : [], stages, tasks: [c], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
beforeEach(() => { setLanguage('pt'); });

test('right-click › diff da etapa and diff da worktree hand the task and its scope to the dock\'s diff opener; both are disabled without a worktree on disk, the stage one also without a start in the current stage (#270, #458)', async () => {
  const user = userEvent.setup();
  const openDiff = vi.fn((_task: Task, _scope: DiffScope) => undefined);
  const board = (c: Task, live = true) => <DiffOpenerContext.Provider value={openDiff}><Flow state={state(c, live)} /></DiffOpenerContext.Provider>;
  const item = (name: string): HTMLElement => screen.getByRole('menuitem', { name });
  const { rerender } = render(board(task()));
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'diff da etapa' })).toHaveAttribute('data-disabled');
  expect(item('diff da worktree')).toHaveAttribute('data-disabled');
  rerender(board(task({ worktree: '/wt', worktreeGone: true, stageStart: START })));
  expect(item('diff da etapa')).toHaveAttribute('data-disabled');
  expect(item('diff da worktree')).toHaveAttribute('data-disabled');
  rerender(board(task({ worktree: '/wt', stageStart: { ...START, stage: 'spec' } })));
  expect(item('diff da etapa')).toHaveAttribute('data-disabled');
  expect(item('diff da worktree')).not.toHaveAttribute('data-disabled');
  rerender(board(task({ worktree: '/wt', stageStart: START })));
  expect(item('diff da etapa')).not.toHaveAttribute('data-disabled');
  await user.click(item('diff da worktree'));
  expect(openDiff.mock.calls.map(([c, scope]) => [c.item.itemId, scope])).toEqual([['I1', 'worktree']]);
});
