import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activityOf } from '../src/activities.js';
import { mergeBasePrompt } from '../src/merge-prompt.js';
import { sessionsOf } from '../src/tasks.js';
import { AGENT_IDS, type AgentId, type Exec } from '../src/types.js';
import { fakeSpawn } from './fakes.js';
import { send, startReviews } from './review-server.js';

// task 1 of startReviews has its worktree on disk: an open starts its session at once
const OPEN = '/tasks/local%3A1/open';
const PROMPT_MESSAGE = 'prompt must be mergeBase, with promptBase a branch name, on a new agent session';

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

test('another prompt, a bad or missing promptBase, a prompt with a continueId or on a terminal is 400 and opens nothing (#758)', async (t) => {
  const { spawn, workers } = fakeSpawn();
  const { base } = await startReviews(t, { launchPty: spawn });
  const bodies = [
    { kind: 'claude', prompt: 'anything', promptBase: 'main' },
    { kind: 'claude', prompt: 'mergeBase', promptBase: '-x' },
    { kind: 'claude', prompt: 'mergeBase' },
    { kind: 'claude', prompt: 'mergeBase', promptBase: 'main', continueId: 'aaaaaaaa-1111-4111-8111-111111111111' },
    { kind: 'terminal', prompt: 'mergeBase', promptBase: 'main' },
  ];
  for (const body of bodies) {
    const res = await send(base, 'POST', OPEN, body);
    assert.deepEqual([res.status, await res.json()], [400, { error: PROMPT_MESSAGE }], JSON.stringify(body));
  }
  assert.equal(workers.length, 0);
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
