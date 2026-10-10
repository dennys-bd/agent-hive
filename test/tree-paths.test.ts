import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destination, existingItem, GIT_MESSAGE, newItem, type PathFs, refusal, rootsOf, sourceItem } from '../src/tree-paths.js';

// Every path exists and is its own real path, so only the guards under test can refuse
const FS: PathFs = { realpath: async (path) => path, stat: async () => ({ isDirectory: () => true }) };
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
  for (const path of ['.github/x', 'sub/.gitignore', 'a.git/x']) assert.equal(await newItem(roots, path, FS), `/root/${path}`, path);
});
