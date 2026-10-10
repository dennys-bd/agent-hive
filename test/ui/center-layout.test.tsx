import { expect, test } from 'vitest';
import { applyLanding } from '@/components/center-drag';
import {
  type CenterLayout, type CenterTabRef, changePanes, closeLeaf, closeRef, consoleRef, fileRefPath, foldIntoPane, groupsOf, initialLayout, isTabOpen, moveRef, openRef, prune, pruneLayouts,
  readCenterLayouts, refKey, replaceRun, resize, retargetRef, runsOf, selectRef, sharesBuffer, shownRun, splitWith, type TabGroup, withSessions, withStageConsole, writeCenterLayouts,
} from '@/lib/center-layout';
import { focusPane, type Panes, resizePanes } from '@/lib/pane-split';
import { readView, resetViewState, writeView } from '@/lib/view-state';

// Every fixture is frozen deep: a function that wrote to its input would throw here (ESM is strict mode) (#458)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const run = (ptyId: string): CenterTabRef => ({ kind: 'run', ptyId });
const DIFF: CenterTabRef = { kind: 'diff', scope: 'worktree' };
const group = (id: string, tabs: CenterTabRef[], active = 0): TabGroup => ({ kind: 'group', id, tabs, active });
// One group, W1 and W2, W2 shown
const ONE = deepFreeze<CenterLayout>({ root: group('g1', [run('W1'), run('W2')], 1), focused: 'g1' });
// A row: g1 [W1] at 40% beside g2 [W2, W3] at 60%, g2 focused
const ROW = deepFreeze<CenterLayout>({
  root: { kind: 'split', axis: 'row', children: [group('g1', [run('W1')]), group('g2', [run('W2'), run('W3')])], sizes: [40, 60] },
  focused: 'g2',
});
const tabsOf = (layout?: CenterLayout): string[][] => (layout === undefined ? [] : groupsOf(layout.root).map((g) => g.tabs.map(refKey)));
// The layouts as the view state holds them under centerLayouts (#484), read back through readCenterLayouts
function readStored(value: unknown): Record<string, CenterLayout> {
  resetViewState({ centerLayouts: value });
  return readCenterLayouts();
}

test('a tab\'s key is its worker id or its diff\'s scope; a first layout is one group holding the tab, focused (#458)', () => {
  expect([refKey(run('W1')), refKey(DIFF)]).toEqual(['W1', 'diff:worktree']);
  expect(initialLayout(run('W1'))).toEqual({ root: group('g1', [run('W1')]), focused: 'g1' });
});

test('openRef adds a tab at the end of the focused group and shows it; a tab already in the layout is shown where it is, its group focused (#458)', () => {
  const opened = openRef(ROW, DIFF);
  expect(tabsOf(opened)).toEqual([['W1'], ['W2', 'W3', 'diff:worktree']]);
  expect(groupsOf(opened.root)[1].active).toBe(2);
  const again = openRef(ROW, run('W1'));
  expect(tabsOf(again)).toEqual(tabsOf(ROW));
  expect(again.focused).toBe('g1');
  expect(again.root).toMatchObject({ sizes: [40, 60] });
});

test('selectRef shows a tab of a group and focuses that group; an unknown group or index leaves the layout (#458)', () => {
  const picked = selectRef(ROW, 'g2', 1);
  expect([picked.focused, groupsOf(picked.root)[1].active]).toEqual(['g2', 1]);
  expect(selectRef(ROW, 'g1', 0).focused).toBe('g1');
  expect(selectRef(ROW, 'g1', 3)).toBe(ROW);
  expect(selectRef(ROW, 'g9', 0)).toBe(ROW);
});

test('closeRef drops a tab; an emptied group goes, its split collapsing into the sibling, which takes the focus; the last tab leaves nothing (#458)', () => {
  expect(tabsOf(closeRef(ROW, 'W3'))).toEqual([['W1'], ['W2']]);
  expect(closeRef(ONE, 'W2')).toEqual({ root: group('g1', [run('W1')]), focused: 'g1' });
  expect(closeRef({ ...ROW, focused: 'g1' }, 'W1')).toEqual({ root: group('g2', [run('W2'), run('W3')]), focused: 'g2' });
  expect(closeRef(initialLayout(run('W1')), 'W1')).toBeUndefined();
  expect(closeRef(ROW, 'W9')).toEqual(ROW);
});

