import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBranchName, MERGE_BASE_PROMPT, mergeBasePrompt } from '../src/merge-prompt.js';

test('isBranchName takes a branch name and refuses what git refuses, an option and a control character (#758)', () => {
  for (const name of ['main', 'release/1.2', 'feature/x-y_z']) assert.equal(isBranchName(name), true, name);
  const refused: unknown[] = ['', '..', 'a..b', '-x', 'a b', 'a\u0007b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '/a', 'a/', 'a.lock', 'a@{1}', 'a//b', '@', 'a;b', 'a$b', 'a`b', 'a|b', 'a(b', 'a&b', 'a\'b', 'é', 7, undefined];
  for (const name of refused) assert.equal(isBranchName(name), false, String(name));
});

test('the merge prompt names origin/{base}, the conflicts, the tests, the commit and the push, and no agent (#758)', () => {
  const prompt = mergeBasePrompt('release/1.2');
  assert.equal(MERGE_BASE_PROMPT, 'mergeBase');
  for (const part of ['origin/release/1.2', 'conflict', 'tests', 'commit', 'push']) assert.ok(prompt.includes(part), part);
  assert.equal(/claude/i.test(prompt), false);
});
