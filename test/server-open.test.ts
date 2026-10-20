import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityOf } from '../src/activities.js';
import { mergeBasePrompt } from '../src/merge-prompt.js';
import { sessionsOf } from '../src/tasks.js';
import { AGENT_IDS, type AgentId, type Exec } from '../src/types.js';
import { pluginSource } from '../src/hooks-settings.js';
import { specializedAgents } from '../src/launch-options.js';
import { fakeSpawn, plainArgs } from './fakes.js';
import { SESSION_A, send, startReviews } from './review-server.js';

// task 1 of startReviews has its worktree on disk: an open starts its session at once
const OPEN = '/tasks/local%3A1/open';
const PROMPT_MESSAGE = 'prompt must be mergeBase, with promptBase a branch name';

test('prompt mergeBase opens a claude session whose first prompt is the merge-from-base text, rendered by the server (#758)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base } = await startReviews(t, { launchPty: spawn });
  const res = await send(base, 'POST', OPEN, { kind: 'claude', prompt: 'mergeBase', promptBase: 'main' });
  assert.equal(res.status, 200);
  const { promptPath } = workers[0].launch;
  assert.ok(promptPath);
  assert.equal(await readFile(promptPath, 'utf8'), mergeBasePrompt('main'));
});

test('a claude session without a prompt starts with none, as before (#758)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base } = await startReviews(t, { launchPty: spawn });
  assert.equal((await send(base, 'POST', OPEN, { kind: 'claude' })).status, 200);
  assert.equal(workers[0].launch.promptPath, undefined);
});

test('another prompt, a bad or missing promptBase, or a prompt on a terminal is 400 and opens nothing (#758)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base } = await startReviews(t, { launchPty: spawn });
  const bodies = [
    { kind: 'claude', prompt: 'anything', promptBase: 'main' },
    { kind: 'claude', prompt: 'mergeBase', promptBase: '-x' },
    { kind: 'claude', prompt: 'mergeBase' },
    { kind: 'terminal', prompt: 'mergeBase', promptBase: 'main' },
  ];
  for (const body of bodies) {
    const res = await send(base, 'POST', OPEN, body);
    assert.deepEqual([res.status, await res.json()], [400, { error: PROMPT_MESSAGE }], JSON.stringify(body));
  }
  assert.equal(workers.length, 0);
});

test('prompt mergeBase with a continueId resumes that session with the merge-from-base text as its prompt (#379)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base } = await startReviews(t, { launchPty: spawn });
  const res = await send(base, 'POST', OPEN, { kind: 'claude', continueId: SESSION_A, prompt: 'mergeBase', promptBase: 'main' });
  assert.equal(res.status, 200);
  assert.deepEqual(plainArgs(workers[0].launch).slice(-2), ['--resume', SESSION_A]);
  assert.equal(await readFile(workers[0].launch.promptPath!, 'utf8'), mergeBasePrompt('main'));
});

test('a free session opened in a stage with no recorded start records one at its HEAD; a later open in that stage keeps it (#812)', async (t) => {
  const { spawn } = fakeSpawn();
  const git = { head: 'a'.repeat(40) };
  const exec: Exec = async (_file, args) => ({ stdout: args.includes('rev-parse') && args.includes('HEAD') ? `${git.head}\n` : '' });
  const { base, server } = await startReviews(t, { launchPty: spawn, exec });
  const startOf = () => activityOf(server.getState()!, 'local:1')?.stageStart;
  assert.equal(startOf(), undefined);
  assert.equal((await send(base, 'POST', OPEN, { kind: 'claude' })).status, 200);
  assert.deepEqual(startOf(), { stage: 'fila', commit: 'a'.repeat(40) }, 'restart can undo the free session\'s work');
  git.head = 'b'.repeat(40);
  assert.equal((await send(base, 'POST', OPEN, { kind: 'claude' })).status, 200);
  assert.deepEqual(startOf(), { stage: 'fila', commit: 'a'.repeat(40) }, 'one stage start per stage');
});

test('the kind an open asks for is the new session\'s agent, over the default agent (#925)', async (t) => {
  const { spawn } = fakeSpawn();
  const { base, server } = await startReviews(t, { launchPty: spawn });
  await server.dispatch({ type: 'setDefaultAgent', agent: 'other' as AgentId }); // #925: no second id until 3.1; the default only has to differ
  assert.equal((await send(base, 'POST', OPEN, { kind: 'claude' })).status, 200);
  assert.equal(server.getState()!.workers.find((w) => w.freeSession)?.agent, 'claude');
});

test('a kind that is neither terminal nor an agent is refused with the accepted kinds and opens nothing (#925)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base } = await startReviews(t, { launchPty: spawn });
  const res = await send(base, 'POST', OPEN, { kind: 'gpt' });
  assert.deepEqual([res.status, await res.json(), workers.length], [400, { error: `kind precisa ser terminal ou ${AGENT_IDS.join(', ')}` }, 0]);
});

