import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // this file runs from dist/test/: the sources are two levels up
const read = (path: string): Promise<string> => readFile(join(ROOT, path), 'utf8');

// The spawns whose whole tree a timeout, a cap or a stop kills (#637): one shared kill, never a copy that knows only process groups
const TREE_SPAWNERS = ['src/worktree-steps.ts'];

test('the tree spawners take treeSpawnOptions and kill through killTree, so on win32 they are not detached and taskkill reaches the tree (#637)', async () => {
  for (const path of TREE_SPAWNERS) {
    const text = await read(path);
    assert.ok(text.includes('...treeSpawnOptions(process.platform)'), `${path}: spawn options`);
    assert.ok(text.includes('void killTree(child.pid, process.platform)'), `${path}: the kill`);
    assert.ok(!text.includes('detached: true'), `${path}: still detached on win32`);
    assert.ok(!text.includes('process.kill(-'), `${path}: its own group kill`);
  }
});