test('splitWith moves a tab into a new group on that edge of its own, half and half, the new group focused (#458)', () => {
  const cases = [
    ['right', 'row', [['W1'], ['W2']]], ['left', 'row', [['W2'], ['W1']]],
    ['bottom', 'column', [['W1'], ['W2']]], ['top', 'column', [['W2'], ['W1']]],
  ] as const;
  for (const [edge, axis, tabs] of cases) {
    const split = splitWith(ONE, 'W2', 'g1', edge);
    expect(split.root).toMatchObject({ kind: 'split', axis, sizes: [50, 50] });
    expect(tabsOf(split)).toEqual(tabs);
    expect(split.focused).toBe('g2');
  }
});

test('splitWith in its split\'s own direction adds a sibling, across it nests a split; a tab from another group empties that one away; a group\'s only tab does nothing (#458)', () => {
  const same = splitWith(ROW, 'W3', 'g2', 'right');
  expect(same.root).toMatchObject({ kind: 'split', axis: 'row', sizes: [40, 30, 30] });
  expect(tabsOf(same)).toEqual([['W1'], ['W2'], ['W3']]);
  const across = splitWith(ROW, 'W3', 'g2', 'bottom');
  expect(across.root).toMatchObject({ kind: 'split', axis: 'row', sizes: [40, 60], children: [{ id: 'g1' }, { kind: 'split', axis: 'column', sizes: [50, 50] }] });
  expect(tabsOf(across)).toEqual([['W1'], ['W2'], ['W3']]);
  const moved = splitWith(ROW, 'W1', 'g2', 'left');
  expect(moved.root).toMatchObject({ kind: 'split', axis: 'row', sizes: [50, 50] });
  expect(tabsOf(moved)).toEqual([['W1'], ['W2', 'W3']]);
  expect(splitWith(ROW, 'W1', 'g1', 'right')).toBe(ROW);
});

test('moveRef puts a tab at an index of another group or its own, shown and focused, an emptied group gone; an unknown tab leaves the layout (#458)', () => {
  expect(moveRef(ROW, 'W1', 'g2', 1)).toEqual({ root: group('g2', [run('W2'), run('W1'), run('W3')], 1), focused: 'g2' });
  const reordered = moveRef(ROW, 'W3', 'g2', 0);
  expect(tabsOf(reordered)).toEqual([['W1'], ['W3', 'W2']]);
  expect(groupsOf(reordered.root)[1].active).toBe(0);
  expect(tabsOf(moveRef(ROW, 'W2', 'g1', 99))).toEqual([['W1', 'W2'], ['W3']]);
  expect(moveRef(ROW, 'W9', 'g1', 0)).toBe(ROW);
});

test('resize sets a split\'s sizes by its path, every child held at 10% at least and the sizes still summing 100; a wrong count leaves them (#458)', () => {
  expect(resize(ROW, [], [70, 30]).root).toMatchObject({ sizes: [70, 30] });
  expect(resize(ROW, [], [5, 95]).root).toMatchObject({ sizes: [10, 90] });
  expect(resize(ROW, [], [104, -4]).root).toMatchObject({ sizes: [90, 10] });
  expect(resize(ROW, [], [50, 25, 25]).root).toMatchObject({ sizes: [40, 60] });
  const nested = splitWith(ROW, 'W3', 'g2', 'bottom');
  expect(resize(nested, [1], [80, 20]).root).toMatchObject({ sizes: [40, 60], children: [{ id: 'g1' }, { sizes: [80, 20] }] });
});

test('prune drops the tabs of runs no longer live, then any emptied group; diffs stay; nothing left is undefined; pruneLayouts does it per task and drops a task no longer running (#458)', () => {
  expect(prune(ROW, new Set(['W1', 'W2', 'W3']))).toBe(ROW);
  expect(tabsOf(prune(ROW, new Set(['W1', 'W3'])))).toEqual([['W1'], ['W3']]);
  expect(prune(ROW, new Set(['W2', 'W3']))).toEqual({ root: group('g2', [run('W2'), run('W3')]), focused: 'g2' });
  expect(prune(ROW, new Set())).toBeUndefined();
  expect(tabsOf(prune(openRef(ROW, DIFF), new Set()))).toEqual([['diff:worktree']]);
  const all = { A: ROW, B: ONE };
  expect(pruneLayouts(all, { A: ['W1', 'W2', 'W3'], B: ['W1', 'W2'] })).toBe(all);
  expect(pruneLayouts(all, { A: ['W1'] })).toEqual({ A: { root: group('g1', [run('W1')]), focused: 'g1' } });
});

