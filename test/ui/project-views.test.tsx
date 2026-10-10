import { expect, test } from 'vitest';
import { readProjectView, writeProjectView } from '@/lib/project-views';
import { readView, resetViewState } from '@/lib/view-state';

const ROADMAP = { groupBy: 'status', collapsed: ['Done'], columns: ['status', 'field:Priority'], sort: { key: 'field:Priority', desc: true }, widths: { status: 140 } };
const BARE = { groupBy: null, collapsed: [], columns: [], sort: null, widths: {} };

test('writeProjectView keeps each source\'s view under projectViews, and readProjectView reads it back (#756)', () => {
  resetViewState({ projectViews: { notes: BARE } });
  writeProjectView('roadmap', ROADMAP);
  expect(readView('projectViews')).toEqual({ notes: BARE, roadmap: ROADMAP });
  expect(readProjectView('roadmap')).toEqual(ROADMAP);
  expect(readProjectView('notes')).toEqual(BARE);
});

test('readProjectView: nothing saved for the source, or a value it cannot read, is undefined: the table\'s defaults (#756)', () => {
  resetViewState();
  expect(readProjectView('roadmap')).toBeUndefined();
  const bad: unknown[] = [null, 'x', [ROADMAP], { ...ROADMAP, groupBy: 3 }, { ...ROADMAP, collapsed: 'Done' }, { ...ROADMAP, columns: [1] }, { groupBy: 'status' },
    { ...ROADMAP, sort: 'issue' }, { ...ROADMAP, sort: { key: 'issue' } }, { ...ROADMAP, widths: { status: '140' } }, { ...ROADMAP, widths: [140] }];
  for (const value of bad) {
    resetViewState({ projectViews: { roadmap: value } });
    expect(readProjectView('roadmap')).toBeUndefined();
  }
  for (const value of [null, 'x', [ROADMAP]]) {
    resetViewState({ projectViews: value });
    expect(readProjectView('roadmap')).toBeUndefined();
  }
  resetViewState({ projectViews: { roadmap: ROADMAP } });
  expect(readProjectView('toString')).toBeUndefined(); // own keys only
});

test('readProjectView: a view saved before sort and widths existed reads with no sort and no widths (#756)', () => {
  resetViewState({ projectViews: { roadmap: { groupBy: 'status', collapsed: [], columns: ['status'] } } });
  expect(readProjectView('roadmap')).toEqual({ groupBy: 'status', collapsed: [], columns: ['status'], sort: null, widths: {} });
});
