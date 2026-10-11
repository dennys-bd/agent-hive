import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestorsOf, buildTree, ignoredToRead, parentOf, renamedPath, visibleRows } from '../src/ui/lib/file-tree.js';
import type { FolderEntries } from '../src/types.js';

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

test('buildTree adds the ignored files and folders as ignored, with no mark; an ignored folder not read yet is unloaded with no children; hidden ones only when asked (HIVE-22)', () => {
  const tree = buildTree(['src/a.ts'], {}, false, [], { files: ['debug.log', 'src/gen.js', '.env.local'], folders: ['node_modules', '.cache'] });
  assert.deepEqual(tree.map((n) => [n.path, n.isIgnored, n.isUnloaded, n.children?.length]), [
    ['node_modules', true, true, 0], ['src', undefined, undefined, 2], ['debug.log', true, undefined, undefined],
  ]);
  assert.deepEqual(tree[1].children?.map((n) => [n.path, n.isIgnored, n.mark]), [['src/a.ts', undefined, undefined], ['src/gen.js', true, undefined]]);
  assert.deepEqual(buildTree([], {}, true, [], { files: ['.env.local'], folders: ['.cache'] }).map((n) => n.path), ['.cache', '.env.local']);
});

test('buildTree fills a loaded ignored folder from the map, a loaded subfolder from it too, and leaves any other subfolder unloaded (HIVE-22)', () => {
  const loaded = new Map([
    ['docs', { files: ['glossary.md', '.hidden'], folders: ['agent', 'old'] }],
    ['docs/agent', { files: ['plan.md'], folders: [] }],
  ]);
  const [docs] = buildTree([], {}, false, [], { files: [], folders: ['docs'] }, loaded);
  assert.deepEqual([docs.path, docs.isIgnored, docs.isUnloaded], ['docs', true, undefined]);
  assert.deepEqual(docs.children?.map((n) => [n.path, n.isIgnored, n.isUnloaded]), [
    ['docs/agent', true, undefined], ['docs/old', true, true], ['docs/glossary.md', true, undefined],
  ]);
  assert.deepEqual(docs.children?.[0].children?.map((n) => [n.path, n.isIgnored]), [['docs/agent/plan.md', true]]);
});

test('ignoredToRead reads the expanded ignored folders and the expanded ones under them whose folders down from the ignored one are all expanded, sorted (HIVE-22)', () => {
  const ignored = ['node_modules', 'docs'];
  assert.deepEqual(ignoredToRead(new Set(['src', 'docs/agent', 'docs', 'node_modules/x']), ignored), ['docs', 'docs/agent']);
  assert.deepEqual(ignoredToRead(new Set(['docs/agent', 'docsx']), ignored), []);
});

test('buildTree shows a nested repository\'s children as it sees them: a changed file marked, a tracked one plain, an ignored one dimmed, a folder unloaded until read, and the repository\'s own folder still ignored (#1)', () => {
  const loaded = new Map<string, FolderEntries>([
    ['docs', { files: ['README.md'], folders: ['agent', 'build', 'specs'], repo: { marks: {}, ignored: ['build'] } }],
    ['docs/agent', { files: ['bar.md', 'foo.md', 'x.log'], folders: [], repo: { marks: { 'foo.md': 'M' }, ignored: ['x.log'] } }],
  ]);
  const [docs] = buildTree([], {}, false, [], { files: [], folders: ['docs'] }, loaded);
  assert.deepEqual([docs.path, docs.isIgnored, docs.isUnloaded], ['docs', true, undefined]);
  assert.deepEqual(docs.children?.map((n) => [n.path, n.isIgnored, n.isUnloaded, n.mark]), [
    ['docs/agent', undefined, undefined, undefined], ['docs/build', true, true, undefined], ['docs/specs', undefined, true, undefined],
    ['docs/README.md', undefined, undefined, undefined],
  ]);
  assert.deepEqual(docs.children?.[0].children?.map((n) => [n.path, n.isIgnored, n.mark]), [
    ['docs/agent/bar.md', undefined, undefined], ['docs/agent/foo.md', undefined, 'M'], ['docs/agent/x.log', true, undefined],
  ]);
});
