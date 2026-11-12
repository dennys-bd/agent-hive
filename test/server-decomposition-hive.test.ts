import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { activityOf, resultOf } from '../src/activities.js';
import { decompositionTarget } from '../src/decomposition.js';
import { NOT_CREATED_MESSAGE } from '../src/decomposition-write-hive.js';
import { flatten } from '../src/flows.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { registerDecompositionRoutes } from '../src/server-decomposition.js';
import { CREATE_ISSUE, CREATE_PULL_REQUEST, PROJECT_FIELDS, REPOSITORY_BRANCH } from '../src/sources/github-queries.js';
import { worktreePath } from '../src/worktree.js';
import { END, HIVE_EPIC, type CombConfig, type DecompositionPreview, type Effect, type Exec, type HiveEvent, type State, type Task, type TaskEntry } from '../src/types.js';
import { fakeGqlJson, fakeLog, GITHUB_ENTRY } from './fakes.js';
import { HIVE_TREE, hiveFlows } from './fixtures/decomposition.js';
import { activityIdOf, withWork } from './fixtures/work.js';
import { tempDir } from './temp-dir.js';

// The decomposition's routes with the hive target (#783), over the real reducer and no worker: every dispatch reduces the state the next
// request and latest() read; git and GitHub are fakes; the goal's worktree holds the file.

const SLUG = 'hive-7-site';
const SINCE = '2026-11-12T10:00:00.000Z';
const DOCS_ORIGIN = 'git@github.com:acme/docs.git';
const FIELDS = { repositoryOwner: { projectV2: { id: 'PV1', field: { id: 'F1', options: [{ id: 'o1', name: 'Backlog' }, { id: 'o2', name: 'Goals' }] } } } };
const PENDING = { decomposition: 'decomposition.md' };
const HIVE_GOAL: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Site for XPTO', body: '', url: '' }, stage: 'goal', boardColumn: '', auto: true, created: true, workspace: 'hive' };
const GITHUB_GOAL: Task = { item: { itemId: 'board:I7', id: '7', title: 'Site for XPTO', body: '', url: 'https://github.com/acme/site/issues/7', source: 'board' }, stage: 'goal', boardColumn: 'Goals', auto: true, workspace: 'hive' };
// a hive task made from the GitHub goal's item (#756): what decision 9 refuses to duplicate
const COPY: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Site for XPTO', body: '', url: '', origin: 'board:I7' }, boardColumn: '', auto: true, created: true };
const ENTRIES: TaskEntry[] = [null, { flow: 'main' }, { flow: 'main', stage: 'goal' }, { flow: 'main', stage: 'spec' }, { flow: 'other' }, { flow: 'other', stage: 'build' }];

interface Setup {
  task?: Task; others?: Task[]; result?: Record<string, unknown>; to?: string; hiveSource?: boolean; docsOrigin?: string; noCheckout?: boolean; branch?: string;
  onEvent?(event: HiveEvent, state: State): State; // a change of the state right after a dispatch: a stage removed mid-write
}