test('shownRun is the worker id of the focused group\'s shown tab; undefined when that tab is a diff and when there is no layout (#492)', () => {
  expect(shownRun(ONE)).toBe('W2'); // one group, W2 shown
  expect(shownRun(ROW)).toBe('W2'); // g2 focused, its first tab shown
  expect(shownRun({ ...ROW, focused: 'g1' })).toBe('W1');
  expect(shownRun(openRef(ROW, DIFF))).toBeUndefined(); // the diff just opened is g2's shown tab
  expect(shownRun(undefined)).toBeUndefined();
});

test('no function mutates the layout it is given (#458)', () => {
  const before = JSON.stringify([ONE, ROW]);
  openRef(ROW, DIFF);
  selectRef(ROW, 'g1', 0);
  closeRef(ROW, 'W1');
  moveRef(ROW, 'W1', 'g2', 0);
  splitWith(ROW, 'W3', 'g2', 'top');
  resize(ROW, [], [30, 70]);
  prune(ROW, new Set(['W1']));
  closeRef(ONE, 'W1');
  splitWith(ONE, 'W1', 'g1', 'left');
  expect(JSON.stringify([ONE, ROW])).toBe(before);
});

test('the layouts round-trip under the view state\'s centerLayouts; a malformed entry is dropped alone, a value that is no object reads as none (#458, #484)', () => {
  resetViewState();
  writeCenterLayouts({ A: ROW, B: ONE });
  expect(readView('centerLayouts')).toEqual({ A: ROW, B: ONE });
  expect(readCenterLayouts()).toEqual({ A: ROW, B: ONE });
  const bad: unknown[] = [
    { ...ONE, root: { ...ONE.root, kind: 'tab' } }, // an unknown kind
    { ...ROW, root: { ...ROW.root, sizes: [40, 50] } }, // sizes not summing to 100
    { ...ROW, focused: 'g9' }, // focused not a group
    { root: group('g1', []), focused: 'g1' }, // a group with no tab
    { root: group('g1', [run('W1'), run('W1')]), focused: 'g1' }, // a duplicate key
    { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run' }], active: 0 }, focused: 'g1' }, // a run with no worker
    { root: group('g1', [run('W1')], 1), focused: 'g1' }, // active past the tabs
  ];
  for (const entry of bad) expect(readStored({ good: ONE, bad: entry })).toEqual({ good: ONE });
  for (const value of ['{oops', [], 42, null]) expect(readStored(value)).toEqual({});
  resetViewState();
  expect(readCenterLayouts()).toEqual({});
});

test('the console is a tab of its own, keyed console: it survives a prune like a diff and round-trips under the view state\'s centerLayouts (redesign 05, #484)', () => {
  const withConsole = openRef(ONE, { kind: 'console' });
  expect(refKey({ kind: 'console' })).toBe('console');
  expect(tabsOf(prune(withConsole, new Set()))).toEqual([['console']]);
  resetViewState();
  writeCenterLayouts({ A: withConsole });
  expect(readCenterLayouts()).toEqual({ A: withConsole });
});

test('splitWith with a share gives the new group that part and the old one the rest, on either side; without one, half and half as a drag does (#536)', () => {
  expect(splitWith(ONE, 'W2', 'g1', 'right', 44).root).toMatchObject({ kind: 'split', axis: 'row', sizes: [56, 44] });
  expect(splitWith(ONE, 'W2', 'g1', 'top', 44).root).toMatchObject({ kind: 'split', axis: 'column', sizes: [44, 56] });
  expect(splitWith(ONE, 'W2', 'g1', 'bottom').root).toMatchObject({ kind: 'split', axis: 'column', sizes: [50, 50] });
  expect(applyLanding(ONE, 'W2', { kind: 'edge', group: 'g1', edge: 'right', share: 44 }).root).toMatchObject({ sizes: [56, 44] });
  expect(applyLanding(ONE, 'W2', { kind: 'edge', group: 'g1', edge: 'right' }).root).toMatchObject({ sizes: [50, 50] });
});

test('a stored diff tab of the commit scope reads back (#591)', () => {
  resetViewState();
  const layout = initialLayout({ kind: 'diff', scope: 'commit' });
  writeCenterLayouts({ I1: layout });
  expect(readCenterLayouts()).toEqual({ I1: layout });
});

test('retargetRef turns a tab into another in place; when the other is already open, the first closes and the other shows (#591)', () => {
  const layout = deepFreeze(openRef(ROW, DIFF));
  expect(tabsOf(retargetRef(layout, 'diff:worktree', { kind: 'diff', scope: 'commit' }))).toEqual([['W1'], ['W2', 'W3', 'diff:commit']]);
  const both = deepFreeze(openRef(layout, { kind: 'diff', scope: 'stage' }));
  const merged = retargetRef(both, 'diff:worktree', { kind: 'diff', scope: 'stage' });
  expect(tabsOf(merged)).toEqual([['W1'], ['W2', 'W3', 'diff:stage']]);
  expect(retargetRef(layout, 'diff:worktree', DIFF)).toBe(layout);
});

test('a stored PR tab, the activity\'s until #758, leaves its group on read: the rest stays, the tab before it shown; a group of it alone drops its layout (#592, #758)', () => {
  const pr = { kind: 'pr', url: 'https://github.com/acme/app/pull/7' };
  const stored = (tabs: unknown[], active: number) => ({ root: { kind: 'group', id: 'g1', tabs, active }, focused: 'g1' });
  writeView('centerLayouts', { I1: stored([{ kind: 'run', ptyId: 'W1' }, pr], 1), I2: stored([pr], 0) });
  expect(readCenterLayouts()).toEqual({ I1: { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }], active: 0 }, focused: 'g1' } });
});

