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
import { ADD_PROJECT_ITEM, CREATE_ISSUE, CREATE_PULL_REQUEST, ISSUE_ID, PROJECT_FIELDS, REPOSITORY_BRANCH } from '../src/sources/github-queries.js';
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
// #936: the worktree's checkout answers a separate docs repository, so the links and the PR go there while the issues go to acme/site
const DOCS_ORIGIN = 'git@github.com:acme/docs.git';

interface Setup {
  task?: Task; result?: Record<string, unknown>; awaiting?: boolean; text?: string; origin?: string; fail?: string; sources?: SourceConfig[];
  dirty?: boolean; pushFails?: string; noCheckout?: boolean; // #936: the file's checkout as git answers it
}

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
    prefix: 'HIVE', workspaces: [{ name: 'hive', path: repo, env: {}, fork: null }], sources: setup.sources ?? [GITHUB_ENTRY], commands: [],
    stages: [{ name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive:new-spec {url}' }, { name: 'goal', from: { board: ['Goals'] }, prompt: '/hive:decomposition {url}', approval: true }],
    transitions: [], hiveSource: true, createIn: 'hive',
  };
  const events: HiveEvent[] = [];
  const git: string[][] = [];
  const exec: Exec = async (_file, args) => {
    git.push(args);
    if (setup.pushFails !== undefined && args.includes('push')) throw Object.assign(new Error('Command failed: git push'), { stderr: `${setup.pushFails}\n` });
    if (args.includes('--show-toplevel')) {
      if (setup.noCheckout === true) throw Object.assign(new Error('Command failed: git rev-parse'), { stderr: 'fatal: not a git repository\n' });
      return { stdout: `${worktree}\n` };
    }
    if (args.includes('--show-current')) return { stdout: 'hive/7-site\n' };
    if (args.includes('--porcelain')) return { stdout: setup.dirty === true ? ' M decomposition.md\n' : '' };
    if (args.includes('get-url')) return { stdout: `${args[1] === worktree ? DOCS_ORIGIN : setup.origin ?? ''}\n` };
    return { stdout: '' };
  };
  let number = 100;
  const { calls, gql } = fakeGqlJson((query, variables) => {
    if (setup.fail !== undefined && query === CREATE_ISSUE && number === 101) throw new Error(setup.fail);
    if (query === PROJECT_FIELDS) return FIELDS;
    if (query === REPOSITORY_BRANCH) return variables.name === 'docs' ? { repository: { id: 'RD', defaultBranchRef: { name: 'trunk' } } } : { repository: { id: 'R1', defaultBranchRef: { name: 'main' } } };
    if (query === ISSUE_ID) return { repository: { issue: { id: `I${String(variables.number)}` } } };
    if (query === CREATE_ISSUE) {
      number += 1;
      return { createIssue: { issue: { id: `I${number}`, number } } };
    }
    if (query === ADD_PROJECT_ITEM) return { addProjectV2ItemById: { item: { id: 'PI' } } };
    if (query === CREATE_PULL_REQUEST) return { createPullRequest: { pullRequest: { number: 300, url: 'https://github.com/acme/docs/pull/300' } } };
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
  return { url: `${base}/decomposition`, base, events, calls, app, worktree, git };
}

const post = (url: string, body: unknown): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const CHOICE = { source: 'board', column: 'Backlog' };
const stepsOf = (events: HiveEvent[]): string[] => events.map((e) => (e.type === 'decompositionIssue' ? `${e.id}=${e.number}` : e.type));

test('GET answers what the dialog shows: the counts, the suggestions, the goal\'s repository and each GitHub source with its Status options and suggested column (#865)', async (t) => {
  const { url } = await routes(t);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const expected: DecompositionPreview = {
    title: 'Site for XPTO', issues: 6, blockers: 3, suggestions: 1, problems: [], warnings: [], repository: 'acme/site',
    sources: [{ name: 'board', statuses: ['Backlog', 'Goals'], column: 'Backlog' }],
  };
  assert.deepEqual(await res.json(), expected);
});

test('GET reads the file wherever the result points, outside the worktree too (a docsRepo elsewhere), and answers 404 for a file that is not there (#865, #936)', async (t) => {
  const outside = await routes(t, { result: { decomposition: '../../../outside.md' } });
  const read = await fetch(outside.url);
  assert.deepEqual([read.status, ((await read.json()) as DecompositionPreview).title], [200, 'Site for XPTO']);
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

test('GET lists the overlap warnings, and the file stays writable (#936)', async (t) => {
  // 2.1 and 2.2 are not ordered: 2.1 waits for 1.2, 2.2 for nothing but 2's blocker, which holds neither
  const text = EXAMPLE.replace('Blocked by: 1.2', 'Touches: src/contact.ts\nBlocked by: 1.2')
    .replace('In: the landing page. Out: the contact form.', 'In: the landing page. Out: the contact form.\nTouches: src/');
  const { url } = await routes(t, { text });
  const read = (await (await fetch(url)).json()) as DecompositionPreview;
  assert.deepEqual([read.problems, read.warnings], [[], [{ line: 76, message: '"2.1" touches "src/contact.ts" and "2.2" touches "src", and no "Blocked by:" orders them' }]]);
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
  const { url, events, calls } = await routes(t);
  const res = await post(url, CHOICE);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(stepsOf(events), ['design=7', '1=101', '1.1=102', '1.2=103', '2=104', '2.1=105', '2.2=106', 'pr=300', 'done=7', 'approve']);
  assert.deepEqual(events.at(-1), { type: 'approve', activityId: activityIdOf('board:I7') });
  const bodies = calls.filter((c) => c.query === CREATE_ISSUE).map((c) => String(c.variables.body));
  assert.match(bodies[0], /^Parent: #7$/m);
  assert.match(bodies[2], /^Design: https:\/\/github\.com\/acme\/docs\/blob\/trunk\/decomposition\.md#1-backend$/m, 'the file\'s repository, its default branch, the path in its checkout');
  assert.deepEqual(calls.filter((c) => c.query === CREATE_ISSUE).map((c) => c.variables.repositoryId), Array<string>(6).fill('R1'), 'the issues stay in the goal\'s repository');
});

test('POST on a local goal writes its root issue first and ends with closeTask (#865)', async (t) => {
  const { url, events } = await routes(t, { task: LOCAL, origin: 'git@github.com:acme/hive.git' });
  assert.equal((await post(url, CHOICE)).status, 200);
  assert.deepEqual(stepsOf(events), ['root=101', '1=102', '1.1=103', '1.2=104', '2=105', '2.1=106', '2.2=107', 'pr=300', 'done=101', 'closeTask']);
  const local = await routes(t, { task: LOCAL });
  const refused = await post(local.url, CHOICE);
  assert.deepEqual([refused.status, await refused.json()], [409, { error: 'o workspace não tem origin no GitHub' }]);
});

test('POST refuses a file in no git checkout before any issue is written (#936)', async (t) => {
  const { url, events, calls } = await routes(t, { noCheckout: true });
  const res = await post(url, CHOICE);
  assert.deepEqual([res.status, await res.json()], [502, { error: 'the decomposition file is in no git checkout' }]);
  assert.deepEqual([events, calls.some((c) => c.query === CREATE_ISSUE)], [[], false]);
});

test('POST commits a hand edit in the file\'s checkout, pushes its branch and opens the PR in the file\'s repository before done; a retry with pr recorded opens none (#936)', async (t) => {
  const dirty = await routes(t, { dirty: true });
  assert.equal((await post(dirty.url, CHOICE)).status, 200);
  assert.deepEqual(dirty.git.map((args) => args.slice(2)), [
    ['rev-parse', '--show-toplevel'], ['remote', 'get-url', 'origin'], ['branch', '--show-current'],
    ['status', '--porcelain', '--', 'decomposition.md'], ['add', '--', 'decomposition.md'], ['commit', '-m', 'docs: decomposition for #7', '--', 'decomposition.md'],
    ['push', '-u', 'origin', 'hive/7-site'],
  ]);
  assert.ok(dirty.git.every((args) => args[0] === '-C' && args[1] === dirty.worktree), 'every git call runs in the file\'s checkout');
  const [pr] = dirty.calls.filter((c) => c.query === CREATE_PULL_REQUEST).map((c) => c.variables);
  assert.deepEqual([pr?.repositoryId, pr?.baseRefName, pr?.headRefName], ['RD', 'trunk', 'hive/7-site']);
  const issues = { design: 7, '1': 101, '1.1': 102, '1.2': 103, '2': 104, '2.1': 105, '2.2': 106 };
  const retried = await routes(t, { result: { ...PENDING, decompositionIssues: { ...issues, pr: 300 } } });
  assert.equal((await post(retried.url, CHOICE)).status, 200);
  assert.deepEqual(
    [stepsOf(retried.events), retried.git.map((args) => args[2]), retried.calls.some((c) => c.query === CREATE_PULL_REQUEST)],
    [['done=7', 'approve'], ['rev-parse', 'remote', 'branch'], false],
  );
});

test('a failed push answers 502 with git\'s words; the issues stay recorded and neither pr nor done is (#936)', async (t) => {
  const { url, events } = await routes(t, { pushFails: 'rejected: non-fast-forward' });
  const res = await post(url, CHOICE);
  assert.deepEqual([res.status, await res.json()], [502, { error: 'rejected: non-fast-forward' }]);
  assert.deepEqual(stepsOf(events), ['design=7', '1=101', '1.1=102', '1.2=103', '2=104', '2.1=105', '2.2=106']);
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
