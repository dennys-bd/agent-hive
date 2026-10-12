import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkResumedAgents } from '../src/config-transitions.js';
import type { AgentId, Stage, Transition } from '../src/types.js';

// #925: AGENT_IDS holds only claude until 3.1, so a second agent is a cast: the check only compares ids
const OTHER = 'other' as AgentId;
const stage = (name: string, extra: Partial<Stage> = {}): Stage => ({ name, from: {}, prompt: `/${name}`, ...extra });
const T = (from: string, to: string, extra: Partial<Transition> = {}): Transition => ({ from, to, when: 'done', ...extra });
const check = (stages: Stage[], transitions: Transition[]) => () => checkResumedAgents(stages, transitions, 'claude');
const refusal = (i: number): { message: string } =>
  ({ message: `hive.config.json: "comb.transitions[${i}].session" resumes a session of claude in a stage of other: use "handoff" to switch agents (#692)` });

test('previous, continueOf and a plain move into a continue stage are refused when the resumed session is another agent\'s, naming the field (#925)', () => {
  const stages = [stage('Spec'), stage('Build', { agent: OTHER }), stage('Review', { agent: OTHER, session: 'continue' })];
  assert.throws(check(stages, [T('Spec', 'Build', { session: 'previous' })]), refusal(0));
  assert.throws(check(stages, [T('Build', 'Review'), T('Review', 'Build', { session: { continueOf: 'Spec' } })]), refusal(1));
  assert.throws(check(stages, [T('Spec', 'Review')]), refusal(0));
});

test('the same flows parse with one agent, a stage with no agent reading as the default; new and a new-session destination resume nothing (#925)', () => {
  const stages = [stage('Spec'), stage('Build', { agent: 'claude' }), stage('Review', { session: 'continue' })];
  assert.doesNotThrow(check(stages, [T('Spec', 'Build', { session: 'previous' }), T('Build', 'Review'), T('Review', 'Build', { session: { continueOf: 'Spec' } })]));
  const mixed = [stage('Spec'), stage('Build', { agent: OTHER })];
  assert.doesNotThrow(check(mixed, [T('Spec', 'Build', { session: 'new' }), T('Spec', 'Build')]));
});

test('a stage that spawns no agent is neither side of the check: a gate, a commands stage, the end (#925)', () => {
  const gate: Stage = { name: 'Gate', from: {}, approval: true };
  const checks: Stage = { name: 'Checks', from: {}, action: 'commands', commands: ['lint'], stopOnFailure: true, onMissing: 'fail' };
  const stages = [stage('Spec'), gate, checks, stage('Fix', { agent: OTHER, session: 'continue' })];
  assert.doesNotThrow(check(stages, [T('Spec', 'Gate', { session: 'previous' }), T('Checks', 'Fix'), T('Spec', 'end', { session: 'previous' })]));
});
