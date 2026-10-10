// The split tree under the center's groups (#458) and a split tab's terminal panes (#641): a leaf, or a split of children in a row or a
// column, each sized in percent. Both trees share these rules, so a divider, a close and a stored value behave the same in either. Pure:
// every function returns a new tree and never touches its input.

export type Axis = 'row' | 'column';
/** sizes: percent of the split's extent, one per child, summing 100. */
export interface TreeSplit<L> { kind: 'split'; axis: Axis; children: TreeNode<L>[]; sizes: number[] }
export type TreeNode<L> = L | TreeSplit<L>;
// What a leaf must have: a kind, which is never 'split'
type Leaf = { kind: string };
interface Sized<N> { node: N; size: number }

export const MIN_SIZE = 10; // percent: a divider never squeezes a child below it
const EPSILON = 1e-9;
const SIZE_TOLERANCE = 0.5; // percent: what rounding may leave off 100 in a stored tree

export const isSplit = <L extends Leaf>(node: TreeNode<L>): node is TreeSplit<L> => node.kind === 'split';

/** Every leaf, in reading order. */
export const leaves = <L extends Leaf>(node: TreeNode<L>): L[] => (isSplit(node) ? node.children.flatMap((child) => leaves(child)) : [node]);

// A split's children after a change: none left removes it, one takes its place, a child split of the same axis gives its children in
// (VS Code's grid never nests a row in a row, and iTerm's panes neither), and the sizes scale back to 100.
function collapse<L extends Leaf>(axis: Axis, kept: Sized<TreeNode<L>>[]): TreeNode<L> | undefined {
  if (kept.length <= 1) return kept[0]?.node;
  const flat = kept.flatMap(({ node, size }): Sized<TreeNode<L>>[] => (isSplit(node) && node.axis === axis
    ? node.children.map((child, i) => ({ node: child, size: (size * node.sizes[i]) / 100 }))
    : [{ node, size }]));
  const total = flat.reduce((sum, { size }) => sum + size, 0);
  const scale = Math.abs(total - 100) < EPSILON ? 1 : 100 / total;
  return { kind: 'split', axis, children: flat.map(({ node }) => node), sizes: flat.map(({ size }) => size * scale) };
}

/** Every leaf replaced by what `change` gives it (undefined removes it), each split collapsed on the way up; undefined once nothing is left. */
export function rebuild<L extends Leaf>(node: TreeNode<L>, change: (leaf: L) => TreeNode<L> | undefined): TreeNode<L> | undefined {
  if (!isSplit(node)) return change(node);
  const kept = node.children.flatMap((child, i): Sized<TreeNode<L>>[] => {
    const next = rebuild(child, change);
    return next === undefined ? [] : [{ node: next, size: node.sizes[i] }];
  });
  return collapse<L>(node.axis, kept);
}

// Every child at least MIN_SIZE: those below it raised to it, what that adds taken from the others in proportion to their room above it
function clampSizes(sizes: readonly number[]): number[] {
  const floored = sizes.map((size) => Math.max(MIN_SIZE, size));
  const excess = floored.reduce((sum, size) => sum + size, 0) - 100;
  const room = floored.reduce((sum, size) => sum + (size - MIN_SIZE), 0);
  if (room <= 0) return sizes.map(() => 100 / sizes.length);
  return floored.map((size) => size - ((size - MIN_SIZE) * excess) / room);
}

/** A divider's move: the split at `path` (child indexes from the root) takes `sizes`, one per child (else nothing changes), each clamped to
 * MIN_SIZE. A path that ends on a leaf changes nothing. */
export function resizeAt<L extends Leaf>(node: TreeNode<L>, path: readonly number[], sizes: readonly number[]): TreeNode<L> {
  if (!isSplit(node)) return node;
  if (path.length === 0) return sizes.length === node.children.length ? { ...node, sizes: clampSizes(sizes) } : node;
  const [head, ...rest] = path;
  return { ...node, children: node.children.map((child, i) => (i === head ? resizeAt(child, rest, sizes) : child)) };
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** A stored tree rebuilt from its known keys: a split of two children or more, its sizes positive and summing 100 within rounding, every
 * leaf one `parseLeaf` accepts; undefined for anything else. */
export function parseTree<L extends Leaf>(value: unknown, parseLeaf: (value: Record<string, unknown>) => L | undefined): TreeNode<L> | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind !== 'split') return parseLeaf(value);
  const { axis, children, sizes } = value;
  if ((axis !== 'row' && axis !== 'column') || !Array.isArray(children) || !Array.isArray(sizes)) return undefined;
  if (children.length < 2 || sizes.length !== children.length || !sizes.every(isSize)) return undefined;
  if (Math.abs(sizes.reduce((sum, size) => sum + size, 0) - 100) > SIZE_TOLERANCE) return undefined;
  const nodes = children.map((child) => parseTree(child, parseLeaf));
  if (!nodes.every((node): node is TreeNode<L> => node !== undefined)) return undefined;
  return { kind: 'split', axis, children: nodes, sizes };
}
