import { expect, test } from 'vitest';
import { closePane, focusPane, leavesOf, type PaneNode, type Panes, parsePanes, prunePanes, resizePanes, splitPane } from '@/lib/pane-split';

// Every fixture is frozen deep: a function that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const pane = (ptyId: string): PaneNode => ({ kind: 'pane', ptyId });
// W1 beside W3, half and half, W3 focused: what a first ⌘D gives
const PAIR = deepFreeze<Panes>({ root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), pane('W3')] }, focused: 'W3' });
// W1 beside a column of W3 over W4, W4 focused
const NESTED = deepFreeze<Panes>({
  root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), { kind: 'split', axis: 'column', sizes: [50, 50], children: [pane('W3'), pane('W4')] }] },
  focused: 'W4',
});

test('a first split is the tab\'s run beside the new one, half and half, the new pane focused; leavesOf reads the panes in order (#641)', () => {
  expect(splitPane(undefined, 'W1', 'W1', 'W3', 'row')).toEqual(PAIR);
  expect(splitPane(undefined, 'W1', 'W1', 'W3', 'column')).toEqual({ root: { kind: 'split', axis: 'column', sizes: [50, 50], children: [pane('W1'), pane('W3')] }, focused: 'W3' });
  expect(leavesOf(NESTED.root)).toEqual(['W1', 'W3', 'W4']);
});

test('a split on the focused pane\'s own axis flattens into its parent; across it nests (#641)', () => {
  expect(splitPane(PAIR, 'W1', 'W3', 'W4', 'row')).toEqual({ root: { kind: 'split', axis: 'row', sizes: [50, 25, 25], children: [pane('W1'), pane('W3'), pane('W4')] }, focused: 'W4' });
  expect(splitPane(PAIR, 'W1', 'W3', 'W4', 'column')).toEqual(NESTED);
});

test('a split at a run that is no pane, or with a run already a pane, changes nothing (#641)', () => {
  expect(splitPane(PAIR, 'W1', 'W9', 'W4', 'row')).toBe(PAIR);
  expect(splitPane(PAIR, 'W1', 'W1', 'W3', 'row')).toBe(PAIR);
  expect(splitPane(undefined, 'W1', 'W9', 'W3', 'row')).toBeUndefined();
});

test('closePane collapses the split around it, the focus moving to the first pane left when it was the one closed; one pane left is undefined (#641)', () => {
  expect(closePane(NESTED, 'W3')).toEqual({ root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), pane('W4')] }, focused: 'W4' });
  expect(closePane(NESTED, 'W4')).toEqual({ root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), pane('W3')] }, focused: 'W1' });
  expect(closePane(NESTED, 'W1')).toEqual({ root: { kind: 'split', axis: 'column', sizes: [50, 50], children: [pane('W3'), pane('W4')] }, focused: 'W4' });
  expect(closePane(PAIR, 'W3')).toBeUndefined();
});

test('focusPane moves the focus to a pane, and gives the same panes for a run that is none or already focused (#641)', () => {
  expect(focusPane(NESTED, 'W1').focused).toBe('W1');
  expect(focusPane(NESTED, 'W9')).toBe(NESTED);
  expect(focusPane(NESTED, 'W4')).toBe(NESTED);
});

test('resizePanes sets a split\'s sizes by its path, each held at 10% at least (#641)', () => {
  expect(resizePanes(PAIR, [], [5, 95]).root).toMatchObject({ sizes: [10, 90] });
  expect(resizePanes(NESTED, [1], [70, 30]).root).toMatchObject({ sizes: [50, 50], children: [pane('W1'), { sizes: [70, 30] }] });
});

test('prunePanes closes every pane whose run is no longer live; undefined once one pane or none is left (#641)', () => {
  expect(prunePanes(NESTED, (ptyId) => ptyId !== 'W3')).toEqual(closePane(NESTED, 'W3'));
  expect(prunePanes(NESTED, (ptyId) => ptyId === 'W1')).toBeUndefined();
  expect(prunePanes(NESTED, () => false)).toBeUndefined();
  expect(prunePanes(NESTED, () => true)).toBe(NESTED);
});

test('parsePanes reads back what was stored and refuses a run twice, a focus on no pane, a single pane and an empty run (#641)', () => {
  expect(parsePanes(JSON.parse(JSON.stringify(NESTED)))).toEqual(NESTED);
  const bad: unknown[] = [
    { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), pane('W1')] }, focused: 'W1' },
    { ...PAIR, focused: 'W9' },
    { root: pane('W1'), focused: 'W1' },
    { root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [pane('W1'), { kind: 'pane', ptyId: '' }] }, focused: 'W1' },
    { root: PAIR.root },
    'W1', null,
  ];
  for (const value of bad) expect(parsePanes(value)).toBeUndefined();
});