async function routes(t: TestContext, setup: Setup = {}) {
  const repo = await realpath(await tempDir(t, 'hive-783-'));
  const worktree = worktreePath(repo, SLUG);
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, 'decomposition.md'), HIVE_TREE);
  const task = setup.task ?? HIVE_GOAL;
  const flows = hiveFlows(setup.to);
  const tasks = [task, ...(setup.others ?? [])];
  const localCount = tasks.filter((c) => c.created === true).length; // the fixtures' local numbers are handed out already
  let state: State = withWork({ ...initialState(0), workspaces: ['hive'], flows, ...flatten(flows), tasks, localCount }, task.item.itemId, { slug: SLUG, approval: { since: SINCE } }, { result: setup.result ?? PENDING });
  const comb: CombConfig = {
    prefix: 'HIVE', workspaces: [{ name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }],
    sources: [GITHUB_ENTRY], commands: [], flows, hiveSource: setup.hiveSource ?? true, createIn: 'hive',
  };
  const events: HiveEvent[] = [];
  const git: string[][] = [];
  const exec: Exec = async (_file, args) => {
    git.push(args);
    if (args.includes('--show-toplevel')) {
      if (setup.noCheckout === true) throw Object.assign(new Error('Command failed: git rev-parse'), { stderr: 'fatal: not a git repository\n' });
      return { stdout: `${worktree}\n` };
    }
    if (args.includes('check-ignore')) throw Object.assign(new Error('Command failed: git check-ignore'), { code: 1, stderr: '' });
    if (args.includes('--show-current')) return { stdout: `${setup.branch ?? 'hive/7-site'}\n` };
    if (args.includes('get-url')) return { stdout: `${args[1] === worktree ? setup.docsOrigin ?? DOCS_ORIGIN : ''}\n` };
    return { stdout: '' };
  };
  const { calls, gql } = fakeGqlJson((query) => {
    if (query === PROJECT_FIELDS) return FIELDS;
    if (query === REPOSITORY_BRANCH) return { repository: { id: 'RD', defaultBranchRef: { name: 'trunk' } } };
    if (query === CREATE_PULL_REQUEST) return { createPullRequest: { pullRequest: { number: 300, url: 'https://github.com/acme/docs/pull/300' } } };
    return {};
  });
  const dispatch = async (event: HiveEvent): Promise<Effect[]> => {
    events.push(event);
    const reduced = reduce(state, event);
    state = setup.onEvent?.(event, reduced.state) ?? reduced.state;
    return reduced.effects;
  };
  const { log, lines } = fakeLog();
  const app = express();
  app.use(express.json());
  registerDecompositionRoutes(app, { requireLive: () => ({ state, runtime: { config: { comb } } }), dispatch, latest: () => state, exec, gql, log, sleep: async () => undefined });
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/activities/${encodeURIComponent(activityIdOf(task.item.itemId))}/decomposition`;
  return { url, events, calls, git, lines, state: () => state, setState: (next: State) => { state = next; } };
}

const post = (url: string, body: unknown): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const read = async (url: string): Promise<DecompositionPreview> => (await (await fetch(url)).json()) as DecompositionPreview;

test('GET with hiveSource on offers the hive: outside the flow, every flow and its stages, the flow the approve leads to, the task count, preselected for a hive goal, its own delivery (#783)', async (t) => {
  const preview = await read((await routes(t)).url);
  assert.deepEqual(preview.hive, { entries: ENTRIES, entry: { flow: 'main' }, tasks: 4, preselected: true, delivery: { repository: 'acme/docs', branch: 'hive/7-site', path: 'decomposition.md' } });
  assert.equal('target' in preview, false);
  assert.deepEqual(preview.sources.map((s) => s.name), ['board'], 'sources stay GitHub only');
});

test('the suggested entry is the flow the approved exit leads to, and the goal\'s own flow when it leads to END (#783)', async (t) => {
  assert.deepEqual((await read((await routes(t, { to: 'build' })).url)).hive?.entry, { flow: 'other' });
  assert.deepEqual((await read((await routes(t, { to: END })).url)).hive?.entry, { flow: 'main' });
});

test('a GitHub goal counts its root task and is not preselected; with hiveSource off there is no hive, and a recorded target is still answered (#783)', async (t) => {
  const github = await read((await routes(t, { task: GITHUB_GOAL })).url);
  assert.deepEqual([github.hive?.tasks, github.hive?.preselected], [5, undefined]);
  const off = await read((await routes(t, { hiveSource: false, result: { ...PENDING, decompositionTarget: 'hive' } })).url);
  assert.deepEqual(['hive' in off, off.target], [false, 'hive']);
});

test('a checkout with no GitHub origin, and a file in no checkout, stay local under the hive with no refusal, while the GitHub target is still refused (#783)', async (t) => {
  // the file sits at its checkout's root, so the path in the checkout and the path the result names are both decomposition.md here;
  // test/decomposition-deliver.test.ts tells the two apart
  const cases: [Setup, string][] = [[{ docsOrigin: '' }, 'the decomposition file\'s checkout has no GitHub origin'], [{ noCheckout: true }, 'the decomposition file is in no git checkout']];
  for (const [setup, refusal] of cases) {
    const preview = await read((await routes(t, setup)).url);
    assert.deepEqual([preview.hive?.delivery, preview.hive?.deliveryRefusal, preview.deliveryRefusal], [{ path: 'decomposition.md', local: true }, undefined, refusal], refusal);
  }
});

test('a GitHub goal whose item a hive task already holds as origin answers hive.refusal, until root is recorded (#783)', async (t) => {
  const taken = await read((await routes(t, { task: GITHUB_GOAL, others: [COPY] })).url);
  assert.equal(taken.hive?.refusal, 'já existe uma tarefa criada desse item');
  const resumed = await read((await routes(t, { task: GITHUB_GOAL, others: [COPY], result: { ...PENDING, decompositionTarget: 'hive', decompositionIssues: { root: 1 } } })).url);
  assert.deepEqual([resumed.hive?.refusal, resumed.target], [undefined, 'hive']);
});

test('after a partial hive write the preview answers target hive, and a POST naming a GitHub source is a 409 that writes nothing (#783)', async (t) => {
  const { url, events, calls } = await routes(t, { result: { ...PENDING, decompositionTarget: 'hive', decompositionIssues: { '1': 2 } } });
  assert.equal((await read(url)).target, 'hive');
  const asked = calls.length;
  const res = await post(url, { source: 'board', column: 'Backlog' });
  assert.deepEqual([res.status, await res.json()], [409, { error: 'a decomposição já começou a ser escrita no hive: continue por lá' }]);
  assert.deepEqual([events, calls.length], [[], asked]);
});

const hive = (entry: unknown) => ({ source: 'hive', entry });
const ENTRY: TaskEntry = { flow: 'main', stage: 'spec' };
const NODES = ['local:2', 'local:3', 'local:4', 'local:5'];
const taskIn = (state: State, itemId: string): Task | undefined => state.tasks.find((c) => c.item.itemId === itemId);
const stepsOf = (events: HiveEvent[]): string[] => events.map((e) => (e.type === 'decompositionIssue' ? `${e.id}=${e.number}` : e.type));

test('POST on a hive goal writes the tree under it at the entry, auto on, in its workspace, the inner node born an epic; then stamps the goal and approves it by its approved exit; no issue is created (#783)', async (t) => {
  const { url, events, calls, state } = await routes(t);
  const res = await post(url, hive(ENTRY));
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(stepsOf(events), ['decompositionTarget', 'createTask', '1=2', 'createTask', '1.1=3', 'createTask', '1.2=4', 'createTask', '2=5', 'blockerSet', 'pr=300', 'done=1', 'markEpic', 'approve']);
  const s = state();
  assert.deepEqual(NODES.map((id) => [taskIn(s, id)?.stage, taskIn(s, id)?.auto, taskIn(s, id)?.workspace]), Array<unknown>(4).fill(['spec', true, 'hive']));
  assert.deepEqual(NODES.map((id) => [taskIn(s, id)?.item.parent, taskIn(s, id)?.item.epic]), [['local:1', HIVE_EPIC], ['local:2', undefined], ['local:2', undefined], ['local:1', undefined]]);
  assert.deepEqual([taskIn(s, 'local:4')?.item.blockers?.blockedBy.map((r) => r.id), taskIn(s, 'local:3')?.item.blockers?.blocking.map((r) => r.id)], [['HIVE-3'], ['HIVE-4']]);
  assert.match(taskIn(s, 'local:3')?.item.body ?? '', /^Parent: HIVE-2\nDesign: https:\/\/github\.com\/acme\/docs\/blob\/trunk\/decomposition\.md#1-pages$/m);
  assert.deepEqual([taskIn(s, 'local:1')?.item.epic, taskIn(s, 'local:1')?.stage, activityOf(s, 'local:1')?.approval], [HIVE_EPIC, 'spec', undefined]);
  assert.equal(calls.some((c) => c.query === CREATE_ISSUE), false);
});

test('POST on a GitHub goal creates a root hive task from it, born an epic and never started, the tree under it, and approves the goal with no stamp; no issue is created (#783)', async (t) => {
  const { url, events, calls, state } = await routes(t, { task: GITHUB_GOAL });
  assert.equal((await post(url, hive(ENTRY))).status, 200);
  assert.deepEqual(stepsOf(events), ['decompositionTarget', 'createTask', 'root=1', 'createTask', '1=2', 'createTask', '1.1=3', 'createTask', '1.2=4', 'createTask', '2=5', 'blockerSet', 'pr=300', 'done=1', 'approve']);
  const s = state();
  const root = taskIn(s, 'local:1');
  assert.deepEqual([root?.item.title, root?.item.origin, root?.item.url, root?.item.epic, root?.stage], ['Site for XPTO', 'board:I7', GITHUB_GOAL.item.url, HIVE_EPIC, 'spec']);
  assert.equal(activityOf(s, 'local:1')?.workerId, undefined, 'never started');
  assert.deepEqual(['local:2', 'local:5'].map((id) => taskIn(s, id)?.item.parent), ['local:1', 'local:1']);
  assert.deepEqual([taskIn(s, 'board:I7')?.item.epic, taskIn(s, 'board:I7')?.stage, activityOf(s, 'board:I7')?.approval], [undefined, 'spec', undefined]);
  assert.equal(calls.some((c) => c.query === CREATE_ISSUE), false);
});

test('the entry null creates the tasks outside the flow, and the goal still moves by its approve (#783)', async (t) => {
  const { url, state } = await routes(t);
  assert.equal((await post(url, hive(null))).status, 200);
  const s = state();
  assert.deepEqual(NODES.map((id) => taskIn(s, id)?.stage), [undefined, undefined, undefined, undefined]);
  assert.deepEqual([taskIn(s, 'local:1')?.stage, taskIn(s, 'local:1')?.item.epic, activityOf(s, 'local:1')?.approval], ['spec', HIVE_EPIC, undefined]);
});

test('an approve that leads to END: the goal leaves the state and its children keep item.parent (#783)', async (t) => {
  const { url, state } = await routes(t, { to: END });
  assert.equal((await post(url, hive(ENTRY))).status, 200);
  // the stamped goal is not followed while it awaits approval, so the approve takes its END exit (decision 12)
  assert.equal(taskIn(state(), 'local:1'), undefined);
  assert.deepEqual(['local:2', 'local:5'].map((id) => taskIn(state(), id)?.item.parent), ['local:1', 'local:1']);
});

test('a write stopped halfway answers 502 with code hive and logs its words; what was recorded stays, and the next POST creates only the missing tasks, no blocker twice (#783)', async (t) => {
  let removed = false;
  const onEvent = (event: HiveEvent, s: State): State => {
    if (removed || event.type !== 'decompositionIssue' || event.id !== '1') return s;
    removed = true;
    return { ...s, stages: s.stages.filter((stage) => stage.name !== 'spec') };
  };
  const { url, events, lines, state, setState } = await routes(t, { onEvent });
  const res = await post(url, hive(ENTRY));
  assert.deepEqual([res.status, await res.json()], [502, { error: NOT_CREATED_MESSAGE, code: 'hive' }]);
  assert.deepEqual(lines, [`WARN decomposition #HIVE-1: the hive write stopped: ${NOT_CREATED_MESSAGE}`]);
  assert.deepEqual(resultOf(state(), 'local:1'), { ...PENDING, decompositionTarget: 'hive', decompositionIssues: { '1': 2 } });
  setState({ ...state(), stages: flatten(state().flows).stages });
  const first = events.length;
  assert.equal((await post(url, hive(ENTRY))).status, 200);
  assert.deepEqual(stepsOf(events.slice(first)), ['createTask', '1.1=3', 'createTask', '1.2=4', 'createTask', '2=5', 'blockerSet', 'pr=300', 'done=1', 'markEpic', 'approve']);
  assert.deepEqual(taskIn(state(), 'local:4')?.item.blockers?.blockedBy.map((r) => r.id), ['HIVE-3']);
});

