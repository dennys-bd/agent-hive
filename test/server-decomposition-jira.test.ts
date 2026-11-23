import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { HOST_PATHS, fakeMachine } from './fake-machine.js';
import { initialState } from '../src/orchestrator.js';
import { registerDecompositionRoutes } from '../src/server-decomposition.js';
import { CREATE_PULL_REQUEST, PROJECT_FIELDS, REPOSITORY_BRANCH } from '../src/sources/github-queries.js';
import { worktreePath } from '../src/worktree.js';
import type { BlockerChange, CombConfig, DecompositionPreview, Exec, HiveEvent, Source, SourceConfig, State, Task } from '../src/types.js';
import { fakeGqlJson, fakeLog, GITHUB_ENTRY, goneItem, JIRA_ENTRY } from './fakes.js';
import { activityIdOf, withWork } from './fixtures/work.js';
import { EXAMPLE } from './fixtures/decomposition.js';
import { mainFlows } from './fixtures/main-flow.js';
import { tempDir } from './temp-dir.js';

// The decomposition's routes with a Jira goal (#832): its own source is a fake Source, git and GitHub (the file's delivery) are fakes, and
// every dispatched event is recorded rather than reduced. The GitHub goal's cases stay in server-decomposition.test.ts.

const SLUG = 'hive-abc-1-site';
const SINCE = '2026-11-18T10:00:00.000Z';
const GOAL: Task = {
  item: { itemId: 'tickets:10001', id: 'ABC-1', title: 'Site for XPTO', body: '', url: 'https://acme.example/browse/ABC-1', source: 'tickets' },
  stage: 'goal', boardColumn: 'Goals', auto: true, workspace: 'hive',
};
const PENDING = { decomposition: 'decomposition.md' };
const DOCS_ORIGIN = 'git@github.com:acme/docs.git';
const CHOICE = { source: 'tickets', column: 'To Do' };

function fakeSource() {
  const made: Parameters<NonNullable<Source['create']>>[0][] = [];
  const related: [string, BlockerChange][] = [];
  const comments: string[] = [];
  let n = 100;
  const source: Source = {
    item: goneItem, resolveFields: async () => {}, settingsOptions: async () => [], setColumn: async () => {}, apply: async () => {}, listItems: async () => [],
    createOptions: async () => ({ statuses: ['To Do', 'Goals'], labels: [], issueTypes: [] }),
    createDepth: async () => 2,
    comment: async (_itemId, body) => { comments.push(body); },
    create: async (fields) => {
      n += 1;
      made.push(fields);
      return { itemId: `tickets:${10000 + n}`, ref: { id: `ABC-${n}`, url: `https://acme.example/browse/ABC-${n}` } };
    },
    relate: async (itemId, change) => { related.push([itemId, change]); return { blockers: { blockedBy: [], blocking: [] } }; },
  };
  return { source, made, related, comments };
}

