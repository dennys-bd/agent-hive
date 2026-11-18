import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countMessages, ownsTranscript, readTurn, sessionFiles } from '../../src/agents/copilot-transcript.js';
import { ZERO_TOKENS } from '../../src/facts.js';
import { fakeMachine, machineWith } from '../fake-machine.js';
import { tempDir } from '../temp-dir.js';

const ID = '3f1c2a9e-0b7d-4c55-8a10-5d6e7f809abc';
const OTHER_ID = '9a8b7c6d-1111-4222-8333-444455556666';
const CWD = '/work/repo';
const FIRST = Date.parse('2026-11-18T13:10:00.000Z');
const BETWEEN = Date.parse('2026-11-18T13:12:00.000Z');

const event = (type: string, id: string, timestamp: string, data: unknown, agentId: string | null = null): string =>
  JSON.stringify({ type, data, id, timestamp, parentId: null, agentId });
const usage = (id: string, timestamp: string, model: string, u: { input: number; output: number; read?: number; write?: number }, agentId: string | null = null): string =>
  event('session.usage_record', id, timestamp, { usage: { model, inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.read ?? 0, cacheWriteTokens: u.write ?? 0, reasoningTokens: 7, cost: 1 } }, agentId);

// Two prompts; the second runs a shell call and a subagent. A usage record repeated by id must count once.
const EVENTS = [
  event('session.start', 'e0', '2026-11-18T13:09:00.000Z', {}),
  event('user.message', 'e1', '2026-11-18T13:10:00.000Z', { content: 'hi' }),
  usage('u1', '2026-11-18T13:10:05.000Z', 'mai-code-2-flash', { input: 1000, output: 10, read: 400, write: 5 }),
  event('assistant.message', 'e2', '2026-11-18T13:10:06.000Z', { content: 'hello' }),
  event('user.message', 'e3', '2026-11-18T13:13:00.000Z', { content: 'run it' }),
  event('tool.execution_start', 'e4', '2026-11-18T13:13:01.000Z', { toolName: 'bash' }),
  event('some.future.event', 'e5', '2026-11-18T13:13:02.000Z', { anything: true }),
  usage('u2', '2026-11-18T13:13:08.000Z', 'mai-code-2-flash', { input: 2000, output: 20, read: 500 }),
  usage('u2', '2026-11-18T13:13:08.000Z', 'mai-code-2-flash', { input: 2000, output: 20, read: 500 }),
  usage('u3', '2026-11-18T13:13:09.000Z', 'mai-sub', { input: 300, output: 30 }, 'sub-1'),
  event('assistant.message', 'e6', '2026-11-18T13:13:10.000Z', { content: 'sub says' }, 'sub-1'),
  event('assistant.message', 'e7', '2026-11-18T13:13:11.000Z', { content: 'done' }),
  '{"type":"session.usage_record","id":"u4","timesta',
];

async function session(t: Parameters<typeof tempDir>[0], lines: string[] = EVENTS, yaml?: string, id = ID): Promise<{ home: string; path: string; folder: string }> {
  const home = await tempDir(t, 'copilot-tr-');
  const folder = join(home, 'session-state', id);
  await mkdir(folder, { recursive: true });
  const path = join(folder, 'events.jsonl');
  await writeFile(path, lines.join('\n'));
  if (yaml !== undefined) await writeFile(join(folder, 'workspace.yaml'), yaml);
  return { home, path, folder };
}
const at = (home: string) => machineWith({ copilotHome: home });

test('readTurn takes each usage record once: input without cache reads, subagents counted and split out, the session total main-only', async (t) => {
  const { home, path } = await session(t);
  const machine = at(home);
  assert.deepEqual(await readTurn(machine, path), { tokens: 600 + 5 + 400 + 10 + 1500 + 500 + 20 });
  const second = await readTurn(machine, path, BETWEEN);
  assert.deepEqual(second.usage, {
    tokens: { input: 1500 + 300, output: 50, cache_write: 0, cache_read: 500 }, models: ['mai-code-2-flash', 'mai-sub'],
    subagentTokens: { input: 300, output: 30, cache_write: 0, cache_read: 0 },
    tokensByModel: { 'mai-code-2-flash': { input: 1500, output: 20, cache_write: 0, cache_read: 500 }, 'mai-sub': { input: 300, output: 30, cache_write: 0, cache_read: 0 } },
  });
  const all = await readTurn(machine, path, FIRST);
  assert.deepEqual(all.usage?.tokens, { input: 600 + 1800, output: 60, cache_write: 5, cache_read: 900 });
  assert.deepEqual((await readTurn(machine, path, Date.parse('2027-01-01'))).usage?.tokens, ZERO_TOKENS);
});

