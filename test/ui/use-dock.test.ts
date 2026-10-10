import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { useDock } from '@/hooks/use-dock';
import { DEFAULT_DOCK_LAYOUT, inEveryView, readDockLayout } from '@/lib/dock-layout';
import { resetViewState } from '@/lib/view-state';
import type { SidebarsPerView } from '../../src/types';

const PER_VIEW: SidebarsPerView = { left: true, right: true, rightTab: true };
const SHARED: SidebarsPerView = { left: false, right: false, rightTab: false };

afterEach(() => resetViewState()); // drops the layout's pending post

test('show on a closed side makes the panel the side\'s active tab and leaves the side closed (#612)', () => {
  resetViewState({ dockLayout: { ...DEFAULT_DOCK_LAYOUT, open: inEveryView({ left: false, right: false }) } });
  const { result } = renderHook(() => useDock(SHARED));
  act(() => result.current.show('activities'));
  expect(result.current.layout.open).toEqual({ left: false, right: false });
  expect(result.current.active).toEqual({ left: 'activities' });
});

test('show on the active tab of an open side keeps the same state (#612)', () => {
  resetViewState();
  const { result } = renderHook(() => useDock(SHARED));
  act(() => result.current.activate('activities'));
  const before = result.current;
  act(() => result.current.show('activities'));
  expect(result.current.layout).toBe(before.layout);
  expect(result.current.active).toBe(before.active);
});

test('the dock starts on the activities view (#746); with the left kept per view, closing it in the activities leaves the flow\'s open, and back it is closed again (#821)', () => {
  resetViewState();
  const { result } = renderHook(() => useDock(PER_VIEW));
  expect(result.current.view).toBe('activities');
  act(() => result.current.close('left'));
  act(() => result.current.setView('automation'));
  expect(result.current.layout.open.left).toBe(true);
  act(() => result.current.setView('activities'));
  expect(result.current.layout.open.left).toBe(false);
  expect(readDockLayout().open).toEqual({ activities: { left: false, right: false }, automation: { left: true, right: false } });
});

test('with the left shared, a toggle changes both views (#821)', () => {
  resetViewState();
  const { result } = renderHook(() => useDock(SHARED));
  act(() => result.current.toggle('left'));
  act(() => result.current.setView('automation'));
  expect(result.current.layout.open.left).toBe(false);
  expect(readDockLayout().open).toEqual(inEveryView({ left: false, right: false }));
});

test('turning the right setting off copies the current view\'s right side, open flag and width, to the other view at once (#821)', () => {
  resetViewState();
  const { result, rerender } = renderHook(({ perView }) => useDock(perView), { initialProps: { perView: PER_VIEW } });
  act(() => result.current.setView('automation'));
  act(() => result.current.activate('detail'));
  act(() => result.current.resize('right', 45));
  expect(readDockLayout().open.activities.right).toBe(false); // per view: the activities' right untouched so far
  rerender({ perView: { ...PER_VIEW, right: false } });
  const stored = readDockLayout();
  expect([stored.open.activities.right, stored.sizes.activities.right]).toEqual([true, 45]);
  expect(stored.sizes.activities.left).toBe(30); // the left side is not synced
});
