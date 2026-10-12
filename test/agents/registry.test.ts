import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLimitsReading, runners } from '../../src/agents/registry.js';
import { transcriptDir } from '../../src/agents/claude-transcript.js';
import { AGENT_IDS, type RateLimits } from '../../src/types.js';
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
  assert.deepEqual(await planLimitsReading(table(async () => reading)), { readings: [{ agent: 'claude', rateLimits: reading }], failures: [] });
  assert.deepEqual(await planLimitsReading(table(async () => { throw new Error('HTTP 401'); })), { readings: [], failures: [{ agent: 'claude', reason: 'HTTP 401' }] });
  assert.deepEqual(await planLimitsReading(table(async () => undefined)), { readings: [], failures: [] });
});
