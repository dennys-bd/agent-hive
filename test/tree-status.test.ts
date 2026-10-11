import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FolderEntries, GitMark } from '../src/types.js';
import { fileStatus, folderStatuses, marksWithLoaded, type TreeStatus, worse } from '../src/ui/lib/tree-status.js';

// #903: worst first, the same order for a file and a folder
const RANKED: TreeStatus[] = ['error', 'warning', 'M', 'D', 'A'];

test('the statuses rank error, warning, M, D, A: the worse of two wins whichever comes first, and anything beats nothing (#903)', () => {
  for (const [i, better] of RANKED.entries()) {
    for (const lesser of RANKED.slice(i)) {
      assert.equal(worse(better, lesser), better, `${better} over ${lesser}`);
      assert.equal(worse(lesser, better), better, `${better} over ${lesser}, reversed`);
    }
  }
  assert.equal(worse(undefined, 'A'), 'A');
});

test('a file\'s own status is its error, then its warning, then its git mark; infos alone give its mark or nothing (#780, #903)', () => {
  const infosOnly = { errors: 0, warnings: 0, infos: 4 };
  assert.equal(fileStatus({ errors: 1, warnings: 3 }, 'M'), 'error');
  assert.equal(fileStatus({ errors: 0, warnings: 2 }, 'A'), 'warning');
  assert.equal(fileStatus(infosOnly, 'D'), 'D');
  assert.equal(fileStatus(infosOnly, undefined), undefined);
  assert.equal(fileStatus(undefined, undefined), undefined);
});

test('a folder takes the worst status of every file under it, at any depth: M beats D, D beats A, a warning beats every mark (#903)', () => {
  const marks: Record<string, GitMark> = {
    'src/a/b/new.ts': 'A', 'src/a/gone.ts': 'D', 'src/x/changed.ts': 'M',
    'lib/new.ts': 'A', 'lib/gone.ts': 'D', 'pkg/gone.ts': 'D', 'pkg/edit.ts': 'M', 'top.ts': 'M',
  };
  const counts = new Map([['src/x/y/z.ts', { errors: 0, warnings: 1 }], ['src/x/y/info.ts', { errors: 0, warnings: 0 }]]);
  assert.deepEqual(Object.fromEntries(folderStatuses(counts, marks)), {
    src: 'warning', 'src/a': 'D', 'src/a/b': 'A', 'src/x': 'warning', 'src/x/y': 'warning', lib: 'D', pkg: 'M',
  });
});

test('a deleted path, in the marks but in no row, raises its folders only; a path at the top raises nothing (#903)', () => {
  assert.deepEqual([...folderStatuses(new Map(), { 'docs/old/gone.md': 'D', 'gone.txt': 'D' })], [['docs', 'D'], ['docs/old', 'D']]);
});

test('marksWithLoaded adds a nested repository\'s marks by full path to the tree\'s, leaves a folder read outside one alone, and does not touch its input (#1, #903)', () => {
  const marks: Record<string, GitMark> = { 'src/a.ts': 'M' };
  const loaded = new Map<string, FolderEntries>([
    ['docs/agent', { files: ['foo.md'], folders: [], repo: { marks: { 'foo.md': 'M', 'gone.md': 'D' }, ignored: [] } }],
    ['node_modules', { files: ['x.js'], folders: [] }],
  ]);
  assert.deepEqual(marksWithLoaded(marks, loaded), { 'src/a.ts': 'M', 'docs/agent/foo.md': 'M', 'docs/agent/gone.md': 'D' });
  assert.deepEqual(marks, { 'src/a.ts': 'M' });
});
