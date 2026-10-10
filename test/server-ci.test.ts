import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityOf, resultOf } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { createCiReader, GH_TIMEOUT_MS, LOG_LINES } from '../src/server-ci.js';
import { createServer, type HiveServer } from '../src/server.js';
import { OUTPUT_MAX } from '../src/server-stage-commands.js';
import { saveState } from '../src/state-store.js';
import type { Activity, CiCheck, Exec, HiveEvent, Stage, StageCi, State, Task } from '../src/types.js';
import { tempHive } from './fakes.js';
import { activityIdOf, savedActivityId, withWork } from './fixtures/work.js';
import { send, settingsBody } from './review-server.js';
import { SECRET } from './secret-client.js';

// A wait for CI on the server (#834): the reader alone over fakes, then the timer end to end through a server.

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const APP = 'https://github.com/acme/app/pull/7';
const SITE = 'https://github.com/acme/site/pull/3';
const WAIT: StageCi = { stage: 'ci', since: '2026-10-07T11:00:00.000Z', reran: [] };
const task = (n: number, source?: string): Task =>
  ({ item: { itemId: `${source ?? 'local'}:${n}`, id: String(n), title: `Task ${n}`, body: '', url: '', ...(source === undefined ? {} : { source }) }, stage: 'ci', boardColumn: '', auto: true });
// The state the reader reads: each task with its activity's work and its record's open PRs
function stateOf(entries: [Task, Partial<Activity>, string[]][], extra: Partial<State> = {}): State {
  const start: State = { ...initialState(1), tasks: entries.map(([t]) => t), ...extra };
  return entries.reduce((s, [t, work, urls]) => withWork(s, t.item.itemId, work, { prs: urls.map((url) => ({ url, state: 'open' as const })) }), start);
}
const run = (name: string, conclusion: string | null) => ({
  __typename: 'CheckRun', name, status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED', conclusion,
  detailsUrl: 'https://github.com/acme/app/actions/runs/11/job/1', checkSuite: { workflowRun: { databaseId: 11 } },
});
// #758's rollup under its headCommit alias, with the head's oid the wait adds
const rollup = (head: string, nodes: unknown[]) =>
  ({ baseRef: { refUpdateRule: null }, headCommit: { nodes: [{ commit: { oid: head, statusCheckRollup: { state: 'PENDING', contexts: { nodes } } } }] } });

interface Harness { reader: ReturnType<typeof createCiReader>; queries: string[]; events: HiveEvent[]; calls: { args: string[]; timeout?: number }[]; errors: string[] }
// The reader over a gql, an exec and a dispatch that only record; `answer` is GitHub's, `logOf` gh's stdout for an argv
function harness(state: State, answer: (query: string) => unknown = () => ({}), logOf: (args: string[]) => string = () => ''): Harness {
  const h: Omit<Harness, 'reader'> = { queries: [], events: [], calls: [], errors: [] };
  const reader = createCiReader({
    gql: async (query) => { h.queries.push(query); return answer(query); },
    exec: async (_file, args, opts) => { h.calls.push({ args, timeout: opts?.timeout }); return { stdout: logOf(args) }; },
    dispatch: async (event) => { h.events.push(event); return []; },
    log: { error: (message: string) => { h.errors.push(message); } },
    state: () => state, now: () => NOW,
  });
  return { reader, ...h };
}
const readIds = (events: HiveEvent[]): string[] => events.flatMap((e) => (e.type === 'ciRead' ? [e.activityId] : []));

test('a read covers every waiting activity in one query and dispatches one ciRead each, with its own PRs, at the read\'s time (#834)', async () => {
  const state = stateOf([[task(1), { ci: WAIT }, [APP]], [task(2), { ci: WAIT }, [SITE]], [task(3), {}, [APP]]]);
  const h = harness(state, () => ({ p0: rollup('h1', [run('build', 'SUCCESS')]), p1: rollup('h2', [run('test', null)]) }));
  await h.reader.readAll();
  assert.equal(h.queries.length, 1);
  assert.ok(h.queries[0].includes(`p0: resource(url: "${APP}")`) && h.queries[0].includes(`p1: resource(url: "${SITE}")`));
  const at = new Date(NOW).toISOString();
  assert.deepEqual(h.events.map((e) => (e.type === 'ciRead' ? [e.activityId, e.at, e.prs.map((p) => [p.url, p.head, p.checks.map((c) => c.state)])] : e.type)), [
    [activityIdOf('local:1'), at, [[APP, 'h1', ['success']]]], [activityIdOf('local:2'), at, [[SITE, 'h2', ['pending']]]],
  ]);
});

