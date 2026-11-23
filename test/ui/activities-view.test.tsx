// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx
import { beforeEach, expect, test } from 'vitest';
import { DEFAULT_VIEW, readWorkspaceView, writeWorkspaceView, type WorkspaceView } from '@/lib/activities-view';
import { readView, resetViewState } from '@/lib/view-state';

beforeEach(() => resetViewState());

test('a workspace with nothing saved reads the defaults: by stage, worktree shown, done collapsed, the workspace open, every task open (#586, #779, #913)', () => {
  expect(readWorkspaceView('hive')).toEqual({ mode: 'stage', showWorktree: true, collapsed: ['done'], isOpen: true, collapsedTasks: [] });
  expect(readWorkspaceView('site')).toEqual(DEFAULT_VIEW);
});

test('a write is read back for its workspace only, lands in the view state under its name, and never in sessionStorage (#779, #913)', () => {
  const hive: WorkspaceView = { mode: 'status', showWorktree: false, collapsed: ['status:working'], isOpen: false, collapsedTasks: ['I1'] };
  writeWorkspaceView('hive', hive);
  expect(readWorkspaceView('hive')).toEqual(hive);
  expect(readWorkspaceView('site')).toEqual(DEFAULT_VIEW);
  writeWorkspaceView('site', DEFAULT_VIEW);
  expect(readView('activitiesView')).toEqual({ hive, site: DEFAULT_VIEW }); // the other workspace's view is kept
  expect(sessionStorage.length).toBe(0);
});

test('a stored value that is no object reads no views; a field of the wrong type reads its default, field by field (#586, #779, #913)', () => {
  for (const stored of [null, [], 'hive', 42]) {
    resetViewState({ activitiesView: stored });
    expect(readWorkspaceView('hive')).toEqual(DEFAULT_VIEW);
  }
  resetViewState({ activitiesView: { hive: { mode: 'bogus', showWorktree: 'no', collapsed: 'done', isOpen: 'no', collapsedTasks: 'I1' } } });
  expect(readWorkspaceView('hive')).toEqual(DEFAULT_VIEW);
  resetViewState({ activitiesView: { hive: { mode: 'none', collapsed: ['stage:dev', 3], isOpen: false, collapsedTasks: ['I1', 3] } } });
  expect(readWorkspaceView('hive')).toEqual({ ...DEFAULT_VIEW, mode: 'none', isOpen: false });
});

test('a view the view state loaded, as a restart loads it, is what its workspace reads (#779, #913)', () => {
  const saved: WorkspaceView = { mode: 'none', showWorktree: false, collapsed: [], isOpen: false, collapsedTasks: ['I2', 'gone'] }; // a gone task's id stays
  resetViewState({ activitiesView: { hive: saved } });
  expect(readWorkspaceView('hive')).toEqual(saved);
  expect(readWorkspaceView('site')).toEqual(DEFAULT_VIEW);
});
