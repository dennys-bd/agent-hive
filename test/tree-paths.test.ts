import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { HOST_PATHS } from './fake-machine.js';
import { linkedDisk } from './fixtures/linked-disk.js';
import { destination, existingItem, GIT_MESSAGE, newItem, OUTSIDE_MESSAGE, type PathFs, refusal, rootsOf, sourceItem, treeFolder, treeItem } from '../src/tree-paths.js';

// Every path exists and is its own real path, so only the guards under test can refuse
const FS: PathFs = { realpath: async (path) => path, stat: async () => ({ isDirectory: () => true }), paths: HOST_PATHS };
const BAD = refusal(400, GIT_MESSAGE);

test('a .git segment anywhere in the path is refused, in any case, for a new item, an existing one, a source and a destination (#818)', async () => {
  const roots = await rootsOf('/root', FS);
  for (const path of ['.git', 'sub/.git/hooks/x', 'sub/.GIT/x', 'a/b/.Git']) {
    assert.deepEqual(await newItem(roots, path, FS), BAD, `new ${path}`);
    assert.deepEqual(await existingItem(roots, path, FS), BAD, `existing ${path}`);
    assert.deepEqual(await sourceItem(roots, path, false, FS), BAD, `source ${path}`);
    assert.deepEqual(await destination(roots, path, FS), BAD, `destination ${path}`);
  }
});

test('a name that only contains .git is not refused (#818)', async () => {
  const roots = await rootsOf('/root', FS);
  for (const path of ['.github/x', 'sub/.gitignore', 'a.git/x']) assert.equal(await newItem(roots, path, FS), resolve('/root', path), path);
});

test('treeFolder and treeItem check with the PathFs they are handed (#160)', async () => {
  assert.equal(await treeFolder('/root', 'sub', FS), resolve('/root', 'sub'));
  assert.equal(await treeItem('/root', 'a.ts', FS), resolve('/root', 'a.ts'));
  assert.deepEqual(await treeItem('/root', '.git/x', FS), BAD);
});

for (const platform of ['linux', 'win32'] as const) {
  test(`the guards on a fake ${platform} disk refuse ../x and a symlink out of the root and take an item inside it, whatever the host (#929)`, async () => {
    const disk = linkedDisk(platform);
    const fs: PathFs = { realpath: disk.realpath, stat: disk.stat, paths: disk.paths };
    const roots = await rootsOf(disk.root, fs);
    const OUT = refusal(400, OUTSIDE_MESSAGE);
    for (const path of ['../x', 'link']) assert.deepEqual(await destination(roots, path, fs), OUT, `destination ${path}`);
    for (const path of ['../x', 'link/new.ts']) assert.deepEqual(await newItem(roots, path, fs), OUT, `new ${path}`);
    for (const path of ['../x.ts', 'link/b.ts']) assert.deepEqual(await sourceItem(roots, path, false, fs), OUT, `source ${path}`);
    assert.equal(await destination(roots, 'sub', fs), disk.at('sub'));
    assert.equal(await newItem(roots, 'sub/new.ts', fs), disk.at('sub', 'new.ts'));
    assert.equal(await sourceItem(roots, 'a.ts', false, fs), disk.at('a.ts'));
  });
}
