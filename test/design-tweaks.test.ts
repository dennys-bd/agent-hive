import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitValue, parseTweaks, sameState, settle, shownTweaks, type TweakSchema } from '../src/design-tweaks.js';
import type { DesignTweakValue } from '../src/types.js';

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
  ], viewports: [] });
  assert.deepEqual(parseTweaks({}), { ok: true, schema: [], viewports: [] });
  assert.deepEqual(parseTweaks({ a: { type: 'enum', options: ['x'], default: 'x' } }), { ok: true, schema: [{ name: 'a', type: 'enum', options: ['x'], default: 'x' }], viewports: [] });
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

test('parseTweaks takes viewports apart from the schema, in its order, [] when absent; it does not count toward 32 (#341)', () => {
  assert.deepEqual(parseTweaks({ viewports: ['desktop', 'mobile'], auto: BLOCK.auto }), {
    ok: true, schema: [{ name: 'auto', type: 'boolean', default: true }], viewports: ['desktop', 'mobile'],
  });
  assert.deepEqual(parseTweaks({ viewports: ['mobile', 'tablet', 'desktop'] }), { ok: true, schema: [], viewports: ['mobile', 'tablet', 'desktop'] });
  const full = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`t${i}`, { type: 'boolean', default: false }]));
  const parsed = parseTweaks({ ...full, viewports: ['tablet'] });
  assert.ok(parsed.ok);
  assert.deepEqual([parsed.schema.length, parsed.viewports], [32, ['tablet']]);
});

test('parseTweaks refuses a viewports that is not a non-empty list of strings, names an unknown viewport or repeats one, each with its reason (#341)', () => {
  const reasonOf = (viewports: unknown): string | undefined => {
    const parsed = parseTweaks({ viewports, auto: BLOCK.auto });
    return parsed.ok ? undefined : parsed.reason;
  };
  const LIST = 'viewports must be a non-empty list of desktop, tablet, mobile';
  assert.deepEqual([reasonOf('desktop'), reasonOf(null), reasonOf({}), reasonOf([]), reasonOf(['desktop', 1])], [LIST, LIST, LIST, LIST, LIST]);
  assert.equal(reasonOf(['desktop', 'natural']), 'viewports: unknown viewport "natural"'); // natural is always offered, never declared
  assert.equal(reasonOf(['watch']), 'viewports: unknown viewport "watch"');
  assert.equal(reasonOf(['mobile', 'mobile']), 'viewports must be unique');
});

// #1034: a when on each type, a list, and a chain (icons names density, itself conditional)
const CONDITIONAL = {
  layout: { options: ['board', 'list', 'grid'], default: 'board' },
  auto: { type: 'boolean', default: true },
  title: { type: 'text', default: 'Fluxo' },
  gap: { type: 'number', default: 8, min: 0, max: 24 },
  density: { options: ['comfortable', 'compact'], default: 'comfortable', when: { layout: 'list' } },
  dense: { type: 'boolean', default: false, when: { layout: ['list', 'grid'], auto: false, title: 'Fluxo', gap: 8 } },
  icons: { type: 'boolean', default: true, when: { density: 'compact' } },
};

test('parseTweaks keeps a when naming any type, a single value as a list of one, and a chain; a tweak without one has no when key (#1034)', () => {
  const schema = schemaOf(CONDITIONAL);
  assert.deepEqual(schema.map((tweak) => tweak.when), [
    undefined, undefined, undefined, undefined,
    { layout: ['list'] }, { layout: ['list', 'grid'], auto: [false], title: ['Fluxo'], gap: [8] }, { density: ['compact'] },
  ]);
  assert.equal(Object.hasOwn(schema[0], 'when'), false);
});

test('parseTweaks refuses a when that is not a non-empty object, names a tweak not declared above it, lists no, repeated or too many values, or a value its tweak does not take, each with its reason (#1034)', () => {
  const reasonOf = (when: unknown): string | undefined => {
    const parsed = parseTweaks({ layout: CONDITIONAL.layout, gap: CONDITIONAL.gap, density: { ...CONDITIONAL.density, when } });
    return parsed.ok ? undefined : parsed.reason;
  };
  const SHAPE = 'density: when must be a non-empty object of tweak name to value';
  assert.deepEqual([reasonOf(null), reasonOf('list'), reasonOf(['list']), reasonOf({})], [SHAPE, SHAPE, SHAPE, SHAPE]);
  for (const other of ['density', 'nope', 'viewports']) { // itself, unknown, the reserved key
    assert.equal(reasonOf({ [other]: true }), `density: when names "${other}", not a tweak declared above it`);
  }
  assert.deepEqual(
    parseTweaks({ first: { type: 'boolean', default: true, when: { later: true } }, later: { type: 'boolean', default: true } }),
    { ok: false, reason: 'first: when names "later", not a tweak declared above it' },
  );
  const LIST = 'density: when: layout\'s values must be a non-empty list of unique values, at most 64';
  const many = Array.from({ length: 65 }, (_, i) => `o${i}`);
  assert.deepEqual([reasonOf({ layout: [] }), reasonOf({ layout: ['list', 'list'] }), reasonOf({ layout: many })], [LIST, LIST, LIST]);
  assert.equal(reasonOf({ layout: 'tiles' }), 'density: when: "tiles" does not fit layout');
  assert.equal(reasonOf({ layout: ['list', 'tiles'] }), 'density: when: "tiles" does not fit layout');
  assert.equal(reasonOf({ gap: 30 }), 'density: when: 30 does not fit gap');
  assert.equal(reasonOf({ gap: '8' }), 'density: when: "8" does not fit gap');
  assert.equal(reasonOf({ layout: 'list', gap: 8 }), undefined);
});

test('shownTweaks shows a tweak whose when holds on the settled values: every key (AND), any value of a key\'s list (OR), text and number exactly, never under a tweak not shown (#1034)', () => {
  const schema = schemaOf(CONDITIONAL);
  const shown = (values: Record<string, DesignTweakValue>): string[] => [...shownTweaks(schema, values)];
  const ALWAYS = ['layout', 'auto', 'title', 'gap'];
  assert.deepEqual(shown({}), ALWAYS);
  assert.deepEqual(shown({ layout: 'list' }), [...ALWAYS, 'density']);
  assert.deepEqual(shown({ layout: 'list', density: 'compact' }), [...ALWAYS, 'density', 'icons']);
  assert.deepEqual(shown({ layout: 'board', density: 'compact' }), ALWAYS); // icons' parent is not shown
  assert.deepEqual(shown({ layout: 'grid', auto: false }), [...ALWAYS, 'dense']); // grid is in dense's list
  assert.deepEqual(shown({ layout: 'list', auto: false }), [...ALWAYS, 'density', 'dense']);
  assert.deepEqual(shown({ layout: 'grid', auto: true }), ALWAYS); // every key must hold
  assert.deepEqual(shown({ layout: 'grid', auto: false, title: 'fluxo' }), ALWAYS); // text exactly
  assert.deepEqual(shown({ layout: 'grid', auto: false, gap: 12 }), ALWAYS); // number exactly
  assert.deepEqual(shown({ layout: 'grid', auto: false, gap: 99 }), [...ALWAYS, 'dense']); // 99 settles to the default 8
  assert.equal(shownTweaks([], {}).size, 0);
});
