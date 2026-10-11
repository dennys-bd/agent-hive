import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { initialState } from '../src/orchestrator.js';
import { registerApprovalRoutes } from '../src/server-approval.js';
import { registerDecompositionRoutes } from '../src/server-decomposition.js';
import type { TaskRouteDeps } from '../src/server-tasks.js';
import { ADD_PROJECT_ITEM, CREATE_ISSUE, ISSUE_ID, PROJECT_FIELDS, REPOSITORY_ID } from '../src/sources/github-queries.js';
import { worktreePath } from '../src/worktree.js';
import type { CombConfig, DecompositionPreview, Exec, HiveEvent, SourceConfig, State, Task } from '../src/types.js';
import { fakeGqlJson, GITHUB_ENTRY } from './fakes.js';
import { activityIdOf, withWork } from './fixtures/work.js';
import { EXAMPLE } from './fixtures/decomposition.js';
import { tempDir } from './temp-dir.js';

// The decomposition's routes (#865) alone over a saved state: the goal's worktree holds decomposition.md, GitHub is a fake, and every
// dispatched event is recorded rather than reduced.

const SLUG = 'hive-7-site';
const SINCE = '2026-10-09T10:00:00.000Z';
const GOAL: Task = {
  item: { itemId: 'board:I7', id: '7', title: 'Site for XPTO', body: '', url: 'https://github.com/acme/site/issues/7', source: 'board' },
  stage: 'goal', boardColumn: 'Goals', auto: true, workspace: 'hive',
};
const LOCAL: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Site for XPTO', body: '', url: '' }, stage: 'goal', boardColumn: '', auto: true, created: true, workspace: 'hive' };
const FIELDS = { repositoryOwner: { projectV2: { id: 'PV1', field: { id: 'F1', options: [{ id: 'o1', name: 'Backlog' }, { id: 'o2', name: 'Goals' }] } } } };
const PENDING = { decomposition: 'decomposition.md' };

interface Setup { task?: Task; result?: Record<string, unknown>; awaiting?: boolean; text?: string; origin?: string; fail?: string; sources?: SourceConfig[] }