test('readTurn skips an unparsable line and an unknown event type, and rejects a file it cannot read', async (t) => {
  const { home, path } = await session(t, ['not json', event('x.y', 'a', '2026-11-18T13:10:00.000Z', null), 'null']);
  assert.deepEqual(await readTurn(at(home), path, FIRST), { tokens: 0, usage: { tokens: ZERO_TOKENS, models: [], subagentTokens: ZERO_TOKENS, tokensByModel: {} } });
  await assert.rejects(readTurn(at(home), join(home, 'missing.jsonl')));
});

test('readTurn rejects a session total that overflows, with or without a stage run', async (t) => {
  const huge = (id: string) => usage(id, '2026-11-18T13:10:05.000Z', 'm', { input: 1e308, output: 1e308 });
  const { home, path } = await session(t, [huge('a'), huge('b')]);
  await assert.rejects(readTurn(at(home), path), /not finite/);
  await assert.rejects(readTurn(at(home), path, FIRST), /not finite/);
});

test('the title is workspace.yaml\'s name only when user_named is true; a missing file means no title', async (t) => {
  const named = await session(t, EVENTS, `cwd: ${CWD}\nname: "Secret Word"\nuser_named: true\n`);
  assert.equal((await readTurn(at(named.home), named.path)).title, 'Secret Word');
  const auto = await session(t, EVENTS, `cwd: ${CWD}\nname: Secret Word Confirmation\nuser_named: false\n`);
  assert.equal((await readTurn(at(auto.home), auto.path)).title, undefined);
  const none = await session(t);
  assert.equal((await readTurn(at(none.home), none.path)).title, undefined);
});

test('countMessages counts the main agent\'s user and assistant messages only', async (t) => {
  const { home, path } = await session(t);
  assert.equal(await countMessages(at(home), path), 4);
});

test('ownsTranscript takes only <copilot home>/session-state/<full session id>/events.jsonl', () => {
  const own = join('/c-home', 'session-state', ID, 'events.jsonl');
  const machine = machineWith({ copilotHome: '/c-home' });
  assert.equal(ownsTranscript(machine, own, CWD, ID), true);
  assert.equal(ownsTranscript(machine, own, CWD, undefined), false, 'no session id');
  assert.equal(ownsTranscript(machine, own, CWD, ID.slice(4)), false, 'a tail of an id');
  assert.equal(ownsTranscript(machine, own, CWD, OTHER_ID), false, 'another session\'s id');
  assert.equal(ownsTranscript(machine, join('/c-home', 'session-state', ID, 'other.jsonl'), CWD, ID), false);
  assert.equal(ownsTranscript(machine, `/c-home/session-state/../session-state/${ID}/events.jsonl`, CWD, ID), false, 'not normalized');
  assert.equal(ownsTranscript(machine, join('/elsewhere', 'session-state', ID, 'events.jsonl'), CWD, ID), false);
  const byDefault = machineWith({ homedir: '/actor/home' });
  assert.equal(ownsTranscript(byDefault, join('/actor/home', '.copilot', 'session-state', ID, 'events.jsonl'), CWD, ID), true);
  for (const copilotHome of ['', 'rel', './rel']) {
    assert.equal(ownsTranscript(machineWith({ homedir: '/actor/home', copilotHome }), join('/actor/home', '.copilot', 'session-state', ID, 'events.jsonl'), CWD, ID), true, copilotHome);
  }
});

test('sessionFiles answers the events file then the folder, only for a uuid, a real folder of session-state and the same cwd', async (t) => {
  const { home, path, folder } = await session(t, EVENTS, `cwd: ${CWD}\nname: x\nuser_named: false\n`);
  const machine = at(home);
  assert.deepEqual(await sessionFiles(machine, CWD, ID), [path, folder]);
  assert.deepEqual(await sessionFiles(machine, '/work/other', ID), [], 'another cwd');
  assert.deepEqual(await sessionFiles(machine, CWD, OTHER_ID), [], 'no such session');
  for (const bad of ['..', '../x', ID.slice(1), `${ID}/..`, '']) assert.deepEqual(await sessionFiles(machine, CWD, bad), [], bad);
  assert.deepEqual(await sessionFiles(at(await tempDir(t, 'copilot-tr-')), CWD, ID), [], 'no session-state at all');
});

test('sessionFiles refuses a symlinked folder and a folder without workspace.yaml', async (t) => {
  const { home } = await session(t, EVENTS, `cwd: ${CWD}\n`);
  const real = join(home, 'session-state', ID);
  await symlink(real, join(home, 'session-state', OTHER_ID));
  assert.deepEqual(await sessionFiles(at(home), CWD, OTHER_ID), []);
  const bare = await session(t);
  assert.deepEqual(await sessionFiles(at(bare.home), CWD, ID), []);
});

test('the machine\'s copilotHome comes from COPILOT_HOME of its env', () => {
  assert.equal(fakeMachine({ env: { COPILOT_HOME: '/c-home' } }).info().copilotHome, '/c-home');
  assert.equal(fakeMachine({ env: {} }).info().copilotHome, undefined);
});
