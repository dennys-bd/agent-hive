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
  expect(headerColumns(layout({ left: 30, right: 30 }), true)).toEqual({
    left: 'calc(44px + (100% - 44px) * 30 / 100)',
    right: 'calc((100% - 44px) * 30 / 100)',
  });
});

test('after a resize both columns follow the groups (#221)', () => {
  expect(headerColumns(layout({ left: 45, right: 20 }), true)).toEqual({
    left: 'calc(44px + (100% - 44px) * 45 / 100)',
    right: 'calc((100% - 44px) * 20 / 100)',
  });
});

test('a collapsed left side leaves the left column to its content; a right column not shown takes no width (#221)', () => {
  expect(headerColumns(layout({ left: 30, right: 30 }, { left: false, right: true }), true)).toEqual({ left: undefined, right: 'calc((100% - 44px) * 30 / 100)' });
  expect(headerColumns(layout({ left: 30, right: 30 }), false)).toEqual({ left: 'calc(44px + (100% - 44px) * 30 / 100)', right: undefined });
});