test('a new codex session on a task opens with no session id: codex runs with no resume, and nothing is recorded until its first SessionStart (#931)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base, server } = await startReviews(t, { launchPty: spawn });
  assert.equal((await send(base, 'POST', OPEN, { kind: 'codex' })).status, 200);
  const { agent } = workers[0].launch;
  assert.equal(agent?.command, 'codex');
  assert.notEqual(agent?.argv[0], 'resume');
  const state = server.getState()!;
  const worker = state.workers.find((w) => w.freeSession);
  assert.deepEqual([worker?.agent, worker?.sessionId], ['codex', undefined]);
  assert.equal(sessionsOf(state, 'local:1').some((s) => s.agent === 'codex'), false);
});

// A spawn failure is dispatched without awaiting, like a real process event: poll the state until it settles
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

test('an open with a model, a specialized agent and args runs claude with them after the global args, and its session keeps them (#257)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base, server } = await startReviews(t, { launchPty: spawn });
  const pick = { model: 'opus', specializedAgent: 'hive:designer', args: ['--verbose'] };
  assert.equal((await send(base, 'POST', OPEN, { kind: 'claude', ...pick })).status, 200);
  const worker = server.getState()!.workers.find((w) => w.freeSession);
  assert.deepEqual(plainArgs(workers[0].launch), ['--verbose', '--agent', 'hive:designer', '--model', 'opus', '--session-id', worker?.sessionId]);
  assert.deepEqual(worker?.launch, pick);
  assert.deepEqual(sessionsOf(server.getState()!, 'local:1').find((s) => s.id === worker?.sessionId)?.launch, pick);
});

test('a codex open with a model and a specialized agent runs codex with -m and the agent\'s instructions after the protocol (#257)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base } = await startReviews(t, { launchPty: spawn });
  assert.equal((await send(base, 'POST', OPEN, { kind: 'codex', model: 'gpt-5.6-terra', specializedAgent: 'hive:designer' })).status, 200);
  assert.deepEqual(plainArgs(workers[0].launch).slice(-2), ['-m', 'gpt-5.6-terra']);
  const argv = workers[0].launch.agent?.argv ?? [];
  const developer = argv.flatMap((arg) => (typeof arg !== 'string' && arg[1].startsWith('developer_instructions=') ? [JSON.parse(arg[1].slice('developer_instructions='.length)) as string] : []))[0];
  const designer = specializedAgents(pluginSource()).find((a) => a.name === 'hive:designer');
  assert.ok(designer && developer?.endsWith(`\n\n${designer.instructions}`), 'the protocol first, then the agent');
});

test('each pick out of shape, on a terminal or on a resume is a 400 naming its field and opens nothing (#257)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base } = await startReviews(t, { launchPty: spawn });
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ kind: 'terminal', model: 'opus' }, /"kind"/],
    [{ kind: 'claude', continueId: SESSION_A, args: ['--verbose'] }, /"continueId"/],
    [{ kind: 'claude', model: '-x' }, /"model"/],
    [{ kind: 'claude', model: 'has space' }, /"model"/],
    [{ kind: 'claude', model: 'm'.repeat(101) }, /"model"/],
    [{ kind: 'claude', model: 7 }, /"model"/],
    [{ kind: 'codex', model: 'opus' }, /"model"/],
    [{ kind: 'codex', model: 'fable[1m]' }, /"model"/],
    [{ kind: 'claude', specializedAgent: 'hive:nope' }, /"specializedAgent"/],
    [{ kind: 'claude', specializedAgent: 'ecc:planner' }, /"specializedAgent"/],
    [{ kind: 'claude', args: '--verbose' }, /"args"/],
    [{ kind: 'claude', args: Array.from({ length: 33 }, () => '-v') }, /"args"/],
    [{ kind: 'claude', args: [''] }, /"args"/],
    [{ kind: 'claude', args: ['x'.repeat(201)] }, /"args"/],
    [{ kind: 'claude', args: ['a\u0000b'] }, /"args"/],
  ];
  for (const [body, field] of cases) {
    const res = await send(base, 'POST', OPEN, body);
    const { error } = (await res.json()) as { error: string };
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(error, field, JSON.stringify(body));
  }
  assert.equal(workers.length, 0);
});

test('a session whose recorded specialized agent left the plugin fails its spawn, naming the agent (#257)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { server } = await startReviews(t, { launchPty: spawn });
  const activityId = activityOf(server.getState()!, 'local:1')?.id ?? '';
  await server.dispatch({ type: 'openSession', activityId, agent: 'claude', launch: { specializedAgent: 'hive:gone' } });
  await until(() => (server.getState()!.error ?? '').includes('hive:gone'));
  assert.equal(workers.length, 0);
  assert.equal(server.getState()!.workers.some((w) => w.freeSession && w.status !== 'empty'), false);
});
