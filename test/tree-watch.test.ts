import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitDirOf, pathKind } from '../src/tree-watch.js';

test('pathKind drops a .git segment at any depth and in any case, keeps the root\'s own .git/index and .git/HEAD as git, and drops .hive/worktrees only under a checkout (#502)', () => {
  assert.equal(pathKind('src/a.ts', false), 'path');
  assert.equal(pathKind('.git/index', false), 'git');
  assert.equal(pathKind('.git/HEAD', true), 'git');
  for (const path of ['.git', '.git/objects/ab/cd', '.git/index.lock', '.git/refs/heads/main', '.GIT/config', 'docs/.git/index', 'docs/.git/HEAD']) assert.equal(pathKind(path, true), 'drop', path);
  assert.equal(pathKind('.hive/worktrees', true), 'drop');
  assert.equal(pathKind('.hive/worktrees/hive-2-x/src/a.ts', true), 'drop');
  assert.equal(pathKind('.hive/worktrees/hive-2-x/src/a.ts', false), 'path', 'a task worktree holds no other activity');
  assert.equal(pathKind('.hive/notes.md', true), 'path');
});

test('gitDirOf reads the gitdir: line of a worktree\'s .git file, a relative one against the folder holding it; other text names none (#502)', () => {
  assert.equal(gitDirOf('gitdir: /repo/.git/worktrees/hive-1\n', '/wt'), '/repo/.git/worktrees/hive-1');
  assert.equal(gitDirOf('gitdir: ../repo/.git/worktrees/docs\n', '/wt/docs'), '/wt/repo/.git/worktrees/docs');
  assert.equal(gitDirOf('not a git file', '/wt'), undefined);
});
