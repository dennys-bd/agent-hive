import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPrompt, hiveAction, runsAgent } from '../src/stage-agent.js';
import type { Stage } from '../src/types.js';

const stage = (extra: Partial<Stage>): Stage => ({ name: 's', from: {}, ...extra });

test('agentPrompt: a prompt stage\'s prompt, /hive:<skill> on a skill stage, nothing on a gate, a show-only stage or a Hive action (#710)', () => {
  assert.equal(agentPrompt(stage({ prompt: '/hive:new-plan {url}' })), '/hive:new-plan {url}');
  assert.equal(agentPrompt(stage({ action: 'skill', skill: 'new-plan' })), '/hive:new-plan');
  const none = [stage({ approval: true }), stage({}), stage({ action: 'commands', commands: ['lint'] }), stage({ action: 'waitForCi' }), stage({ action: 'deleteActivity' })];
  for (const s of none) assert.equal(agentPrompt(s), undefined, JSON.stringify(s));
});

test('runsAgent is a prompt or a skill stage; hiveAction names the actions the Hive runs itself, never skill (#710)', () => {
  assert.deepEqual([stage({ prompt: '/x' }), stage({ action: 'skill', skill: 'new-plan' }), stage({ approval: true }), stage({ action: 'commands' })].map((s) => runsAgent(s)), [true, true, false, false]);
  assert.deepEqual([stage({ action: 'skill', skill: 'x' }), stage({ prompt: '/x' }), stage({ action: 'waitForCi' }), undefined].map((s) => hiveAction(s)), [undefined, undefined, 'waitForCi', undefined]);
});
