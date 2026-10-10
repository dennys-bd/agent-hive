import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  cleanTitle, DAY_MS, HOUR_MS, hasBudget, isTranscriptIn, isTranscriptPath, isWorkerTranscript, parseUsageLine, pruneUsage, readTranscript, transcriptDir, usageTotals,
} from '../src/usage.js';
import { ZERO_TOKENS } from '../src/events.js';
import type { UsageSample } from '../src/types.js';
import { tempDir, type AfterHost } from './temp-dir.js';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const MINUTE_MS = 60_000;

// One assistant line in the shape Claude Code writes: the same message.id repeats once per content block of a reply.
const assistant = (id: string, usage: Record<string, unknown>, text = 'x'): string =>
  JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }], usage } });
const sample = (ageMs: number, tokens: number): UsageSample => ({ at: new Date(NOW - ageMs).toISOString(), tokens });

// Writes a synthetic transcript: one JSON object per line, like the real `.jsonl` files.
async function writeTranscript(t: AfterHost, lines: string[]): Promise<string> {
  const dir = await tempDir(t, 'usage-');
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
  // 1e400 is valid JSON that parses to Infinity; counted it would make every budget check false for a day
  assert.deepEqual(parseUsageLine(`{"type":"assistant","message":{"id":"a5","usage":{"input_tokens":1e400,"output_tokens":2}}}`), { id: 'a5', tokens: 2 });
});

test('readTranscript counts each message.id once, sums distinct ids and skips every other line', async (t) => {
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 };
  const path = await writeTranscript(t, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    assistant('m1', usage, 'first block'),
    assistant('m1', usage, 'second block of the same reply'),
    JSON.stringify({ type: 'progress' }),
    'garbage line',
    assistant('m2', { input_tokens: 10, output_tokens: 5 }),
  ]);
  assert.deepEqual(await readTranscript(path), { tokens: 1165 });
});

test('readTranscript rejects for a missing file and resolves 0 for an empty one', async (t) => {
  const dir = await tempDir(t, 'usage-');
  await assert.rejects(readTranscript(join(dir, 'missing.jsonl')), { code: 'ENOENT' });
  assert.deepEqual(await readTranscript(await writeTranscript(t, [])), { tokens: 0 });
});

test('readTranscript rejects anything that is not a regular file instead of waiting on it forever', async (t) => {
  const dir = await tempDir(t, 'usage-');
  const fifo = join(dir, 'fifo.jsonl');
  await promisify(execFile)('mkfifo', [fifo]); // a FIFO with no writer never reaches EOF
  await assert.rejects(readTranscript(fifo), /not a regular file/);
  await assert.rejects(readTranscript(dir), /not a regular file/);
});

test('readTranscript rejects when finite fields overflow the total to Infinity', async (t) => {
  const huge = { input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE };
  await assert.rejects(readTranscript(await writeTranscript(t, [assistant('a1', huge), assistant('a2', huge)])), /not finite/);
});

// A /rename line in the shape Claude Code appends to the transcript (#489)
const titled = (customTitle: unknown): string => JSON.stringify({ type: 'custom-title', customTitle, sessionId: 'a1b2c3d4-0000-4000-8000-000000000001' });

test('readTranscript returns the last /rename title beside the tokens, which title lines leave unchanged; no /rename, no title (#489)', async (t) => {
  const reply = assistant('m1', { input_tokens: 100, output_tokens: 50 });
  const mention = JSON.stringify({ type: 'user', message: { role: 'user', content: 'custom-title' } }); // names the type, is not one
  const path = await writeTranscript(t, [titled('first name'), reply, titled('fix the login'), mention]);
  assert.deepEqual(await readTranscript(path), { tokens: 150, title: 'fix the login' });
  assert.deepEqual(await readTranscript(await writeTranscript(t, [reply, mention])), { tokens: 150 });
  // cleaned before it leaves; a line cleaned to nothing, or not a string, leaves the title read before it
  const odd = await writeTranscript(t, [titled(`\u0007${'y'.repeat(70)}`), titled('   '), titled(42), reply]);
  assert.deepEqual(await readTranscript(odd), { tokens: 150, title: 'y'.repeat(60) });
});

