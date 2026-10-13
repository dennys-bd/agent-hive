import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitValue, parseTweaks, sameState, settle, type TweakSchema } from '../src/design-tweaks.js';

const BLOCK = {
  layout: { options: ['board', 'list', 'grid'], default: 'board', group: 'look' },
  auto: { type: 'boolean', default: true },
  title: { type: 'text', default: 'Fluxo' },
  gap: { type: 'number', default: 8, min: 0, max: 24, step: 4, group: 'look' },
};
const schemaOf = (raw: unknown): TweakSchema => {
  const parsed = parseTweaks(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.schema;
};

test('parseTweaks reads each type in declared order, an enum without a type as type enum, and keeps group (#241)', () => {
  assert.deepEqual(parseTweaks(BLOCK), { ok: true, schema: [
    { name: 'layout', type: 'enum', options: ['board', 'list', 'grid'], default: 'board', group: 'look' },
    { name: 'auto', type: 'boolean', default: true },
    { name: 'title', type: 'text', default: 'Fluxo' },
    { name: 'gap', type: 'number', default: 8, min: 0, max: 24, step: 4, group: 'look' },
  ] });
  assert.deepEqual(parseTweaks({}), { ok: true, schema: [] });
  assert.deepEqual(parseTweaks({ a: { type: 'enum', options: ['x'], default: 'x' } }), { ok: true, schema: [{ name: 'a', type: 'enum', options: ['x'], default: 'x' }] });
});

test('parseTweaks refuses a non-object, a bad name, empty, blank or duplicate options, a misfit default, min above max, a zero step, an unknown type, a non-string group and too many tweaks, each with a reason (#241)', () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`t${i}`, { type: 'boolean', default: false }]));
  for (const bad of [
    null, [], 'x', 3,
    { Layout: BLOCK.layout }, { '1x': BLOCK.layout }, { a_b: BLOCK.layout }, { a: 'x' },
    { a: { options: [], default: 'x' } }, { a: { options: ['x', 'x'], default: 'x' } }, { a: { options: ['x', ''], default: 'x' } },
    { a: { options: ['x'], default: 'y' } }, { a: { type: 'boolean', default: 'yes' } }, { a: { type: 'text', default: 1 } },
    { a: { type: 'text', default: 't'.repeat(201) } }, { a: { type: 'number', default: 30, max: 24 } },
    { a: { type: 'number', default: 5, min: 10, max: 0 } }, { a: { type: 'number', default: 1, step: 0 } }, { a: { type: 'number', default: Number.NaN } },
    { a: { type: 'color', default: '#fff' } }, { a: { type: 'boolean', default: true, group: 3 } }, many,
  ]) {
    const parsed = parseTweaks(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad)?.slice(0, 80));
    assert.ok(!parsed.ok && parsed.reason.length > 0);
  }
});

test('fitValue takes a value its definition fits and answers undefined otherwise (#241)', () => {
  const [layout, auto, title, gap] = schemaOf(BLOCK);
  assert.deepEqual([fitValue(layout, 'list'), fitValue(layout, 'tiles'), fitValue(layout, 1)], ['list', undefined, undefined]);
  assert.deepEqual([fitValue(auto, false), fitValue(auto, 'false')], [false, undefined]);
  assert.deepEqual([fitValue(title, ''), fitValue(title, 't'.repeat(201)), fitValue(title, 3)], ['', undefined, undefined]);
  assert.deepEqual([fitValue(gap, 24), fitValue(gap, 25), fitValue(gap, -1), fitValue(gap, '8'), fitValue(gap, Number.POSITIVE_INFINITY)], [24, undefined, undefined, undefined, undefined]);
});

test('settle fills the missing and the misfit with defaults and drops names outside the schema; sameState compares settled values over the schema\'s names only (#241)', () => {
  const schema = schemaOf(BLOCK);
  assert.deepEqual(settle(schema, { layout: 'list', auto: 'yes' as unknown as boolean, gap: 99, gone: 'x' }), { layout: 'list', auto: true, title: 'Fluxo', gap: 8 });
  assert.deepEqual(settle([], { layout: 'list' }), {});
  assert.equal(sameState(schema, { layout: 'list', gone: 'a' }, { layout: 'list', gone: 'b' }), true);
  assert.equal(sameState(schema, {}, { layout: 'board', auto: true }), true); // both at the defaults
  assert.equal(sameState(schema, { layout: 'list' }, { layout: 'grid' }), false);
  assert.equal(sameState([], { layout: 'list' }, {}), true);
});
