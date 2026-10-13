import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDesignAnchor } from '../src/review-bodies.js';

const AREA = { kind: 'area', path: 'agent/hive/designs/x/home.hv.html', viewport: 1280, theme: 'dark', rect: { x: 0, y: 0, width: 10, height: 10 } };

test('parseDesignAnchor keeps the tweaks a comment was made on, {} included (#241)', () => {
  assert.deepEqual(parseDesignAnchor({ ...AREA, tweaks: {} }), { ...AREA, tweaks: {} });
  const tweaks = { layout: 'board', auto: true, gap: 8.5, title: 't'.repeat(200) };
  assert.deepEqual(parseDesignAnchor({ ...AREA, tweaks })?.tweaks, tweaks);
});

test('parseDesignAnchor refuses an anchor without tweaks, or with a bad key, a long string, a non-finite number, another value or too many entries (#241)', () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`t${i}`, true]));
  assert.equal(parseDesignAnchor(AREA), undefined);
  for (const tweaks of [
    undefined, null, [], 'x', { Bad: 1 }, { 'a b': 1 }, JSON.parse('{"__proto__":1}') as unknown, { a: 't'.repeat(201) },
    { a: Number.POSITIVE_INFINITY }, { a: Number.NaN }, { a: null }, { a: { b: 1 } }, { a: ['x'] }, many,
  ]) assert.equal(parseDesignAnchor({ ...AREA, tweaks }), undefined, JSON.stringify(tweaks)?.slice(0, 60));
});
