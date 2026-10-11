// What the page knows of each activity's files tree (#818): its root, which GET /activities/:id/tree answers. The file opener resolves a
// path that climbs out of a local checkout against it. A root never changes for an activity, so it is read once and kept.
import type { TaskTree } from '../../types.js';
import { getJson } from './api.js';

const roots = new Map<string, string>(); // the page's cache, by activity id

/** The root an answer of the tree carried (useTaskTree). */
export const rememberRoot = (activityId: string, root: string): void => {
  roots.set(activityId, root);
};

/** The tree's root, absolute: the one remembered, else read from the tree route; undefined when the route refuses. */
export async function treeRootOf(activityId: string): Promise<string | undefined> {
  const known = roots.get(activityId);
  if (known !== undefined) return known;
  const tree = await getJson<TaskTree>(`/activities/${encodeURIComponent(activityId)}/tree`).catch(() => undefined);
  if (tree !== undefined) rememberRoot(activityId, tree.root);
  return tree?.root;
}

const events = new EventTarget(); // one target for every activity: each event's detail names its activity

/** A tree operation the server took (#818): the tree reads again now instead of at its next poll. */
export const treeChanged = (activityId: string): void => {
  events.dispatchEvent(new CustomEvent('changed', { detail: activityId }));
};

/** Calls `read` after each treeChanged of the activity; returns the unsubscribe. */
export function onTreeChanged(activityId: string, read: () => void): () => void {
  const listener = (event: Event): void => {
    if (event instanceof CustomEvent && event.detail === activityId) read();
  };
  events.addEventListener('changed', listener);
  return () => events.removeEventListener('changed', listener);
}

const folders = new Map<string, string>(); // the page's, by activity id

/** The folder of the tree's selection (#818), what the untitled save's dialog starts in; '' = the root. */
export const rememberFolder = (activityId: string, folder: string): void => {
  folders.set(activityId, folder);
};
export const selectionFolderOf = (activityId: string): string => folders.get(activityId) ?? '';

// The page's, by activity id (#947): never view state, so a restart starts every tree collapsed
const expandedFolders = new Map<string, ReadonlySet<string>>();
const NONE_EXPANDED: ReadonlySet<string> = new Set();

/** The folders open in the activity's tree when it was last shown (#947): the sidebar remounts on every switch of activity. */
export const expandedOf = (activityId: string): ReadonlySet<string> => expandedFolders.get(activityId) ?? NONE_EXPANDED;
export const rememberExpanded = (activityId: string, expanded: ReadonlySet<string>): void => {
  expandedFolders.set(activityId, expanded);
};

/** Tests only: forgets every activity's open folders. */
export const resetExpanded = (): void => {
  expandedFolders.clear();
};

/** Selects `path` in the activity's tree (#818): the file an untitled tab was just saved as. */
export const selectInTree = (activityId: string, path: string): void => {
  events.dispatchEvent(new CustomEvent('select', { detail: { activityId, path } }));
};

/** Calls `select` with each path selectInTree names for the activity; returns the unsubscribe. */
export function onTreeSelect(activityId: string, select: (path: string) => void): () => void {
  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as { activityId: string; path: string };
    if (detail.activityId === activityId) select(detail.path);
  };
  events.addEventListener('select', listener);
  return () => events.removeEventListener('select', listener);
}
