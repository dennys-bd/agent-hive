import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue, isReadOnly, MAX_TEXT, STATUS } from '../src/field-values.js';
import type { ItemField } from '../src/types.js';

// A field write's value against its field (#686): the route's 400 before any write.

const field = (type: ItemField['type'], extra: Partial<ItemField> = {}): ItemField => ({ name: 'F', type, value: null, ...extra });

test('checkValue takes each kind\'s own shape, and null clears any kind but the assignees, which clear with [] (#686)', () => {
  assert.deepEqual(checkValue(field('text'), 'hello'), { value: 'hello' });
  assert.deepEqual(checkValue(field('number'), 2.5), { value: 2.5 });
  assert.deepEqual(checkValue(field('date'), '2026-10-20'), { value: '2026-10-20' });
  for (const type of ['singleSelect', 'iteration', 'milestone', 'issueType'] as const) {
    assert.deepEqual(checkValue(field(type, { options: ['a', 'b'] }), 'b'), { value: 'b' }, type);
  }
  for (const type of ['text', 'number', 'date', 'singleSelect', 'iteration', 'milestone', 'issueType'] as const) {
    assert.deepEqual(checkValue(field(type), null), { value: null }, type);
  }
  assert.deepEqual(checkValue(field('assignees', { value: ['ana'], options: ['ana', 'bia'] }), ['ana', 'bia', 'bia']), { value: ['ana', 'bia'] });
  assert.deepEqual(checkValue(field('assignees', { value: ['ana'] }), []), { value: [] });
});

test('checkValue refuses a value of another kind, a choice its options lack, a login not assignable and any write to a read-only field (#686)', () => {
  assert.deepEqual(checkValue(field('text'), 3), { error: '"F" takes text' });
  assert.deepEqual(checkValue(field('number'), '3'), { error: '"F" takes a number' });
  assert.deepEqual(checkValue(field('number'), Number.NaN), { error: '"F" takes a number' });
  assert.deepEqual(checkValue(field('date'), '20/10/2026'), { error: '"F" takes a date (YYYY-MM-DD)' });
  assert.deepEqual(checkValue(field('date'), '2026-13-40'), { error: '"F" takes a date (YYYY-MM-DD)' });
  assert.deepEqual(checkValue(field('singleSelect', { options: ['a'] }), 'z'), { error: '"F" takes one of its options' });
  assert.deepEqual(checkValue(field('milestone'), 'v1'), { error: '"F" takes one of its options' });
  assert.deepEqual(checkValue(field('assignees', { value: [], options: ['ana'] }), ['zoe']), { error: '"zoe" cannot be assigned' });
  assert.deepEqual(checkValue(field('assignees'), null), { error: '"F" takes a list of logins' });
  assert.deepEqual(checkValue(field('repository', { readOnly: true }), 'acme/x'), { error: '"F" is read only' });
  assert.deepEqual(checkValue(field('other'), null), { error: '"F" is read only' });
});

test('an assignee already set stays in the list even when the one page of assignable users does not list them (#686)', () => {
  assert.deepEqual(checkValue(field('assignees', { value: ['old'], options: ['ana'] }), ['old', 'ana']), { value: ['old', 'ana'] });
});

test('isReadOnly: the repository, the progress, the parent issue and any kind the Hive does not know (#686)', () => {
  const types = ['repository', 'progress', 'parentIssue', 'other', 'text', 'singleSelect', 'milestone', 'assignees'] as const;
  assert.deepEqual(types.map(isReadOnly), [true, true, true, true, false, false, false, false]);
});

test('checkValue refuses a day the calendar lacks, a text past the cap, and a cleared Status (#686)', () => {
  assert.deepEqual(checkValue(field('date'), '2026-02-31'), { error: '"F" takes a date (YYYY-MM-DD)' });
  assert.deepEqual(checkValue(field('date'), '2028-02-29'), { value: '2028-02-29' });
  assert.deepEqual(checkValue(field('text'), 'x'.repeat(MAX_TEXT)), { value: 'x'.repeat(MAX_TEXT) });
  assert.deepEqual(checkValue(field('text'), 'x'.repeat(MAX_TEXT + 1)), { error: `"F" takes at most ${MAX_TEXT} characters` });
  const status = { name: STATUS, type: 'singleSelect' as const, value: 'Ready', options: ['Ready'] };
  assert.deepEqual(checkValue(status, null), { error: '"Status" cannot be cleared' });
  assert.deepEqual(checkValue(status, 'Ready'), { value: 'Ready' });
});
