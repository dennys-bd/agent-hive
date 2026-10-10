import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, agentOf, agentRefusal, detectAgents } from '../src/agents.js';
import { AGENT_IDS, DEFAULT_AGENT, type Exec } from '../src/types.js';

const REFUSAL = 'agent claude is not on PATH: install it, then restart the Hive';

test('detectAgents runs `<command> --version` once per agent, in AGENT_IDS order: a resolved exec is available, a rejected one is not (#516)', async () => {
  const calls: string[][] = [];
  const found: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: '1.0.0' };
  };
  assert.deepEqual(await detectAgents(found), AGENT_IDS.map((agent) => ({ agent, available: true })));
  assert.deepEqual(calls, AGENT_IDS.map((id) => [AGENTS[id].command, '--version']));

  const missing: Exec = async () => {
    throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  };
  assert.deepEqual(await detectAgents(missing), AGENT_IDS.map((agent) => ({ agent, available: false })));
});

test("agentOf answers the stage's own agent, else the config's default (#516)", () => {
  assert.equal(agentOf({ agent: 'claude' }, { defaultAgent: 'claude' }), 'claude');
  assert.equal(agentOf({}, { defaultAgent: 'claude' }), 'claude');
  assert.equal(DEFAULT_AGENT, 'claude');
});

test('agentRefusal passes an available agent and names one that is unavailable or was never detected (#516)', () => {
  assert.equal(agentRefusal('claude', [{ agent: 'claude', available: true }]), undefined);
  assert.equal(agentRefusal('claude', [{ agent: 'claude', available: false }]), REFUSAL);
  assert.equal(agentRefusal('claude', []), REFUSAL);
});

test('every agent has a probe command, a model flag and a protocol flag (#516, #167)', () => {
  for (const id of AGENT_IDS) {
    assert.ok(AGENTS[id].command.length > 0, id);
    assert.ok(AGENTS[id].label.length > 0, id);
    assert.match(AGENTS[id].modelFlag, /^-/, id);
    assert.match(AGENTS[id].protocolFlag, /^-/, id);
  }
  assert.equal(AGENTS.claude.protocolFlag, '--append-system-prompt-file', 'appends to Claude Code\'s own system prompt, in interactive runs and with --resume');
});
