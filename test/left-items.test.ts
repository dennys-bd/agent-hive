import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeftItems } from '../src/left-items.js';

// A listing as pollSource holds it: namespaced item ids, each in a column
const listed = (...ids: string[]) => ids.map((itemId) => ({ item: { itemId }, column: 'Done' }));

test('an item closed at or after a poll began reading is dropped from that listing; the rest lands (#353)', () => {
  const left = createLeftItems();
  left.record('board', 'board:I1', 200);
  left.record('board', 'board:I2', 100);
  assert.deepEqual(left.filter('board', 100, listed('board:I1', 'board:I2', 'board:I3')), listed('board:I3'), 'a tie counts as closed after the read began');
});

test('an item closed before the read began is kept, and its record is forgotten (#353)', () => {
  const left = createLeftItems();
  left.record('board', 'board:I1', 100);
  assert.deepEqual(left.filter('board', 200, listed('board:I1')), listed('board:I1'), 'restored on the source: it enters');
  assert.deepEqual(left.filter('board', 50, listed('board:I1')), listed('board:I1'), 'forgotten: even an older read keeps it now');
});

test('another source\'s listing is untouched (#353)', () => {
  const left = createLeftItems();
  left.record('board', 'board:I1', 200);
  assert.deepEqual(left.filter('other', 100, listed('board:I1')), listed('board:I1'));
  assert.deepEqual(left.filter('board', 100, listed('board:I1')), [], 'the other source\'s filter forgot nothing of board\'s');
});

test('the listing given is not mutated and the answer is a new array (#353)', () => {
  const left = createLeftItems();
  left.record('board', 'board:I1', 200);
  const given = Object.freeze(listed('board:I1', 'board:I2'));
  assert.deepEqual(left.filter('board', 100, given), listed('board:I2'));
  assert.equal(given.length, 2);
  const kept = left.filter('board', 300, given);
  assert.notEqual(kept, given);
  assert.deepEqual(kept, given);
});