test('cleanTitle drops control characters, trims, keeps at most 60 characters without splitting one, and reads an empty or non-string title as none (#489)', () => {
  assert.equal(cleanTitle('  fix\u0007 the\u0000 login\n '), 'fix the login');
  assert.equal(cleanTitle('\u202Enigol\u2066 the\u2069\u200F fix'), 'nigol the fix', 'bidi controls dropped: a label never reads reordered');
  assert.equal(cleanTitle('👩\u200D💻 dev'), '👩\u200D💻 dev', 'a zero-width joiner stays: an emoji sequence keeps its shape');
  assert.equal(cleanTitle('x'.repeat(80)), 'x'.repeat(60));
  assert.equal(cleanTitle(`${'x'.repeat(59)}😀😀`), `${'x'.repeat(59)}😀`, 'code points, not UTF-16 units: no lone surrogate');
  assert.equal(cleanTitle(`${'x'.repeat(59)} tail`), 'x'.repeat(59), 'trimmed again after the cut');
  for (const value of ['', '   ', '\u0007\n\u009b', 42, null, undefined, { customTitle: 'x' }]) assert.equal(cleanTitle(value), undefined, String(value));
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

test('transcriptDir is <config dir>/projects/<cwd with every non-alphanumeric as ->; CLAUDE_CONFIG_DIR wins over ~/.claude', () => {
  assert.equal(transcriptDir('/Users/x/my repo/.claude/worktrees/hive-7-fix', {}), join(homedir(), '.claude', 'projects', '-Users-x-my-repo--claude-worktrees-hive-7-fix'));
  assert.equal(transcriptDir('/w', { CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg/projects/-w');
});

test('transcriptDir ignores an empty or relative CLAUDE_CONFIG_DIR (#236)', () => {
  for (const CLAUDE_CONFIG_DIR of ['', '  ', 'cfg', './cfg']) {
    assert.equal(transcriptDir('/w', { CLAUDE_CONFIG_DIR }), join(homedir(), '.claude', 'projects', '-w'));
  }
});

const TASK7 = { slug: 'hive-7-fix' };

test('isWorkerTranscript accepts only a .jsonl directly under the transcript dir of the worker worktree', () => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg' };
  const own = '/cfg/projects/-repo--hive-worktrees-hive-7-fix/abc.jsonl';
  assert.equal(isWorkerTranscript(own, '/repo', TASK7, env), true);
  assert.equal(isWorkerTranscript('/cfg/projects/-repo--hive-worktrees-hive-8-other/abc.jsonl', '/repo', TASK7, env), false, 'another worker');
  assert.equal(isWorkerTranscript('/cfg/projects/-Users-x-secret/abc.jsonl', '/repo', TASK7, env), false, 'another project');
  assert.equal(isWorkerTranscript('/cfg/projects/-repo--hive-worktrees-hive-7-fix/sub/abc.jsonl', '/repo', TASK7, env), false, 'a subdirectory');
  assert.equal(isWorkerTranscript('/cfg/projects/-repo--hive-worktrees-hive-7-fix/../x/abc.jsonl', '/repo', TASK7, env), false, 'no traversal');
  assert.equal(isWorkerTranscript('/cfg/projects/-repo--hive-worktrees-hive-7-fix/abc.json', '/repo', TASK7, env), false);
  assert.equal(isWorkerTranscript(undefined, '/repo', TASK7, env), false);
});

test('isWorkerTranscript on a checkout task accepts a .jsonl under the project\'s own transcript dir, and no longer the worktree\'s (#444)', () => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg' };
  const checkout = { ...TASK7, local: true as const };
  assert.equal(isWorkerTranscript('/cfg/projects/-repo/abc.jsonl', '/repo', checkout, env), true, 'its usage keeps counting');
  assert.equal(isWorkerTranscript('/cfg/projects/-repo--hive-worktrees-hive-7-fix/abc.jsonl', '/repo', checkout, env), false);
});

test('isTranscriptIn takes only a .jsonl directly under the transcript folder of the given checkout (#590)', () => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg' };
  assert.equal(isTranscriptIn('/cfg/projects/-repo/abc.jsonl', '/repo', env), true);
  assert.equal(isTranscriptIn('/cfg/projects/-repo--hive-worktrees-hive-7-fix/abc.jsonl', '/repo', env), false, 'a worktree of it');
  assert.equal(isTranscriptIn('/cfg/projects/-repo/sub/abc.jsonl', '/repo', env), false);
  assert.equal(isTranscriptIn('relative/abc.jsonl', '/repo', env), false);
});

test('readTranscript with a since also sums by type the turns from that time on and lists their models, each message once; without it the read is as before (#742)', async (t) => {
  const line = (id: string, at: string, model: string, usage: Record<string, number>): string =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model, usage } });
  const later = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 };
  const path = await writeTranscript(t, [
    line('a1', '2026-10-03T11:59:00.000Z', 'claude-sonnet-4-5', { input_tokens: 1, output_tokens: 1 }), // before the stage run
    line('a2', '2026-10-03T12:00:01.000Z', 'claude-opus-4-1', later),
    line('a2', '2026-10-03T12:00:01.000Z', 'claude-opus-4-1', later), // the same message, another content block
    line('a3', '2026-10-03T12:00:02.000Z', 'claude-haiku-4-5', { output_tokens: 5 }),
    JSON.stringify({ type: 'assistant', message: { id: 'a4', usage: { output_tokens: 7 } } }), // no time: never the stage run's
  ]);
  assert.deepEqual(await readTranscript(path, Date.parse('2026-10-03T12:00:00.000Z')), {
    tokens: 114, usage: { tokens: { input: 10, output: 25, cache_write: 30, cache_read: 40 }, models: ['claude-opus-4-1', 'claude-haiku-4-5'], subagentTokens: ZERO_TOKENS },
  });
  assert.deepEqual(await readTranscript(path), { tokens: 114 });
});

