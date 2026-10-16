import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { fitPercent, stepPercent, useDesignZoom, wheelPercent, ZOOM_MAX, ZOOM_MIN } from '@/hooks/use-design-zoom';

const NO_BOX = { current: null };

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// A canvas 672 px wide (a 50 % fit at 1280) whose scroll the tests read back
function canvasOf(): HTMLDivElement {
  const canvas = document.createElement('div');
  Object.defineProperty(canvas, 'clientWidth', { value: 672 });
  Object.defineProperty(canvas, 'scrollLeft', { value: 0, writable: true });
  Object.defineProperty(canvas, 'scrollTop', { value: 0, writable: true });
  document.body.append(canvas);
  return canvas;
}

const wheelOn = (canvas: HTMLElement) => (init: WheelEventInit): boolean => {
  let isKept = true;
  act(() => { isKept = canvas.dispatchEvent(new WheelEvent('wheel', { cancelable: true, ...init })); });
  return isKept;
};

test('the fit is the canvas less 32 px over the frame, in whole points, never above 100 nor under 10; a step is 10 points within 10–200 (#109)', () => {
  expect([fitPercent(672, 1280), fitPercent(672, 768), fitPercent(672, 390), fitPercent(40, 1280)]).toEqual([50, 83, 100, ZOOM_MIN]);
  expect([stepPercent(50, 1), stepPercent(50, -1), stepPercent(15, -1), stepPercent(195, 1)]).toEqual([60, 40, ZOOM_MIN, ZOOM_MAX]);
});

test('wheelPercent: a pinch\'s deltas summing to −100 × ln 1.5 take 100 to 150; one deltaY counts at most 10; the result stays within 10–200 (#346)', () => {
  const pinch = Array.from({ length: 16 }, () => (-100 * Math.log(1.5)) / 16);
  expect(pinch.reduce((zoom, deltaY) => wheelPercent(zoom, deltaY), 100)).toBeCloseTo(150, 6);
  expect(wheelPercent(100, 100)).toBeCloseTo(100 * Math.exp(-0.1), 6); // a mouse notch: about −10 %
  expect(wheelPercent(100, -100)).toBeCloseTo(100 * Math.exp(0.1), 6);
  expect([wheelPercent(195, -10), wheelPercent(10.5, 10)]).toEqual([ZOOM_MAX, ZOOM_MIN]);
});

test('the hook starts at the fit; ⌘ or Ctrl + wheel and a pinch zoom it by e^(−deltaY / 100) and keep the page from zooming; a plain wheel only scrolls (#109, #346)', () => {
  const canvas = canvasOf();
  const ref = { current: canvas };
  const { result } = renderHook(() => useDesignZoom(ref, NO_BOX, 1280, true));
  expect(result.current.zoom).toBe(50);
  const wheel = wheelOn(canvas);
  expect(wheel({ deltaY: -100 })).toBe(true);
  expect(result.current.zoom).toBe(50);
  expect(wheel({ deltaY: -100, ctrlKey: true })).toBe(false); // held to 10: 50 × e^0.1 = 55.26
  expect(result.current.zoom).toBe(55);
  wheel({ deltaY: -3, metaKey: true }); // 56.94
  expect(result.current.zoom).toBe(57);
  wheel({ deltaY: 2, ctrlKey: true }); // 55.81
  expect(result.current.zoom).toBe(56);
});

test('small wheel deltas add up instead of rounding away, and a step after them starts from the shown whole value (#346)', () => {
  const canvas = canvasOf();
  const ref = { current: canvas };
  const { result } = renderHook(() => useDesignZoom(ref, NO_BOX, 1280, true));
  const wheel = wheelOn(canvas);
  for (let i = 0; i < 10; i += 1) wheel({ deltaY: -0.5, ctrlKey: true }); // alone, each is 50 → 50.25, which rounds back to 50
  expect(result.current.zoom).toBe(53); // 50 × e^0.05 = 52.56
  act(() => result.current.zoomBy(1));
  expect(result.current.zoom).toBe(63);
  wheel({ deltaY: 0.7, ctrlKey: true }); // from 63: 62.56, still 63; from an unrounded 62.56 it would be 62.12
  expect(result.current.zoom).toBe(63);
});

