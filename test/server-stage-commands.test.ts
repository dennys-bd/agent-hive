import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { resultOf } from '../src/activities.js';
import type { ChannelInfo, ChannelView } from '../src/console.js';
import { parseConfig } from '../src/config.js';
import type { StartPty } from '../src/ptys.js';
import { createServer, type HiveServer, type Runtime } from '../src/server.js';
import { createStageCommandRunner, OUTPUT_MAX, OUTPUT_THROTTLE_MS, outputTail } from '../src/server-stage-commands.js';
import type { Activity, Command, Effect, HiveEvent, SettingsBody, Stage, StageCommands, Task } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { taskDir } from '../src/worktree.js';
import { AUTH, combConfig, fakePtys, fakeSourceFactory, type FakePty, GITHUB_ENTRY, SOURCE, tempHive, WORKSPACE } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// A commands stage's commands on the server (#755): the runner alone over fakes, then end to end through a server over fake ptys.

const BUILD: Command = { name: 'build', impls: [{ workspace: 'hive', command: 'pnpm build' }], menu: true, env: { NODE_ENV: 'production' } };
const LINT: Command = { name: 'lint', impls: [{ workspace: null, command: 'pnpm lint' }], menu: false, env: {}, timeout: '1s' };
const STAGE: Stage = { name: 'checks', from: {}, action: 'commands', commands: ['build', 'lint'], stopOnFailure: true, onMissing: 'fail' };
const TASK: Task = { item: { itemId: 'board:I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'checks', boardColumn: '', auto: true, workspace: 'hive' };
const runAt = (at: number): StageCommands => ({ stage: 'checks', at, ptyId: `P${at}`, runId: 'P0', failed: [], workerId: 'w1', started: [] });
const ACTIVITY: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: 'hive-1-task-1', commands: runAt(0) };
const CWD = taskDir('/repo', ACTIVITY);
const E2E: Command = { name: 'e2e', impls: [{ workspace: 'site', command: 'pnpm e2e' }], menu: true, env: {} };
const DEPLOY: Command = { name: 'deploy', impls: [{ workspace: 'site', command: 'fly deploy' }], menu: false, env: {} };
const runtimeWith = (commands: Command[], stage: Stage = STAGE): Runtime => ({
  config: parseConfig(combConfig({ stages: [stage], commands, workspaces: [{ name: 'hive', path: '/repo', env: { FROM: 'workspace' }, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }, { name: 'site', path: '/site', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }] })),
  sources: new Map(), hooksPath: '/hive/hooks.json', promptsDir: '/hive/prompts', pluginDir: '/hive/plugin', protocol: { stage: '/hive/stage.md', session: '/hive/session.md' }, port: 4321,
});
const effect = (at: number, stage: Stage = STAGE): Extract<Effect, { type: 'stageCommand' }> => ({ type: 'stageCommand', activity: ACTIVITY, task: TASK, stage, at, ptyId: `P${at}` });

interface Harness {
  run(runtime: Runtime, e: Extract<Effect, { type: 'stageCommand' }>): Promise<void>;
  started: StartPty[]; killed: string[]; events: HiveEvent[]; prepared: string[]; appended: string[];
  begun: { channel: ChannelInfo; header: string; group?: string }[]; data: Map<string, (data: string) => void>; ends: Map<string, (code: number) => void>;
}
// The runner over a pool, a pty host, a console and a dispatch that only record; `current` is the run the State holds
function harness(current: () => StageCommands | undefined = () => runAt(0), prepare: () => Promise<string> = async () => CWD, registered = true): Harness {
  const live = new Set<string>();
  const h: Omit<Harness, 'run'> = { started: [], killed: [], events: [], prepared: [], appended: [], begun: [], data: new Map(), ends: new Map() };
  const runner = createStageCommandRunner({
    exec: async () => ({ stdout: '' }),
    pool: { start: (o) => { h.started.push(o); if (registered) live.add(o.ptyId); }, kill: async (ptyId) => { h.killed.push(ptyId); return true; } },
    ptys: { has: (ptyId) => live.has(ptyId), subscribe: (ptyId, onData, onExit) => { h.data.set(ptyId, onData); h.ends.set(ptyId, onExit); return undefined; } },
    consoleStore: { begin: (channel, _ptyId, header, group) => { h.begun.push({ channel, header, group }); }, append: (_ptyId, data) => { h.appended.push(data); }, end: () => undefined },
    dispatch: async (event) => { h.events.push(event); return []; },
    prepare: async (_runtime, _activity, _task, ptyId) => { h.prepared.push(ptyId); return prepare(); },
    current: () => current(),
  });
  return { ...h, run: (runtime, e) => runner.run(runtime, e) };
}

test('a name the Comb no longer has refuses the stage before any worktree or pty, under fail and under skip (#755)', async () => {
  for (const onMissing of ['fail', 'skip'] as const) {
    const stage: Stage = { ...STAGE, onMissing };
    const h = harness();
    await h.run(runtimeWith([BUILD], stage), effect(0, stage));
    assert.deepEqual(h.events, [{ type: 'stageCommandsRefused', activityId: 'a1', ptyId: 'P0', message: 'lint: not in comb.commands' }], onMissing);
    assert.deepEqual([h.prepared, h.started], [[], []], onMissing);
  }
});

test('under fail, every name with no line in the task\'s workspace refuses the stage before anything runs, one per line (#755)', async () => {
  const stage: Stage = { ...STAGE, commands: ['e2e', 'build', 'deploy'] };
  const h = harness();
  await h.run(runtimeWith([BUILD, E2E, DEPLOY], stage), effect(0, stage));
  assert.deepEqual(h.events, [{ type: 'stageCommandsRefused', activityId: 'a1', ptyId: 'P0', message: 'e2e missing in hive\ndeploy missing in hive' }]);
  assert.deepEqual([h.prepared, h.started], [[], []]);
});

test('under skip, a name with no line in the task\'s workspace writes its skipped run to the execution\'s output and ends with 0 at once; index 0 still prepares the worktree, and the next one runs (#755)', async () => {
  const stage: Stage = { ...STAGE, commands: ['e2e', 'build'], onMissing: 'skip' };
  const h = harness();
  await h.run(runtimeWith([BUILD, E2E], stage), effect(0, stage));
  assert.deepEqual([h.prepared, h.started], [['P0'], []]);
  assert.equal(h.begun[0].channel.id, 'stage:checks');
  assert.equal(h.begun[0].group, 'P0', 'in the execution\'s own output');
  assert.match(h.begun[0].header, /^── #1 · skipped · e2e missing in hive · \d\d:\d\d:\d\d ──\r\n$/);
  assert.deepEqual(h.events.at(-1), { type: 'stageCommandEnded', activityId: 'a1', ptyId: 'P0', code: 0, output: '' });
  const next = harness(() => runAt(1));
  await next.run(runtimeWith([BUILD, E2E], stage), effect(1, stage));
  assert.deepEqual(next.started[0]?.launch.run, { command: 'pnpm build', env: { NODE_ENV: 'production' } });
});

test('index 0 prepares the worktree and records it, then starts the command as a command terminal: the worktree as cwd, the workspace env under the command\'s own, on the stage channel (#755)', async () => {
  const h = harness();
  await h.run(runtimeWith([BUILD, LINT]), effect(0));
  assert.deepEqual(h.prepared, ['P0']);
  const ready = h.events[0];
  assert.ok(ready?.type === 'worktreeReady');
  assert.deepEqual([ready.activityId, ready.path, ready.base, ready.local], ['a1', CWD, null, false]);
  const [start] = h.started;
  assert.deepEqual(
    [start.ptyId, start.launch.cwd, start.launch.env, start.launch.run, start.launch.terminal, start.launch.args],
    ['P0', CWD, { FROM: 'workspace' }, { command: 'pnpm build', env: { NODE_ENV: 'production' } }, true, []],
  );
  assert.equal(h.begun[0].channel.id, 'stage:checks');
  assert.equal(h.begun[0].group, 'P0', 'the run is grouped by the stage execution\'s runId');
  assert.match(h.begun[0].header, /^── #1 · running build · 1\/2 · \d\d:\d\d:\d\d ──\r\n$/);
});

test('a later index runs in the worktree with no prepare; a Stop during the setup starts nothing; a failed worktree refuses the stage (#755)', async () => {
  const later = harness(() => runAt(1));
  await later.run(runtimeWith([BUILD, LINT]), effect(1));
  assert.deepEqual([later.prepared, later.started[0]?.launch.cwd, later.events.map((e) => e.type)], [[], CWD, ['stageCommandStarted']]);
  const stopped = harness(() => undefined);
  await stopped.run(runtimeWith([BUILD, LINT]), effect(0));
  assert.deepEqual([stopped.started, stopped.events], [[], []]);
  const failing = harness(() => runAt(0), async () => { throw new Error('setup failed at line 2'); });
  await failing.run(runtimeWith([BUILD, LINT]), effect(0));
  assert.deepEqual(failing.events, [{ type: 'stageCommandsRefused', activityId: 'a1', ptyId: 'P0', message: 'setup failed at line 2' }]);
});

test('a pty the host never registered ends the command with 127 at once, so the stage never waits on an end that cannot come (#755)', async () => {
  const h = harness(() => runAt(0), async () => CWD, false);
  await h.run(runtimeWith([BUILD, LINT]), effect(0));
  assert.deepEqual(h.events.at(-1), { type: 'stageCommandEnded', activityId: 'a1', ptyId: 'P0', code: 127, output: 'pty P0 did not start' });
  assert.deepEqual(h.begun, []);
});

test('the pty\'s end reaches stageCommandEnded with its code and its output\'s tail, ANSI stripped; a pty that never started ends with 127 (#755)', async () => {
  const h = harness();
  await h.run(runtimeWith([BUILD, LINT]), effect(0));
  h.data.get('P0')?.('\x1b[31mboom\x1b[0m\r\n');
  h.ends.get('P0')?.(2);
  assert.deepEqual(h.events.at(-1), { type: 'stageCommandEnded', activityId: 'a1', ptyId: 'P0', code: 2, output: 'boom\r\n' });
  h.started[0].onSpawnFailed('pty: posix_spawn failed');
  assert.deepEqual(h.events.at(-1), { type: 'stageCommandEnded', activityId: 'a1', ptyId: 'P0', code: 127, output: 'pty: posix_spawn failed' });
});

test('a timeout kills the pty through the pool, never through a stop, and ends the command with 124 and the line (#755)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(() => runAt(1));
  await h.run(runtimeWith([BUILD, LINT]), effect(1));
  t.mock.timers.tick(1000);
  assert.deepEqual(h.killed, ['P1']);
  assert.equal(h.events.some((e) => e.type === 'stop'), false);
  assert.ok(h.appended.some((text) => text.includes('tempo esgotado (1s)')), 'the console says so, as for a command terminal');
  h.ends.get('P1')?.(0); // a killed pty exits 0 under node-pty
  const last = h.events.at(-1);
  assert.ok(last?.type === 'stageCommandEnded');
  assert.equal(last.code, 124);
  assert.match(last.output, /timed out after 1s$/);
});

test('outputTail keeps the last 16 000 characters with the escape codes gone (#755)', () => {
  assert.equal(outputTail(`head${'x'.repeat(OUTPUT_MAX)}`).length, OUTPUT_MAX);
  assert.equal(outputTail('\x1b[1mok\x1b[0m\r\n'), 'ok\r\n');
});

// End to end: the board's one task enters checks from Ready, review is where it goes next
const TEST: Command = { name: 'test', impls: [{ workspace: WORKSPACE, command: 'pnpm test' }], menu: true, env: {} };

const CHECKS: Stage = { name: 'checks', from: { [SOURCE]: ['Ready'] }, action: 'commands', commands: ['test'], stopOnFailure: true, onMissing: 'fail' };
const REVIEW: Stage = { name: 'review', from: { [SOURCE]: ['In review'] } };
const TASK_ID = 'board:I1';
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [{ ...GITHUB_ENTRY, switchAt: 'checks' }], stages: [CHECKS, REVIEW], commands: [TEST],
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} },
};
const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const getJson = async (url: string): Promise<unknown> => (await hiveFetch(url)).json();
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i += 1) await sleep(10);
  assert.ok(check(), 'condition not met in time');
}
const runOn = (server: HiveServer): StageCommands | undefined => server.getState()?.activities.find((a) => a.commands !== undefined)?.commands;

