import { expect, test } from 'vitest';
import { applyLanding, type DropGroup, landingOf } from '@/components/center-drag';
import { type CenterLayout, groupsOf, refKey } from '@/lib/center-layout';

const box = (left: number, top: number, right: number, bottom: number): DOMRect =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
// Two groups side by side, 400 wide each: g1's strip holds W1 and W2 (100px each) over a 400px body; g2 at x 400..800 holds W3
const GROUPS: DropGroup[] = [
  { id: 'g1', strip: box(0, 0, 400, 30), body: box(0, 30, 400, 430), tabs: [{ key: 'W1', rect: box(0, 0, 100, 30) }, { key: 'W2', rect: box(100, 0, 200, 30) }] },
  { id: 'g2', strip: box(400, 0, 800, 30), body: box(400, 30, 800, 430), tabs: [{ key: 'W3', rect: box(400, 0, 500, 30) }] },
];
const W1 = { key: 'W1', group: 'g1' };

test('in a strip: tab-drag\'s half-box rule across the tabs, the end past them, in its own group or another (#458)', () => {
  expect(landingOf(GROUPS, 160, 10, W1)).toEqual({ kind: 'strip', group: 'g1', target: 'end' });
  expect(landingOf(GROUPS, 420, 10, W1)).toEqual({ kind: 'strip', group: 'g2', target: 'W3' });
  expect(landingOf(GROUPS, 460, 10, W1)).toEqual({ kind: 'strip', group: 'g2', target: 'end' });
});

test('on a group\'s body: the nearest edge within a quarter of it, else its middle (#458)', () => {
  const at = (x: number, y: number) => landingOf(GROUPS, x, y, W1);
  expect([at(420, 230), at(780, 230), at(600, 50), at(600, 410)]).toEqual(['left', 'right', 'top', 'bottom'].map((edge) => ({ kind: 'edge', group: 'g2', edge })));
  expect(at(600, 230)).toEqual({ kind: 'middle', group: 'g2' });
  expect(at(10, 400)).toEqual({ kind: 'edge', group: 'g1', edge: 'left' }); // its own group, which holds another tab too
});

test('a landing that moves nothing is none: its own place in its strip, its own group\'s middle, an edge of a group it is alone in, or outside every group (#458)', () => {
  expect(landingOf(GROUPS, 40, 10, W1)).toBeUndefined(); // before itself
  expect(landingOf(GROUPS, 120, 10, W1)).toBeUndefined(); // before the tab right after it
  expect(landingOf(GROUPS, 200, 230, W1)).toBeUndefined(); // its own group's middle
  expect(landingOf(GROUPS, 780, 230, { key: 'W3', group: 'g2' })).toBeUndefined(); // alone in g2
  expect(landingOf(GROUPS, 900, 500, W1)).toBeUndefined();
});

test('applyLanding: a strip or a middle moves the tab there, an edge splits that group with the tab on that side (#458)', () => {
  const layout: CenterLayout = {
    root: {
      kind: 'split', axis: 'row', sizes: [50, 50], children: [
        { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'run', ptyId: 'W2' }], active: 0 },
        { kind: 'group', id: 'g2', tabs: [{ kind: 'run', ptyId: 'W3' }], active: 0 },
      ],
    },
    focused: 'g1',
  };
  const tabs = (next: CenterLayout): string[][] => groupsOf(next.root).map((group) => group.tabs.map(refKey));
  expect(tabs(applyLanding(layout, 'W1', { kind: 'strip', group: 'g2', target: 'W3' }))).toEqual([['W2'], ['W1', 'W3']]);
  expect(tabs(applyLanding(layout, 'W1', { kind: 'strip', group: 'g1', target: 'end' }))).toEqual([['W2', 'W1'], ['W3']]);
  expect(tabs(applyLanding(layout, 'W1', { kind: 'middle', group: 'g2' }))).toEqual([['W2'], ['W3', 'W1']]);
  const split = applyLanding(layout, 'W1', { kind: 'edge', group: 'g2', edge: 'bottom' });
  expect(tabs(split)).toEqual([['W2'], ['W3'], ['W1']]);
  expect(split.root).toMatchObject({ axis: 'row', children: [{ id: 'g1' }, { kind: 'split', axis: 'column' }] });
});