test('a ⌘ wheel or zoomAt keeps the frame point under the same client point: the canvas scrolls by where the box lays out after the zoom (#346)', () => {
  const canvas = canvasOf();
  const box = document.createElement('div');
  canvas.append(box);
  // jsdom lays nothing out: the box sits at (100, 50) in the window, less the canvas's scroll
  vi.spyOn(box, 'getBoundingClientRect').mockImplementation(() => ({ left: 100 - canvas.scrollLeft, top: 50 - canvas.scrollTop }) as DOMRect);
  const refs = { canvas: { current: canvas }, box: { current: box } };
  const { result } = renderHook(() => useDesignZoom(refs.canvas, refs.box, 1280, true));
  const underCursor = (): [number, number] => {
    const scale = result.current.zoom / 100;
    const rect = box.getBoundingClientRect();
    return [rect.left + 200 * scale, rect.top + 100 * scale];
  };
  // At 50 % the frame point (200, 100) is at the client point (200, 100)
  wheelOn(canvas)({ deltaY: -10, ctrlKey: true, clientX: 200, clientY: 100 });
  expect(result.current.zoom).toBe(55);
  expect(canvas.scrollLeft).toBeCloseTo(10, 6); // 100 + 200 × 0.55 − 200
  expect(canvas.scrollTop).toBeCloseTo(5, 6); // 50 + 100 × 0.55 − 100
  act(() => result.current.zoomAt(-10, { x: 200, y: 100, clientX: 200, clientY: 100 }));
  expect(result.current.zoom).toBe(61);
  const [x, y] = underCursor();
  expect(x).toBeCloseTo(200, 6);
  expect(y).toBeCloseTo(100, 6);
});

test('startPan begins at the first move and scrolls with the next ones; pointerup, pointercancel or a window blur ends it, and isDragging is true only in between (#346)', () => {
  const canvas = canvasOf();
  const ref = { current: canvas };
  const { result } = renderHook(() => useDesignZoom(ref, NO_BOX, 1280, false));
  expect(result.current.isDragging).toBe(false);
  for (const end of ['pointerup', 'pointercancel', 'blur'] as const) {
    canvas.scrollLeft = 100;
    canvas.scrollTop = 50;
    act(() => result.current.startPan());
    expect(result.current.isDragging).toBe(true);
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 }); // the start: no scroll yet
    expect([canvas.scrollLeft, canvas.scrollTop]).toEqual([100, 50]);
    fireEvent.pointerMove(window, { clientX: 280, clientY: 290 });
    expect([canvas.scrollLeft, canvas.scrollTop]).toEqual([120, 60]);
    act(() => { window.dispatchEvent(new Event(end)); });
    expect(result.current.isDragging).toBe(false);
    fireEvent.pointerMove(window, { clientX: 0, clientY: 0 });
    expect([canvas.scrollLeft, canvas.scrollTop]).toEqual([120, 60]);
  }
});

test('a pan started while one is under way ends the first: one set of window listeners, the new drag alone scrolls (#346)', () => {
  const canvas = canvasOf();
  const ref = { current: canvas };
  const { result } = renderHook(() => useDesignZoom(ref, NO_BOX, 1280, false));
  const added = vi.spyOn(window, 'addEventListener');
  const removed = vi.spyOn(window, 'removeEventListener');
  act(() => result.current.startPan());
  fireEvent.pointerMove(window, { clientX: 300, clientY: 300 });
  act(() => result.current.startPan());
  expect(removed).toHaveBeenCalledWith('pointermove', expect.any(Function));
  expect(added.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(2);
  fireEvent.pointerMove(window, { clientX: 500, clientY: 500 }); // the second pan's start
  fireEvent.pointerMove(window, { clientX: 490, clientY: 500 });
  expect([canvas.scrollLeft, canvas.scrollTop]).toEqual([10, 0]);
  act(() => { window.dispatchEvent(new Event('pointerup')); });
  expect(result.current.isDragging).toBe(false);
});

test('a pane behind another tab measures nothing and waits: it fits once it shows (#109)', () => {
  const canvas = document.createElement('div');
  let width = 0;
  Object.defineProperty(canvas, 'clientWidth', { get: () => width });
  const ref = { current: canvas };
  const { result, rerender } = renderHook(({ shown }) => useDesignZoom(ref, NO_BOX, 1280, shown), { initialProps: { shown: false } });
  expect(result.current.zoom).toBe(100);
  width = 672;
  rerender({ shown: true });
  expect(result.current.zoom).toBe(50);
});
