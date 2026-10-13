import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../src/log.js';
import { initialState } from '../src/orchestrator.js';
import { openReadModel, type ReadModel } from '../src/read-model/db.js';
import type { RestGet } from '../src/read-model/rest.js';
import { type IssueRow, type PullKey, type PullPage, sourceOf } from '../src/read-model/rows.js';
import { prNumber, prRepo } from '../src/pull-requests.js';
import { createServer, type HiveServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import type { Task, Exec, PrReviewFile, Stage } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { tempHive } from './fakes.js';
import { NO_GQL } from './read-model/fixtures.js';
import { send, settingsBody } from './review-server.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { savedActivityId, withKeptRecord, withWork } from './fixtures/work.js';

export const PR = 'https://github.com/acme/app/pull/7'; // task 1's, awaiting approval
export const PR2 = 'https://github.com/acme/app/pull/9'; // task 2's
export const OTHER_PR = 'https://github.com/acme/app/pull/8'; // on no task
export const HEAD = 'a'.repeat(40);
export const AT = '2026-09-30T10:00:00Z';
export const DIFF = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+two', ''].join('\n');
export const ANCHOR = { path: 'a.txt', side: 'new', start: 1, end: 1, excerpt: ['two'] };
/** The read model's source in these tests (#187): the login the fake gh names as viewer. */
export const PR_SOURCE = sourceOf('github.com', 'ana');
const REPOSITORY = 'acme/app';
// Every REST read answering 304 (#187): GitHub unchanged since the round, so a page's refetch writes nothing
const UNCHANGED: RestGet = async () => ({ status: 304 });
export const prKey = (n: number): PullKey => ({ source: PR_SOURCE, nodeId: `PR_${n}`, repository: REPOSITORY, number: n });
/** What pulls/{n} told the round of every seeded PR (#187): fakeGh's PR fields. */
export const PR_PAGE_ROW: PullPage = { headRef: 'feature', baseRef: 'main', headOwner: 'acme', baseOwner: 'acme', commits: 1, additions: 1, deletions: 1, requested: [] };

/** PR n of acme/app as the round stored it (#187): open at HEAD and clean, with fakeGh's page fields; `extra` overrides its issues row. */
export function seedPr(db: ReadModel, n: number, extra: Partial<IssueRow> = {}): void {
  const key = prKey(n);
  db.upsertIssue({
    ...key, kind: 'pr', state: 'open', title: 'The PR', body: 'The description', author: 'bia', labels: [], assignees: [], createdAt: AT, updatedAt: AT,
    closedAt: null, comments: 0, ...extra,
  }, 'sync');
  db.setPullFlags({ ...key, draft: false, mergedAt: null });
  db.setPullPoll(key, { headSha: HEAD, mergeState: 'clean', checks: null });
  db.setPullPage(key, PR_PAGE_ROW);
}

// fila awaits approval (#268), so a merge there approves; feito is where the approved task goes
const STAGES: Stage[] = [{ name: 'fila', from: {}, prompt: 'Task {id}', approval: true }, { name: 'feito', from: {} }];

/** A GitHub review thread as the PR query answers it (#592). */
export const thread = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'T1', path: 'a.txt', diffSide: 'RIGHT', line: 1, startLine: null, originalLine: 1, originalStartLine: null, isOutdated: false, isResolved: false,
  subjectType: 'LINE', comments: { totalCount: 1, nodes: [{ id: 'C1', body: 'why?', createdAt: AT, author: { login: 'bia' } }] }, ...extra,
});

/** What gh answers (#592, #758): `pr` for the threads query and the writes' guard, `heads` for the head each threads query answers in turn (#187), `diff`, and `failWith` refusing every mutation. `git` answers
 * `git merge-tree` (#758); any other git call answers nothing. Every gh call is recorded, a mutation with the JSON it wrote to stdin. */
export interface FakeGh {
  calls: { args: string[]; input?: unknown }[]; pr: Record<string, unknown>; heads: string[]; diff: string; failWith?: string; onMutation?: () => Promise<void>;
  git?: (args: string[]) => { stdout: string };
  compare?: string; ci?: Record<string, unknown>; // compare: REST's compare across forks; ci: the CI read's alias (#854)
  readFailWith?: string; missing?: boolean; // readFailWith: GitHub refuses the PR query; missing: the head query finds no PR, a 404 (#849)
  answer?: (query: string) => unknown; // #187: what a mutation answers by its query; { ok: true } otherwise
  rest?: RestGet; timeline?: string; timelineFailWith?: string; // #187: the read model's REST (default: all 304) and what gh prints for the timeline
}

export function fakeGh(): FakeGh {
  return {
    calls: [], heads: [], diff: DIFF,
    pr: {
      id: 'PR_1', number: 7, title: 'The PR', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', headRefOid: HEAD,
      repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false }, reviewThreads: { totalCount: 1, nodes: [thread()] },
      body: 'The description', author: { login: 'bia' }, createdAt: AT, updatedAt: AT, headRefName: 'feature', baseRefName: 'main', commits: { totalCount: 1 },
      additions: 1, deletions: 1, reviewDecision: null, viewerCanUpdate: true, latestOpinionatedReviews: { nodes: [] }, baseRef: { compare: null },
      headRepositoryOwner: { login: 'acme' }, baseRepository: { owner: { login: 'acme' }, viewerPermission: 'WRITE' },
      headCommit: { nodes: [] }, timelineItems: { nodes: [] },
    },
  };
}

const json = (data: unknown): { stdout: string } => ({ stdout: JSON.stringify({ data }) });

