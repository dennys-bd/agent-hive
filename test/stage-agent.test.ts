import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPrompt, commandFirst, hasFixedVerdicts, hiveAction, holdsWorker, rubricLines, runsAgent } from '../src/stage-agent.js';
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

test('commandFirst splits a prompt opening on a slash command into its command line and the rest, so composers keep it first (#710)', () => {
  assert.deepEqual(commandFirst('/hive:new-plan'), { command: '/hive:new-plan', rest: '' });
  assert.deepEqual(commandFirst('  /build {url}\n\nthen push'), { command: '/build {url}', rest: 'then push' });
  assert.deepEqual(commandFirst('/build x\r\nthen push'), { command: '/build x', rest: 'then push' }, 'a CRLF config');
  assert.deepEqual(commandFirst('/hive:new-plan\r'), { command: '/hive:new-plan', rest: '' });
  assert.equal(commandFirst('Run /hive:new-plan'), undefined);
  assert.equal(commandFirst('/ alone'), undefined);
  assert.equal(commandFirst('docs/x.md'), undefined);
});

test('rubricLines: every non-blank line, trimmed, in order; a blank rubric has none (#877)', () => {
  assert.deepEqual(rubricLines(' a \n\n\tb\r\n  \nc'), ['a', 'b', 'c']);
  assert.deepEqual(rubricLines(' \n '), []);
});

test('hasFixedVerdicts: commands, a wait for CI and an evaluation; holdsWorker: commands and an evaluation (#877)', () => {
  const actions = ['', 'commands', 'waitForCi', 'evaluate', 'skill', 'deleteActivity'] as const;
  assert.deepEqual(actions.map((action) => hasFixedVerdicts({ action })), [false, true, true, true, false, false]);
  assert.deepEqual(actions.map((action) => holdsWorker({ action })), [false, true, false, true, false, false]);
  assert.equal(holdsWorker(undefined), false);
});
