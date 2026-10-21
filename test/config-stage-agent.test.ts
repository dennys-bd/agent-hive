import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { combConfig, FILTER } from './fakes.js';

// #710: a skill stage and a stage's specialized agent, through the whole parse
const github = (stages: unknown[]) => combConfig({ source: { type: 'github', owner: '@me', number: 6, filter: FILTER }, stages, transitions: [] });
const stage = (extra: Record<string, unknown>) => ({ name: 'plan', from: { board: ['Ready'] }, ...extra });
const parsed = (extra: Record<string, unknown>) => parseConfig(github([stage(extra)])).comb.stages[0];
const refused = (extra: Record<string, unknown>, message: string): void =>
  assert.throws(() => parsed(extra), { message: `hive.config.json: "comb.stages[0].${message}` }, JSON.stringify(extra));
const SKILL = { action: 'skill', skill: 'new-plan' };
const BAD_SKILL = 'skill" must be a Hive skill\'s name: lowercase letters, digits and hyphens';
const NEEDS_AGENT = 'specializedAgent" needs a stage that runs an agent: a "prompt" or "action": "skill"';

test('a skill stage parses with every key a prompt stage takes; specializedAgent rides on a prompt stage too, absent = none (#710)', () => {
  const full = { ...SKILL, agent: 'claude', model: 'opus', session: 'new', specializedAgent: 'hive:planner', approval: true, handoff: true, verdicts: ['redo'], maxWorkers: 1, after: '1h' };
  assert.deepEqual(parsed(full), { name: 'plan', from: { board: ['Ready'] }, ...full });
  assert.equal(parsed({ prompt: '/x', specializedAgent: 'hive:designer' }).specializedAgent, 'hive:designer');
  assert.equal('specializedAgent' in parsed({ prompt: '/x' }), false);
});

test('skill is required with action skill, held to a skill name, refused anywhere else; prompt is refused next to it (#710)', () => {
  for (const skill of [undefined, 'hive:new-plan', '../x', 'New-Plan', '', 3]) refused({ action: 'skill', skill }, BAD_SKILL);
  refused({ prompt: '/x', skill: 'new-plan' }, 'skill" needs "action": "skill"');
  refused({ action: 'deleteActivity', skill: 'new-plan' }, 'skill" needs "action": "skill"');
  refused({ ...SKILL, prompt: '/x' }, 'action" cannot be combined with "prompt"');
});

test('specializedAgent is hive:<name>, on a stage that runs an agent only (#710)', () => {
  refused({ action: 'deleteActivity', specializedAgent: 'hive:planner' }, NEEDS_AGENT);
  refused({ specializedAgent: 'hive:planner' }, NEEDS_AGENT); // a show-only stage runs nothing
  for (const bad of ['planner', 'hive:Planner', 'other:planner', 'hive:a/b', 7]) refused({ ...SKILL, specializedAgent: bad }, 'specializedAgent" must be hive:<name>, lowercase letters, digits and hyphens');
});
