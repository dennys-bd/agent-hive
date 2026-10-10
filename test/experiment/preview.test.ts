import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runConfig } from '../../scripts/experiment/arm-config.js';
import { runBranch, runPrefix } from '../../scripts/experiment/plan.js';
import { PREVIEW_TOKENS, previewHome } from '../../scripts/experiment/preview-home.js';
import { STAGES, TASKS, WORKSPACE } from './fixtures.js';

const STATE = '/state';

test('a preview home holds the arm\'s run config as a run would write it, under a home of its own (#105)', () => {
  for (const arm of ['a', 'b'] as const) {
    const token = PREVIEW_TOKENS[arm];
    const { home, config } = previewHome({ stages: STAGES, tasks: TASKS }, arm, WORKSPACE, STATE);
    assert.equal(home, join(STATE, 'homes', `preview-${arm}`));
    assert.deepEqual(config, runConfig(STAGES, arm, runBranch(token), WORKSPACE, runPrefix(token), { state: STATE, home }));
  }
});

test('a preview starts nothing: every delivery sits in the first stage with auto off (#105)', () => {
  const { state } = previewHome({ stages: STAGES, tasks: TASKS }, 'a', WORKSPACE, STATE);
  const tasks = (state as { tasks: { auto: boolean; stage: string }[] }).tasks;
  assert.equal(tasks.length, TASKS.length);
  assert.ok(tasks.every((t) => !t.auto && t.stage === STAGES.stages[0]?.name));
});

test('the two arms preview under different task prefixes, as a pair runs (#105)', () => {
  assert.notEqual(runPrefix(PREVIEW_TOKENS.a), runPrefix(PREVIEW_TOKENS.b));
  for (const token of Object.values(PREVIEW_TOKENS)) assert.match(token, /^[0-9a-f]{6}$/);
});
