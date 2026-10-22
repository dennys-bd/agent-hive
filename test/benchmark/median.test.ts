import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestOf, spread } from '../../src/benchmark/median.js';

test('spread: the middle value of an odd count, the mean of the two middles of an even one, with min, max and n; none for no value (#476)', () => {
  assert.deepEqual(spread([3, 1, 2]), { median: 2, min: 1, max: 3, n: 3 });
  assert.deepEqual(spread([5, 4, 4, 3]), { median: 4, min: 3, max: 5, n: 4 });
  assert.deepEqual(spread([4, 5]), { median: 4.5, min: 4, max: 5, n: 2 });
  assert.deepEqual(spread([7]), { median: 7, min: 7, max: 7, n: 1 });
  assert.equal(spread([]), undefined);
  const frozen = Object.freeze([3, 1, 2]);
  assert.deepEqual(spread(frozen)?.median, 2, 'it sorts a copy');
});

test('bestOf: the key of the unique lowest or highest defined value; a tie for the best or fewer than two defined values is no best (#476)', () => {
  assert.equal(bestOf({ a: 3, b: 1, c: 2 }, 'low'), 'b');
  assert.equal(bestOf({ a: 3, b: 1, c: undefined }, 'high'), 'a');
  assert.equal(bestOf({ a: 1, b: 1, c: 2 }, 'low'), undefined);
  assert.equal(bestOf({ a: 1, b: 2, c: 2 }, 'high'), undefined);
  assert.equal(bestOf({ a: 1, b: 2, c: 2 }, 'low'), 'a', 'a tie below the best marks nothing off');
  assert.equal(bestOf({ a: 4, b: undefined }, 'high'), undefined);
  assert.equal(bestOf({}, 'low'), undefined);
});
