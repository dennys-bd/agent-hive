import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { PrPage, type PrPageProps } from '@/components/PrPage';
import type { TaskPr, FileDiff, PrData, PrReviewFile, PrThread, RepoSummary, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { jsonResponse } from '../fakes';
import type { Call } from './diff-harness';

export const PR = 'https://github.com/acme/app/pull/7';
export const PR2 = 'https://github.com/acme/app/pull/9';
/** acme/app#7's route on the page (#758): the PR under its repository, by its number. */
export const ROUTE = '/repositories/acme/app/pulls/7';
export const HEAD = 'f'.repeat(40);
export const AT = '2026-09-30T10:00:00.000Z';
export const FILE: FileDiff = { path: 'src/a.ts', status: 'modified', hash: 'a'.repeat(64), hunks: [{ header: '@@ -1,2 +1,2 @@ intro', lines: [
  { kind: 'context', text: 'one', old: 1, new: 1 }, { kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: '2', new: 2 },
] }] };
export const ANCHOR = { path: 'src/a.ts', side: 'new' as const, start: 2, end: 2, excerpt: ['2'] };
/** The task's PRs, in its activity's record (#629). */
export const PRS: TaskPr[] = [{ url: PR, state: 'open' }];
export const thread = (extra: Partial<PrThread> = {}): PrThread => ({
  id: 'T1', anchor: { path: 'src/a.ts', side: 'new', start: 2, end: 2 }, outdated: false, resolved: false, subject: 'line', more: false,
  comments: [{ id: 'C1', author: 'bia', at: AT, text: 'why?' }], ...extra,
});
export const prData = (extra: Partial<PrData> = {}): PrData => ({
  url: PR, id: 'PR_1', number: 7, title: 'The PR', state: 'open', isDraft: false, mergeState: 'clean', head: HEAD, methods: ['merge', 'squash'], viewer: 'ana',
  files: [FILE], threads: [thread()], truncated: false, body: 'The description', author: 'bia', createdAt: AT, updatedAt: AT, headRef: 'feature', baseRef: 'main',
  commits: 2, additions: 1, deletions: 1, approvals: 0, reviews: [], comments: [], canEdit: true, canPush: true, headOwner: 'acme', baseOwner: 'acme', ...extra,
});

/** The page's fetch for a PR (#592, #758): GET …/pulls/:number answers `pr`, GET …/review `review`, `answers[method url]` override, the rest ok. */
export interface FakePrHive { calls: Call[]; pr: PrData; review: PrReviewFile; answers: Record<string, { status: number; body: unknown }> }

export function fakePrHive(): FakePrHive {
  const hive: FakePrHive = { calls: [], pr: prData(), review: { reviewed: [], drafts: [] }, answers: {} };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    hive.calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const answer = hive.answers[`${method} ${url}`];
    if (answer !== undefined) return jsonResponse(answer.body, answer.status);
    if (method === 'GET' && /\/pulls\/\d+\/review$/.test(url)) return jsonResponse(hive.review);
    if (method === 'GET' && /\/pulls\/\d+$/.test(url)) return jsonResponse(hive.pr);
    return jsonResponse({ ok: true });
  }));
  return hive;
}

export const prCalls = (hive: FakePrHive, method: string, url: string): Call[] => hive.calls.filter((c) => c.method === method && c.url === url);

/** acme/app's summary (#758): what a PR without a task shows as its properties. */
export const APP: RepoSummary = { repository: 'acme/app', url: 'https://github.com/acme/app', workspace: 'hive', openPrs: 1, openIssues: 0, closedIssues: 0, canPush: true, issuesEnabled: true };
/** A State with no task (#758): the PR is no task's. */
export const STATE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: {}, prompt: 'x' }], tasks: [], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
/** Task I1, issue acme/app#1, holding PR in its live activity a-I1 (#758). */
export const WITH_TASK: State = {
  ...STATE,
  tasks: [{ item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/app/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true }],
  activities: [{ id: 'a-I1', kind: 'task', workspace: 'hive', slug: 'hive-1-task-1' }],
  activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions: [], prs: PRS }],
};

/** acme/app#7's page (#758) over `state`; answers the render and the props, its callbacks spies. */
export function renderPage(state: State = STATE, extra: Partial<PrPageProps> = {}) {
  const props: PrPageProps = {
    state, locale: 'pt-BR', pr: { repository: 'acme/app', number: 7 }, summary: APP, header: () => null, onGoTo: vi.fn(), onOpenIssue: vi.fn(), onOpenPr: vi.fn(), ...extra,
  };
  return { ...render(<PrPage {...props} />), props };
}
