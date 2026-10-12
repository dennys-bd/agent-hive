import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEvent } from '../src/log.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { AgentId } from '../src/types.js';

// #925: every run records its agent. AGENT_IDS holds only claude until 3.1; the reducer only compares and copies ids, so a second agent
// is a cast
const OTHER = 'other' as AgentId;

test('setDefaultAgent puts the config\'s default agent on the live state with no effect, and the log names it (#925)', () => {
  const { state, effects } = reduce(initialState(1), { type: 'setDefaultAgent', agent: OTHER });
  assert.deepEqual([state.defaultAgent, effects], [OTHER, []]);
  assert.equal(describeEvent({ type: 'setDefaultAgent', agent: 'claude' }), 'setDefaultAgent claude');
});