async function routes(t: TestContext, setup: Setup = {}) {
  const repo = await realpath(await tempDir(t, 'hive-865-'));
  const worktree = worktreePath(repo, SLUG);
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, 'decomposition.md'), setup.text ?? EXAMPLE);
  await writeFile(join(repo, 'outside.md'), EXAMPLE);
  const task = setup.task ?? GOAL;
  const work = { slug: SLUG, ...(setup.awaiting === false ? {} : { approval: { since: SINCE } }) };
  const state: State = withWork({ ...initialState(0), tasks: [task] }, task.item.itemId, work, { result: setup.result ?? PENDING });
  const comb: CombConfig = {
    prefix: 'HIVE', workspaces: [{ name: 'hive', path: repo, env: {}, fork: null, memoryCap: 4000 }], sources: setup.sources ?? [GITHUB_ENTRY], commands: [],
    stages: [{ name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive:new-spec {url}' }, { name: 'goal', from: { board: ['Goals'] }, prompt: '/hive:decomposition {url}', approval: true }],
    transitions: [], hiveSource: true, createIn: 'hive',
  };
  const events: HiveEvent[] = [];
  const exec: Exec = async () => ({ stdout: `${setup.origin ?? ''}\n` });
  let number = 100;
  const { calls, gql } = fakeGqlJson((query, variables) => {
    if (setup.fail !== undefined && query === CREATE_ISSUE && number === 101) throw new Error(setup.fail);
    if (query === PROJECT_FIELDS) return FIELDS;
    if (query === REPOSITORY_ID) return { repository: { id: 'R1' } };
    if (query === ISSUE_ID) return { repository: { issue: { id: `I${String(variables.number)}` } } };
    if (query === CREATE_ISSUE) {
      number += 1;
      return { createIssue: { issue: { id: `I${number}`, number } } };
    }
    if (query === ADD_PROJECT_ITEM) return { addProjectV2ItemById: { item: { id: 'PI' } } };
    return {};
  });
  const app = express();
  app.use(express.json());
  const dispatch = async (event: HiveEvent): Promise<never[]> => { events.push(event); return []; };
  registerDecompositionRoutes(app, { requireLive: () => ({ state, runtime: { config: { comb } } }), dispatch, exec, gql });
  registerApprovalRoutes(app, { requireLive: (() => ({ state, runtime: { config: { comb } } })) as unknown as TaskRouteDeps['requireLive'], dispatch });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/activities/${encodeURIComponent(activityIdOf(task.item.itemId))}`;
  return { url: `${base}/decomposition`, base, events, calls, app, worktree };
}

const post = (url: string, body: unknown): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const CHOICE = { source: 'board', column: 'Backlog' };
const stepsOf = (events: HiveEvent[]): string[] => events.map((e) => (e.type === 'decompositionIssue' ? `${e.id}=${e.number}` : e.type));

test('GET answers what the dialog shows: the counts, the suggestions, the goal\'s repository and each GitHub source with its Status options and suggested column (#865)', async (t) => {
  const { url } = await routes(t);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const expected: DecompositionPreview = {
    title: 'Site for XPTO', issues: 6, blockers: 3, suggestions: 1, problems: [], repository: 'acme/site',
    sources: [{ name: 'board', statuses: ['Backlog', 'Goals'], column: 'Backlog' }],
  };
  assert.deepEqual(await res.json(), expected);
});

test('GET refuses a path that resolves outside the worktree, and a file that is not there (#865)', async (t) => {
  const outside = await routes(t, { result: { decomposition: '../../../outside.md' } });
  const refused = await fetch(outside.url);
  assert.deepEqual([refused.status, await refused.json()], [409, { error: 'a decomposição precisa estar na worktree da tarefa' }]);
  const missing = await routes(t, { result: { decomposition: 'nope.md' } });
  assert.deepEqual((await fetch(missing.url)).status, 404);
});

test('GET on a local goal counts its root issue, and reports a workspace with no GitHub origin by leaving the repository out (#865)', async (t) => {
  const none = await routes(t, { task: LOCAL });
  const read = (await (await fetch(none.url)).json()) as DecompositionPreview;
  assert.deepEqual([read.issues, 'repository' in read], [7, false]);
  const origin = await routes(t, { task: LOCAL, origin: 'git@github.com:acme/hive.git' });
  assert.equal(((await (await fetch(origin.url)).json()) as DecompositionPreview).repository, 'acme/hive');
});

test('GET lists the problems with their lines and no title (#865)', async (t) => {
  const { url } = await routes(t, { text: ['# G', '## 1 A', '### Scope', 'In: a.', '## 2 B', '### Scope', 'In: b.', '### Acceptance criteria', '- it works'].join('\n') });
  const read = (await (await fetch(url)).json()) as DecompositionPreview;
  assert.deepEqual([read.problems, read.issues, 'title' in read], [[{ line: 2, message: 'a leaf needs "### Acceptance criteria"' }], 0, false]);
});

test('POST refuses 409 on a task not awaiting approval, and on a file with problems, before asking GitHub anything (#865)', async (t) => {
  const idle = await routes(t, { awaiting: false });
  const refused = await post(idle.url, CHOICE);
  assert.deepEqual([refused.status, await refused.json()], [409, { error: 'tarefa não aguarda aprovação' }]);
  const broken = await routes(t, { text: ['# G', '## 1 A', '### Scope', 'In: a.'].join('\n') });
  const problems = await post(broken.url, CHOICE);
  assert.deepEqual([problems.status, await problems.json()], [409, { error: 'decomposition.md tem problemas: corrija antes de criar as issues' }]);
  assert.deepEqual([idle.calls.length, broken.calls.length, idle.events, broken.events], [0, 0, [], []]);
});

test('POST refuses 400 a source that is no GitHub source and a column that is no Status option of it (#865)', async (t) => {
  const { url, events } = await routes(t);
  for (const body of [{ source: 'other', column: 'Backlog' }, { source: 'board', column: 'Done' }, {}]) {
    const res = await post(url, body);
    assert.deepEqual([res.status, await res.json()], [400, { error: 'source precisa ser uma source do GitHub e column uma opção do seu Status' }], JSON.stringify(body));
  }
  assert.deepEqual(events, []);
});

test('POST on a GitHub goal records each step as it is done, then approves the stage straight through the reducer (#865)', async (t) => {
  const { url, events } = await routes(t);
  const res = await post(url, CHOICE);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(stepsOf(events), ['design=7', '1=101', '1.1=102', '1.2=103', '2=104', '2.1=105', '2.2=106', 'done=7', 'approve']);
  assert.deepEqual(events.at(-1), { type: 'approve', activityId: activityIdOf('board:I7') });
});

test('POST on a local goal writes its root issue first and ends with closeTask (#865)', async (t) => {
  const { url, events } = await routes(t, { task: LOCAL, origin: 'git@github.com:acme/hive.git' });
  assert.equal((await post(url, CHOICE)).status, 200);
  assert.deepEqual(stepsOf(events), ['root=101', '1=102', '1.1=103', '1.2=104', '2=105', '2.1=106', '2.2=107', 'done=101', 'closeTask']);
  const local = await routes(t, { task: LOCAL });
  const refused = await post(local.url, CHOICE);
  assert.deepEqual([refused.status, await refused.json()], [409, { error: 'o workspace não tem origin no GitHub' }]);
});

test('a GitHub error answers 502 with its message; the steps done stay recorded and the stage does not end (#865)', async (t) => {
  const { url, events } = await routes(t, { fail: 'was submitted too quickly' });
  const res = await post(url, CHOICE);
  assert.deepEqual([res.status, await res.json()], [502, { error: 'was submitted too quickly' }]);
  assert.deepEqual(stepsOf(events), ['design=7', '1=101']);
});

test('POST refuses 409 a decomposition already written (#865)', async (t) => {
  const { url } = await routes(t, { result: { ...PENDING, decompositionIssues: { done: 7 } } });
  const res = await post(url, CHOICE);
  assert.deepEqual([res.status, await res.json()], [409, { error: 'a decomposição já foi escrita no GitHub' }]);
});

test('POST …/approve refuses 409 while a decomposition is not on GitHub, from whichever door it comes, and approves once it is (#865)', async (t) => {
  const pending = await routes(t);
  const refused = await post(`${pending.base}/approve`, {});
  assert.deepEqual([refused.status, await refused.json()], [409, { error: 'a decomposição ainda não foi escrita no GitHub: use criar issues' }]);
  assert.deepEqual(pending.events, []);
  const written = await routes(t, { result: { ...PENDING, decompositionIssues: { done: 7 } } });
  assert.equal((await post(`${written.base}/approve`, {})).status, 200);
  assert.deepEqual(written.events.map((e) => e.type), ['approve']);
});

test('with no GitHub source there is nowhere to write the tree: approve is plain (#865)', async (t) => {
  const { base, events } = await routes(t, { sources: [] });
  assert.equal((await post(`${base}/approve`, {})).status, 200);
  assert.deepEqual(events.map((e) => e.type), ['approve']);
});

test('GET answers a fixed 500 for a local read failure, without the path, and 413 for a file over 256 KB (#865)', async (t) => {
  const { url, worktree } = await routes(t);
  await chmod(join(worktree, 'decomposition.md'), 0o000);
  const failed = await fetch(url);
  assert.deepEqual([failed.status, await failed.json()], [500, { error: 'não foi possível ler o decomposition.md' }]);
  const big = await routes(t, { text: 'x'.repeat(256 * 1024 + 1) });
  const refused = await fetch(big.url);
  assert.deepEqual([refused.status, await refused.json()], [413, { error: 'o decomposition.md passa de 256 KB' }]);
});
