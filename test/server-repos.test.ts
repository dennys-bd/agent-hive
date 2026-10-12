import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState } from '../src/orchestrator.js';
import { registerRepoRoutes, type RepoRouteDeps } from '../src/server-repos.js';
import { ADD_COMMENT, ADD_LABELS, REPO_LABELS, UPDATE_ISSUE } from '../src/repos/github-repo-queries.js';
import type { CombConfig, Exec, State, Task } from '../src/types.js';
import { fakeGqlJson } from './fakes.js';

const COMB: CombConfig = { prefix: 'HIVE', workspaces: [{ name: 'hive', path: '/code/hive', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }], sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive' };
const exec: Exec = async () => ({ stdout: 'git@github.com:acme/hive.git\n' }); // the one workspace's origin: acme/hive
const RATE = { limit: 5000, remaining: 4000, resetAt: '2999-01-01T00:00:00Z' };
type Answer = (query: string, variables: Record<string, unknown>) => unknown;

// The repository routes alone over this state, GitHub answering `answer`; `polls` records every poll. Answers the base URL
function routes(t: TestContext, answer: Answer, extra: Partial<State> = {}, polls: string[][] = [], poll?: RepoRouteDeps['poll'], errors: string[] = []): string {
  const app = express();
  app.use(express.json());
  const state: State = { ...initialState(0), ...extra };
  const deps: RepoRouteDeps = {
    requireLive: () => ({ state, runtime: { config: { comb: COMB } } }), exec, gql: fakeGqlJson(answer).gql,
    poll: poll ?? (async (names) => { polls.push(names); }), log: { error: (message: string) => { errors.push(message); } },
  };
  registerRepoRoutes(app, deps);
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const U1 = '2026-10-05T09:00:00Z';
const U2 = '2026-10-06T10:00:00Z';
const post = (url: string, body: unknown): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a reading under the reserve refuses the writes with 429 and its reset; with no reading yet they write (#757, #181)', async (t) => {
  let reads = 0;
  const low = { ...RATE, remaining: 499 };
  const base = routes(t, (query) => {
    if (query !== ADD_COMMENT) reads += 1;
    return { rateLimit: low, repository: { issue: { id: 'I_12', updatedAt: U1 } } };
  });
  assert.equal((await post(`${base}/repositories/acme/hive/issues/12/comments`, { body: 'one' })).status, 200, 'no reading yet: it writes, and keeps the low one');
  const refused = await post(`${base}/repositories/acme/hive/issues/12/comments`, { body: 'two' });
  assert.deepEqual([refused.status, await refused.json()], [429, { error: 'GitHub quota is low', resetsAt: low.resetAt }]);
  assert.equal(reads, 1, 'refused before the read');
});

test('POST …/issues/:number refuses no title nor body, an empty or long title, a long body or no updatedAt, before asking GitHub (#757)', async (t) => {
  let calls = 0;
  const base = routes(t, () => { calls += 1; return {}; });
  const bodies = [{ updatedAt: U1 }, { title: '  ', updatedAt: U1 }, { title: 'x'.repeat(257), updatedAt: U1 }, { body: 'x'.repeat(65_537), updatedAt: U1 }, { title: 'ok' }];
  for (const body of bodies) assert.equal((await post(`${base}/repositories/acme/hive/issues/12`, body)).status, 400, JSON.stringify(body).slice(0, 40));
  assert.equal(calls, 0);
});

test('POST …/issues/:number is a 409 that writes nothing on a newer issue; a match writes and polls the source of the issue\'s task, another issue polls nothing (#757)', async (t) => {
  const writes: unknown[] = [];
  const polls: string[][] = [];
  const answer = (query: string, variables: Record<string, unknown>) => {
    if (query !== UPDATE_ISSUE) return { rateLimit: RATE, repository: { issue: { id: `I_${variables.number}`, updatedAt: U2 } } };
    writes.push(variables);
    return { updateIssue: { issue: { id: variables.id } } };
  };
  const task: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'T', body: '', url: 'https://github.com/acme/hive/issues/12', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
  const base = routes(t, answer, { tasks: [task] }, polls);
  const stale = await post(`${base}/repositories/acme/hive/issues/12`, { title: 'New', updatedAt: U1 });
  assert.equal(stale.status, 409);
  assert.deepEqual([writes, polls], [[], []]);
  const fresh = await post(`${base}/repositories/acme/hive/issues/12`, { title: 'New', updatedAt: U2 });
  assert.deepEqual([fresh.status, await fresh.json()], [200, { ok: true }]);
  assert.deepEqual(writes, [{ id: 'I_12', title: 'New' }]);
  assert.deepEqual(polls, [['roadmap']]);
  assert.equal((await post(`${base}/repositories/acme/hive/issues/13`, { body: 'b', updatedAt: U2 })).status, 200);
  assert.deepEqual(polls, [['roadmap']], 'an issue no task is: nothing polled');
});

test('labels: POST refuses a malformed body or an unknown label, and a valid one writes and polls the issue\'s source (#757)', async (t) => {
  const polls: string[][] = [];
  const writes: string[] = [];
  const answer = (query: string) => {
    if (query === REPO_LABELS) return { rateLimit: RATE, repository: { labels: { nodes: [{ id: 'L_bug', name: 'bug' }] } } };
    if (query === ADD_LABELS) { writes.push('add'); return {}; }
    return { rateLimit: RATE, repository: { issue: { id: 'I_12', updatedAt: U1 } } };
  };
  const task: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'T', body: '', url: 'https://github.com/acme/hive/issues/12', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
  const base = routes(t, answer, { tasks: [task] }, polls);
  assert.equal((await post(`${base}/repositories/acme/hive/issues/12/labels`, { add: 'bug', remove: [] })).status, 400);
  const unknown = await post(`${base}/repositories/acme/hive/issues/12/labels`, { add: ['wontfix'], remove: [] });
  assert.deepEqual([unknown.status, await unknown.json()], [400, { error: 'label not in the repository: wontfix' }]);
  assert.deepEqual([writes, polls], [[], []]);
  const ok = await post(`${base}/repositories/acme/hive/issues/12/labels`, { add: ['bug'], remove: [] });
  assert.deepEqual([ok.status, writes, polls], [200, ['add'], [['roadmap']]]);
});

test('comments: an empty or overlong body is a 400; a body posts to the issue and polls nothing (#757)', async (t) => {
  const polls: string[][] = [];
  const bodies: unknown[] = [];
  const answer = (query: string, variables: Record<string, unknown>) => {
    if (query === ADD_COMMENT) { bodies.push(variables.body); return {}; }
    return { rateLimit: RATE, repository: { issue: { id: 'I_12', updatedAt: U1 } } };
  };
  const base = routes(t, answer, {}, polls);
  for (const body of ['  ', 'x'.repeat(65_537), 3]) assert.equal((await post(`${base}/repositories/acme/hive/issues/12/comments`, { body })).status, 400);
  const ok = await post(`${base}/repositories/acme/hive/issues/12/comments`, { body: 'Looks good' });
  assert.deepEqual([ok.status, bodies, polls], [200, ['Looks good'], []]);
});

test('a poll that throws after a write still answers ok, and the failure is logged without a token (#757)', async (t) => {
  const errors: string[] = [];
  const answer = (query: string) => (query === ADD_COMMENT || query === ADD_LABELS ? {} : { rateLimit: RATE, repository: { issue: { id: 'I_12', updatedAt: U1 }, labels: { nodes: [{ id: 'L_bug', name: 'bug' }] } } });
  const task: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'T', body: '', url: 'https://github.com/acme/hive/issues/12', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
  const base = routes(t, answer, { tasks: [task] }, [], async () => { throw new Error('poll down'); }, errors);
  const ok = await post(`${base}/repositories/acme/hive/issues/12/labels`, { add: ['bug'], remove: [] });
  assert.deepEqual([ok.status, await ok.json()], [200, { ok: true }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /poll down/);
});

test('an issue number is digits only, no leading zero, at most ten: 1e2, 0x10 and 01 are 400 (#757)', async (t) => {
  const base = routes(t, () => ({ rateLimit: RATE, repository: { issue: { id: 'I_1', updatedAt: U1 } } }));
  for (const bad of ['1e2', '0x10', '01', '12345678901']) assert.equal((await fetch(`${base}/repositories/acme/hive/issues/${bad}`)).status, 400, bad);
});
