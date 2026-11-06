import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samePath } from '../src/same-path.js';

const AS_GIT_PRINTS = 'C:/Users/x/repo/.hive/worktrees/wt'; // git on Windows: forward slashes, the drive as the OS reports it

test('on win32 a path git prints with / is the one the Hive builds with \\, whatever the case and a trailing separator; a sibling is not (#640)', () => {
  assert.equal(samePath(AS_GIT_PRINTS, 'c:\\Users\\X\\repo\\.hive\\worktrees\\wt\\', 'win32'), true);
  assert.equal(samePath(AS_GIT_PRINTS, 'c:\\Users\\X\\repo\\.hive\\worktrees\\wt2', 'win32'), false);
});

test('on win32 a UNC path reads the same with either separator (#640)', () => {
  assert.equal(samePath('//server/share/x', '\\\\server\\share\\X', 'win32'), true);
});

test('on darwin and linux the compare is exact: another case is another path, a trailing / is not (#640)', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.equal(samePath('/r/.hive/worktrees/wt', '/r/.hive/worktrees/WT', platform), false, platform);
    assert.equal(samePath('/r/.hive/worktrees/wt', '/r/.hive/worktrees/wt/', platform), true, platform);
  }
});