const pane = (ptyId: string) => ({ kind: 'pane' as const, ptyId });
// W1's tab split: W1 beside W4, W4 focused (#641)
const PANES: Panes = { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), pane('W4')] }, focused: 'W4' };
const SPLIT_TAB: CenterTabRef = { kind: 'run', ptyId: 'W1', panes: PANES };
// ROW with g1's tab split into W1 and W4, g2 [W2, W3] focused
const PANED = deepFreeze<CenterLayout>({
  root: { kind: 'split', axis: 'row', children: [group('g1', [SPLIT_TAB]), group('g2', [run('W2'), run('W3')])], sizes: [40, 60] },
  focused: 'g2',
});
// The first tab of a layout's group
const tabOf = (layout: CenterLayout | undefined, index = 0): CenterTabRef | undefined => (layout === undefined ? undefined : groupsOf(layout.root)[index].tabs[0]);

test('a split tab round-trips under centerLayouts beside a layout stored before #641, which reads as it did; panes that break an invariant drop the layout (#641)', () => {
  resetViewState();
  writeCenterLayouts({ A: PANED, B: ROW });
  expect(readCenterLayouts()).toEqual({ A: PANED, B: ROW });
  const bad: unknown[] = [
    { root: group('g1', [{ kind: 'run', ptyId: 'W9', panes: PANES }]), focused: 'g1' }, // the anchor is no pane
    { root: group('g1', [SPLIT_TAB, run('W4')]), focused: 'g1' }, // W4 both a pane and a tab
    { root: group('g1', [{ kind: 'run', ptyId: 'W1', panes: { root: pane('W1'), focused: 'W1' } }]), focused: 'g1' }, // a single pane
    { root: group('g1', [{ kind: 'run', ptyId: 'W1', panes: { ...PANES, focused: 'W9' } }]), focused: 'g1' }, // the focus on no pane
  ];
  for (const entry of bad) expect(readStored({ good: ONE, bad: entry })).toEqual({ good: ONE });
});

