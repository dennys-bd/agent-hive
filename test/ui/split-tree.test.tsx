import { expect, test } from 'vitest';
import { leaves, MIN_SIZE, parseTree, rebuild, resizeAt, type TreeNode } from '@/lib/split-tree';

// A leaf of the tests' own: split-tree knows nothing of groups or panes (#641)
interface Leaf { kind: 'leaf'; id: string }
type Node = TreeNode<Leaf>;

// Every fixture is frozen deep: a function that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const leaf = (id: string): Leaf => ({ kind: 'leaf', id });
const ids = (node: Node | undefined): string[] => (node === undefined ? [] : leaves(node).map((l) => l.id));
const parseLeaf = ({ kind, id }: Record<string, unknown>): Leaf | undefined => (kind === 'leaf' && typeof id === 'string' ? leaf(id) : undefined);
// A row: A at 40 beside a column of B over C at 60
const TREE = deepFreeze<Node>({
  kind: 'split', axis: 'row', sizes: [40, 60],
  children: [leaf('A'), { kind: 'split', axis: 'column', sizes: [50, 50], children: [leaf('B'), leaf('C')] }],
});

test('leaves reads in order; rebuild drops a leaf, its split collapsing into the sibling and the sizes scaling back to 100; none left is undefined (#641)', () => {
  expect(ids(TREE)).toEqual(['A', 'B', 'C']);
  expect(rebuild(TREE, (l) => (l.id === 'C' ? undefined : l))).toEqual({ kind: 'split', axis: 'row', sizes: [40, 60], children: [leaf('A'), leaf('B')] });
  expect(rebuild(TREE, (l) => (l.id === 'A' ? undefined : l))).toEqual({ kind: 'split', axis: 'column', sizes: [50, 50], children: [leaf('B'), leaf('C')] });
  expect(rebuild(TREE, () => undefined)).toBeUndefined();
});

test('a leaf turned into a split of its parent\'s axis flattens into the parent, its share split; across the axis it nests (#641)', () => {
  const pair = (axis: 'row' | 'column'): Node => ({ kind: 'split', axis, sizes: [50, 50], children: [leaf('A'), leaf('D')] });
  const same = rebuild(TREE, (l) => (l.id === 'A' ? pair('row') : l));
  expect(same).toMatchObject({ kind: 'split', axis: 'row', sizes: [20, 20, 60] });
  expect(ids(same)).toEqual(['A', 'D', 'B', 'C']);
  const across = rebuild(TREE, (l) => (l.id === 'A' ? pair('column') : l));
  expect(across).toMatchObject({ kind: 'split', axis: 'row', sizes: [40, 60], children: [{ kind: 'split', axis: 'column', sizes: [50, 50] }, { axis: 'column' }] });
});

test('resizeAt sets the sizes of the split at a path, each child held at MIN_SIZE at least; a wrong count or a path to a leaf changes nothing (#641)', () => {
  expect(MIN_SIZE).toBe(10);
  expect(resizeAt(TREE, [], [70, 30])).toMatchObject({ sizes: [70, 30] });
  expect(resizeAt(TREE, [], [5, 95])).toMatchObject({ sizes: [10, 90] });
  expect(resizeAt(TREE, [], [104, -4])).toMatchObject({ sizes: [90, 10] });
  expect(resizeAt(TREE, [1], [80, 20])).toMatchObject({ sizes: [40, 60], children: [leaf('A'), { sizes: [80, 20] }] });
  expect(resizeAt(TREE, [], [50, 25, 25])).toMatchObject({ sizes: [40, 60] });
  expect(resizeAt(TREE, [0], [50, 50])).toEqual(TREE);
});

test('parseTree reads back what was stored and refuses what is not a split: sizes off 100, one child, a count mismatch, an unknown axis or leaf (#641)', () => {
  expect(parseTree(JSON.parse(JSON.stringify(TREE)), parseLeaf)).toEqual(TREE);
  const bad: unknown[] = [
    { ...TREE, sizes: [40, 50] },
    { kind: 'split', axis: 'row', sizes: [100], children: [leaf('A')] },
    { ...TREE, sizes: [40, 30, 30] },
    { ...TREE, axis: 'diagonal' },
    { ...TREE, children: [leaf('A'), { kind: 'group' }] },
    'A', null, [],
  ];
  for (const value of bad) expect(parseTree(value, parseLeaf)).toBeUndefined();
});
