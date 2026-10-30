import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARM_OVERRIDES, STAGE_OVERRIDE } from '../../src/benchmark/schemas.js';

test('arm overrides refuse an items key that is not an item id, which would drop the experiment on the next load (#462)', () => {
  assert.equal(ARM_OVERRIDES.safeParse({ items: { 'a/../b': 'v1' } }).success, false);
  assert.equal(ARM_OVERRIDES.safeParse({ stages: { Build: { agent: 'codex', model: null } } }).success, true);
});

test('arm overrides key stages by name, never __proto__, and hold no flow (#536)', () => {
  // zod drops a __proto__ key on its own: what reaches mergeArm holds no such stage
  const parsed = ARM_OVERRIDES.safeParse(JSON.parse('{"stages":{"__proto__":{"agent":"codex"}}}'));
  assert.ok(parsed.success);
  assert.equal(Object.hasOwn(parsed.data.stages ?? {}, '__proto__'), false);
  assert.equal(ARM_OVERRIDES.safeParse({ flow: {} }).success, false);
});

test("STAGE_OVERRIDE takes only the editable fields; a null model is the agent's default (#536)", () => {
  assert.equal(STAGE_OVERRIDE.safeParse({ agent: 'codex', model: null }).success, true);
  for (const bad of [{ from: {} }, { model: '' }, { skill: 'Bad Name' }, { threshold: 11 }, { commands: [] }]) assert.equal(STAGE_OVERRIDE.safeParse(bad).success, false, JSON.stringify(bad));
});