test('opening a run that is a pane shows its tab and focuses that pane, with no tab added; shownRun is the focused pane\'s run; runsOf lists a tab\'s runs (#641)', () => {
  expect([runsOf(SPLIT_TAB), runsOf(run('W2')), runsOf(DIFF)]).toEqual([['W1', 'W4'], ['W2'], []]);
  expect(shownRun({ ...PANED, focused: 'g1' })).toBe('W4');
  const anchor = openRef(PANED, run('W1'));
  expect([anchor.focused, shownRun(anchor)]).toEqual(['g1', 'W1']);
  expect(tabsOf(anchor)).toEqual(tabsOf(PANED));
  const other = openRef(PANED, run('W4'));
  expect([other.focused, shownRun(other)]).toEqual(['g1', 'W4']);
  expect(tabsOf(other)).toEqual([['W1'], ['W2', 'W3']]);
});

test('prune drops a dead pane, its split collapsing; a dead anchor hands the tab and its key to the next pane; a tab with no live run goes (#641)', () => {
  expect(prune(PANED, new Set(['W1', 'W4', 'W2', 'W3']))).toBe(PANED);
  expect(tabOf(prune(PANED, new Set(['W1', 'W2', 'W3'])))).toEqual(run('W1'));
  const handed = prune(PANED, new Set(['W4', 'W2', 'W3']));
  expect(tabsOf(handed)).toEqual([['W4'], ['W2', 'W3']]);
  expect(tabOf(handed)).toEqual(run('W4'));
  const three: CenterTabRef = {
    kind: 'run', ptyId: 'W1', panes: { root: { kind: 'split', axis: 'row', sizes: [50, 25, 25], children: [pane('W1'), pane('W4'), pane('W5')] }, focused: 'W5' },
  };
  expect(tabOf(prune(initialLayout(three), new Set(['W4', 'W5'])))).toEqual({
    kind: 'run', ptyId: 'W4', panes: { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W4'), pane('W5')] }, focused: 'W5' },
  });
  expect(tabsOf(prune(PANED, new Set(['W2', 'W3'])))).toEqual([['W2', 'W3']]);
  const all = { A: PANED };
  expect(pruneLayouts(all, { A: ['W1', 'W4', 'W2', 'W3'] })).toBe(all);
});

test('closeLeaf takes one run out: a pane of a split tab, or the tab of a run alone, an emptied group going; an unknown run leaves the layout (#641)', () => {
  expect(tabOf(closeLeaf(PANED, 'W4'))).toEqual(run('W1'));
  expect(tabsOf(closeLeaf(PANED, 'W1'))).toEqual([['W4'], ['W2', 'W3']]);
  expect(tabsOf(closeLeaf(PANED, 'W2'))).toEqual([['W1'], ['W3']]);
  expect(closeLeaf(PANED, 'W9')).toBe(PANED);
  expect(closeLeaf(initialLayout(run('W1')), 'W1')).toBeUndefined();
});

test('foldIntoPane moves a landed tab into the anchor tab\'s focused pane, half and half, the new pane focused and its tab shown; anything else leaves the layout (#641)', () => {
  const first = foldIntoPane(ROW, 'W1', 'W3', 'row'); // W3 landed in g2
  expect(tabsOf(first)).toEqual([['W1'], ['W2']]);
  expect(tabOf(first)).toEqual({ kind: 'run', ptyId: 'W1', panes: { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), pane('W3')] }, focused: 'W3' } });
  expect([first.focused, shownRun(first)]).toEqual(['g1', 'W3']);
  expect(first.root).toMatchObject({ sizes: [40, 60] });
  const nested = foldIntoPane(PANED, 'W1', 'W3', 'column'); // W4 is the focused pane: it is the one split
  expect(tabOf(nested)).toEqual({
    kind: 'run', ptyId: 'W1',
    panes: { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), { kind: 'split', axis: 'column', sizes: [50, 50], children: [pane('W4'), pane('W3')] }] }, focused: 'W3' },
  });
  const withDiff = openRef(ROW, DIFF);
  expect(foldIntoPane(ROW, 'W1', 'W1', 'row')).toBe(ROW);
  expect(foldIntoPane(ROW, 'W1', 'W9', 'row')).toBe(ROW);
  expect(foldIntoPane(withDiff, 'diff:worktree', 'W3', 'row')).toBe(withDiff);
  expect(foldIntoPane(withDiff, 'W1', 'diff:worktree', 'row')).toBe(withDiff);
  expect(foldIntoPane(PANED, 'W2', 'W1', 'row')).toBe(PANED); // a split tab never folds into another
});

