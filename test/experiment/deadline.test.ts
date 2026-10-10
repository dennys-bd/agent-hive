import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayStart, parseRunTimeout, untilDeadline } from '../../scripts/experiment/deadline.js';

test('untilDeadline is the next HH:MM in local time: later today, or tomorrow once passed (#105)', () => {
  const evening = new Date(2026, 9, 1, 22, 0);
  assert.deepEqual(untilDeadline(evening, '07:00'), new Date(2026, 9, 2, 7, 0));
  assert.deepEqual(untilDeadline(evening, '23:15'), new Date(2026, 9, 1, 23, 15));
  assert.deepEqual(untilDeadline(evening, '22:00'), new Date(2026, 9, 2, 22, 0));
  for (const bad of ['7:00', '24:00', '07:60', '0700', '']) assert.throws(() => untilDeadline(evening, bad), /--until/, bad);
});

test('mayStart is true with no deadline and before it, false at it and after (#105)', () => {
  const at = new Date(2026, 9, 2, 7, 0);
  assert.equal(mayStart(new Date(2026, 9, 2, 6, 59), undefined), true);
  assert.equal(mayStart(new Date(2026, 9, 2, 6, 59), at), true);
  assert.equal(mayStart(at, at), false);
  assert.equal(mayStart(new Date(2026, 9, 2, 8, 0), at), false);
});

test('parseRunTimeout reads the timeout grammar of the Hive, up to 24h (#105)', () => {
  assert.equal(parseRunTimeout('20h'), 72_000_000);
  assert.equal(parseRunTimeout('90m'), 5_400_000);
  for (const bad of ['6', '25h', '1d', 'x']) assert.throws(() => parseRunTimeout(bad), /--run-timeout/, bad);
});
