import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableRunners, runners } from '../../src/agents/registry.js';
import { AGENT_IDS } from '../../src/types.js';

test('every agent of AGENT_IDS has a runner, and availableRunners keeps the ones boot found (#924)', () => {
  assert.deepEqual(Object.keys(runners).sort(), [...AGENT_IDS].sort());
  assert.deepEqual(availableRunners([{ agent: 'claude', available: true }]), [runners.claude]);
  assert.deepEqual(availableRunners([{ agent: 'claude', available: false }]), []);
});

test('Claude\'s runner strips the env a Hive started from inside Claude Code would pass on (#924)', () => {
  assert.deepEqual(runners.claude.hostEnv, ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION']);
});