test('changePanes focuses or resizes a split tab\'s panes and leaves any other tab; no pane function mutates the layout (#641)', () => {
  expect(shownRun({ ...changePanes(PANED, 'W1', (panes) => focusPane(panes, 'W1')), focused: 'g1' })).toBe('W1');
  expect(tabOf(changePanes(PANED, 'W1', (panes) => resizePanes(panes, [], [70, 30])))).toMatchObject({ panes: { root: { sizes: [70, 30] } } });
  expect(changePanes(PANED, 'W2', (panes) => focusPane(panes, 'W2'))).toEqual(PANED);
  const before = JSON.stringify(PANED);
  openRef(PANED, run('W4'));
  prune(PANED, new Set(['W4']));
  closeLeaf(PANED, 'W1');
  foldIntoPane(PANED, 'W1', 'W3', 'row');
  changePanes(PANED, 'W1', (panes) => resizePanes(panes, [], [70, 30]));
  expect(JSON.stringify(PANED)).toBe(before);
});


test('a file tab is keyed by its path, opens once, survives a prune and round-trips, a normalized absolute path too; a stored one with an empty, .. or unnormalized path drops its layout (#717, #697)', () => {
  const file: CenterTabRef = { kind: 'file', path: 'src/a.ts' };
  expect(refKey(file)).toBe('file:src/a.ts');
  const opened = deepFreeze(openRef(openRef(ONE, file), { kind: 'file', path: 'src/a.ts' }));
  expect(tabsOf(opened)).toEqual([['W1', 'W2', 'file:src/a.ts']]);
  expect(tabsOf(prune(opened, new Set()))).toEqual([['file:src/a.ts']]);
  writeCenterLayouts({ I1: opened });
  expect(readCenterLayouts()).toEqual({ I1: opened });
  const outside = initialLayout({ kind: 'file', path: '/docs-repo/plan.md' });
  writeCenterLayouts({ I1: outside });
  expect(readCenterLayouts()).toEqual({ I1: outside });
  for (const path of ['', '/', '../x.ts', 'src/../../x.ts', '/w/../x.ts', '/w//x.ts', '/w/./x.ts']) {
    writeCenterLayouts({ I1: initialLayout({ kind: 'file', path }) });
    expect(readCenterLayouts()).toEqual({});
  }
});

test('fileRefPath makes a click\'s path a tab\'s: relative to the folder when it lands inside it, else absolute and normalized; only an empty path, or one climbing out of no known folder, is none (#717, #697)', () => {
  expect(fileRefPath('./src//a.ts')).toBe('src/a.ts');
  expect(fileRefPath('/w/hive-1/src/a.ts', '/w/hive-1')).toBe('src/a.ts');
  expect(fileRefPath('docs/plans/../specs/s.md', '/w/hive-1')).toBe('docs/specs/s.md');
  expect(fileRefPath('/docs-repo/./plan.md', '/w/hive-1')).toBe('/docs-repo/plan.md');
  expect(fileRefPath('../docs-repo/plan.md', '/w/hive-1')).toBe('/w/docs-repo/plan.md');
  expect(fileRefPath('/w/hive-1/src/a.ts')).toBe('/w/hive-1/src/a.ts'); // no folder known: a local activity's
  expect(fileRefPath('../x.ts')).toBeUndefined();
  expect(fileRefPath('', '/w/hive-1')).toBeUndefined();
});

test('replaceRun hands a sleeping run\'s tab, or its pane, to the run that continues it, in place and focused as it was (#672)', () => {
  const layout: CenterLayout = { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'run', ptyId: 'W2' }], active: 1 }, focused: 'g1' };
  expect(replaceRun(layout, 'W2', 'W9')).toEqual({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'run', ptyId: 'W9' }], active: 1 }, focused: 'g1' });
  const split: CenterLayout = {
    root: { kind: 'group', id: 'g1', active: 0, tabs: [{ kind: 'run', ptyId: 'W1', panes: { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [{ kind: 'pane', ptyId: 'W1' }, { kind: 'pane', ptyId: 'W2' }] }, focused: 'W2' } }] },
    focused: 'g1',
  };
  expect(groupsOf(replaceRun(split, 'W2', 'W9').root)[0].tabs[0]).toEqual({
    kind: 'run', ptyId: 'W1', panes: { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [{ kind: 'pane', ptyId: 'W1' }, { kind: 'pane', ptyId: 'W9' }] }, focused: 'W9' },
  });
  expect(replaceRun(layout, 'nope', 'W9')).toEqual(layout);
});

