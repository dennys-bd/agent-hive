// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx
import { beforeEach, expect, test } from 'vitest';
import { DEFAULT_VIEW, readWorkspaceView, writeWorkspaceView, type WorkspaceView } from '@/lib/activities-view';
import { readView, resetViewState } from '@/lib/view-state';

beforeEach(() => resetViewState());

test('a workspace with nothing saved reads the defaults: by stage, worktree shown, done collapsed, the workspace open (#586, #779)', () => {
  expect(readWorkspaceView('hive')).toEqual({ mode: 'stage', showWorktree: true, collapsed: ['done'], isOpen: true });
  expect(readWorkspaceView('site')).toEqual(DEFAULT_VIEW);
});

test('a write is read back for its workspace only, lands in the view state under its name, and never in sessionStorage (#779)', () => {
  const hive: WorkspaceView = { mode: 'status', showWorktree: false, collapsed: ['status:working'], isOpen: false };
  writeWorkspaceView('hive', hive);
  expect(readWorkspaceView('hive')).toEqual(hive);
  expect(readWorkspaceView('site')).toEqual(DEFAULT_VIEW);
  writeWorkspaceView('site', DEFAULT_VIEW);
  expect(readView('activitiesView')).toEqual({ hive, site: DEFAULT_VIEW }); // the other workspace's view is kept
  expect(sessionStorage.length).toBe(0);
});

test('a stored value that is no object reads no views; a field of the wrong type reads its default, field by field (#586, #779)', () => {
  for (const stored of [null, [], 'hive', 42]) {
    resetViewState({ activitiesView: stored });
    expect(readWorkspaceView('hive')).toEqual(DEFAULT_VIEW);
  }
  resetViewState({ activitiesView: { hive: { mode: 'bogus', showWorktree: 'no', collapsed: 'done', isOpen: 'no' } } });
  expect(readWorkspaceView('hive')).toEqual(DEFAULT_VIEW);
  resetViewState({ activitiesView: { hive: { mode: 'none', collapsed: ['stage:dev', 3], isOpen: false } } });
  expect(readWorkspaceView('hive')).toEqual({ ...DEFAULT_VIEW, mode: 'none', isOpen: false });
});

test('a view the view state loaded, as a restart loads it, is what its workspace reads (#779)', () => {
  const saved: WorkspaceView = { mode: 'none', showWorktree: false, collapsed: [], isOpen: false };
  resetViewState({ activitiesView: { hive: saved } });
  expect(readWorkspaceView('hive')).toEqual(saved);
  expect(readWorkspaceView('site')).toEqual(DEFAULT_VIEW);
});
