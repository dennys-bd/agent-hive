import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useActivity } from '@/hooks/use-activity';
import { useDock } from '@/hooks/use-dock';
import { DEFAULT_DOCK_LAYOUT, inEveryView } from '@/lib/dock-layout';
import { resetViewState } from '@/lib/view-state';
import type { SidebarsPerView } from '../../src/types';

const PER_VIEW: SidebarsPerView = { left: true, right: true, rightTab: true };
const SHARED: SidebarsPerView = { left: false, right: false, rightTab: false };
// The dock and the selection as MainDock wires them (#821): the dock holds the view
const useBoth = (perView: SidebarsPerView) => {
  const dock = useDock(perView);
  return { dock, selection: useActivity([], vi.fn(), dock) };
};

test('the center starts on Atividades with nothing picked, the dock\'s view, so the window opens on Home (#746, #821)', () => {
  const { result } = renderHook(() => useBoth(SHARED));
  expect([result.current.selection.center, result.current.dock.view]).toEqual(['activities', 'activities']);
  expect(result.current.selection.current).toBeUndefined();
});

test('switching views sets the dock\'s view and shows the view\'s tab without opening a closed left side, per view or shared (#533, #821)', () => {
  for (const perView of [PER_VIEW, SHARED]) {
    resetViewState({ dockLayout: { ...DEFAULT_DOCK_LAYOUT, open: inEveryView({ left: false, right: false }) } });
    const { result, unmount } = renderHook(() => useBoth(perView));
    act(() => result.current.selection.activateTab('automation'));
    expect([result.current.selection.center, result.current.dock.view]).toEqual(['automation', 'automation']);
    expect(result.current.dock.layout.open.left).toBe(false);
    expect(result.current.dock.active).toEqual({ left: 'automation' }); // shown once the side is reopened (#612)
    act(() => result.current.selection.activateTab('activities'));
    expect(result.current.dock.layout.open.left).toBe(false);
    unmount();
  }
});

test('any other dock tab still activates: Detalhes opens its side and the view stays (#452, #821)', () => {
  resetViewState();
  const { result } = renderHook(() => useBoth(SHARED));
  act(() => result.current.selection.activateTab('detail'));
  expect(result.current.dock.layout.open.right).toBe(true);
  expect(result.current.selection.center).toBe('activities');
});
