import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBranchName, MERGE_BASE_PROMPT, mergeBasePrompt, PROMPT_MESSAGE, promptText } from '../src/merge-prompt.js';

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

test('promptText: nothing without a prompt, the text on the remote for mergeBase on a branch name, else the refusal (#379)', () => {
  assert.deepEqual(promptText(undefined, undefined, 'origin'), {});
  assert.deepEqual(promptText('mergeBase', 'main', 'upstream'), { text: mergeBasePrompt('main', 'upstream') });
  const refused: [unknown, unknown][] = [['rebase', 'main'], ['mergeBase', '-x'], ['mergeBase', undefined], [7, 'main']];
  for (const [prompt, base] of refused) assert.deepEqual(promptText(prompt, base, 'origin'), { refused: PROMPT_MESSAGE }, String(prompt));
  assert.equal(PROMPT_MESSAGE, 'prompt must be mergeBase, with promptBase a branch name');
});
