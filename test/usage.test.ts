import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAY_MS, HOUR_MS, hasBudget, isTranscriptPath, parseUsageLine, pruneUsage, sumTranscriptTokens, usageTotals,
} from '../src/usage.js';
import type { UsageSample } from '../src/types.js';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const MINUTE_MS = 60_000;

// One assistant line in the shape Claude Code writes: the same message.id repeats once per content block of a reply.
const assistant = (id: string, usage: Record<string, unknown>, text = 'x'): string =>
  JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }], usage } });
const sample = (ageMs: number, tokens: number): UsageSample => ({ at: new Date(NOW - ageMs).toISOString(), tokens });

// Writes a synthetic transcript: one JSON object per line, like the real `.jsonl` files.
async function writeTranscript(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hive-usage-'));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}

test('parseUsageLine ignores invalid JSON, non-assistant lines and assistant lines without usage or id', () => {
  assert.equal(parseUsageLine('{not json'), undefined);
  assert.equal(parseUsageLine(''), undefined);
  assert.equal(parseUsageLine('null'), undefined);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'user', message: { id: 'u1', usage: { input_tokens: 5 } } })), undefined);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'assistant', message: { id: 'a1' } })), undefined);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5 } } })), undefined);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'assistant', message: { id: 'a1', usage: null } })), undefined);
});

test('parseUsageLine sums the four usage fields and counts missing or non-numeric ones as 0', () => {
  const full = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 };
  assert.deepEqual(parseUsageLine(assistant('a1', full)), { id: 'a1', tokens: 4330 });
  assert.deepEqual(parseUsageLine(assistant('a2', { input_tokens: 7, output_tokens: 3 })), { id: 'a2', tokens: 10 });
  assert.deepEqual(parseUsageLine(assistant('a3', {})), { id: 'a3', tokens: 0 });
  assert.deepEqual(parseUsageLine(assistant('a4', { input_tokens: 'many', output_tokens: 2 })), { id: 'a4', tokens: 2 });
});

test('sumTranscriptTokens counts each message.id once, sums distinct ids and skips every other line', async () => {
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 };
  const path = await writeTranscript([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    assistant('m1', usage, 'first block'),
    assistant('m1', usage, 'second block of the same reply'),
    JSON.stringify({ type: 'progress' }),
    'garbage line',
    assistant('m2', { input_tokens: 10, output_tokens: 5 }),
  ]);
  assert.equal(await sumTranscriptTokens(path), 1165);
});

test('sumTranscriptTokens rejects for a missing file and resolves 0 for an empty one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-usage-'));
  await assert.rejects(sumTranscriptTokens(join(dir, 'missing.jsonl')), { code: 'ENOENT' });
  assert.equal(await sumTranscriptTokens(await writeTranscript([])), 0);
});

test('usageTotals separates the last hour from the last day', () => {
  const usage = [
    sample(30 * MINUTE_MS, 100), sample(59 * MINUTE_MS, 20), sample(61 * MINUTE_MS, 1000),
    sample(23 * HOUR_MS, 5000), sample(25 * HOUR_MS, 70_000),
  ];
  assert.deepEqual(usageTotals(usage, NOW), { hour: 120, day: 6120 });
  assert.deepEqual(usageTotals([], NOW), { hour: 0, day: 0 });
});

test('hasBudget: an absent or 0 limit never restricts; an exhausted hour or day limit does', () => {
  const usage = [sample(10 * MINUTE_MS, 900), sample(5 * HOUR_MS, 4000)]; // hour 900, day 4900
  assert.equal(hasBudget(usage, {}, NOW), true);
  assert.equal(hasBudget(usage, { maxTokensPerHour: 0, maxTokensPerDay: 0 }, NOW), true);
  assert.equal(hasBudget(usage, { maxTokensPerHour: 901, maxTokensPerDay: 4901 }, NOW), true);
  assert.equal(hasBudget(usage, { maxTokensPerHour: 900 }, NOW), false, 'hour exactly at the limit');
  assert.equal(hasBudget(usage, { maxTokensPerHour: 500 }, NOW), false);
  assert.equal(hasBudget(usage, { maxTokensPerHour: 5000, maxTokensPerDay: 4900 }, NOW), false, 'hour ok, day exhausted');
  assert.equal(hasBudget([], { maxTokensPerHour: 1, maxTokensPerDay: 1 }, NOW), true);
});

test('pruneUsage drops samples older than 24 h and keeps the rest in order', () => {
  const fresh = sample(0, 1);
  const hourOld = sample(HOUR_MS, 2);
  const edge = sample(DAY_MS, 3);
  const old = sample(DAY_MS + 1, 4);
  assert.deepEqual(pruneUsage([old, fresh, hourOld, edge], NOW), [fresh, hourOld, edge]);
  assert.deepEqual(pruneUsage([], NOW), []);
});

test('isTranscriptPath accepts only an absolute string ending in .jsonl', () => {
  assert.equal(isTranscriptPath('/Users/x/.claude/projects/p/abc.jsonl'), true);
  assert.equal(isTranscriptPath('relative/abc.jsonl'), false);
  assert.equal(isTranscriptPath('/Users/x/abc.json'), false);
  assert.equal(isTranscriptPath('/Users/x/abc.jsonl/'), false);
  assert.equal(isTranscriptPath(''), false);
  assert.equal(isTranscriptPath(undefined), false);
  assert.equal(isTranscriptPath(42), false);
});