test('isTabOpen finds a run as a tab or as a pane in any activity\'s layout (#672)', () => {
  const split: CenterLayout = {
    root: { kind: 'group', id: 'g1', active: 0, tabs: [{ kind: 'run', ptyId: 'W1', panes: { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [{ kind: 'pane', ptyId: 'W1' }, { kind: 'pane', ptyId: 'W2' }] }, focused: 'W1' } }] },
    focused: 'g1',
  };
  expect([isTabOpen({ I1: split }, 'W1'), isTabOpen({ I1: split }, 'W2'), isTabOpen({ I1: split }, 'W3'), isTabOpen({}, 'W1')]).toEqual([true, true, false, false]);
});

test('a preview tab is keyed apart from its file\'s editor tab, opens once, survives a prune and round-trips; a stored one with a .. path drops its layout (#697)', () => {
  const preview: CenterTabRef = { kind: 'preview', path: 'docs/spec.md' };
  expect(refKey(preview)).toBe('preview:docs/spec.md');
  const opened = deepFreeze(openRef(openRef(openRef(ONE, { kind: 'file', path: 'docs/spec.md' }), preview), { kind: 'preview', path: 'docs/spec.md' }));
  expect(tabsOf(opened)).toEqual([['W1', 'W2', 'file:docs/spec.md', 'preview:docs/spec.md']]);
  expect(tabsOf(prune(opened, new Set()))).toEqual([['file:docs/spec.md', 'preview:docs/spec.md']]);
  writeCenterLayouts({ I1: opened });
  expect(readCenterLayouts()).toEqual({ I1: opened });
  const outside = initialLayout({ kind: 'preview', path: '/docs-repo/plan.md' });
  writeCenterLayouts({ I1: outside });
  expect(readCenterLayouts()).toEqual({ I1: outside });
  writeCenterLayouts({ I1: initialLayout({ kind: 'preview', path: '../x.md' }) });
  expect(readCenterLayouts()).toEqual({});
});

const ONE_REF = (ref: CenterTabRef): CenterLayout => ({ root: { kind: 'group', id: 'g1', tabs: [ref], active: 0 }, focused: 'g1' });

test('withSessions writes each run\'s session on its tab; replaceRun keeps it as the new run takes the tab (#696)', () => {
  expect(withSessions(ONE_REF({ kind: 'run', ptyId: 'W1' }), { W1: 'S1' })).toEqual(ONE_REF({ kind: 'run', ptyId: 'W1', sessionId: 'S1' }));
  expect(withSessions(ONE_REF({ kind: 'run', ptyId: 'T1' }), {})).toEqual(ONE_REF({ kind: 'run', ptyId: 'T1' }));
  expect(replaceRun(ONE_REF({ kind: 'run', ptyId: 'W1', sessionId: 'S1' }), 'W1', 'W9')).toEqual(ONE_REF({ kind: 'run', ptyId: 'W9', sessionId: 'S1' }));
});

test('prune keeps a tab whose run is gone while its session sleeps, not once no session sleeps there; closeLeaf closes it (#696)', () => {
  const session = ONE_REF({ kind: 'run', ptyId: 'W1', sessionId: 'S1' });
  expect(prune(session, new Set(), new Set(['S1']))).toEqual(session);
  expect(prune(session, new Set(), new Set())).toBeUndefined();
  expect(closeLeaf(session, 'W1')).toBeUndefined();
});

test('a stored run tab keeps its sessionId, and pruneLayouts writes the sessions before the prune (#696)', () => {
  resetViewState({ centerLayouts: { I1: ONE_REF({ kind: 'run', ptyId: 'W1', sessionId: 'S1' }) } });
  expect(readCenterLayouts()).toEqual({ I1: ONE_REF({ kind: 'run', ptyId: 'W1', sessionId: 'S1' }) });
  const written = pruneLayouts({ I1: ONE_REF({ kind: 'run', ptyId: 'W1' }) }, { I1: ['W1'] }, { I1: { held: { W1: 'S1' }, sleeping: [] } });
  expect(written).toEqual({ I1: ONE_REF({ kind: 'run', ptyId: 'W1', sessionId: 'S1' }) });
  expect(pruneLayouts(written, { I1: [] }, { I1: { held: {}, sleeping: ['S1'] } })).toEqual(written);
});

