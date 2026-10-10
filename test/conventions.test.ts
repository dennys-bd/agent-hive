
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVENTION_KEYS, conventionValue, parseConventions } from '../src/conventions.js';

const KNOWN = 'docsRepo, specsDir, plansDir, walkthroughsDir, docsLanguage, chatLanguage, delivery, sliceSize, featureFlags, uiCheck, testCommand';

test('parseConventions keeps every key at its bounds, trimmed; absent and {} read as none (#692)', () => {
  assert.equal(CONVENTION_KEYS.join(', '), KNOWN);
  const all = {
    docsRepo: ' ../docs ', specsDir: 'docs/specs', plansDir: 'docs/plans', walkthroughsDir: 'docs/walkthroughs', docsLanguage: 'x'.repeat(40),
    chatLanguage: 'Português', delivery: 'stacked', sliceSize: { min: 50, max: 5000 }, featureFlags: 'partial', uiCheck: 'x'.repeat(2000), testCommand: 'x'.repeat(500),
  };
  assert.deepEqual(parseConventions(all), { ...all, docsRepo: '../docs' }, 'docsRepo may be relative to the worktree, .. included');
  assert.deepEqual(parseConventions({ sliceSize: { min: 300, max: 300 }, docsLanguage: ' E ' }), { sliceSize: { min: 300, max: 300 }, docsLanguage: 'E' });
  assert.deepEqual(parseConventions(undefined), {});
  assert.deepEqual(parseConventions({}), {});
  for (const delivery of ['single', 'stacked', 'integration']) assert.equal(conventionValue('delivery', delivery), delivery);
  for (const flags of ['none', 'partial', 'always']) assert.equal(conventionValue('featureFlags', flags), flags);
});

test('parseConventions answers the first problem as the tail of the parser\'s message, naming the key (#692)', () => {
  const refused = (raw: unknown, message: string): void => assert.equal(parseConventions(raw), message, JSON.stringify(raw));
  refused([], 'conventions must be an object');
  refused('x', 'conventions must be an object');
  refused({ flow: 'x' }, `conventions.flow is not a convention (known: ${KNOWN})`);
  for (const docsRepo of ['', '  ', 3]) refused({ docsRepo }, 'conventions.docsRepo must be a non-empty path');
  for (const specsDir of ['/abs', '../up', 'docs/../..', ' ', 7]) refused({ specsDir }, 'conventions.specsDir must be a relative path inside the docs repository');
  refused({ walkthroughsDir: 'a/..' }, 'conventions.walkthroughsDir must be a relative path inside the docs repository');
  for (const docsLanguage of ['', '   ', 'x'.repeat(41)]) refused({ docsLanguage }, 'conventions.docsLanguage must be a language name of 1 to 40 characters');
  refused({ delivery: 'trunk' }, 'conventions.delivery must be one of single, stacked, integration');
  const slice = 'conventions.sliceSize must be { min, max } with 50 ≤ min ≤ max ≤ 5000';
  for (const sliceSize of [{ min: 49, max: 300 }, { min: 300, max: 5001 }, { min: 600, max: 550 }, { min: 300.5, max: 550 }, { min: 300 }, 300, null]) refused({ sliceSize }, slice);
  refused({ featureFlags: 'some' }, 'conventions.featureFlags must be one of none, partial, always');
  refused({ uiCheck: 'x'.repeat(2001) }, 'conventions.uiCheck must be 1 to 2000 characters');
  refused({ testCommand: '' }, 'conventions.testCommand must be 1 to 500 characters');
});
