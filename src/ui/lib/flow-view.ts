// The flowchart's view (#909, #571): the loops toggle, the tree toggle (#34) and the details' collapsed outline parents (#36), one value each and
// shared by every flowchart, and per flow, by name, its canvas: the zoom and pan #910 applies and the collapsed groups of #34. Per-viewer UI
// state kept in the view state (#484), never a setting. Each field is read on its own, so an unreadable zoom never resets the toggle. A value
// stored before #571 (zoom, pan, collapsed at the top) keeps its shared fields and starts every flow at the defaults: no migration, one user.
import { ZOOM_MAX, ZOOM_MIN } from './flow-zoom.js';
import { readView, writeView } from './view-state.js';

/** One flowchart's canvas (#910, #34): collapsed holds one `<stage>\u0000<root itemId | none>` key each. */
export interface FlowCanvas { zoom: number; pan: { x: number; y: number }; collapsed: string[] }
export interface FlowView {
  loops: boolean;
  tree?: boolean; // #34: unset until the first click, read as "a tree exists" meanwhile
  outline: string[]; // #36: the details' collapsed outline parents; only toggleOutline writes it
  canvas: Record<string, FlowCanvas>; // #571: by flow name
}
/** What Flow reads (#571): the shared fields with the shown flow's canvas, so `view.zoom` reads as before. */
export type ShownFlowView = Omit<FlowView, 'canvas'> & FlowCanvas;

export const CANVAS_DEFAULTS: FlowCanvas = { zoom: 1, pan: { x: 0, y: 0 }, collapsed: [] };
export const FLOW_VIEW_DEFAULTS: FlowView = { loops: true, outline: [], canvas: {} };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const freshCanvas = (): FlowCanvas => ({ ...CANVAS_DEFAULTS, pan: { ...CANVAS_DEFAULTS.pan }, collapsed: [] }); // a copy: a caller's edit never reaches the defaults

function readPan(value: unknown): FlowCanvas['pan'] {
  const pan = isRecord(value) ? value : {};
  return { x: finiteOr(pan.x, CANVAS_DEFAULTS.pan.x), y: finiteOr(pan.y, CANVAS_DEFAULTS.pan.y) };
}

// #34, #36: stale keys stay as they are; a key whose stage, root or parent is gone matches nothing
const readIds = (value: unknown): string[] => (Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);

function readCanvas(value: unknown): FlowCanvas {
  if (!isRecord(value)) return freshCanvas();
  const zoom = finiteOr(value.zoom, CANVAS_DEFAULTS.zoom);
  return { zoom: zoom >= ZOOM_MIN && zoom <= ZOOM_MAX ? zoom : CANVAS_DEFAULTS.zoom, pan: readPan(value.pan), collapsed: readIds(value.collapsed) };
}

const readCanvases = (value: unknown): Record<string, FlowCanvas> =>
  (isRecord(value) ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, readCanvas(entry)])) : {});

/** The stored flowView, field by field and canvas by canvas: a field that fails falls back to its default alone; a value that is no plain object reads as the defaults. */
export function readFlowView(): FlowView {
  const stored = readView('flowView');
  if (!isRecord(stored)) return { loops: FLOW_VIEW_DEFAULTS.loops, outline: [], canvas: {} };
  return {
    loops: typeof stored.loops === 'boolean' ? stored.loops : FLOW_VIEW_DEFAULTS.loops,
    ...(typeof stored.tree === 'boolean' ? { tree: stored.tree } : {}), // #34: absent, not undefined, until the first click
    outline: readIds(stored.outline),
    canvas: readCanvases(stored.canvas),
  };
}

/** The whole value, so the zoom and pan (#910), the toggles and the other flows' canvases never overwrite one another. */
export function writeFlowView(view: FlowView): void {
  writeView('flowView', view);
}

/** A flow's canvas, the defaults for a name with none yet. hasOwn: a flow named like an Object method is no entry. */
export function canvasOf(view: FlowView, flow: string): FlowCanvas {
  return Object.hasOwn(view.canvas, flow) ? view.canvas[flow] : freshCanvas();
}

export function shownOf(view: FlowView, flow: string): ShownFlowView {
  const { canvas: _canvas, ...shared } = view; // the canvases stay in the store; Flow reads its own one
  return { ...shared, ...canvasOf(view, flow) };
}

/** `stored` with the shared fields and `flow`'s canvas taken from `shown`; the outline and every other canvas stay as stored (#36, #571). */
export function withShown(stored: FlowView, flow: string, shown: ShownFlowView): FlowView {
  const { loops, tree, zoom, pan, collapsed } = shown;
  return { loops, ...(tree === undefined ? {} : { tree }), outline: stored.outline, canvas: { ...stored.canvas, [flow]: { zoom, pan, collapsed } } };
}


/** Collapses or expands one parent of the details' outline (#36): reads the stored view, flips the id in `outline`, writes the whole value back
 * and returns the new list. The flow's fields go back as stored, so a zoom or a pan is never undone. */
export function toggleOutline(itemId: string): string[] {
  const view = readFlowView();
  const outline = view.outline.includes(itemId) ? view.outline.filter((id) => id !== itemId) : [...view.outline, itemId];
  writeFlowView({ ...view, outline });
  return outline;
}
