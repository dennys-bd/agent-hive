// The flow canvas's zoom (#910): its bounds and the arithmetic of −, +, fit and the scroll that keeps a point in place. Pure, no DOM, so
// flowView's parse (#909) and the canvas share one range.
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.1;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
// Two decimals: 0.7 + 0.1 is 0.7999999999999999 in floating point, and the label and flowView want 0.8
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The next 10% grid value in `direction`, clamped to [ZOOM_MIN, ZOOM_MAX]: one step from a zoom on the grid; from one off it (after a fit),
 * the nearest multiple of 10% that way, so the label is round again. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const steps = zoom / ZOOM_STEP;
  const isOnGrid = Math.abs(steps - Math.round(steps)) < 1e-6;
  const next = isOnGrid ? Math.round(steps) + direction : direction === 1 ? Math.ceil(steps) : Math.floor(steps);
  return clamp(round2(next * ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
}

/** The zoom that shows the whole `graph` (the layout with every node at NODE_MIN) in `viewport`: never above 100%, never under ZOOM_MIN, where
 * a chart wider than twice the canvas stays scrollable. */
export function fitZoom(viewport: { width: number; height: number }, graph: { width: number; height: number }): number {
  const ratio = Math.min(viewport.width / graph.width, viewport.height / graph.height);
  return Number.isFinite(ratio) ? clamp(ratio, ZOOM_MIN, 1) : 1; // an empty or unmeasured chart: 0 / 0 is no zoom
}

/** The scroll offset on one axis that keeps the point `anchor` px into the viewport in place when the zoom goes `from` → `to`; never
 * before 0. The centre is `viewport / 2`. */
export function anchoredScroll(scroll: number, anchor: number, from: number, to: number): number {
  return Math.max(0, ((scroll + anchor) * to) / from - anchor);
}
