import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityOf } from '../src/activities.js';
import { runModel } from '../src/agents.js';
import type { HiveServer } from '../src/server.js';
import type { RunPick, Stage } from '../src/types.js';
import { type FakeWorker, fakeSpawn, LOCAL_STAGES, plainArgs } from './fakes.js';
import { SESSION_A, startReviews } from './review-server.js';

// A manual start's run picks (#290) through the server: the stage spawn runs them, POST /tasks/:id/start checks them.
const BUILD: Stage = { name: 'build', from: {}, prompt: 'Build {id}', model: 'opus' };

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

// local:1 (its worktree on disk, sessions A and B of fila, both Claude's) moved by hand into build, a stage it never ran, with auto off so only a
// start runs it: executar etapas posts a start there
async function inBuild(t: TestContext): Promise<{ base: string; server: HiveServer; workers: FakeWorker[] }> {
  const { spawn, workers } = fakeSpawn();
  const { base, server } = await startReviews(t, { launchPty: spawn });
  await server.dispatch({ type: 'setStages', stages: [...LOCAL_STAGES, BUILD], transitions: [] });
  await server.dispatch({ type: 'setAuto', taskId: 'local:1', auto: false });
  await server.dispatch({ type: 'moveToStage', taskId: 'local:1', stage: 'build' });
  return { base, server, workers };
}
const startWith = (server: HiveServer, runPick?: RunPick) => server.dispatch({ type: 'start', itemId: 'local:1', ...(runPick === undefined ? {} : { runPick }) });
const sessionOf = (server: HiveServer): string | undefined => activityOf(server.getState()!, 'local:1')?.sessionId;

test('runModel: a model picked by hand, else the stage\'s own on the stage\'s agent, else none, which is the agent\'s default (#290)', () => {
  assert.equal(runModel('sonnet', BUILD, 'claude', 'claude'), 'sonnet');
  assert.equal(runModel(undefined, BUILD, 'claude', 'claude'), 'opus');
  assert.equal(runModel(undefined, BUILD, 'codex', 'claude'), undefined, 'a stage\'s model is a name of its own agent');
  assert.equal(runModel(undefined, { ...BUILD, agent: 'codex' }, 'codex', 'claude'), 'opus');
  assert.equal(runModel(undefined, {}, 'claude', 'claude'), undefined);
});

test('a stage run with picks runs claude with them after the global args: the picked model over the stage\'s, the specialized agent, the args (#290)', async (t) => {
  const { server, workers } = await inBuild(t);
  await startWith(server, { agent: 'claude', resume: null, launch: { model: 'sonnet', specializedAgent: 'hive:designer', args: ['--verbose'] } });
  await until(() => workers.length === 1);
  assert.deepEqual(plainArgs(workers[0].launch).slice(-7), ['--verbose', '--agent', 'hive:designer', '--model', 'sonnet', '--session-id', sessionOf(server)]);
});

test('a pick with no model keeps the stage\'s; a pick of another agent with no model runs that agent\'s default (#290)', async (t) => {
  const plain = await inBuild(t);
  await startWith(plain.server, { resume: null });
  await until(() => plain.workers.length === 1);
  assert.deepEqual(plainArgs(plain.workers[0].launch).slice(-4), ['--model', 'opus', '--session-id', sessionOf(plain.server)]);
  const codex = await inBuild(t);
  await startWith(codex.server, { agent: 'codex', resume: null });
  await until(() => codex.workers.length === 1);
  assert.equal(codex.workers[0].launch.agent?.command, 'codex');
  assert.equal(plainArgs(codex.workers[0].launch).includes('-m'), false);
});

test('a picked resume runs --resume on that session; a codex pick with a model runs codex with -m (#290)', async (t) => {
  const resumed = await inBuild(t);
  await startWith(resumed.server, { resume: SESSION_A });
  await until(() => resumed.workers.length === 1);
  assert.deepEqual(plainArgs(resumed.workers[0].launch).slice(-2), ['--resume', SESSION_A]);
  const codex = await inBuild(t);
  await startWith(codex.server, { agent: 'codex', resume: null, launch: { model: 'gpt-5.6-terra' } });
  await until(() => codex.workers.length === 1);
  assert.deepEqual(plainArgs(codex.workers[0].launch).slice(-2), ['-m', 'gpt-5.6-terra']);
});

test('a picked specialized agent the plugin no longer has fails the spawn, naming it, and runs nothing (#290)', async (t) => {
  const { server, workers } = await inBuild(t);
  await startWith(server, { launch: { specializedAgent: 'hive:gone' } });
  await until(() => (server.getState()!.error ?? '').includes('hive:gone'));
  assert.equal(workers.length, 0);
});
