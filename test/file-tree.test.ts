import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestorsOf, buildTree, parentOf, renamedPath, visibleRows } from '../src/ui/lib/file-tree.js';

const FILES = ['b.ts', 'src/z.ts', 'src/lib/a.ts', '.env', '.github/ci.yml', 'a.md'];

test('buildTree nests the paths, folders first then by name, with each file\'s mark, and leaves hidden paths out unless asked (redesign 07)', () => {
  const tree = buildTree(FILES, { 'src/z.ts': 'M' }, false);
  assert.deepEqual(tree.map((n) => n.name), ['src', 'a.md', 'b.ts']);
  assert.deepEqual(tree[0].children?.map((n) => [n.path, n.mark]), [['src/lib', undefined], ['src/z.ts', 'M']]);
  assert.deepEqual(buildTree(FILES, {}, true).map((n) => n.name), ['.github', 'src', '.env', 'a.md', 'b.ts']);
});

test('visibleRows shows a folder\'s children only while it and every folder above it are expanded', () => {
  const tree = buildTree(FILES, {}, false);
  const rows = (open: string[]) => visibleRows(tree, new Set(open)).map((r) => `${r.depth}:${r.node.path}`);
  assert.deepEqual(rows([]), ['0:src', '0:a.md', '0:b.ts']);
  assert.deepEqual(rows(['src/lib']), ['0:src', '0:a.md', '0:b.ts']);
  assert.deepEqual(rows(['src', 'src/lib']), ['0:src', '1:src/lib', '2:src/lib/a.ts', '1:src/z.ts', '0:a.md', '0:b.ts']);
});

test('buildTree adds the empty folders as folders with no children, a hidden one only when asked (#818)', () => {
  const tree = buildTree(['src/a.ts'], {}, false, ['empty', 'src/void', '.cache']);
  assert.deepEqual(tree.map((n) => [n.name, n.children?.length]), [['empty', 0], ['src', 2]]);
  assert.deepEqual(tree[1].children?.map((n) => n.path), ['src/void', 'src/a.ts']);
  assert.deepEqual(buildTree([], {}, true, ['.cache']).map((n) => n.path), ['.cache']);
});

test('parentOf is the folder a path sits in, \'\' at the top (#818)', () => {
  assert.deepEqual([parentOf('src/lib/a.ts'), parentOf('src'), parentOf('README.md')], ['src/lib', '', '']);
});

test('renamedPath follows a rename to the path itself and to every path under a renamed folder; any other path is untouched (#818)', () => {
  assert.equal(renamedPath('src/a.ts', 'src/a.ts', 'lib/a.ts'), 'lib/a.ts');
  assert.equal(renamedPath('src/deep/b.ts', 'src', 'lib'), 'lib/deep/b.ts');
  assert.equal(renamedPath('srcs/x.ts', 'src', 'lib'), undefined);
  assert.equal(renamedPath('README.md', 'src', 'lib'), undefined);
});

test('ancestorsOf lists the folders above a path, outermost first (#818)', () => {
  assert.deepEqual([ancestorsOf('a/b/c.ts'), ancestorsOf('README.md')], [['a', 'a/b'], []]);
});
