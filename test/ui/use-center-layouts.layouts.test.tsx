import { renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useCenterLayouts } from '@/hooks/use-center-layouts';
import { activitiesOf } from '@/lib/activities';
import type { CenterLayout } from '@/lib/center-layout';
import { resetViewState } from '@/lib/view-state';
import type { State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withWork } from '../fixtures/work';

// #533: the design layer reads every activity's stored layout, not only the picked one's
const task = (itemId: string, id: string): Task => ({ item: { itemId, id, title: `Task ${id}`, body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true });
const BASE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [], tasks: [task('A', '1'), task('B', '2')], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [],
  usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: [], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const designIn = (path: string): CenterLayout => ({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'design', path }], active: 0 }, focused: 'g1' });
const STORED = { A: designIn('design/a.hv.html'), B: designIn('design/b.hv.html') };

beforeEach(() => resetViewState({ centerLayouts: STORED }));

test('every listed activity\'s stored layout leaves the hook, the picked one\'s and the others\' (#533)', () => {
  const list = activitiesOf(withWork(withWork(BASE, 'A', { worktree: '/a' }), 'B', { worktree: '/b' })); // a worktree keeps an activity listed
  const { result } = renderHook(() => useCenterLayouts(list, list[0], undefined));
  expect(result.current.layouts).toEqual(STORED);
});
