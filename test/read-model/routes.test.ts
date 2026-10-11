import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ADD_COMMENT, ADD_LABELS, UPDATE_ISSUE } from '../../src/repos/github-repo-queries.js';
import { initialState } from '../../src/orchestrator.js';
import { openReadModel } from '../../src/read-model/db.js';
import { registerRepoRoutes, type RepoReadModel, type RepoRouteDeps } from '../../src/server-repos.js';
import type { CombConfig, Exec, IssuePage } from '../../src/types.js';
import { fakeGqlJson } from '../fakes.js';
import { commentRow, GQL_COMMENT, GQL_ISSUE, issueRow, REPO, SOURCE, T1, T2, T3, T4 } from './fixtures.js';

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

const RATE = { limit: 5000, remaining: 4000, resetAt: '2999-01-01T00:00:00Z' };
const open = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...GQL_ISSUE, state: 'OPEN', closedAt: null, ...extra });

test('a write\'s GraphQL answer lands in the read model before the route answers: an edit, a label change and a comment (#765)', async (t) => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(12, T1, { state: 'open', closedAt: null }));
  const answer: Answer = (query) => {
    if (query === UPDATE_ISSUE) return { updateIssue: { issue: open({ title: 'edited', updatedAt: T2 }) } };
    if (query === ADD_LABELS) return { addLabelsToLabelable: { labelable: open({ title: 'edited', labels: { nodes: [{ name: 'bug' }, { name: 'docs' }] }, updatedAt: T3 }) } };
    if (query === ADD_COMMENT) {
      return { addComment: { commentEdge: { node: { ...GQL_COMMENT, id: 'C9', body: 'hi', createdAt: T4, updatedAt: T4 } }, subject: open({ title: 'edited', labels: { nodes: [{ name: 'bug' }, { name: 'docs' }] }, comments: { totalCount: 2 }, updatedAt: T4 }) } };
    }
    return { rateLimit: RATE, repository: { issue: { id: 'I_12', updatedAt: T1 }, labels: { nodes: [{ id: 'L_docs', name: 'docs' }] } } };
  };
  const errors: string[] = [];
  const base = routes(t, { db, source: SOURCE, refetch: () => undefined }, answer, errors);
  const post = (path: string, body: unknown) => fetch(`${base}/repositories/acme/hive/issues/12${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('', { title: 'edited', updatedAt: T1 })).status, 200);
  assert.deepEqual([db.issue(SOURCE, REPO, 12)?.title, db.issue(SOURCE, REPO, 12)?.updatedAt], ['edited', T2]);
  assert.equal((await post('/labels', { add: ['docs'], remove: [] })).status, 200);
  assert.deepEqual(db.issue(SOURCE, REPO, 12)?.labels, ['bug', 'docs']);
  assert.equal((await post('/comments', { body: 'hi' })).status, 200);
  assert.deepEqual(db.comments(SOURCE, 'I_12').map((c) => [c.nodeId, c.body]), [['C9', 'hi']]);
  assert.equal(db.issue(SOURCE, REPO, 12)?.comments, 2);
  assert.deepEqual(errors, []);
});

test('a write GitHub took whose answer the normalizer refuses still answers ok, and the reason is logged (#765)', async (t) => {
  const db = openReadModel(':memory:');
  const answer: Answer = (query) => (query === UPDATE_ISSUE ? { updateIssue: { issue: { id: 'I_12' } } } : { rateLimit: RATE, repository: { issue: { id: 'I_12', updatedAt: T1 } } });
  const errors: string[] = [];
  const base = routes(t, { db, source: SOURCE, refetch: () => undefined }, answer, errors);
  const res = await fetch(`${base}/repositories/acme/hive/issues/12`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', updatedAt: T1 }) });
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(errors, ['repositories: acme/hive not stored in the read model: read model: unexpected state']);
});
