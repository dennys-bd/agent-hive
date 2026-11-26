import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prsOf } from '../src/activities.js';
import { type GitlabAnswer, GitlabHttpError } from '../src/gitlab/api.js';
import type { GitlabAccess } from '../src/gitlab/pr-states.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { PrActivity } from '../src/pull-requests.js';
import { pollPrStates } from '../src/server-pr-states.js';
import type { HiveEvent, State, Task } from '../src/types.js';
import { withWork } from './fixtures/work.js';

// The PR poll split by host (#1052), over the real reducer: what each task's record holds after it
const GH = 'https://github.com/acme/app/pull/9';
const MERGED = 'https://git.example.com/acme/app/-/merge_requests/3';
const CLOSED = 'https://gitlab.com/acme/site/-/merge_requests/4';
const OPENED = '2026-11-20T10:00:00.000Z';
const task = (n: number): Task => ({ item: { itemId: `local:${n}`, id: String(n), title: `Task ${n}`, body: '', url: '' }, stage: 'review', boardColumn: '', auto: true });

// Task 1 holds the GitHub PR, task 2 both MRs, every one open
function opened(): State {
  const one = withWork({ ...initialState(1), tasks: [task(1), task(2)] }, 'local:1', {}, { prs: [{ url: GH, state: 'open' }] });
  return withWork(one, 'local:2', {}, { prs: [{ url: MERGED, state: 'open' }, { url: CLOSED, state: 'open' }] });
}

// Both GitLab hosts' answers by API path; a path in `failing` (or under it) is a 503, any other unknown one a 404
const PATHS: Record<string, GitlabAnswer> = {
  'projects/acme%2Fapp/merge_requests/3': { body: { state: 'merged', created_at: OPENED, merged_at: '2026-11-21T09:00:00.000Z' } },
  'projects/acme%2Fapp/merge_requests/3/commits?per_page=100': { body: [{ id: 'abcdef0123456789', committed_date: '2026-11-20T11:00:00.000Z' }] },
  'projects/acme%2Fsite/merge_requests/4': { body: { state: 'closed', created_at: OPENED, closed_at: '2026-11-21T10:00:00.000Z' } },
  'projects/acme%2Fsite/merge_requests/4/commits?per_page=100': { body: [] },
};
const answering = (failing: readonly string[] = []): GitlabAccess => async () => ({
  get: async (path: string) => {
    if (failing.some((prefix) => path.startsWith(prefix))) throw new GitlabHttpError(503);
    if (!Object.hasOwn(PATHS, path)) throw new GitlabHttpError(404);
    return PATHS[path];
  },
});
const GH_MERGED = () => ({ p0: { state: 'MERGED', mergedAt: '2026-11-22T08:00:00.000Z' } });

interface Harness { state: State; events: HiveEvent[]; queries: string[]; lines: string[]; activity: { github: string[]; gitlab: PrActivity[]; open: readonly string[] }[] }

function harness(gitlab: GitlabAccess, gql: () => unknown = GH_MERGED, state: State = opened()): { h: Harness; run: () => Promise<void> } {
  const h: Harness = { state, events: [], queries: [], lines: [], activity: [] };
  const run = (): Promise<void> => pollPrStates({
    state: () => h.state,
    gql: async (query) => { h.queries.push(query); return gql(); },
    gitlab,
    dispatch: async (event) => { h.events.push(event); h.state = reduce(h.state, event).state; return []; },
    log: { error: (line: string) => { h.lines.push(line); } },
    pollPrActivity: async (_state, github, _gql, mrs = [], open = github) => { h.activity.push({ github, gitlab: mrs, open }); },
  });
  return { h, run };
}

