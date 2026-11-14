import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readsRef, REF_GRAMMARS, TASK_ID } from '../src/blocker-refs.js';
import { githubRefs } from '../src/sources/github-refs.js';

test('GitHub\'s grammar reads 12 and #12 as 12, owner/repo#12 as it is, and nothing else: no acme/r12, no task id, no 10-digit number (#810)', () => {
  assert.equal(REF_GRAMMARS.github, githubRefs);
  const cases: [string, string | undefined][] = [
    ['12', '12'], ['#12', '12'], [' #12 ', '12'], ['acme/r#12', 'acme/r#12'], ['acme/r12', undefined], ['ABC-12', undefined], ['1234567890', undefined], ['', undefined],
  ];
  for (const [text, ref] of cases) assert.equal(githubRefs.refOf(text), ref, JSON.stringify(text));
  assert.equal(githubRefs.forms, '12, #12, owner/repo#12');
});

test('GitHub\'s isShort is true only for digits, an issue of the item\'s own repository (#810)', () => {
  assert.deepEqual(['12', 'acme/r#12', 'foo-12', '#12', ''].map((id) => githubRefs.isShort(id)), [true, false, false, false, false]);
});

test('readsRef tries the type\'s grammar, then a task id; with no grammar, a hive task, it reads only a task id (#810)', () => {
  assert.deepEqual(['#12', 'acme/r#12', 'HIVE-3', 'foo-12', 'acme/r12', 'pager'].map((text) => readsRef(githubRefs, text)), ['12', 'acme/r#12', 'HIVE-3', 'foo-12', undefined, undefined]);
  assert.deepEqual(['12', '#12', ' HIVE-3 ', 'foo.bar-7'].map((text) => readsRef(undefined, text)), [undefined, undefined, 'HIVE-3', 'foo.bar-7']);
  assert.equal(TASK_ID.test('3-HIVE'), false);
});