async function routes(t: TestContext, sources: SourceConfig[] = [GITHUB_ENTRY, JIRA_ENTRY]) {
  const repo = await realpath(await tempDir(t, 'hive-832-'));
  const worktree = worktreePath(HOST_PATHS, repo, SLUG);
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, 'decomposition.md'), EXAMPLE);
  const state: State = withWork({ ...initialState(0), tasks: [GOAL] }, GOAL.item.itemId, { slug: SLUG, approval: { since: SINCE } }, { result: PENDING });
  const comb: CombConfig = {
    prefix: 'HIVE', workspaces: [{ name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' }], sources, commands: [],
    flows: mainFlows([{ name: 'spec', from: { tickets: ['To Do'] }, prompt: '/hive:new-spec {url}' }, { name: 'goal', from: { tickets: ['Goals'] }, prompt: '/hive:decomposition {url}', approval: true }]),
    hiveSource: false, createIn: 'hive',
  };
  const exec: Exec = async (_file, args) => {
    if (args.includes('--show-toplevel')) return { stdout: `${worktree}\n` };
    if (args.includes('check-ignore')) throw Object.assign(new Error('Command failed: git check-ignore'), { code: 1, stderr: '' });
    if (args.includes('--show-current')) return { stdout: 'hive/abc-1-site\n' };
    if (args.includes('get-url')) return { stdout: `${args[1] === worktree ? DOCS_ORIGIN : ''}\n` };
    return { stdout: '' };
  };
  const { calls, gql } = fakeGqlJson((query) => {
    if (query === REPOSITORY_BRANCH) return { repository: { id: 'RD', defaultBranchRef: { name: 'trunk' } } };
    if (query === CREATE_PULL_REQUEST) return { createPullRequest: { pullRequest: { number: 300, url: 'https://github.com/acme/docs/pull/300' } } };
    return {};
  });
  const jira = fakeSource();
  const live = new Map<string, Source>([['tickets', jira.source]]);
  const events: HiveEvent[] = [];
  const dispatch = async (event: HiveEvent): Promise<never[]> => { events.push(event); return []; };
  const app = express();
  app.use(express.json());
  registerDecompositionRoutes(app, { requireLive: () => ({ state, runtime: { config: { comb }, sources: live } }), dispatch, latest: () => state, exec, gql, log: fakeLog().log, machineFor: () => fakeMachine({ exec }), sleep: async () => undefined });
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/activities/${encodeURIComponent(activityIdOf(GOAL.item.itemId))}/decomposition`;
  return { url, events, calls, jira };
}

const post = (url: string, body: unknown): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stepsOf = (events: HiveEvent[]): string[] => events.map((e) => (e.type === 'decompositionIssue' ? `${e.id}=${e.number}` : e.type));

test('GET on a Jira goal lists only its own source, with its statuses and the suggested column, and counts no root issue (#832)', async (t) => {
  const { url, calls } = await routes(t);
  const read = (await (await fetch(url)).json()) as DecompositionPreview;
  assert.deepEqual([read.sources, read.issues, read.blockers], [[{ name: 'tickets', statuses: ['To Do', 'Goals'], column: 'To Do' }], 6, 3]);
  assert.equal(calls.some((c) => c.query === PROJECT_FIELDS), false, 'no GitHub source is read');
});

test('POST on a Jira goal writes the tree into its source, delivers the file with the Jira words, records done and approves (#832)', async (t) => {
  const { url, events, calls, jira } = await routes(t);
  const res = await post(url, CHOICE);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(stepsOf(events), ['design=10001', '1=10101', '1.1=10102', '1.2=10103', '2=10104', '2.1=10105', '2.2=10106', 'pr=300', 'done=10001', 'approve']);
  assert.deepEqual(jira.made.map((f) => [f.parent, f.column]).slice(0, 2), [['tickets:10001', 'To Do'], ['tickets:10101', 'To Do']]);
  assert.match(jira.made[1]?.body ?? '', /^Design: https:\/\/github\.com\/acme\/docs\/blob\/trunk\/decomposition\.md#1-backend$/m);
  assert.equal(jira.related.length, 3);
  const [pr] = calls.filter((c) => c.query === CREATE_PULL_REQUEST).map((c) => c.variables);
  assert.equal(pr?.title, 'docs: decomposition for ABC-1: Site for XPTO');
});

test('POST on a Jira goal under epics show stamps it an epic with deleteActivity false before the approve (#832)', async (t) => {
  const { url, events } = await routes(t, [{ ...JIRA_ENTRY, epics: 'show' }]);
  assert.equal((await post(url, CHOICE)).status, 200);
  assert.deepEqual(events.slice(-2), [
    { type: 'markEpic', taskId: 'tickets:10001', epic: { follows: 'behind', switchAt: 'fila', deleteActivity: false } },
    { type: 'approve', activityId: activityIdOf('tickets:10001') },
  ]);
});

test('POST on a Jira goal refuses 400 a body naming another source or a column that is not one of its statuses, before any write (#832)', async (t) => {
  const { url, events, jira } = await routes(t);
  for (const body of [{ source: 'board', column: 'Backlog' }, { source: 'tickets', column: 'Done' }, {}]) {
    const res = await post(url, body);
    assert.deepEqual([res.status, await res.json()], [400, { error: 'source precisa ser uma source do GitHub e column uma opção do seu Status' }], JSON.stringify(body));
  }
  assert.deepEqual([events, jira.made, jira.comments], [[], [], []]);
});

test('POST on a Jira goal whose source has no blocking type refuses 409 before any write (#832)', async (t) => {
  const { url, events } = await routes(t, [{ ...JIRA_ENTRY, blockingLinkTypes: [] }]);
  const res = await post(url, CHOICE);
  assert.deepEqual([res.status, ((await res.json()) as { error: string }).error], [409, 'the source has no blocking link type: the file\'s "Blocked by" lines cannot be written']);
  assert.deepEqual(events, []);
});
