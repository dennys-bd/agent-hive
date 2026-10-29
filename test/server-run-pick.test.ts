import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityOf } from '../src/activities.js';
import { runModel } from '../src/agents.js';
import type { HiveServer } from '../src/server.js';
import type { RunPick, Stage } from '../src/types.js';
import { type FakeWorker, fakeSpawn, LOCAL_STAGES, plainArgs } from './fakes.js';
import { SESSION_A, send, startReviews } from './review-server.js';

// A manual start's run picks (#290) through the server: the stage spawn runs them, POST /tasks/:id/start checks them.
const BUILD: Stage = { name: 'build', from: {}, prompt: 'Build {id}', model: 'opus' };
const START = '/tasks/local%3A1/start';

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

// local:1 (its worktree on disk, sessions A and B of fila, both Claude's) moved by hand into build, a stage it never ran, with auto off so only a
// start runs it: executar etapas posts a start there
async function inBuild(t: TestContext, stage: Stage = BUILD): Promise<{ base: string; server: HiveServer; workers: FakeWorker[] }> {
  const { spawn, workers } = fakeSpawn();
  const { base, server } = await startReviews(t, { launchPty: spawn });
  await server.dispatch({ type: 'setStages', stages: [...LOCAL_STAGES, stage], transitions: [] });
  await server.dispatch({ type: 'setAuto', taskId: 'local:1', auto: false });
  await server.dispatch({ type: 'moveToStage', taskId: 'local:1', stage: stage.name });
  return { base, server, workers };
}
const startWith = (server: HiveServer, runPick?: RunPick) => server.dispatch({ type: 'start', itemId: 'local:1', ...(runPick === undefined ? {} : { runPick }) });
const sessionOf = (server: HiveServer): string | undefined => activityOf(server.getState()!, 'local:1')?.sessionId;

test('runModel: a model picked by hand, else the stage\'s own on the stage\'s agent, else none, which is the agent\'s default (#290)', () => {
  const config = { defaultAgent: 'claude' as const, agentModels: { claude: null, codex: null } };
  assert.equal(runModel('sonnet', BUILD, 'claude', config), 'sonnet');
  assert.equal(runModel(undefined, BUILD, 'claude', config), 'opus');
  assert.equal(runModel(undefined, BUILD, 'codex', config), undefined, 'a stage\'s model is a name of its own agent');
  assert.equal(runModel(undefined, { ...BUILD, agent: 'codex' }, 'codex', config), 'opus');
  assert.equal(runModel(undefined, {}, 'claude', config), undefined);
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

test('POST /tasks/:id/start runs the picks it is sent (#290)', async (t) => {
  const { base, server, workers } = await inBuild(t);
  assert.equal((await send(base, 'POST', START, { agent: 'codex', session: 'new', model: 'gpt-5.6-terra' })).status, 200);
  await until(() => workers.length === 1);
  assert.equal(workers[0].launch.agent?.command, 'codex');
  assert.equal(server.getState()!.workers.find((w) => w.status !== 'empty')?.agent, 'codex');
});

test('POST /tasks/:id/start refuses picks out of shape with a 400 naming the field, and picks on a continue with a 409; nothing runs (#290)', async (t) => {
  const { base, workers } = await inBuild(t);
  const cases: [string, Record<string, unknown>, number, RegExp][] = [
    [START, { agent: 'gemini' }, 400, /"agent"/],
    [START, { agent: 'codex', model: 'opus' }, 400, /"model"/],
    [START, { session: 'cccccccc-0000-4000-8000-000000000009' }, 400, /"session"/],
    [START, { agent: 'codex', session: SESSION_A }, 400, /"session"/],
    ['/tasks/local%3A2/start', { session: 'new' }, 409, /"session"/], // local:2 already ran fila: Continue
  ];
  for (const [path, body, status, field] of cases) {
    const res = await send(base, 'POST', path, body);
    const { error } = (await res.json()) as { error: string };
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match(error, field, JSON.stringify(body));
  }
  assert.equal(workers.length, 0);
});

// #710: a skill stage with its own specialized agent
const PLAN: Stage = { name: 'plan', from: {}, action: 'skill', skill: 'new-plan', specializedAgent: 'hive:planner' };
const agentFlag = (worker: FakeWorker): string | undefined => {
  const args = plainArgs(worker.launch);
  return args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined;
};

test('a skill stage\'s run is told /hive:<skill> and runs as the stage\'s specialized agent (#710)', async (t) => {
  const { server, workers } = await inBuild(t, PLAN);
  await startWith(server);
  await until(() => workers.length === 1);
  assert.equal(await readFile(workers[0].launch.promptPath ?? '', 'utf8'), '/hive:new-plan');
  assert.equal(agentFlag(workers[0]), 'hive:planner');
});

test('a manual start\'s specialized agent wins over the stage\'s (#710)', async (t) => {
  const { server, workers } = await inBuild(t, PLAN);
  await startWith(server, { launch: { specializedAgent: 'hive:designer' } });
  await until(() => workers.length === 1);
  assert.equal(agentFlag(workers[0]), 'hive:designer');
});

test('a skill the workspace\'s plugin folder lacks fails the spawn, naming it, and runs nothing (#710)', async (t) => {
  const { server, workers } = await inBuild(t, { ...PLAN, skill: 'gone' });
  await startWith(server);
  await until(() => (server.getState()!.error ?? '').includes('hive:gone'));
  assert.equal(workers.length, 0);
});
