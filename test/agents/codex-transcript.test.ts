import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ownsRollout, readRollout, rolloutFiles, sessionsRoot } from '../../src/agents/codex-transcript.js';
import { ZERO_TOKENS } from '../../src/events.js';
import { CHILD, CWD, DAY, NOW, OTHER, OTHER_CHILD, SESSION, STALE, sessionMeta, subagent, TWO_TURNS, writeRollout } from '../codex-rollouts.js';
import { tempDir } from '../temp-dir.js';

const START = Date.parse('2026-10-12T10:00:00.000Z');
const BETWEEN = Date.parse('2026-10-12T10:05:00.000Z');
const TURN_2 = { input: 5000, output: 500, cache_write: 100, cache_read: 15000 };
const CHILD_TURN = { input: 2000, output: 200, cache_write: 0, cache_read: 1000 };

test('readRollout maps each response once: input without the cached tokens, cached as cache_read, reasoning left inside output; the session total is the last thread total (#929)', async (t) => {
  const path = await writeRollout(await tempDir(t, 'codex-'), DAY, SESSION, TWO_TURNS);
  assert.doesNotMatch(TWO_TURNS.join('\n'), /creator_/, 'no account id in the fixture');
  assert.deepEqual(await readRollout(path), { tokens: 32366 }, 'without since: no stage tally and no subagent scan');
  assert.deepEqual(await readRollout(path, START, NOW), {
    tokens: 32366, usage: { tokens: { input: 7803, output: 563, cache_write: 100, cache_read: 24000 }, models: ['gpt-5.6-luna', 'gpt-5.6-terra'], subagentTokens: ZERO_TOKENS },
  });
  assert.deepEqual(await readRollout(path, BETWEEN, NOW), { tokens: 32366, usage: { tokens: TURN_2, models: ['gpt-5.6-terra'], subagentTokens: ZERO_TOKENS } }, 'only the turn at or after since');
});

test('readRollout counts the session\'s own subagents written since the stage run, in any folder of the range; not another session\'s, nor a stale one (#929)', async (t) => {
  const home = await tempDir(t, 'codex-');
  const path = await writeRollout(home, DAY, SESSION, TWO_TURNS);
  await writeRollout(home, '2026/10/13', CHILD, subagent(CHILD, SESSION)); // past midnight: the next day's folder
  await writeRollout(home, DAY, OTHER_CHILD, subagent(OTHER_CHILD, OTHER));
  await writeRollout(home, '2026/10/11', STALE, subagent(STALE, SESSION), START - 1); // last written before the stage run: never opened
  const turn = await readRollout(path, START, NOW);
  assert.equal(turn.tokens, 32366, 'the session total stays the session\'s own');
  assert.deepEqual(turn.usage, {
    tokens: { input: 9803, output: 763, cache_write: 100, cache_read: 25000 }, models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-luna'], subagentTokens: CHILD_TURN,
  });
});

test('readRollout skips a half-written last line and counts a non-finite number as 0 (#929)', async (t) => {
  const huge = '{"timestamp":"2026-10-12T10:20:00.000Z","type":"token_usage_record","payload":{"turn_id":"turn-2","response_id":"resp-9","usage":{"input_tokens":1e400,"cached_input_tokens":0,"output_tokens":5},"thread_token_usage":{"total_tokens":1e400}}}';
  const path = await writeRollout(await tempDir(t, 'codex-'), DAY, SESSION, [...TWO_TURNS, huge, '{"timestamp":"2026-10-12T10:30:00.000Z","type":"token_usage_rec']);
  const turn = await readRollout(path, BETWEEN, NOW);
  assert.equal(turn.tokens, 0, 'the last thread total read 1e400: Infinity counts 0');
  assert.deepEqual(turn.usage?.tokens, { ...TURN_2, output: TURN_2.output + 5 });
});

test('ownsRollout takes only <sessions root>/YYYY/MM/DD/…-<session id>.jsonl, and nothing without a session id (#929)', () => {
  const env = { CODEX_HOME: '/codex-home' };
  const at = (rest: string): string => `/codex-home/sessions/${rest}`;
  const own = at(`2026/10/12/rollout-2026-10-12T10-00-00-${SESSION}.jsonl`);
  assert.equal(ownsRollout(own, SESSION, env), true);
  const refused: [string, string][] = [
    [at(`2026/10/12/rollout-2026-10-12T10-00-00-${OTHER}.jsonl`), 'another session'],
    [`/elsewhere/sessions/2026/10/12/rollout-x-${SESSION}.jsonl`, 'outside the root'],
    [at(`2026/10/rollout-x-${SESSION}.jsonl`), 'one folder too shallow'],
    [at(`2026/10/12/sub/rollout-x-${SESSION}.jsonl`), 'one folder too deep'],
    [at(`2026/oct/12/rollout-x-${SESSION}.jsonl`), 'not a date folder'],
    [`sessions/2026/10/12/rollout-x-${SESSION}.jsonl`, 'relative'],
    [at(`2026/10/12/rollout-x-${SESSION}.json`), 'not .jsonl'],
    [at(`2026/10/12/../12/rollout-x-${SESSION}.jsonl`), 'not normalized: the root would be read from the wrong folders'],
  ];
  for (const [path, why] of refused) assert.equal(ownsRollout(path, SESSION, env), false, why);
  assert.equal(ownsRollout(own, SESSION.slice(9), env), false, 'a tail of the id is no session id');
  assert.equal(ownsRollout(own, undefined, env), false, 'no session id: nothing is owned');
  assert.equal(ownsRollout(own, '', env), false);
});

test('sessionsRoot is $CODEX_HOME/sessions for an absolute CODEX_HOME, else ~/.codex/sessions (#929)', () => {
  assert.equal(sessionsRoot({ CODEX_HOME: '/codex-home' }), '/codex-home/sessions');
  for (const CODEX_HOME of [undefined, '', '  ', 'codex', './codex']) assert.equal(sessionsRoot({ CODEX_HOME }), join(homedir(), '.codex', 'sessions'), String(CODEX_HOME));
});

test('rolloutFiles lists the session\'s rollout, then every rollout whose first line names it as parent, in any date folder (#929)', async (t) => {
  const home = await tempDir(t, 'codex-');
  const own = await writeRollout(home, DAY, SESSION, TWO_TURNS);
  const child = await writeRollout(home, '2025/01/02', CHILD, subagent(CHILD, SESSION));
  await writeRollout(home, DAY, OTHER, [sessionMeta(OTHER)]);
  await writeRollout(home, DAY, OTHER_CHILD, subagent(OTHER_CHILD, OTHER));
  assert.deepEqual(await rolloutFiles(SESSION, CWD, { CODEX_HOME: home }), [own, child]);
  assert.deepEqual(await rolloutFiles(SESSION, CWD, { CODEX_HOME: join(home, 'none') }), [], 'no sessions folder');
});

test('rolloutFiles takes nothing when the session\'s rollout ran in another folder: a forged id never deletes a session run elsewhere (#929)', async (t) => {
  const home = await tempDir(t, 'codex-');
  await writeRollout(home, DAY, SESSION, [sessionMeta(SESSION, undefined, '/elsewhere'), ...TWO_TURNS.slice(1)]);
  await writeRollout(home, DAY, CHILD, subagent(CHILD, SESSION));
  assert.deepEqual(await rolloutFiles(SESSION, CWD, { CODEX_HOME: home }), [], 'neither the session nor its subagents');
});