test('a console tab is keyed by its channel, keeps channel and locked through the view state, and a stored one with a bad channel reads as the plain console (#755)', () => {
  const locked = consoleRef('stage:checks', true);
  expect(locked).toEqual({ kind: 'console', channel: 'stage:checks', locked: true });
  expect([refKey(locked), refKey(consoleRef('command:hive:test')), refKey(consoleRef())]).toEqual(['console:stage:checks', 'console:command:hive:test', 'console']);
  const layout = openRef(openRef(ONE, consoleRef('command:hive:test')), locked);
  const stored = readStored({ A: layout }).A;
  expect(groupsOf(stored.root)[0].tabs.slice(2)).toEqual([{ kind: 'console', channel: 'command:hive:test' }, locked]);
  const bad = { root: group('g1', [{ kind: 'console', channel: 7, locked: true } as unknown as CenterTabRef]), focused: 'g1' };
  expect(groupsOf(readStored({ A: bad }).A.root)[0].tabs).toEqual([{ kind: 'console' }]);
  expect(tabsOf(retargetRef(layout, 'console:command:hive:test', consoleRef('setup')))).toEqual([['W1', 'W2', 'console:setup', 'console:stage:checks']]);
});

test('withStageConsole adds a locked console tab of one stage execution at the end of the first group, shown, the focus kept; makes a layout around it when there is none; leaves one already on that channel and run (#755)', () => {
  const tab = consoleRef('stage:checks', true, 'R1');
  expect(tab).toEqual({ kind: 'console', channel: 'stage:checks', locked: true, run: 'R1' });
  expect(withStageConsole(undefined, 'stage:checks', 'R1')).toEqual(initialLayout(tab));
  const added = withStageConsole(ROW, 'stage:checks', 'R1');
  expect(tabsOf(added)).toEqual([['W1', 'console:stage:checks#R1'], ['W2', 'W3']]);
  expect([groupsOf(added.root)[0].active, added.focused]).toEqual([1, 'g2']);
  expect(withStageConsole(added, 'stage:checks', 'R1')).toBe(added);
  expect(tabsOf(withStageConsole(added, 'stage:checks', 'R2'))).toEqual([['W1', 'console:stage:checks#R1', 'console:stage:checks#R2'], ['W2', 'W3']]); // a later execution is a tab of its own
  expect(readStored({ A: added }).A).toEqual(added); // the run is saved with the layout
});

test('a changes tab is keyed apart from its file\'s editor tab, opens once, survives a prune and round-trips; a stored one with an empty, .. or unnormalized path drops its layout; sharesBuffer tells either tab the other holds the buffer (#668)', () => {
  const changes: CenterTabRef = { kind: 'changes', path: 'src/a.ts' };
  const file: CenterTabRef = { kind: 'file', path: 'src/a.ts' };
  expect(refKey(changes)).toBe('changes:src/a.ts');
  const opened = deepFreeze(openRef(openRef(openRef(ONE, file), changes), { kind: 'changes', path: 'src/a.ts' }));
  expect(tabsOf(opened)).toEqual([['W1', 'W2', 'file:src/a.ts', 'changes:src/a.ts']]);
  expect(tabsOf(prune(opened, new Set()))).toEqual([['file:src/a.ts', 'changes:src/a.ts']]);
  writeCenterLayouts({ I1: opened });
  expect(readCenterLayouts()).toEqual({ I1: opened });
  for (const path of ['', '../x.ts', '/w/../x.ts']) {
    writeCenterLayouts({ I1: initialLayout({ kind: 'changes', path }) });
    expect(readCenterLayouts()).toEqual({});
  }
  expect([sharesBuffer(opened, changes), sharesBuffer(opened, file), sharesBuffer(ONE, changes), sharesBuffer(opened, run('W1')), sharesBuffer(undefined, file)]).toEqual([true, true, false, false, false]);
});