test('a GitHub PR and two MRs open: the GitHub query holds no GitLab link, the MRs read merged and closed with their times, each host dispatches its own prStates, and the activity gets both (#1052)', async () => {
  const { h, run } = harness(answering());
  await run();
  assert.equal(h.queries.length, 1);
  assert.ok(h.queries[0].includes(GH) && !h.queries[0].includes('merge_requests'), h.queries[0]);
  assert.deepEqual(prsOf(h.state, 'local:2'), [
    { url: MERGED, state: 'merged', openedAt: OPENED, mergedAt: '2026-11-21T09:00:00.000Z' },
    { url: CLOSED, state: 'closed', openedAt: OPENED, closedAt: '2026-11-21T10:00:00.000Z' },
  ]);
  assert.deepEqual(prsOf(h.state, 'local:1'), [{ url: GH, state: 'merged', mergedAt: '2026-11-22T08:00:00.000Z' }]);
  assert.equal(h.events.filter((e) => e.type === 'prStates').length, 2);
  assert.deepEqual(h.activity, [{
    github: [GH], open: [GH, MERGED, CLOSED],
    gitlab: [
      { url: MERGED, commits: 1, afterOpen: 1, recent: [{ sha: 'abcdef01', committedAt: '2026-11-20T11:00:00.000Z' }], checks: [] },
      { url: CLOSED, commits: 0, afterOpen: 0, recent: [], checks: [] },
    ],
  }]);
  assert.deepEqual(h.lines, []);
});

test('a failing MR read is logged with its host and number, that MR stays open, and the GitHub PR and the other MR still update (#1052)', async () => {
  const { h, run } = harness(answering(['projects/acme%2Fapp/merge_requests/3']));
  await run();
  assert.deepEqual(prsOf(h.state, 'local:2').map((pr) => pr.state), ['open', 'closed']);
  assert.equal(prsOf(h.state, 'local:1')[0]?.state, 'merged');
  assert.deepEqual(h.lines, ['pr states gitlab git.example.com #3: gitlab api: HTTP 503']);
});

test('a failing commits read costs no state: the MR reads merged and the failure is its own line (#1052)', async () => {
  const { h, run } = harness(answering(['projects/acme%2Fapp/merge_requests/3/commits']));
  await run();
  assert.equal(prsOf(h.state, 'local:2')[0]?.state, 'merged');
  assert.deepEqual(h.lines, ['pr activity gitlab git.example.com #3: gitlab api: HTTP 503']);
});

test('a host with no account is logged once per poll and its MR keeps its state; the first poll after a connect reads it, with no restart (#1052)', async () => {
  let isConnected = false;
  const access: GitlabAccess = async (host) => (isConnected || host !== 'git.example.com' ? answering()(host) : undefined);
  const { h, run } = harness(access);
  await run();
  assert.deepEqual(h.lines, ['pr states gitlab git.example.com: no account']);
  assert.equal(prsOf(h.state, 'local:2')[0]?.state, 'open');
  isConnected = true;
  await run();
  assert.equal(prsOf(h.state, 'local:2')[0]?.state, 'merged');
  assert.equal(h.lines.length, 1);
});

test('the GitHub query failing costs no MR its state; with only MRs open no GitHub query is sent (#1052)', async () => {
  const failing = harness(answering(), () => { throw new Error('gh api graphql: HTTP 502'); });
  await failing.run();
  assert.deepEqual(failing.h.lines, ['pr states: gh api graphql: HTTP 502']);
  assert.deepEqual(prsOf(failing.h.state, 'local:2').map((pr) => pr.state), ['merged', 'closed']);
  assert.equal(prsOf(failing.h.state, 'local:1')[0]?.state, 'open');
  const mrOnly = withWork({ ...initialState(1), tasks: [task(2)] }, 'local:2', {}, { prs: [{ url: MERGED, state: 'open' }] });
  const only = harness(answering(), GH_MERGED, mrOnly);
  await only.run();
  assert.deepEqual(only.h.queries, []);
  assert.equal(prsOf(only.h.state, 'local:2')[0]?.state, 'merged');
});
