import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { fitPercent, stepPercent, useDesignZoom, ZOOM_MAX, ZOOM_MIN } from '@/hooks/use-design-zoom';

test('the fit is the canvas less 32 px over the frame, in whole points, never above 100 nor under 10; a step is 10 points within 10–200 (#109)', () => {
  expect([fitPercent(672, 1280), fitPercent(672, 768), fitPercent(672, 390), fitPercent(40, 1280)]).toEqual([50, 83, 100, ZOOM_MIN]);
  expect([stepPercent(50, 1), stepPercent(50, -1), stepPercent(15, -1), stepPercent(195, 1)]).toEqual([60, 40, ZOOM_MIN, ZOOM_MAX]);
});

test('the hook starts at the fit; ⌘ or Ctrl + wheel and a pinch step it and keep the page from zooming; a plain wheel only scrolls (#109)', () => {
  const canvas = document.createElement('div');
  Object.defineProperty(canvas, 'clientWidth', { value: 672 });
  document.body.append(canvas);
  const ref = { current: canvas };
  const { result } = renderHook(() => useDesignZoom(ref, 1280, true));
  expect(result.current.zoom).toBe(50);
  const wheel = (init: WheelEventInit): boolean => {
    let isKept = true;
    act(() => { isKept = canvas.dispatchEvent(new WheelEvent('wheel', { cancelable: true, ...init })); });
    return isKept;
  };
  expect(wheel({ deltaY: -100 })).toBe(true);
  expect(result.current.zoom).toBe(50);
  expect(wheel({ deltaY: -100, ctrlKey: true })).toBe(false); // a pinch: Chromium sends it as a wheel with ctrlKey
  wheel({ deltaY: -3, metaKey: true });
  expect(result.current.zoom).toBe(70);
  wheel({ deltaY: 2, ctrlKey: true });
  expect(result.current.zoom).toBe(60);
  canvas.remove();
});

test('a pane behind another tab measures nothing and waits: it fits once it shows (#109)', () => {
  const canvas = document.createElement('div');
  let width = 0;
  Object.defineProperty(canvas, 'clientWidth', { get: () => width });
  const ref = { current: canvas };
  const { result, rerender } = renderHook(({ shown }) => useDesignZoom(ref, 1280, shown), { initialProps: { shown: false } });
  expect(result.current.zoom).toBe(100);
  width = 672;
  rerender({ shown: true });
  expect(result.current.zoom).toBe(50);
});