// A Hive whose poll puts the task in checks: its command's pty is the first fake pty
async function start(t: TestContext): Promise<{ base: string; ptys: FakePty[]; server: HiveServer }> {
  const { home, repo } = await tempHive(t);
  const { spawnPty, ptys } = fakePtys();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, spawnPty, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(async () => {
    for (const pty of ptys) pty.exit(); // a fake pty's kill exits nothing, and close() awaits every run's exit
    await server.close();
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: [{ name: WORKSPACE, path: repo, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }] })).status, 200);
  await server.dispatch({ type: 'setMax', max: 1 }); // #727: a commands stage holds a worker
  await server.dispatch({ type: 'setSignal', signal: 'green' }); // and follows the rows: a new task needs green
  await server.poll();
  await waitFor(() => ptys.length === 1);
  return { base, ptys, server };
}

test('a commands stage runs its command in a pty of its own, listed under its task; a 0 exit moves the task on with passed, its output on the stage channel (#755)', async (t) => {
  const { base, ptys, server } = await start(t);
  const run = runOn(server);
  assert.ok(run);
  assert.deepEqual(await getJson(`${base}/ptys`), { active: 1, ptys: [{ id: run.ptyId, taskId: TASK_ID, status: 'terminal', label: '#1 from Ready' }] });
  ptys[0].emit('ok\r\n');
  ptys[0].exit(0);
  await waitFor(() => server.getState()?.tasks[0]?.stage === 'review');
  const state = server.getState();
  assert.ok(state);
  assert.deepEqual(resultOf(state, TASK_ID)?.commands, { verdict: 'passed', runId: run.runId });
  const view = (await getJson(`${base}/console/${encodeURIComponent('stage:checks')}`)) as ChannelView;
  assert.match(view.history, /^── #1 · running test · 1\/1 · \d\d:\d\d:\d\d ──\r\nok\r\n$/);
  assert.equal(view.status, 'done');
  const mine = (await getJson(`${base}/console/${encodeURIComponent('stage:checks')}?run=${run.ptyId}`)) as ChannelView;
  assert.equal(mine.history, view.history, 'the execution\'s own run id (its first pty) selects its output');
  const other = (await getJson(`${base}/console/${encodeURIComponent('stage:checks')}?run=other`)) as ChannelView;
  assert.deepEqual([other.history, other.live], ['', []], 'another execution\'s id shows none of it');
});

test('POST /ptys/sleep and /ptys/:id/stop reach a running command: stopped, no verdict, its exit changes nothing (#755)', async (t) => {
  const { base, ptys, server } = await start(t);
  const run = runOn(server);
  assert.ok(run);
  const sleepAll = await postJson(`${base}/ptys/sleep`, { ptyIds: [run.ptyId, 'nope'] });
  assert.deepEqual([sleepAll.status, await sleepAll.json()], [404, { error: 'nenhuma execução viva com esse id: nope' }], 'the stage pty passes the check; the unknown id is the one named');
  const stopping = postJson(`${base}/ptys/${run.ptyId}/stop`);
  await waitFor(() => ptys[0].killed > 0);
  ptys[0].exit(0);
  assert.equal((await stopping).status, 200);
  const state = server.getState();
  assert.ok(state);
  const activity = state.activities.find((a) => a.kind === 'task');
  assert.deepEqual([activity?.commands, activity?.stopped, state.tasks[0].stage, resultOf(state, TASK_ID)], [undefined, true, 'checks', undefined]);
});

test('a fed pty answers stageCommandStarted; its output answers stageCommandOutput at once, then at most once every 30 s; a skip answers stageCommandStarted, skipped, before its end (#914)', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T10:00:00.000Z') });
  const h = harness();
  await h.run(runtimeWith([BUILD, LINT]), effect(0));
  const times = (): HiveEvent[] => h.events.filter((e) => e.type === 'stageCommandStarted' || e.type === 'stageCommandOutput');
  assert.deepEqual(times(), [{ type: 'stageCommandStarted', activityId: 'a1', ptyId: 'P0', at: '2026-10-10T10:00:00.000Z' }]);
  const write = h.data.get('P0');
  assert.ok(write);
  write('a');
  t.mock.timers.tick(OUTPUT_THROTTLE_MS - 1);
  write('b');
  t.mock.timers.tick(1);
  write('c');
  assert.deepEqual(times().slice(1), [
    { type: 'stageCommandOutput', activityId: 'a1', ptyId: 'P0', at: '2026-10-10T10:00:00.000Z' },
    { type: 'stageCommandOutput', activityId: 'a1', ptyId: 'P0', at: '2026-10-10T10:00:30.000Z' },
  ]);
  const stage: Stage = { ...STAGE, commands: ['e2e', 'build'], onMissing: 'skip' };
  const skipping = harness();
  await skipping.run(runtimeWith([BUILD, E2E], stage), effect(0, stage));
  assert.deepEqual(skipping.events.slice(-2).map((e) => e.type), ['stageCommandStarted', 'stageCommandEnded']);
  assert.deepEqual(skipping.events.at(-2), { type: 'stageCommandStarted', activityId: 'a1', ptyId: 'P0', at: '2026-10-10T10:00:30.000Z', skipped: true });
});