test('a task whose source is in its quota backoff is left out of the read; the others go on (#834)', async () => {
  const quota = { limit: 5000, remaining: 10, resetsAt: '2026-10-07T13:00:00.000Z', at: '2026-10-07T11:59:00.000Z' };
  const h = harness(stateOf([[task(1, 'board'), { ci: WAIT }, [APP]], [task(2), { ci: WAIT }, [SITE]]], { syncs: { board: { quota } } }), () => ({ p0: rollup('h2', []) }));
  await h.reader.readAll();
  assert.equal(h.queries[0].includes(APP), false);
  assert.deepEqual(readIds(h.events), [activityIdOf('local:2')]);
});

test('nothing waiting sends no query; a wait with no open PR sends none either and still reads, so its timeout counts (#834)', async () => {
  const idle = harness(stateOf([[task(1), {}, [APP]]]));
  await idle.reader.readAll();
  assert.deepEqual([idle.queries, idle.events], [[], []]);
  const bare = harness(stateOf([[task(1), { ci: WAIT }, []]]));
  await bare.reader.readAll();
  assert.deepEqual([bare.queries, bare.events], [[], [{ type: 'ciRead', activityId: activityIdOf('local:1'), at: new Date(NOW).toISOString(), prs: [] }]]);
});

test('a query that fails logs and only ticks each wait\'s clock; a PR the answer left out ticks its activity\'s clock, never a false pass; readOne reads only its activity (#834)', async () => {
  const state = stateOf([[task(1), { ci: WAIT }, [APP]], [task(2), { ci: WAIT }, [SITE]]]);
  const at = new Date(NOW).toISOString();
  const failing = harness(state, () => { throw new Error('gh api graphql: HTTP 502'); });
  await failing.reader.readAll();
  assert.deepEqual([failing.events, failing.errors], [
    [{ type: 'ciClock', activityId: activityIdOf('local:1'), at }, { type: 'ciClock', activityId: activityIdOf('local:2'), at }], ['ci read: gh api graphql: HTTP 502'],
  ]);
  const partial = harness(state, () => ({ p0: rollup('h1', []), p1: null }));
  await partial.reader.readAll();
  assert.deepEqual(partial.events.map((e) => [e.type, 'activityId' in e ? e.activityId : '']), [['ciRead', activityIdOf('local:1')], ['ciClock', activityIdOf('local:2')]]);
  const one = harness(state, () => ({ p0: rollup('h2', []) }));
  await one.reader.readOne(activityIdOf('local:2'));
  assert.equal(one.queries[0].includes(APP), false);
  assert.deepEqual(readIds(one.events), [activityIdOf('local:2')]);
});

test('ciRerun runs gh run rerun --failed per run, an argv array with a 60 s timeout; a failure is logged and the next run still goes (#834)', async () => {
  const h = harness(stateOf([]), undefined, (args) => { if (args[2] === '11') throw new Error('gh run: not found\nmore'); return ''; });
  await h.reader.rerun({ type: 'ciRerun', activityId: 'a1', runs: [{ repo: 'acme/app', runId: 11 }, { repo: 'acme/site', runId: 12 }] });
  assert.deepEqual(h.calls, [
    { args: ['run', 'rerun', '11', '--failed', '-R', 'acme/app'], timeout: GH_TIMEOUT_MS }, { args: ['run', 'rerun', '12', '--failed', '-R', 'acme/site'], timeout: GH_TIMEOUT_MS },
  ]);
  assert.deepEqual(h.errors, ['ci rerun 11: gh run: not found']);
});

test('ciCollect keeps the last 80 lines of each failed job, ANSI stripped, a check outside Actions as its name and url, a fetch error in its block, and always answers ciFailed (#834)', async () => {
  const lines = (job: string, n: number): string => Array.from({ length: n }, (_, i) => `${job}\tstep\t\u001b[31mline ${i}\u001b[0m`).join('\n');
  const h = harness(stateOf([]), undefined, (args) => {
    if (args[2] !== '11') throw new Error('HTTP 410: logs expired');
    return `${lines('build', 200)}\n${lines('lint', 5)}`;
  });
  const failed: CiCheck[] = [
    { name: 'build', pr: APP, state: 'failure', runId: 11, url: 'https://github.com/acme/app/actions/runs/11/job/1' },
    { name: 'lint', pr: APP, state: 'failure', runId: 11 },
    { name: 'e2e', pr: APP, state: 'failure', runId: 13 },
    { name: 'vercel', pr: APP, state: 'failure', url: 'https://vercel.com/x' },
  ];
  await h.reader.collect({ type: 'ciCollect', activityId: 'a1', failed });
  assert.deepEqual(h.calls.map((c) => c.args), [['run', 'view', '11', '--log-failed', '-R', 'acme/app'], ['run', 'view', '13', '--log-failed', '-R', 'acme/app']], 'one gh run view per run');
  const [event] = h.events;
  assert.ok(event?.type === 'ciFailed');
  assert.deepEqual([event.activityId, event.names], ['a1', ['build', 'lint', 'e2e', 'vercel']]);
  const [build, lint, e2e, vercel] = event.output.split('\n\n');
  assert.equal(build.split('\n')[0], 'build · #7 · https://github.com/acme/app/actions/runs/11/job/1');
  assert.equal(build.split('\n').length, 1 + LOG_LINES);
  assert.ok(build.endsWith('build\tstep\tline 199') && !event.output.includes('\u001b'));
  assert.equal(lint.split('\n').length, 1 + 5);
  assert.equal(e2e, 'e2e · #7\nlog unavailable: HTTP 410: logs expired');
  assert.equal(vercel, 'vercel · #7 · https://vercel.com/x');
});