test('readTranscript with a since adds the session\'s subagent transcripts to the stage run\'s usage and as its subagent share; only .jsonl regular files directly under its own subagents folder; the session total is untouched (#742)', async (t) => {
  const line = (id: string, at: string, model: string, usage: Record<string, number>): string =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model, usage } });
  const path = await writeTranscript(t, [line('m1', '2026-10-03T12:00:01.000Z', 'claude-opus-4-1', { input_tokens: 10, output_tokens: 1 })]);
  const sub = join(dirname(path), 'session', 'subagents'); // <transcript dir>/<session_id>/subagents
  await mkdir(join(sub, 'deeper'), { recursive: true });
  const write = (name: string, lines: string[]): Promise<void> => writeFile(join(sub, name), lines.map((l) => `${l}\n`).join(''));
  await write('agent-a1.jsonl', [
    line('s0', '2026-10-03T11:59:00.000Z', 'claude-haiku-4-5', { input_tokens: 1000 }), // before the stage run
    line('s1', '2026-10-03T12:00:02.000Z', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 3 }),
    line('s1', '2026-10-03T12:00:02.000Z', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 3 }), // another block
    line('m1', '2026-10-03T12:00:01.000Z', 'claude-opus-4-1', { input_tokens: 10, output_tokens: 1 }), // a message id already counted
  ]);
  await write('agent-a1.meta.json', [JSON.stringify({ agentType: 'Explore' })]);
  await write('agent-a2.jsonl', [line('s2', '2026-10-03T12:00:03.000Z', 'claude-sonnet-4-5', { output_tokens: 7 })]);
  await writeFile(join(sub, 'deeper', 'agent-z.jsonl'), `${line('z1', '2026-10-03T12:00:04.000Z', 'x', { input_tokens: 9999 })}\n`); // not directly under
  await mkdir(join(sub, 'agent-dir.jsonl')); // a folder, not a file
  await symlink(path, join(sub, 'agent-link.jsonl')); // a link, not a regular file
  await write('agent-locked.jsonl', [line('l1', '2026-10-03T12:00:05.000Z', 'x', { input_tokens: 5000 })]);
  await chmod(join(sub, 'agent-locked.jsonl'), 0o000); // unreadable: costs only its own share, never the read
  assert.deepEqual(await readTranscript(path, Date.parse('2026-10-03T12:00:00.000Z')), {
    tokens: 11,
    usage: {
      tokens: { input: 110, output: 28, cache_write: 0, cache_read: 3 }, models: ['claude-opus-4-1', 'claude-haiku-4-5', 'claude-sonnet-4-5'],
      subagentTokens: { input: 100, output: 27, cache_write: 0, cache_read: 3 },
    },
  });
  assert.deepEqual(await readTranscript(path), { tokens: 11 }, 'the session total, for budgets, never reads the subagents');
});

test('readTranscript skips a subagent transcript last written before the stage run, and never follows a linked session or subagents folder (#742)', async (t) => {
  const SINCE = Date.parse('2026-10-03T12:00:00.000Z');
  const line = (id: string, at: string): string => JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model: 'm', usage: { input_tokens: 10 } } });
  const path = await writeTranscript(t, []);
  const sub = join(dirname(path), 'session', 'subagents');
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, 'agent-old.jsonl'), `${line('o1', '2026-10-03T12:00:05.000Z')}\n`); // a stale mtime: never opened
  await utimes(join(sub, 'agent-old.jsonl'), new Date(SINCE - 60_000), new Date(SINCE - 60_000));
  await writeFile(join(sub, 'agent-new.jsonl'), `${line('n1', '2026-10-03T12:00:06.000Z')}\n`);
  assert.deepEqual((await readTranscript(path, SINCE)).usage?.subagentTokens, { input: 10, output: 0, cache_write: 0, cache_read: 0 });
  const linkedSub = await writeTranscript(t, []); // its subagents folder is a link to the real one
  await mkdir(join(dirname(linkedSub), 'session'));
  await symlink(sub, join(dirname(linkedSub), 'session', 'subagents'));
  assert.deepEqual((await readTranscript(linkedSub, SINCE)).usage?.subagentTokens, ZERO_TOKENS, 'a linked subagents folder');
  const linkedSession = await writeTranscript(t, []); // its session folder is a link
  await symlink(join(dirname(path), 'session'), join(dirname(linkedSession), 'session'));
  assert.deepEqual((await readTranscript(linkedSession, SINCE)).usage?.subagentTokens, ZERO_TOKENS, 'a linked session folder');
});
