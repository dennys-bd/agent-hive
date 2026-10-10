// A run tab's own split (#641), iTerm's ⌘D inside one tab of the center: a tree of terminal panes built of split-tree.ts, as the center's
// groups are, so a divider, a close and a stored value behave the same in both. Pure: every function returns a new value and never touches
// its input.
import { type Axis, isObject, leaves, parseTree, rebuild, resizeAt, type TreeNode } from './split-tree.js';

/** One terminal pane: the run it shows. */
export interface PaneLeaf { kind: 'pane'; ptyId: string }
export type PaneNode = TreeNode<PaneLeaf>;
/** A tab's split (#641): focused is the ptyId of the pane the keys act on. A tab never split, or split back to one pane, has none. */
export interface Panes { root: PaneNode; focused: string }

const HALF = 50; // a pane split in two gives the new one half its place, as iTerm does

const leaf = (ptyId: string): PaneLeaf => ({ kind: 'pane', ptyId });

/** Every pane's run, in reading order. */
export const leavesOf = (node: PaneNode): string[] => leaves(node).map((pane) => pane.ptyId);

/** Pane `at` split in two on `axis` (#641): `newPty`'s pane after it (on its right in a row, below it in a column), half and half, and
 * focused. With no panes yet the tab's own run, `anchor`, is the one pane. A split on its parent's axis flattens into the parent. An `at`
 * that is no pane, or a `newPty` already one, gives the panes back as they were. */
export function splitPane(panes: Panes | undefined, anchor: string, at: string, newPty: string, axis: Axis): Panes | undefined {
  const root: PaneNode = panes?.root ?? leaf(anchor);
  const runs = leavesOf(root);
  if (!runs.includes(at) || runs.includes(newPty)) return panes;
  const split = (pane: PaneLeaf): PaneNode => (pane.ptyId === at ? { kind: 'split', axis, children: [pane, leaf(newPty)], sizes: [HALF, HALF] } : pane);
  const next = rebuild(root, split);
  return next === undefined ? panes : { root: next, focused: newPty };
}

/** The panes without `ptyId`'s (#641): its split collapses into its sibling, and the focus moves to the first pane left when it was the one
 * closed. undefined once a single pane is left: the tab is one run again. */
export function closePane(panes: Panes, ptyId: string): Panes | undefined {
  const root = rebuild(panes.root, (pane) => (pane.ptyId === ptyId ? undefined : pane));
  if (root === undefined || root.kind === 'pane') return undefined;
  const runs = leavesOf(root);
  return { root, focused: runs.includes(panes.focused) ? panes.focused : runs[0] };
}

/** The focus on `ptyId`'s pane; the same panes when it is none, or already focused. */
export const focusPane = (panes: Panes, ptyId: string): Panes =>
  (panes.focused !== ptyId && leavesOf(panes.root).includes(ptyId) ? { ...panes, focused: ptyId } : panes);

/** `from`'s pane showing `to` instead (#672): a sleeping pane's session continued in a new run; the focus follows it. */
export function renamePane(panes: Panes, from: string, to: string): Panes {
  const root = rebuild(panes.root, (pane) => (pane.ptyId === from ? leaf(to) : pane)) ?? panes.root;
  return { root, focused: panes.focused === from ? to : panes.focused };
}

/** A divider's move inside the tab: the split at `path` takes `sizes`, as the groups' resize does. */
export const resizePanes = (panes: Panes, path: readonly number[], sizes: readonly number[]): Panes => ({ ...panes, root: resizeAt(panes.root, path, sizes) });

/** The panes without every run `isLive` refuses, closed one by one; undefined once one pane or none is left. */
export const prunePanes = (panes: Panes, isLive: (ptyId: string) => boolean): Panes | undefined =>
  leavesOf(panes.root).filter((ptyId) => !isLive(ptyId)).reduce<Panes | undefined>((left, ptyId) => left && closePane(left, ptyId), panes);

const parseLeaf = ({ kind, ptyId }: Record<string, unknown>): PaneLeaf | undefined =>
  (kind === 'pane' && typeof ptyId === 'string' && ptyId !== '' ? leaf(ptyId) : undefined);

/** A stored tab's panes (#641): a split of two panes or more, each run once, the focus on one of them; anything else is undefined. */
export function parsePanes(value: unknown): Panes | undefined {
  if (!isObject(value)) return undefined;
  const { root: stored, focused } = value;
  const root = parseTree(stored, parseLeaf);
  if (root === undefined || root.kind === 'pane' || typeof focused !== 'string') return undefined;
  const runs = leavesOf(root);
  return new Set(runs).size === runs.length && runs.includes(focused) ? { root, focused } : undefined;
}
