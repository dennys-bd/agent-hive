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

test('anchoredScroll keeps the point at the anchor where it was, the centre being half the viewport, never scrolling before the start (#910, #81)', () => {
  expect(anchoredScroll(100, 200, 1, 2)).toBe(400); // a 400 px viewport's centre: the chart's 300 before and after
  expect(anchoredScroll(400, 200, 2, 1)).toBe(100);
  expect(anchoredScroll(0, 200, 1, 1)).toBe(0);
  const next = anchoredScroll(100, 50, 1, 2); // off-centre: the pointer 50 px into the pane
  expect(next).toBe(250);
  expect((100 + 50) / 1).toBe((next + 50) / 2); // the content point under the anchor is the same before and after
  expect(anchoredScroll(300, 350, 1.5, 1)).toBeCloseTo(650 / 1.5 - 350);
  expect(anchoredScroll(0, 300, 1, 0.5)).toBe(0); // (0 + 300) × 0.5 − 300 is −150: the pane cannot scroll there
});
