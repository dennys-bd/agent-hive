import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState } from '../../src/orchestrator.js';
import { openReadModel } from '../../src/read-model/db.js';
import { registerRepoRoutes, type RepoReadModel, type RepoRouteDeps } from '../../src/server-repos.js';
import type { CombConfig, Exec, IssuePage } from '../../src/types.js';
import { fakeGqlJson } from '../fakes.js';
import { commentRow, issueRow, REPO, SOURCE, T1, T2 } from './fixtures.js';

const COMB: CombConfig = { prefix: 'HIVE', workspaces: [{ name: 'hive', path: '/code/hive', env: {}, fork: null }], sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive' };
const exec: Exec = async () => ({ stdout: 'git@github.com:acme/hive.git\n' }); // the one workspace's origin: acme/hive
type Answer = (query: string, variables: Record<string, unknown>) => unknown;
const OFFLINE: Answer = () => { throw new Error('the network is off'); };

// The repository routes over a read model, GitHub answering `answer`; errors collects the log's. Answers the base URL
function routes(t: TestContext, readModel: RepoReadModel, answer: Answer = OFFLINE, errors: string[] = []): string {
  const app = express();
  app.use(express.json());
  const state = initialState(0);
  const deps: RepoRouteDeps = {
    requireLive: () => ({ state, runtime: { config: { comb: COMB } } }), exec, gql: fakeGqlJson(answer).gql,
    poll: async () => undefined, log: { error: (message: string) => { errors.push(message); } }, readModel,
  };
  registerRepoRoutes(app, deps);
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('with a read model the list and the page answer from the database with GitHub unreachable; opening a page starts its refetch (#765)', async (t) => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(12, T1, { state: 'open' }));
  db.upsertIssue(issueRow(13, T2, { state: 'open', kind: 'pr' }));
  db.upsertComment(commentRow('C1', 'I_12'));
  const refetched: string[] = [];
  const base = routes(t, { db, source: SOURCE, refetch: (repository, number) => { refetched.push(`${repository}#${number}`); } });
  const list = await fetch(`${base}/repositories/acme/hive/issues?state=open`);
  assert.deepEqual([list.status, await list.json()], [200, {
    state: 'open', total: 1, truncated: false,
    issues: [{ number: 12, title: 'T12', url: 'https://github.com/acme/hive/issues/12', labels: ['bug'], assignees: [], updatedAt: T1, pullRequests: [] }],
  }]);
  const page = await fetch(`${base}/repositories/acme/hive/issues/12`);
  assert.equal(page.status, 200);
  const issue = (await page.json()) as IssuePage;
  assert.deepEqual([issue.repository, issue.body, issue.author, issue.commentCount], [REPO, 'b', 'bia', 1]);
  assert.deepEqual(issue.comments, [{ author: 'bia', createdAt: T1, body: 'c', url: 'https://github.com/acme/hive/issues/12' }]);
  const missing = await fetch(`${base}/repositories/acme/hive/issues/99`);
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'issue not in the read model yet' }]);
  assert.deepEqual(refetched, ['acme/hive#12', 'acme/hive#99'], 'a page not stored yet is refetched too');
});
