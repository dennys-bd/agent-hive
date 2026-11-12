import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { flatten } from '../src/flows.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { registerDecompositionRoutes } from '../src/server-decomposition.js';
import { CREATE_PULL_REQUEST, PROJECT_FIELDS, REPOSITORY_BRANCH } from '../src/sources/github-queries.js';
import { worktreePath } from '../src/worktree.js';
import { END, type CombConfig, type DecompositionPreview, type Effect, type Exec, type HiveEvent, type State, type Task, type TaskEntry } from '../src/types.js';
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
