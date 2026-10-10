import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictedFiles } from '../src/pr-conflicts.js';
import { mergeBasePrompt } from '../src/merge-prompt.js';
import type { Exec } from '../src/types.js';

const HEAD = 'a'.repeat(40);
const log = { debug: (_line: string): void => undefined };
// An exit as execFile rejects it: its code and what it printed
const exit = (code: number, stdout = ''): never => { throw Object.assign(new Error(`exit ${code}`), { code, stdout }); };
// git as conflictedFiles runs it: every call recorded; the fetch answers `fetch`, merge-tree `merge`
function fakeGit(merge: () => { stdout: string }, fetch: () => { stdout: string } = () => ({ stdout: '' })): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return args.includes('fetch') ? fetch() : merge();
  };
  return { exec, calls };
}

test('a clean merge is [], in argv only: the fetch of the base, then merge-tree of origin/base and the head (#758)', async () => {
  const git = fakeGit(() => ({ stdout: 'f00d\n' }));
  assert.deepEqual(await conflictedFiles('/wt/x', 'main', HEAD, git.exec, log), []);
  assert.deepEqual(git.calls, [
    ['git', '-C', '/wt/x', 'fetch', 'origin', 'main'],
    ['git', '-C', '/wt/x', 'merge-tree', '--write-tree', '--name-only', '--no-messages', 'origin/main', HEAD],
  ]);
});

test('exit 1 lists the paths after the tree line; another exit, a failed fetch, a bad base or head is undefined (#758)', async () => {
  assert.deepEqual(await conflictedFiles('/wt/x', 'main', HEAD, fakeGit(() => exit(1, 'f00d\nsrc/a.ts\ndocs/b.md\n')).exec, log), ['src/a.ts', 'docs/b.md']);
  assert.equal(await conflictedFiles('/wt/x', 'main', HEAD, fakeGit(() => exit(129)).exec, log), undefined, 'git older than 2.38 has no --write-tree');
  const offline = fakeGit(() => ({ stdout: '' }), () => exit(1));
  assert.equal(await conflictedFiles('/wt/x', 'main', HEAD, offline.exec, log), undefined);
  assert.equal(offline.calls.length, 1, 'no merge-tree after a failed fetch: its exit 1 is no conflict');
  for (const [base, head] of [['-x', HEAD], ['main', 'HEAD']]) {
    const git = fakeGit(() => ({ stdout: '' }));
    assert.equal(await conflictedFiles('/wt/x', base, head, git.exec, log), undefined, `${base} ${head}`);
    assert.deepEqual(git.calls, []);
  }
});

test('a fork\'s PR fetches and merges the base from the base remote (#854)', async () => {
  const git = fakeGit(() => ({ stdout: 'f00d\n' }));
  assert.deepEqual(await conflictedFiles('/wt/x', 'main', HEAD, git.exec, log, 'upstream'), []);
  assert.deepEqual(git.calls, [
    ['git', '-C', '/wt/x', 'fetch', 'upstream', 'main'],
    ['git', '-C', '/wt/x', 'merge-tree', '--write-tree', '--name-only', '--no-messages', 'upstream/main', HEAD],
  ]);
});

test('the merge prompt names the base remote (#854)', () => {
  assert.match(mergeBasePrompt('master', 'upstream'), /Run `git fetch upstream master`, merge `upstream\/master` into this branch/);
  assert.match(mergeBasePrompt('main'), /`git fetch origin main`/);
});
