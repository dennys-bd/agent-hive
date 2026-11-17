import type { StoredSourceItem } from '../read-model/source-items.js';
import type { JiraTree, SourceConfig, SourceItem } from '../types.js';
import { treeFields, type TreeLinks } from './github-tree.js';

// A Jira project's tree (#830), read from the parent the sync stores: the same links GitHub's sub-issues give (github-tree.ts), so the task tree
// and the "tree started" rule read both alike. Only two of Jira's levels count, each behind its own toggle; Advanced Roadmaps levels above the
// epic never do

type Stored = Pick<StoredSourceItem, 'item'>;
type Epics = Pick<Extract<SourceConfig, { type: 'jira' }>, 'epics' | 'epicFollows' | 'switchAt'>;

const EPIC_LEVEL = 1;
const SUBTASK_LEVEL = -1;
const DONE = 'done'; // the status category key Jira gives every done status, whatever its name

const levelOf = ({ item }: Stored): unknown => item.data.hierarchyLevel;

// An epic's link needs the epic toggle and a subtask's the subtask one; any other pair is a level the Hive does not read
const counts = (tree: JiraTree, parent: Stored, child: Stored): boolean =>
  levelOf(parent) === EPIC_LEVEL ? tree.epics : levelOf(child) === SUBTASK_LEVEL && tree.subtasks;

/** Each stored issue's tree links over a whole listing, keyed by node id, read before a status or a filter drops one: a child filtered out is
 * still a child. A parent outside the listing (another project, never synced) links nothing, so its child is a root. Children keep listing order. */
export function treeLinks(listing: readonly Stored[], tree: JiraTree): Map<string, TreeLinks> {
  const byId = new Map(listing.map((s) => [s.item.nodeId, s]));
  const parentOf = (child: Stored): string | undefined => {
    const parent = child.item.parentId === null ? undefined : byId.get(child.item.parentId);
    return parent !== undefined && parent !== child && counts(tree, parent, child) ? parent.item.nodeId : undefined;
  };
  const parents = new Map(listing.flatMap((s): [string, string][] => {
    const parent = parentOf(s);
    return parent === undefined ? [] : [[s.item.nodeId, parent]];
  }));
  const under = new Map<string, Stored[]>(); // built once here, so a project's listing costs one pass rather than one scan per parent
  for (const s of listing) {
    const parent = parents.get(s.item.nodeId);
    if (parent !== undefined) under.set(parent, [...(under.get(parent) ?? []), s]);
  }
  return new Map(listing.map((s): [string, TreeLinks] => {
    const kids = under.get(s.item.nodeId) ?? [];
    const parent = parents.get(s.item.nodeId);
    const links = { children: kids.map((k) => k.item.nodeId), closedChildren: kids.filter((k) => k.item.data.statusCategory === DONE).map((k) => k.item.nodeId) };
    return [s.item.nodeId, parent === undefined ? links : { parent, ...links }];
  }));
}

/** A task with its links; under `epics: show` a task with children is an epic, at any level, as on GitHub. A Jira epic's activity is never
 * deleted: a jira source has no epicDeleteActivity. */
export function withTree(task: SourceItem, links: TreeLinks | undefined, source: Epics): SourceItem {
  if (links === undefined) return task;
  const epic = source.epics === 'show' && links.children.length > 0 ? { epic: { follows: source.epicFollows, switchAt: source.switchAt, deleteActivity: false } } : {};
  return { ...task, item: { ...task.item, ...treeFields(links), ...epic } };
}

/** Whether `epics: hide` takes the task off the source: any task with children, which stay tasks. */
export const isHidden = (task: SourceItem, source: Pick<Epics, 'epics'>): boolean => source.epics === 'hide' && (task.item.children ?? []).length > 0;

/** The tasks with each parent's children right after it, depth first, as GitHub's groupUnderEpics: only a child in its parent's column follows it.
 * The rest keep their order; a cycle leaves its tasks rootless, so they come last, each once. */
export function groupUnderParents(tasks: readonly SourceItem[]): SourceItem[] {
  const byId = new Map(tasks.map((t) => [t.item.itemId, t]));
  const parentOf = (task: SourceItem): SourceItem | undefined => {
    const parent = task.item.parent === undefined ? undefined : byId.get(task.item.parent);
    return parent !== undefined && parent !== task && parent.column === task.column ? parent : undefined;
  };
  const placed = new Set<SourceItem>();
  const walk = (task: SourceItem): SourceItem[] => {
    if (placed.has(task)) return [];
    placed.add(task);
    const children = (task.item.children ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child !== undefined && parentOf(child) === task ? [child] : [];
    });
    return [task, ...children.flatMap(walk)];
  };
  return [...tasks.filter((t) => parentOf(t) === undefined), ...tasks].flatMap(walk);
}

/** The listing with one re-read issue in its place, appended when it lacked it, so a single read's links equal the next listing's. */
export const inPlace = <T extends Stored>(listing: readonly T[], one: T): T[] =>
  listing.some((s) => s.item.nodeId === one.item.nodeId) ? listing.map((s) => (s.item.nodeId === one.item.nodeId ? one : s)) : [...listing, one];
