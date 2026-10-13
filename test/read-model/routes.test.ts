import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState } from '../../src/orchestrator.js';
import type { ReadModel, SyncKind } from '../../src/read-model/db.js';
import type { RefetchOutcome } from '../../src/read-model/loop.js';
import { REPO_ISSUE_LIMIT } from '../../src/read-model/views.js';
import { ADD_COMMENT, ADD_LABELS, UPDATE_ISSUE } from '../../src/repos/github-repo-queries.js';
import { registerRepoRoutes, type RepoReadModel, type RepoRouteDeps } from '../../src/server-repos.js';
import type { GqlJson } from '../../src/sources/github-gql.js';
import type { CombConfig, Exec, Workspace } from '../../src/types.js';
import { CLOSING_PRS, COMMENT_ROW, commentRow, GQL_COMMENT, GQL_ISSUE, ISSUE_ROW, issueRow, OTHER_SOURCE, REPO, REPO_ROW, SOURCE, SYNCED, T1, T2, T3, tempModel } from './fixtures.js';

const SITE = 'acme/site';
const LATER = '2026-10-06T00:00:00Z';
const workspace = (name: string): Workspace => ({ name, path: `/code/${name}`, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' });
const COMB: CombConfig = { prefix: 'HIVE', workspaces: [workspace('hive'), workspace('site')], sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive' };
// each workspace's origin: /code/hive is acme/hive, /code/site is acme/site
const exec: Exec = async (_file, args) => ({ stdout: `git@github.com:acme/${args[1] === '/code/site' ? 'site' : 'hive'}.git\n` });
const READS = ['/repositories', '/repositories/acme/hive/issues?state=open', '/repositories/acme/hive/issues/12', '/repositories/acme/hive/labels'];

type Refetch = (db: ReadModel, repository: string, number: number) => Promise<RefetchOutcome>;
interface Options { model?: boolean; source?: string | undefined; sourceFails?: true; refetch?: Refetch; gql?: GqlJson }
interface Harness { base: string; db: ReadModel; gqlCalls(): number; refetched: string[]; errors: string[]; notified: [string, SyncKind[]][] }

// The repository routes over a real read model in a temporary home; GraphQL throws on any call and counts it, unless the test answers it
async function routesOn(t: TestContext, options: Options = {}): Promise<Harness> {
  const db = await tempModel(t);
  const refetched: string[] = [];
  const errors: string[] = [];
  const notified: [string, SyncKind[]][] = [];
  let gqlCalls = 0;
  const readModel: RepoReadModel = {
    db,
    source: async () => {
      if (options.sourceFails) throw new Error('credential store corrupt');
      return 'source' in options ? options.source : SOURCE;
    },
    notify: (repository, kinds) => { notified.push([repository, kinds]); },
    refetch: (repository, number) => {
      refetched.push(`${repository}#${number}`);
      return options.refetch?.(db, repository, number) ?? Promise.resolve('unchanged');
    },
  };
  const deps: RepoRouteDeps = {
    requireLive: () => ({ state: initialState(0), runtime: { config: { comb: COMB } } }), exec,
    gql: async (query, variables) => {
      gqlCalls += 1;
      if (options.gql) return options.gql(query, variables);
      throw new Error('a read route called GraphQL');
    },
    poll: async () => undefined, log: { error: (message: string) => { errors.push(message); } },
    ...(options.model === false ? {} : { readModel }),
  };
  const app = express();
  app.use(express.json()); // the write routes read a JSON body, as server.ts's app does
  registerRepoRoutes(app, deps);
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, db, gqlCalls: () => gqlCalls, refetched, errors, notified };
}

async function get(url: string): Promise<[number, unknown]> {
  const res = await fetch(url);
  return [res.status, await res.json()];
}

// acme/hive synced: its repos row, two labels, both scopes stamped, two open issues, a closed one with a comment and closing PRs, an open PR
function seed(db: ReadModel): void {
  db.setRepo(REPO_ROW);
  db.setLabels(SOURCE, REPO, ['bug', 'wontfix']);
  for (const kind of ['issues', 'repo'] as const) db.setScope(SOURCE, REPO, kind, { cursor: null, etag: null, syncedAt: SYNCED });
  db.upsertIssue(issueRow(1, T1, { state: 'open' }), 'sync');
  db.upsertIssue(issueRow(2, T2, { state: 'open' }), 'sync');
  db.upsertIssue(ISSUE_ROW, 'sync');
  db.setClosingPrs(SOURCE, 'I_12', CLOSING_PRS);
  db.upsertComment(COMMENT_ROW, 'sync');
  db.upsertIssue(issueRow(3, T3, { kind: 'pr', state: 'open' }), 'sync');
}

const listed = (n: number, updatedAt: string) => ({
  number: n, title: `T${n}`, url: `https://github.com/acme/hive/issues/${n}`, labels: ['bug'], assignees: ['bia', 'caio'], updatedAt, pullRequests: [],
});
const NEVER_SYNCED_SITE = { repository: SITE, url: 'https://github.com/acme/site', workspace: 'site', openPrs: 0, openIssues: 0, closedIssues: 0, canPush: false, issuesEnabled: true, syncedAt: null };
const NO_ISSUES = { state: 'open', total: 0, truncated: false, syncedAt: null, issues: [] };

test('the four read routes answer a synced repository from the model and never call GraphQL (#181)', async (t) => {
  const { base, db, gqlCalls } = await routesOn(t);
  seed(db);
  const statuses = await Promise.all(READS.map(async (path) => (await get(`${base}${path}`))[0]));
  assert.deepEqual(statuses, [200, 200, 200, 200]);
  assert.equal(gqlCalls(), 0);
});

test('GET /repositories lists a synced repository with its repos row and counts, a never-synced one with syncedAt null and counts 0 (#181)', async (t) => {
  const { base, db } = await routesOn(t);
  seed(db);
  assert.deepEqual(await get(`${base}/repositories`), [200, [
    { repository: REPO, url: 'https://github.com/acme/hive', workspace: 'hive', openPrs: 1, openIssues: 2, closedIssues: 1, canPush: true, issuesEnabled: true, lastActivity: T3, syncedAt: SYNCED },
    NEVER_SYNCED_SITE,
  ]]);
});

test('the counts are rows by state and kind; lastActivity is the later of pushed_at and the newest row; a fork names its parent (#181)', async (t) => {
  const { base, db } = await routesOn(t);
  seed(db);
  db.upsertIssue(issueRow(4, T1, { kind: 'pr' }), 'sync'); // a closed PR counts nowhere
  db.setRepo({ ...REPO_ROW, pushedAt: LATER, forkParent: 'up/hive' });
  const [, summaries] = await get(`${base}/repositories`);
  const [hive] = summaries as Record<string, unknown>[];
  assert.deepEqual([hive?.openIssues, hive?.closedIssues, hive?.openPrs, hive?.lastActivity, hive?.fork], [2, 1, 1, LATER, { parent: 'up/hive' }]);
});

test('GET …/issues answers the state asked, newest update first, with the issues scope\'s syncedAt; a never-synced repository has none (#181)', async (t) => {
  const { base, db } = await routesOn(t);
  seed(db);
  assert.deepEqual(await get(`${base}/repositories/acme/hive/issues?state=open`), [200, { state: 'open', total: 2, truncated: false, syncedAt: SYNCED, issues: [listed(2, T2), listed(1, T1)] }]);
  assert.deepEqual(await get(`${base}/repositories/acme/site/issues?state=open`), [200, NO_ISSUES]);
  assert.deepEqual(await get(`${base}/repositories/acme/hive/issues?state=all`), [400, { error: 'state must be open or closed' }]);
  assert.deepEqual(await get(`${base}/repositories/acme/other/issues?state=open`), [404, { error: 'repository is not one the Hive lists' }]);
});

test('GET …/issues past REPO_ISSUE_LIMIT answers the first 1000 and says truncated (#181)', async (t) => {
  const { base, db } = await routesOn(t);
  db.transaction(() => {
    for (let n = 1; n <= REPO_ISSUE_LIMIT + 1; n++) db.upsertIssue(issueRow(n, T1, { state: 'open' }), 'sync');
  });
  const [status, body] = await get(`${base}/repositories/acme/hive/issues?state=open`);
  const page = body as { total: number; truncated: boolean; issues: unknown[] };
  assert.deepEqual([status, page.total, page.truncated, page.issues.length], [200, REPO_ISSUE_LIMIT + 1, true, REPO_ISSUE_LIMIT]);
});

test('GET …/issues/:number answers the stored page at once and starts its refetch without awaiting it (#181)', async (t) => {
  const { base, db, refetched } = await routesOn(t, { refetch: () => new Promise<RefetchOutcome>(() => undefined) });
  seed(db);
  db.upsertComment({ ...commentRow('C2', 'I_12', T2), author: null }, 'sync');
  assert.deepEqual(await get(`${base}/repositories/acme/hive/issues/12`), [200, {
    number: 12, title: 'T12', url: 'https://github.com/acme/hive/issues/12', labels: ['bug'], assignees: ['bia', 'caio'], updatedAt: T1, pullRequests: CLOSING_PRS,
    repository: REPO, body: 'b', author: 'bia', createdAt: ISSUE_ROW.createdAt, commentCount: 2,
    comments: [
      { author: 'bia', createdAt: COMMENT_ROW.createdAt, body: 'c', url: COMMENT_ROW.url },
      { author: 'ghost', createdAt: T2, body: 'c', url: COMMENT_ROW.url },
    ],
  }]);
  assert.deepEqual(refetched, ['acme/hive#12']);
});

test('an issue page the model lacks waits for its refetch: the row after changed, 404 on gone or still missing, 503 on failed and skipped (#181)', async (t) => {
  const outcomes: RefetchOutcome[] = ['changed', 'gone', 'unchanged', 'failed', 'skipped'];
  const answers: [number, unknown][] = [];
  for (const outcome of outcomes) {
    const { base } = await routesOn(t, {
      refetch: async (db, _repository, number) => {
        if (outcome === 'changed') db.upsertIssue(issueRow(number, T1), 'sync');
        return outcome;
      },
    });
    answers.push(await get(`${base}/repositories/acme/hive/issues/7`));
  }
  assert.deepEqual([answers[0]?.[0], (answers[0]?.[1] as { title?: string } | undefined)?.title], [200, 'T7']);
  const missing = [404, { error: 'issue not found: acme/hive#7' }];
  const unreachable = [503, { error: 'could not reach GitHub' }];
  assert.deepEqual(answers.slice(1), [missing, missing, unreachable, unreachable]);
});

test('GET …/labels answers the labels table, a label no issue carries included (#181)', async (t) => {
  const { base, db } = await routesOn(t);
  seed(db);
  assert.deepEqual(await get(`${base}/repositories/acme/hive/labels`), [200, ['bug', 'wontfix']]);
});

test('rows stored under another source never show in any of the four answers (#181)', async (t) => {
  const { base, db } = await routesOn(t);
  db.setRepo({ ...REPO_ROW, source: OTHER_SOURCE, repository: SITE, url: 'https://github.com/acme/site' });
  db.setLabels(OTHER_SOURCE, SITE, ['theirs']);
  db.setScope(OTHER_SOURCE, SITE, 'issues', { cursor: null, etag: null, syncedAt: SYNCED });
  db.upsertIssue(issueRow(5, T1, { source: OTHER_SOURCE, repository: SITE, state: 'open' }), 'sync');
  const [, summaries] = await get(`${base}/repositories`);
  assert.deepEqual((summaries as unknown[])[1], NEVER_SYNCED_SITE);
  assert.deepEqual(await get(`${base}/repositories/acme/site/issues?state=open`), [200, NO_ISSUES]);
  assert.deepEqual(await get(`${base}/repositories/acme/site/issues/5`), [404, { error: 'issue not found: acme/site#5' }]);
  assert.deepEqual(await get(`${base}/repositories/acme/site/labels`), [200, []]);
});

test('with no read model, or no login, the read routes answer 503 and none calls GraphQL (#181)', async (t) => {
  const cases: [Options, string][] = [[{ model: false }, 'the read model is not open yet'], [{ source: undefined }, 'no GitHub login']];
  for (const [options, error] of cases) {
    const { base, gqlCalls } = await routesOn(t, options);
    for (const path of READS) assert.deepEqual(await get(`${base}${path}`), [503, { error }], `${error}: ${path}`);
    assert.equal(gqlCalls(), 0);
  }
});

test('a source lookup that rejects answers 503 with the fixed message, logs the cause and never leaks it (#181)', async (t) => {
  const { base, errors } = await routesOn(t, { sourceFails: true });
  for (const path of READS) assert.deepEqual(await get(`${base}${path}`), [503, { error: 'no GitHub login' }], path);
  assert.equal(errors.length, READS.length);
  assert.match(errors[0] as string, /credential store corrupt/);
});

const RATE = { limit: 5000, remaining: 4000, resetAt: '2999-01-01T00:00:00Z' };
// What every write reads first: issue 12's id and updatedAt, and the repository's labels
const READ12 = { rateLimit: RATE, repository: { issue: { id: 'I_12', updatedAt: T1 }, labels: { nodes: [{ id: 'L_bug', name: 'bug' }, { id: 'L_docs', name: 'docs' }] } } };
// GitHub answering `mutation` with `answer`, and every read with READ12
const github = (mutation: string, answer: () => unknown): GqlJson => async (query) => (query === mutation ? answer() : READ12);
const ANSWERED = { ...GQL_ISSUE, updatedAt: T2 };
const POSTED = { ...GQL_COMMENT, id: 'IC_6', url: 'https://github.com/acme/hive/issues/12#issuecomment-6', body: 'Looks good', createdAt: T2, updatedAt: T2 };

async function post(url: string, body: unknown): Promise<[number, unknown]> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}

const page12 = async (base: string): Promise<Record<string, unknown>> => (await get(`${base}/repositories/acme/hive/issues/12`))[1] as Record<string, unknown>;

test('an edit upserts the issue its mutation answers: the next GET shows it with no sync round, and the event names issues (#183)', async (t) => {
  const { base, db, notified } = await routesOn(t, { gql: github(UPDATE_ISSUE, () => ({ updateIssue: { issue: { ...ANSWERED, title: 'New' } } })) });
  seed(db);
  assert.deepEqual(await post(`${base}/repositories/acme/hive/issues/12`, { title: 'New', updatedAt: T1 }), [200, { ok: true }]);
  const shown = await page12(base);
  assert.deepEqual([shown.title, shown.updatedAt], ['New', T2]);
  assert.deepEqual(notified, [[REPO, ['issues']]]);
});

test('a label change upserts the labelable its last mutation answers: the next GET shows the new labels (#183)', async (t) => {
  const labelled = { ...ANSWERED, labels: { nodes: [{ name: 'bug' }, { name: 'docs' }] } };
  const { base, db } = await routesOn(t, { gql: github(ADD_LABELS, () => ({ addLabelsToLabelable: { labelable: labelled } })) });
  seed(db);
  assert.deepEqual(await post(`${base}/repositories/acme/hive/issues/12/labels`, { add: ['docs'], remove: [] }), [200, { ok: true }]);
  assert.deepEqual((await page12(base)).labels, ['bug', 'docs']);
});

test('a comment upserts its comment and the issue it moved: the next GET counts it, and the event names both kinds (#183)', async (t) => {
  const answer = () => ({ addComment: { commentEdge: { node: POSTED }, subject: { ...ANSWERED, comments: { totalCount: 2 } } } });
  const { base, db, notified } = await routesOn(t, { gql: github(ADD_COMMENT, answer) });
  seed(db);
  assert.deepEqual(await post(`${base}/repositories/acme/hive/issues/12/comments`, { body: 'Looks good' }), [200, { ok: true }]);
  const shown = (await page12(base)) as { commentCount: number; comments: unknown[] };
  assert.deepEqual([shown.commentCount, shown.comments.at(-1)], [2, { author: 'bia', createdAt: T2, body: 'Looks good', url: POSTED.url }]);
  assert.equal(db.issue(SOURCE, REPO, 12)?.comments, 2);
  assert.deepEqual(notified, [[REPO, ['issues', 'comments']]]);
});

test('a refused write leaves the database as it was: GitHub\'s error, an issue changed since the page read it, an unknown label (#183)', async (t) => {
  const refusals: [GqlJson, string, unknown, number][] = [
    [github(UPDATE_ISSUE, () => { throw new Error('GitHub refused'); }), '', { title: 'New', updatedAt: T1 }, 502],
    [github(UPDATE_ISSUE, () => ({ updateIssue: { issue: ANSWERED } })), '', { title: 'New', updatedAt: T2 }, 409],
    [github(ADD_LABELS, () => ({ addLabelsToLabelable: { labelable: ANSWERED } })), '/labels', { add: ['wontfix'], remove: [] }, 400],
  ];
  for (const [gql, path, body, status] of refusals) {
    const { base, db, notified } = await routesOn(t, { gql });
    seed(db);
    const before = [db.issue(SOURCE, REPO, 12), db.comments(SOURCE, 'I_12')];
    assert.equal((await post(`${base}/repositories/acme/hive/issues/12${path}`, body))[0], status, `${path || 'edit'} ${status}`);
    assert.deepEqual([db.issue(SOURCE, REPO, 12), db.comments(SOURCE, 'I_12'), notified], [...before, []]);
  }
});

test('an answer the model cannot store still answers ok and is logged; with no login the write goes to GitHub and nothing is stored (#183)', async (t) => {
  const malformed = github(UPDATE_ISSUE, () => ({ updateIssue: { issue: { id: 'I_12' } } }));
  const renamed = github(UPDATE_ISSUE, () => ({ updateIssue: { issue: { ...ANSWERED, title: 'New' } } }));
  const cases: [Options, number][] = [[{ gql: malformed }, 1], [{ gql: renamed, source: undefined }, 0]];
  for (const [options, logged] of cases) {
    const { base, db, notified, errors, gqlCalls } = await routesOn(t, options);
    seed(db);
    assert.deepEqual(await post(`${base}/repositories/acme/hive/issues/12`, { title: 'New', updatedAt: T1 }), [200, { ok: true }]);
    assert.deepEqual([db.issue(SOURCE, REPO, 12)?.title, notified, errors.length, gqlCalls()], ['T12', [], logged, 2]);
  }
});
