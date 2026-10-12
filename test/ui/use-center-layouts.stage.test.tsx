import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useCenterLayouts } from '@/hooks/use-center-layouts';
import { type Activity, activitiesOf } from '@/lib/activities';
import { type CenterLayout, groupsOf, refKey } from '@/lib/center-layout';
import { resetViewState } from '@/lib/view-state';
import type { Activity as LiveActivity, Stage, StageCommands, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withWork } from '../fixtures/work';

// A commands stage's locked console tab (#755), as the center's layouts open it
const CHECKS: Stage = { name: 'checks', from: {}, action: 'commands', commands: ['build'], stopOnFailure: true };
const TASK: Task = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'checks', boardColumn: '', auto: true };
const BASE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [CHECKS], tasks: [TASK], sourceOrder: [], localCount: 0, activities: [], activityRecords: [],
  usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: [], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const RUN: StageCommands = { stage: 'checks', at: 0, ptyId: 'P0', runId: 'R0', failed: [], workerId: 'w1', started: [] };
const listWith = (work: Partial<LiveActivity>): Activity[] => activitiesOf(withWork(BASE, 'A', work));
const keysOf = (layout?: CenterLayout): string[][] => (layout === undefined ? [] : groupsOf(layout.root).map((group) => group.tabs.map(refKey)));

beforeEach(() => resetViewState({}));

test('a commands stage in flight lists its activity and adds a locked console tab on its channel; a closed one stays closed for that run and comes back with the next (#755)', () => {
  const { result, rerender } = renderHook(({ list }: { list: Activity[] }) => useCenterLayouts(list, list[0], undefined), { initialProps: { list: listWith({ commands: RUN }) } });
  expect(keysOf(result.current.layout)).toEqual([['console:stage:checks#R0']]);
  expect(groupsOf(result.current.layout?.root ?? { kind: 'group', id: 'none', tabs: [], active: 0 })[0].tabs).toEqual([{ kind: 'console', channel: 'stage:checks', locked: true, run: 'R0' }]);
  act(() => result.current.close('console:stage:checks#R0'));
  expect(result.current.layout).toBeUndefined();
  rerender({ list: listWith({ commands: { ...RUN, at: 1, ptyId: 'P1' } }) }); // the next command of the same run
  expect(result.current.layout).toBeUndefined();
  rerender({ list: listWith({ worktree: '/wt' }) }); // the stage ended; its worktree keeps the activity listed
  rerender({ list: listWith({ worktree: '/wt', commands: { ...RUN, ptyId: 'P9', runId: 'R9' } }) }); // the stage's next execution
  expect(keysOf(result.current.layout)).toEqual([['console:stage:checks#R9']]);
});