test('a press the delivery refuses (the docs repository\'s default branch) writes nothing and records no target (#783)', async (t) => {
  const { url, events, state } = await routes(t, { branch: 'trunk' });
  const res = await post(url, hive(ENTRY));
  assert.deepEqual([res.status, ((await res.json()) as { error: string }).error], [409, 'the decomposition file\'s checkout is on acme/docs\'s default branch (trunk): the Hive never pushes it']);
  assert.deepEqual([events, decompositionTarget(resultOf(state(), 'local:1'))], [[], undefined]);
});

test('a partial GitHub write refuses a hive POST, an entry that is none of the offered is a 400, and the hive off is a 409; none writes anything (#783)', async (t) => {
  const github = await routes(t, { task: GITHUB_GOAL, result: { ...PENDING, decompositionIssues: { design: 7 } } });
  const refused = await post(github.url, hive(ENTRY));
  assert.deepEqual([refused.status, await refused.json()], [409, { error: 'a decomposição já começou a ser escrita no GitHub: continue por lá' }]);
  const local = await routes(t);
  for (const body of [{ source: 'hive' }, hive({ flow: 'nope' }), hive({ flow: 'main', stage: 'build' }), hive({ flow: 'main', stage: 'spec', more: 1 })]) {
    const res = await post(local.url, body);
    assert.deepEqual([res.status, await res.json()], [400, { error: 'entry precisa ser uma das entradas oferecidas' }], JSON.stringify(body));
  }
  const off = await routes(t, { hiveSource: false });
  const closed = await post(off.url, hive(ENTRY));
  assert.deepEqual([closed.status, await closed.json()], [409, { error: 'hive is turned off: create the task in a source' }]);
  assert.deepEqual([github.events, local.events, off.events], [[], [], []]);
});

