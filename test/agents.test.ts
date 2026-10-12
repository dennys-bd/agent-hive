import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, agentOf, agentRefusal, detectAgents, knownAgent, liveDefaultAgent, ranAgent, savedAgent, stageAgentIn } from '../src/agents.js';
import { runners } from '../src/agents/registry.js';
import { AGENT_IDS, DEFAULT_AGENT, type AgentId, type Exec } from '../src/types.js';

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

test('every agent has a probe command, a label and its subcommands; Claude\'s protocol file rides --append-system-prompt-file (#516, #167, #924)', () => {
  for (const id of AGENT_IDS) {
    assert.ok(AGENTS[id].command.length > 0, id);
    assert.ok(AGENTS[id].label.length > 0, id);
    assert.ok(AGENTS[id].subcommands.length > 0, id);
  }
  const argv = runners.claude.launch({ ptyId: 'W1', cwd: '/wt', port: 4242, withHive: true, hooksPath: '/h', pluginDir: '/p', protocolPath: '/s.md', extraArgs: [] });
  assert.deepEqual(argv.at(-1), ['--append-system-prompt-file', '/s.md'], 'appends to Claude Code\'s own system prompt, in interactive runs and with --resume');
});

// #925: AGENT_IDS holds only claude until 3.1; these helpers only pass ids through, so a second one is a cast
const OTHER = 'other' as AgentId;

test('knownAgent keeps an id AGENT_IDS has; savedAgent reads anything else as claude, what every run before #925 ran (#925)', () => {
  assert.equal(knownAgent('claude'), 'claude');
  for (const value of [undefined, null, 7, '', 'gpt']) {
    assert.equal(knownAgent(value), undefined, String(value));
    assert.equal(savedAgent(value), 'claude', String(value));
  }
});

test('ranAgent is a run\'s own agent, claude on a literal built without one; the live default is the state\'s; a stage\'s own wins (#925)', () => {
  assert.equal(ranAgent({ agent: OTHER }), OTHER);
  assert.equal(ranAgent({}), 'claude');
  assert.equal(liveDefaultAgent({ defaultAgent: OTHER }), OTHER);
  assert.equal(liveDefaultAgent({}), DEFAULT_AGENT);
  assert.equal(stageAgentIn({ defaultAgent: OTHER }, {}), OTHER);
  assert.equal(stageAgentIn({ defaultAgent: OTHER }, { agent: 'claude' }), 'claude');
});

test('claude reports plan limits: the header offers their refresh (#925)', () => {
  assert.equal(AGENTS.claude.planLimits, true);
});

test('codex runs as `codex`, reports no plan limits until #929 and cannot choose its session id; claude can (#927)', () => {
  assert.deepEqual(AGENT_IDS, ['claude', 'codex']);
  assert.deepEqual([AGENTS.codex.label, AGENTS.codex.command, AGENTS.codex.planLimits, AGENTS.codex.canChooseSessionId], ['Codex', 'codex', false, false]);
  assert.equal(AGENTS.claude.canChooseSessionId, true);
  assert.ok(AGENTS.codex.subcommands.includes('exec'));
  assert.ok(['resume', 'fork'].every((c) => AGENTS.codex.subcommands.includes(c)), 'both open a session the user chose: the shim runs them as typed (#932)');
  assert.deepEqual(AGENTS.codex.shimFlags, ['-h', '--help', '-V', '--version'], 'no -c: Codex\'s is a config override, not continue (#932)');
  assert.ok(AGENTS.claude.shimFlags.includes('-c') && AGENTS.claude.shimFlags.includes('--resume=*'));
});