// gh as the server runs it: a mutation on stdin, the diff, the PR query, the head query; anything else is the poll's PR states (#207), nothing new
function ghOf(gh: FakeGh): Exec {
  return async (file, args, opts) => {
    if (file !== 'gh') return file === 'git' && args.includes('merge-tree') && gh.git ? gh.git(args) : { stdout: '' };
    gh.calls.push({ args, ...(opts?.input === undefined ? {} : { input: JSON.parse(opts.input) as unknown }) });
    if (args.includes('--input')) {
      await gh.onMutation?.(); // something else happening while GitHub takes the write
      if (gh.failWith !== undefined) throw new Error(`gh api graphql: ${gh.failWith}`);
      return json(gh.answer?.(String((JSON.parse(opts?.input ?? '{}') as { query?: unknown }).query)) ?? { ok: true });
    }
    if (args[1]?.includes('/timeline')) {
      if (gh.timelineFailWith !== undefined) throw new Error(gh.timelineFailWith);
      return { stdout: gh.timeline ?? '' };
    }
    if (args[1]?.includes('/compare/')) return { stdout: gh.compare ?? '{}' };
    if (args[1] !== 'graphql') return { stdout: gh.diff };
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    if (query.includes('reviewThreads')) {
      if (gh.readFailWith !== undefined) throw new Error(`gh api graphql: ${gh.readFailWith}`); // what gh prints when GitHub answers errors (#849)
      return json({ viewer: { login: 'ana' }, resource: gh.missing ? null : { ...gh.pr, headRefOid: gh.heads.shift() ?? gh.pr.headRefOid } });
    }
    if (query.includes('requiredStatusCheckContexts')) return json({ p0: gh.ci ?? null }); // the CI read (#834, #854)
    if (query.includes('viewerPermission')) return json({ viewer: { login: 'ana' }, resource: gh.missing ? null : gh.pr }); // the writes' guard (#187)
    return json({});
  };
}

export interface Prs { base: string; home: string; server: HiveServer; db: ReadModel }

/** A Comb with no source and two local tasks in fila (#592): 1 awaits approval and holds PR, 2 holds PR2. gh is `gh`. With `worktree`, task 1's
 * worktree is on disk (#758). */
export async function startPrs(t: TestContext, gh: FakeGh, log?: Logger, { worktree = false }: { worktree?: boolean } = {}): Promise<Prs> {
  const { home, repo } = await tempHive(t);
  const path = worktreePath(repo, 'hive-1-task');
  if (worktree) await mkdir(path, { recursive: true });
  const task = (n: number, more: Partial<Task>): Task => ({
    item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive', ...more,
  });
  const tasks = [task(1, {}), task(2, {})];
  // #629: the PRs are the records', the approval task 1's live activity's
  const work = { id: savedActivityId(1), approval: { since: '2026-09-30T09:00:00.000Z' }, ...(worktree ? { slug: 'hive-1-task', worktree: path } : {}) };
  const one = withWork({ ...initialState(0), localCount: 2, tasks }, 'local:1', work, { prs: [{ url: PR, state: 'open' }] });
  await saveState(home, withKeptRecord(one, 'local:2', 'r2', { prs: [{ url: PR2, state: 'open' }] }));
  const { db } = await openReadModel(':memory:'); // server.close() closes it
  db.setRepo({ source: PR_SOURCE, repository: REPOSITORY, url: 'https://github.com/acme/app', canPush: true, issuesEnabled: true, forkParent: null, pushedAt: null, methods: ['merge', 'squash'] });
  for (const n of [7, 8, 9]) seedPr(db, n);
  const readAccess = async () => ({ source: PR_SOURCE, rest: (path: string, etag?: string) => (gh.rest ?? UNCHANGED)(path, etag), gql: NO_GQL });
  const server = createServer({ secret: SECRET, home, exec: ghOf(gh), readModel: db, readAccess, ...(log ? { log } : {}) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send(base, 'POST', '/settings', settingsBody(repo, STAGES))).status, 200);
  return { base, home, server, db };
}

/** The data of the first `name` event /events streams while `act` runs (#592). */
export async function namedEventDuring(base: string, name: string, act: () => Promise<unknown>): Promise<unknown> {
  const reader = (await hiveFetch(`${base}/events`, { signal: AbortSignal.timeout(5000) })).body!.getReader();
  const decoder = new TextDecoder();
  const marker = `event: ${name}\n`;
  let text = decoder.decode((await reader.read()).value, { stream: true }); // the State every connection gets first
  await act();
  while (!text.includes(marker)) text += decoder.decode((await reader.read()).value, { stream: true });
  await reader.cancel();
  const frame = text.slice(text.indexOf(marker)).split('\n\n')[0];
  return JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length));
}

export async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await check()); i += 1) await sleep(10);
  assert.ok(await check(), 'condition not met in time');
}

/** GET …/pulls/:number/review's answer (#592, #758). */
export const reviewFileOf = async (base: string, url = PR): Promise<PrReviewFile> =>
  (await hiveFetch(`${base}/repositories/${prRepo(url)}/pulls/${prNumber(url)}/review`)).json() as Promise<PrReviewFile>;

/** PR 7 as PR_ROW_FIELDS answers it (#187): the seeded row; `extra` overrides any field. */
export const GQL_PR_7 = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'PR_7', number: 7, title: 'The PR', body: 'The description', state: 'OPEN', isDraft: false, mergedAt: null, createdAt: AT, updatedAt: AT, closedAt: null,
  author: { login: 'bia' }, labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0 }, ...extra,
});