test('a GitHub goal whose item a hive task holds as origin is refused 409 with nothing written; with root recorded the write goes on (#783)', async (t) => {
  const taken = await routes(t, { task: GITHUB_GOAL, others: [COPY] });
  const res = await post(taken.url, hive(ENTRY));
  assert.deepEqual([res.status, await res.json(), taken.events], [409, { error: 'já existe uma tarefa criada desse item' }, []]);
  const resumed = await routes(t, { task: GITHUB_GOAL, others: [COPY], result: { ...PENDING, decompositionTarget: 'hive', decompositionIssues: { root: 1 } } });
  assert.equal((await post(resumed.url, hive(ENTRY))).status, 200);
  assert.equal(stepsOf(resumed.events).includes('root=1'), false, 'the recorded root is not created again');
  assert.equal(taskIn(resumed.state(), 'local:2')?.item.parent, 'local:1');
});

test('under the hive a checkout with no GitHub origin does not refuse the write: the tasks are created, nothing is pushed or opened, and no body links the file (#783)', async (t) => {
  const { url, events, git, calls, state } = await routes(t, { docsOrigin: '' });
  assert.equal((await post(url, hive(ENTRY))).status, 200);
  assert.deepEqual([git.some((args) => args.includes('push')), calls.some((c) => c.query === CREATE_PULL_REQUEST), stepsOf(events).includes('pr=300')], [false, false, false]);
  assert.deepEqual(NODES.map((id) => taskIn(state(), id) !== undefined), [true, true, true, true]);
  assert.doesNotMatch(taskIn(state(), 'local:3')?.item.body ?? '', /^Design:/m);
});

test('a delivered hive write opens its PR named by the goal\'s ref and title: the display id for a hive goal, owner/repo#n for a GitHub goal (#783)', async (t) => {
  const cases: [Task, string][] = [[HIVE_GOAL, 'docs: decomposition for HIVE-1: Site for XPTO'], [GITHUB_GOAL, 'docs: decomposition for acme/site#7: Site for XPTO']];
  for (const [task, title] of cases) {
    const { url, calls } = await routes(t, { task });
    assert.equal((await post(url, hive(ENTRY))).status, 200);
    assert.deepEqual(calls.filter((c) => c.query === CREATE_PULL_REQUEST).map((c) => c.variables.title), [title]);
  }
});
