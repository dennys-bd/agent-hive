import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS } from '../../src/agents.js';
import { planLimitsReading, runners } from '../../src/agents/registry.js';
import { transcriptDir } from '../../src/agents/claude-transcript.js';
import { AGENT_IDS, type AgentId, type RateLimits } from '../../src/types.js';
import { isTranscriptIn } from '../../src/usage.js';
import { tempDir } from '../temp-dir.js';

test('every agent of AGENT_IDS has a runner (#924)', () => {
  assert.deepEqual(Object.keys(runners).sort(), [...AGENT_IDS].sort());
});

test('Claude\'s runner strips the env a Hive started from inside Claude Code would pass on (#924)', () => {
  assert.deepEqual(runners.claude.hostEnv, ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION']);
});

test('shared code reads a run\'s transcripts and status line through its agent\'s runner (#924)', async (t) => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg' };
  assert.equal(runners.claude.transcriptDir('/repo', env), transcriptDir('/repo', env));
  assert.equal(isTranscriptIn(join(transcriptDir('/repo', env), 'a.jsonl'), '/repo', 'claude', env), true);
  const path = join(await tempDir(t, 'agents-'), 's.jsonl');
  await writeFile(path, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n${JSON.stringify({ type: 'assistant', message: { id: 'm1' } })}\n`);
  assert.equal(await runners.claude.countMessages(path), 2);
  assert.equal(runners.claude.statusLimits({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1_800_000_000 } } }, 0)?.windows.five_hour?.usedPercent, 5);
});

test('planLimitsReading reads every agent whose entry has plan limits and lists a failing one with its reason; no reading is no failure (#929)', async () => {
  const reading: RateLimits = { at: '2026-10-12T12:00:00.000Z', windows: { five_hour: { usedPercent: 5, resetsAt: '2026-10-12T15:00:00.000Z' } } };
  const table = (claude: () => Promise<RateLimits | undefined>) => ({ claude: { planLimits: claude }, codex: { planLimits: async () => undefined } });
  assert.deepEqual(await planLimitsReading(undefined, table(async () => reading)), { readings: [{ agent: 'claude', rateLimits: reading }], failures: [] });
  assert.deepEqual(await planLimitsReading(undefined, table(async () => { throw new Error('HTTP 401'); })), { readings: [], failures: [{ agent: 'claude', reason: 'HTTP 401' }] });
  assert.deepEqual(await planLimitsReading(undefined, table(async () => undefined)), { readings: [], failures: [] });
});

test('Codex has plan limits too, and one agent\'s failure never costs another\'s reading (#929)', async () => {
  assert.deepEqual(AGENT_IDS.filter((id) => AGENTS[id].planLimits), ['claude', 'codex']);
  const codex: RateLimits = { at: '2026-10-12T12:00:00.000Z', windows: { thirty_day: { usedPercent: 40, resetsAt: '2026-11-01T00:00:00.000Z' } } };
  const report = await planLimitsReading(undefined, { claude: { planLimits: async () => { throw new Error('no Claude Code OAuth token'); } }, codex: { planLimits: async () => codex } });
  assert.deepEqual(report, { readings: [{ agent: 'codex', rateLimits: codex }], failures: [{ agent: 'claude', reason: 'no Claude Code OAuth token' }] });
});

test('planLimitsReading reads only the listed agents, in AGENT_IDS order, never one without plan limits; no list reads every one (#223)', async () => {
  const at = '2026-10-12T12:00:00.000Z';
  const claude: RateLimits = { at, windows: { five_hour: { usedPercent: 5, resetsAt: '2026-10-12T15:00:00.000Z' } } };
  const codex: RateLimits = { at, windows: { thirty_day: { usedPercent: 40, resetsAt: '2026-11-01T00:00:00.000Z' } } };
  const read: AgentId[] = [];
  const table = {
    claude: { planLimits: async () => { read.push('claude'); return claude; } },
    codex: { planLimits: async () => { read.push('codex'); return codex; } },
  };
  assert.deepEqual(await planLimitsReading(['codex'], table), { readings: [{ agent: 'codex', rateLimits: codex }], failures: [] });
  // no agent lacks planLimits today: an id outside AGENT_IDS takes the same filter
  assert.deepEqual(await planLimitsReading(['nope' as AgentId], table), { readings: [], failures: [] });
  const both = { readings: [{ agent: 'claude', rateLimits: claude }, { agent: 'codex', rateLimits: codex }], failures: [] };
  assert.deepEqual(await planLimitsReading(['codex', 'claude'], table), both, 'AGENT_IDS order, not the list\'s');
  assert.deepEqual(await planLimitsReading(undefined, table), both);
  assert.deepEqual(read, ['codex', 'claude', 'codex', 'claude', 'codex']);
});