test('ciCollect caps the output at 16 000 characters, the block keeping its header and its log\'s tail (#834)', async () => {
  const long = Array.from({ length: LOG_LINES }, (_, i) => `build\tstep\t${'x'.repeat(400)} ${i}`).join('\n');
  const h = harness(stateOf([]), undefined, () => long);
  await h.reader.collect({ type: 'ciCollect', activityId: 'a1', failed: [{ name: 'build', pr: APP, state: 'failure', runId: 11 }] });
  const [event] = h.events;
  assert.ok(event?.type === 'ciFailed');
  assert.ok(event.output.length <= OUTPUT_MAX);
  assert.ok(event.output.startsWith('build · #7\n') && event.output.endsWith(` ${LOG_LINES - 1}`));
});

test('ciCollect drops control characters from the logs and turns a check name\'s line breaks into spaces, so no line is forged (#834)', async () => {
  const h = harness(stateOf([]), undefined, () => 'job\tstep\tbell\u0007 here\r\njob\tstep\tback\u0008space\u007f\u001b[31m!\u001b[0m');
  await h.reader.collect({ type: 'ciCollect', activityId: 'a1', failed: [{ name: 'build\nfake · #9\r', pr: APP, state: 'failure', runId: 11 }] });
  const [event] = h.events;
  assert.ok(event?.type === 'ciFailed');
  assert.deepEqual(event.names, ['build fake · #9 ']);
  assert.equal(event.output, 'build fake · #9  · #7\njob\tstep\tbell here\njob\tstep\tbackspace!');
});

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await sleep(5);
  assert.ok(done(), 'timed out waiting');
}

/** A server over a saved local task waiting in a wait-for-CI stage with one open PR (#834); `checks` is what GitHub reports at each read. The
 * timer is mocked before listen, so a test ticks it. */
async function waitingServer(t: TestContext, checks: () => unknown[] = () => []): Promise<{ server: HiveServer; base: string; reads: string[] }> {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { home, repo } = await tempHive(t);
  const stages: Stage[] = [{ name: 'ci', from: {}, action: 'waitForCi', ciChecks: 'all', rerunOnce: false }, { name: 'review', from: {} }];
  const local: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Task 1', body: '', url: '' }, stage: 'ci', boardColumn: '', auto: true, created: true, workspace: 'hive' };
  await saveState(home, withWork({ ...initialState(0), localCount: 1, tasks: [local] }, 'local:1', { id: savedActivityId(1), slug: 'hive-1-task-1', ci: WAIT }, { prs: [{ url: APP, state: 'open' }] }));
  const reads: string[] = [];
  const exec: Exec = async (file, args) => {
    const query = args.find((a) => a.startsWith('query='));
    if (file !== 'gh' || query === undefined) return { stdout: '' };
    if (!query.includes('requiredStatusCheckContexts')) return { stdout: JSON.stringify({ data: {} }) }; // the PR poll's and the PR page's own queries
    reads.push(query);
    return { stdout: JSON.stringify({ data: { p0: rollup('h1', checks()) } }) };
  };
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send(base, 'POST', '/settings', settingsBody(repo, stages))).status, 200);
  return { server, base, reads };
}

test('the timer reads a waiting task\'s CI on every tick, apart from the poll, and a passed CI moves the task on (#834)', async (t) => {
  let green = false;
  const { server, reads } = await waitingServer(t, () => [run('build', green ? 'SUCCESS' : null)]);
  t.mock.timers.tick(30_000);
  await waitFor(() => activityOf(server.getState()!, 'local:1')?.ci?.total === 1);
  green = true;
  t.mock.timers.tick(30_000);
  await waitFor(() => server.getState()?.tasks[0]?.stage === 'review');
  assert.ok(reads.length >= 2);
  assert.deepEqual(resultOf(server.getState()!, 'local:1')?.ci, { verdict: 'passed' });
});

test('POST /activities/:id/ci/stop ends the wait, stopped, with no verdict; an activity waiting for nothing answers 404 (#834)', async (t) => {
  const { server, base } = await waitingServer(t);
  const path = `/activities/${encodeURIComponent(savedActivityId(1))}/ci/stop`;
  assert.equal((await send(base, 'POST', path)).status, 200);
  const after = activityOf(server.getState()!, 'local:1');
  assert.deepEqual([after?.ci, after?.stopped, resultOf(server.getState()!, 'local:1')?.ci], [undefined, true, undefined]);
  assert.equal((await send(base, 'POST', path)).status, 404);
});
