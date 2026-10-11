// The flowchart's view (#909): the loops toggle, the zoom and pan #910 applies, the tree toggle and collapsed groups of #34, and the details' collapsed outline parents of #36. Per-viewer UI state kept in the view
// state (#484), never a setting. One flat value: there is one flowchart today, and a key per flowchart can wrap it when tabs per flowchart arrive. Each field is read
// on its own, so an unreadable zoom never resets the toggle.
import { ZOOM_MAX, ZOOM_MIN } from './flow-zoom.js';
import { readView, writeView } from './view-state.js';

export interface FlowView {
  loops: boolean; zoom: number; pan: { x: number; y: number };
  tree?: boolean; // #34: the tree toggle; unset until the first click, read as "a tree exists" meanwhile
  collapsed: string[]; // #34: the collapsed groups, one `<stage>\u0000<root itemId | none>` key each
  outline: string[]; // #36: the details' collapsed outline parents, one itemId each; only toggleOutline writes it
}

export const FLOW_VIEW_DEFAULTS: FlowView = { loops: true, zoom: 1, pan: { x: 0, y: 0 }, collapsed: [], outline: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function readPan(value: unknown): FlowView['pan'] {
  const pan = isRecord(value) ? value : {};
  return { x: finiteOr(pan.x, FLOW_VIEW_DEFAULTS.pan.x), y: finiteOr(pan.y, FLOW_VIEW_DEFAULTS.pan.y) };
}

// #34, #36: stale keys stay as they are; a key whose stage, root or parent is gone matches nothing
const readIds = (value: unknown): string[] => (Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);

/** The stored flowView, field by field: a field that fails falls back to its default alone; a value that is no plain object reads as the
 * defaults (loops on, zoom 1, pan 0, 0, no tree choice yet, nothing collapsed). */
export function readFlowView(): FlowView {
  const stored = readView('flowView');
  if (!isRecord(stored)) return { ...FLOW_VIEW_DEFAULTS, pan: { ...FLOW_VIEW_DEFAULTS.pan }, collapsed: [], outline: [] }; // a copy: a caller's edit never reaches the defaults
  const zoom = finiteOr(stored.zoom, FLOW_VIEW_DEFAULTS.zoom);
  return {
    loops: typeof stored.loops === 'boolean' ? stored.loops : FLOW_VIEW_DEFAULTS.loops,
    zoom: zoom >= ZOOM_MIN && zoom <= ZOOM_MAX ? zoom : FLOW_VIEW_DEFAULTS.zoom,
    pan: readPan(stored.pan),
    ...(typeof stored.tree === 'boolean' ? { tree: stored.tree } : {}), // #34: absent, not undefined, until the first click
    collapsed: readIds(stored.collapsed),
    outline: readIds(stored.outline),
  };
}

/** The whole value, so the zoom and pan (#910) and the toggle never overwrite one another. */
export function writeFlowView(view: FlowView): void {
  writeView('flowView', view);
}

/** Collapses or expands one parent of the details' outline (#36): reads the stored view, flips the id in `outline`, writes the whole value back
 * and returns the new list. The flow's fields go back as stored, so a zoom or a pan is never undone. */
export function toggleOutline(itemId: string): string[] {
  const view = readFlowView();
  const outline = view.outline.includes(itemId) ? view.outline.filter((id) => id !== itemId) : [...view.outline, itemId];
  writeFlowView({ ...view, outline });
  return outline;
}
