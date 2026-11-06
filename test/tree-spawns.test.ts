import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // this file runs from dist/test/: the sources are two levels up
const read = (path: string): Promise<string> => readFile(join(ROOT, path), 'utf8');

// The spawns whose whole tree a timeout, a cap or a stop kills (#637): one shared kill, never a copy that knows only process groups
const TREE_SPAWNERS = ['src/check-run.ts', 'src/format-run.ts', 'src/worktree-steps.ts'];

test('the tree spawners take treeSpawnOptions and kill through killTree, so on win32 they are not detached and taskkill reaches the tree (#637)', async () => {
  for (const path of TREE_SPAWNERS) {
    const text = await read(path);
    assert.ok(text.includes('...treeSpawnOptions(process.platform)'), `${path}: spawn options`);
    assert.ok(text.includes('void killTree(child.pid, process.platform)'), `${path}: the kill`);
    assert.ok(!text.includes('detached: true'), `${path}: still detached on win32`);
    assert.ok(!text.includes('process.kill(-'), `${path}: its own group kill`);
  }
});

// Every .ts under src/ and .js under bin/, as forward-slash paths from the root; src/benchmark/ is out of #637's scope
async function sourceFiles(): Promise<string[]> {
  const src = (await readdir(join(ROOT, 'src'), { recursive: true })).map((p) => `src/${p.split(sep).join('/')}`);
  const bin = (await readdir(join(ROOT, 'bin'))).map((p) => `bin/${p}`);
  return [...src, ...bin].filter((p) => /\.(ts|js)$/.test(p) && !p.startsWith('src/benchmark/'));
}

test('only src/kill-tree.ts kills a process group: no spawn keeps a copy that knows nothing of win32 (#637)', async () => {
  const copies: string[] = [];
  for (const path of await sourceFiles()) {
    if (path !== 'src/kill-tree.ts' && (await read(path)).includes('process.kill(-')) copies.push(path);
  }
  assert.deepEqual(copies, []);
});
