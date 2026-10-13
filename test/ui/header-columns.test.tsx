import { expect, test } from 'vitest';
import { RAIL_WIDTH } from '@/components/ViewRail';
import type { Side, ViewLayout } from '@/lib/dock-layout';
import { headerColumns } from '@/lib/header-columns';

// The dock's sizes are percent of the frame alone (DockFrame's measure); the header spans the rail plus the frame
const layout = (sizes: Record<Side, number>, open: Record<Side, boolean> = { left: true, right: true }): ViewLayout =>
  ({ docks: { automation: 'left', activities: 'left', detail: 'right' }, sizes, open });

test('the rail is the 44px the left column adds to its share of the frame (#221)', () => {
  expect(RAIL_WIDTH).toBe(44);
});

test('at the default sizes the left column spans the rail and the left group, the right column the right group (#221)', () => {
  expect(headerColumns(layout({ left: 30, right: 30 }), true, false)).toEqual({
    left: 'calc(44px + (100% - 44px) * 30 / 100)',
    right: 'calc((100% - 44px) * 30 / 100)',
  });
});

test('after a resize both columns follow the groups (#221)', () => {
  expect(headerColumns(layout({ left: 45, right: 20 }), true, false)).toEqual({
    left: 'calc(44px + (100% - 44px) * 45 / 100)',
    right: 'calc((100% - 44px) * 20 / 100)',
  });
});

test('a collapsed left side leaves the window buttons\' 92px block in a window and the rail\'s 44px in full screen; a right column not shown takes no width (#221, #295)', () => {
  const closed = layout({ left: 30, right: 30 }, { left: false, right: true });
  expect(headerColumns(closed, true, false)).toEqual({ left: '92px', right: 'calc((100% - 44px) * 30 / 100)' });
  expect(headerColumns(closed, true, true)).toEqual({ left: '44px', right: 'calc((100% - 44px) * 30 / 100)' });
  expect(headerColumns(layout({ left: 30, right: 30 }), false, false)).toEqual({ left: 'calc(44px + (100% - 44px) * 30 / 100)', right: undefined });
});

test('open, the left column is the same calc in a window and in full screen: only its inset changes, in CSS (#295)', () => {
  expect(headerColumns(layout({ left: 45, right: 20 }), true, true)).toEqual(headerColumns(layout({ left: 45, right: 20 }), true, false));
});
