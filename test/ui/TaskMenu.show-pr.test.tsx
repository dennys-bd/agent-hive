import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { PrOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { ActivityRecord, Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork } from '../fixtures/work';

// Its own file: Radix's ContextMenu opens once per file under jsdom; every state arrives through rerender
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (extra: Partial<Task> = {}): Task => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const workers: Worker[] = [{ id: 's1', status: 'empty' }];
// live: the task runs a plain shell, which makes it an activity; mostrar PR no longer needs one (#758)
const state = (c: Task, live = true, activityRecords: ActivityRecord[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: live ? [{ terminalId: 'W1', activityId: activityIdOf('I1'), startedAt: '2026-01-01T00:00:00Z', cwd: '/repo' }] : [], stages, tasks: [c], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const prs = [{ url: 'https://github.com/acme/app/pull/7', state: 'merged' as const }, { url: 'https://github.com/acme/app/pull/8', state: 'open' as const }];
beforeEach(() => { setLanguage('pt'); });

test('right-click › mostrar PR hands the task\'s next PR to the dock\'s PR opener, activity or not; disabled while it has none (#592, #758)', async () => {
  const user = userEvent.setup();
  const openPr = vi.fn();
  const board = (c: Task, live = true, records: ActivityRecord[] = []) => <PrOpenerContext.Provider value={openPr}><Flow state={state(c, live, records)} /></PrOpenerContext.Provider>;
  const withPrs = [{ id: 'a-I1', taskIds: ['I1'], sessions: [], prs }]; // #629: the PRs are the record's
  const item = (): HTMLElement => screen.getByRole('menuitem', { name: 'mostrar PR' });
  const { rerender } = render(board(task()));
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'mostrar PR' })).toHaveAttribute('data-disabled');
  rerender(board(task(), false, withPrs));
  expect(item()).not.toHaveAttribute('data-disabled');
  await user.click(item());
  expect(openPr).toHaveBeenCalledWith(prs[1].url);
});
