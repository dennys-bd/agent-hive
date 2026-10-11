import { expect, test } from 'vitest';
import { anchoredScroll, fitZoom, stepZoom, ZOOM_MAX, ZOOM_MIN } from '@/lib/flow-zoom';

test('stepZoom moves 10% on the grid, to the next 10% in its direction from off it, and stops at 50% and 150% (#910)', () => {
  expect([stepZoom(1, 1), stepZoom(1, -1)]).toEqual([1.1, 0.9]);
  expect([stepZoom(0.7, 1), stepZoom(0.8, -1), stepZoom(1.1, 1)]).toEqual([0.8, 0.7, 1.2]); // two decimals: 0.7 + 0.1 is no 0.7999…
  expect([stepZoom(0.73, 1), stepZoom(0.73, -1)]).toEqual([0.8, 0.7]); // after a fit
  expect([stepZoom(ZOOM_MIN, -1), stepZoom(ZOOM_MAX, 1)]).toEqual([0.5, 1.5]);
  expect([stepZoom(0.55, -1), stepZoom(1.45, 1)]).toEqual([0.5, 1.5]);
});

test('fitZoom is the largest zoom up to 100% that shows the whole chart, never under 50% (#910)', () => {
  const viewport = { width: 400, height: 300 };
  expect(fitZoom(viewport, { width: 800, height: 200 })).toBe(0.5); // twice the canvas's width
  expect(fitZoom(viewport, { width: 500, height: 200 })).toBe(0.8); // 1.25×
  expect(fitZoom(viewport, { width: 300, height: 200 })).toBe(1); // smaller than the canvas: never above 100%
  expect(fitZoom(viewport, { width: 2000, height: 200 })).toBe(0.5); // wider than twice: it stays scrollable at 50%
  expect(fitZoom(viewport, { width: 300, height: 375 })).toBe(0.8); // the height can be the tighter one
  expect(fitZoom({ width: 0, height: 0 }, { width: 500, height: 200 })).toBe(0.5); // a canvas not measured yet
});

test('anchoredScroll keeps the point at the viewport\'s centre where it was, never scrolling before the start (#910)', () => {
  expect(anchoredScroll(100, 400, 1, 2)).toBe(400); // the centre is the chart's 300 before and after: (100 + 200) / 1 = (400 + 200) / 2
  expect(anchoredScroll(400, 400, 2, 1)).toBe(100);
  expect(anchoredScroll(0, 400, 1, 1)).toBe(0);
  expect(anchoredScroll(0, 400, 1, 0.5)).toBe(0); // (0 + 200) × 0.5 − 200 is −100: the pane cannot scroll there
});
