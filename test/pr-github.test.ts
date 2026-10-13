import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMENT_MUTATION, EDIT_MUTATION, isReviewEvent, MERGE_MUTATION, mergeBlocker, mergeState, mergeVariables, parseHead, parsePrChecks, parsePrData, PR_CHECKS_QUERY,
  PR_HEAD_QUERY, PR_QUERY, parseThreads, PR_THREADS_QUERY, prDiffArgs, PrNotFound, readView, REPLY_MUTATION, requestTimesOf, RESOLVE_MUTATION, REVIEW_MUTATION, reviewVariables,
  parseGuard, PR_GUARD_QUERY, threadAnchor, timelineArgs, timelineOf, UNRESOLVE_MUTATION, withRequestTimes,
} from '../src/pr-github.js';
import { COMMENT_ROW_FIELDS, PR_ROW_FIELDS, REVIEW_ROW_FIELDS } from '../src/repos/github-repo-queries.js';
import type { Gql } from '../src/types.js';

const LINK = 'https://github.com/acme/app/pull/7';
const HEAD = 'a'.repeat(40);
const AT = '2026-09-30T10:00:00Z';
const comment = (id: string, login: string | null) => ({ id, body: `text ${id}`, createdAt: AT, author: login === null ? null : { login } });
const threadNode = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'T1', path: 'src/a.ts', diffSide: 'RIGHT', line: 4, startLine: null, originalLine: 4, originalStartLine: null, isOutdated: false, isResolved: false,
  subjectType: 'LINE', comments: { totalCount: 1, nodes: [comment('C1', 'bia')] }, ...extra,
});
// The page's fields as PR_QUERY answers them (#758), and what parsePrData reads of them
const PAGE = {
  body: 'The description', author: { login: 'bia' }, createdAt: AT, updatedAt: AT, headRefName: 'feature', baseRefName: 'main', commits: { totalCount: 2 },
  additions: 10, deletions: 3, reviewDecision: 'APPROVED', viewerCanUpdate: true,
  headRepositoryOwner: { login: 'bia' }, baseRepository: { owner: { login: 'acme' }, viewerPermission: 'WRITE' },
  latestOpinionatedReviews: { nodes: [{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }] }, baseRef: { compare: { behindBy: 4 } },
  headCommit: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null, completedAt: AT }] } } } }] },
  timelineItems: { nodes: [
    { __typename: 'PullRequestReview', id: 'R1', author: { login: 'caio' }, submittedAt: AT, state: 'APPROVED', body: 'ship it' },
    { __typename: 'IssueComment', id: 'IC1', author: null, createdAt: AT, body: 'thanks' },
  ] },
};
const PAGE_VIEW = {
  body: 'The description', author: 'bia', createdAt: AT, updatedAt: AT, headRef: 'feature', baseRef: 'main', commits: 2, additions: 10, deletions: 3,
  decision: 'approved', approvals: 1, canEdit: true, headOwner: 'bia', baseOwner: 'acme', canPush: true, behindBy: 4, checks: { state: 'success', at: AT, items: [{ name: 'test', state: 'success', at: AT }] },
  reviews: [{ id: 'R1', author: 'caio', at: AT, kind: 'approved', text: 'ship it' }], comments: [{ id: 'IC1', author: 'ghost', at: AT, text: 'thanks' }], reviewRequests: [], closes: [],
};
const answer = (pr: Record<string, unknown> = {}) => ({
  viewer: { login: 'ana' },
  resource: {
    id: 'PR_1', number: 7, title: 'The PR', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', headRefOid: HEAD,
    repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false },
    reviewThreads: { totalCount: 1, nodes: [threadNode()] }, ...PAGE, ...pr,
  },
});

test('parsePrData reads the PR, its allowed methods, the viewer, its threads and the page\'s fields; a null resource is PrNotFound, a missing field throws (#592, #758)', () => {
  assert.deepEqual(parsePrData(answer()), {
    id: 'PR_1', number: 7, title: 'The PR', state: 'open', isDraft: false, mergeState: 'clean', head: HEAD, methods: ['merge', 'squash'], viewer: 'ana', truncated: false,
    threads: [{
      id: 'T1', anchor: { path: 'src/a.ts', side: 'new', start: 4, end: 4 }, outdated: false, resolved: false, subject: 'line', more: false,
      comments: [{ id: 'C1', author: 'bia', at: AT, text: 'text C1' }],
    }],
    ...PAGE_VIEW,
  });
  const bare = parsePrData(answer({ reviewDecision: null, baseRef: { compare: null }, headCommit: { nodes: [] } }));
  assert.deepEqual(['decision' in bare, 'behindBy' in bare, 'checks' in bare], [false, false, false], 'no decision, no compare, no checks: none of them');
  assert.throws(() => parsePrData({ viewer: { login: 'ana' }, resource: null }), PrNotFound);
  assert.throws(() => parsePrData(answer({ headRefOid: undefined })), /headRefOid/);
  assert.throws(() => parsePrData(answer({ baseRefName: undefined })), /baseRefName/);
  assert.throws(() => parsePrData(answer({ state: 'WEIRD' })), /not a pull request/);
});

test('parsePrData skips a thread it cannot read and names why; a deleted author reads ghost; past 100 threads or comments it says so (#592)', () => {
  const skipped: string[] = [];
  const cut = { totalCount: 150, nodes: [comment('C2', null)] };
  const view = parsePrData(answer({ reviewThreads: { totalCount: 140, nodes: [threadNode({ path: 42 }), threadNode({ id: 'T2', comments: cut })] } }), (reason) => skipped.push(reason));
  assert.deepEqual(view.threads.map((t) => [t.id, t.more, t.comments[0].author]), [['T2', true, 'ghost']]);
  assert.equal(view.truncated, true);
  assert.equal(skipped.length, 1);
});

test('threadAnchor: one line, a range, the old side, a line gone from the diff, a file-level thread; no line at all throws (#592)', () => {
  assert.deepEqual(threadAnchor(threadNode()), { path: 'src/a.ts', side: 'new', start: 4, end: 4 });
  assert.deepEqual(threadAnchor(threadNode({ startLine: 2 })), { path: 'src/a.ts', side: 'new', start: 2, end: 4 });
  assert.deepEqual(threadAnchor(threadNode({ diffSide: 'LEFT', line: 3 })), { path: 'src/a.ts', side: 'old', start: 3, end: 3 });
  assert.deepEqual(threadAnchor(threadNode({ line: null, originalLine: 9, originalStartLine: 7 })), { path: 'src/a.ts', side: 'new', start: 7, end: 9 });
  assert.deepEqual(threadAnchor(threadNode({ subjectType: 'FILE', line: null, originalLine: null })), { path: 'src/a.ts', side: 'new', start: 0, end: 0 });
  assert.throws(() => threadAnchor(threadNode({ line: null, originalLine: null })), /no line/);
  const nodes = [threadNode({ line: null, originalLine: 9 }), threadNode({ id: 'T2', subjectType: 'FILE', line: null, originalLine: null })];
  const [gone, file] = parsePrData(answer({ reviewThreads: { totalCount: 2, nodes } })).threads;
  assert.deepEqual([gone.outdated, file.outdated, file.subject], [true, false, 'file']);
});

test('prDiffArgs asks gh api for the PR as a diff, owner, repo and number off the link; parseHead reads the head alone (#592)', () => {
  assert.deepEqual(prDiffArgs(LINK), ['api', 'repos/acme/app/pulls/7', '-H', 'Accept: application/vnd.github.diff']);
  assert.deepEqual(parseHead({ resource: { headRefOid: HEAD, headRefName: 'feature', state: 'OPEN' } }), { oid: HEAD, ref: 'feature', open: true });
  assert.deepEqual(['MERGED', 'CLOSED', undefined].map((state) => parseHead({ resource: { headRefOid: HEAD, headRefName: 'feature', state } }).open), [false, false, false]);
  assert.throws(() => parseHead({ resource: null }), PrNotFound);
});

test('mergeState lowercases and shortens GitHub\'s status; mergeBlocker names why mergear is off, by state, draft and status (#592)', () => {
  assert.deepEqual(['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'DIRTY', 'BLOCKED', 'BEHIND', 'DRAFT', 'UNKNOWN', 'NEW_ONE', 7].map((raw) => mergeState(raw)),
    ['clean', 'unstable', 'hooks', 'conflicts', 'blocked', 'behind', 'draft', 'unknown', 'unknown', 'unknown']);
  const states = ['clean', 'hooks', 'unstable', 'conflicts', 'blocked', 'behind', 'draft', 'unknown'] as const;
  assert.deepEqual(states.map((s) => mergeBlocker({ state: 'open', isDraft: false, mergeState: s })),
    [undefined, undefined, undefined, 'conflicts', 'blocked', 'behind', 'draft', 'unknown']);
  assert.equal(mergeBlocker({ state: 'open', isDraft: true, mergeState: 'clean' }), 'draft');
  assert.equal(mergeBlocker({ state: 'merged', isDraft: false, mergeState: 'unknown' }), 'merged');
  assert.equal(mergeBlocker({ state: 'closed', isDraft: false, mergeState: 'clean' }), 'closed');
});

test('reviewVariables carries the event GitHub names and every value as a variable, a range\'s start only on a range; no value ever enters a query\'s text (#592, #758)', () => {
  const one = { anchor: { path: 'src/a.ts', side: 'new' as const, start: 4, end: 4, excerpt: ['x'] }, text: 'why?' };
  const range = { anchor: { path: 'b.ts', side: 'old' as const, start: 2, end: 3, excerpt: ['y', 'z'] }, text: '"}) { evil }' };
  assert.deepEqual(reviewVariables('PR_1', HEAD, 'comment', 'overall', [one, range]), {
    pr: 'PR_1', head: HEAD, event: 'COMMENT', body: 'overall', threads: [
      { path: 'src/a.ts', line: 4, side: 'RIGHT', body: 'why?' },
      { path: 'b.ts', line: 3, side: 'LEFT', body: '"}) { evil }', startLine: 2, startSide: 'LEFT' },
    ],
  });
  assert.deepEqual([reviewVariables('PR_1', HEAD, 'approve', '', []).event, reviewVariables('PR_1', HEAD, 'request_changes', 'no', []).event], ['APPROVE', 'REQUEST_CHANGES']);
  assert.equal('body' in reviewVariables('PR_1', HEAD, 'approve', '', [one]), false, 'no summary, no body');
  assert.deepEqual(['comment', 'approve', 'request_changes', 'APPROVE', 'dismiss', 3].map((value) => isReviewEvent(value)), [true, true, true, false, false, false]);
  assert.deepEqual(mergeVariables('PR_1', HEAD, 'squash'), { pr: 'PR_1', head: HEAD, method: 'SQUASH' });
  const queries = [PR_QUERY, PR_CHECKS_QUERY, REVIEW_MUTATION, EDIT_MUTATION, COMMENT_MUTATION, REPLY_MUTATION, RESOLVE_MUTATION, UNRESOLVE_MUTATION, MERGE_MUTATION];
  for (const query of queries) {
    for (const value of ['PR_1', HEAD, 'why?', 'src/a.ts', 'evil', LINK]) assert.ok(!query.includes(value), `${value} in ${query.slice(0, 40)}`);
  }
});

test('timelineOf keeps GitHub\'s order, a review\'s kind and body, a comment by ghost when its author left; a pending review or another item is skipped and named (#758)', () => {
  const skipped: string[] = [];
  const nodes = [
    { __typename: 'IssueComment', id: 'IC1', author: { login: 'ana' }, createdAt: AT, body: 'first' },
    { __typename: 'PullRequestReview', id: 'R1', author: { login: 'bia' }, submittedAt: AT, state: 'CHANGES_REQUESTED', body: 'not yet' },
    { __typename: 'PullRequestReview', id: 'R2', author: { login: 'bia' }, submittedAt: null, state: 'PENDING', body: '' },
    { __typename: 'PullRequestReview', id: 'R3', author: null, submittedAt: AT, state: 'COMMENTED', body: '' },
    { __typename: 'MergedEvent' },
  ];
  assert.deepEqual(timelineOf({ nodes }, (reason) => skipped.push(reason)), {
    reviews: [{ id: 'R1', author: 'bia', at: AT, kind: 'changes', text: 'not yet' }, { id: 'R3', author: 'ghost', at: AT, kind: 'commented', text: '' }],
    comments: [{ id: 'IC1', author: 'ana', at: AT, text: 'first' }],
  });
  assert.deepEqual(skipped, ['review in state PENDING', 'timeline item MergedEvent']);
});

test('readView reads the head branch first and hands it to the PR query as $head, never in its text (#758)', async () => {
  const calls: [string, Record<string, string | number | boolean> | undefined][] = [];
  const gql: Gql = async (query, variables) => {
    calls.push([query, variables]);
    return query === PR_HEAD_QUERY ? { resource: { headRefOid: HEAD, headRefName: 'feature', state: 'OPEN' } } : answer();
  };
  assert.equal((await readView(gql, LINK)).head, HEAD);
  assert.deepEqual(calls, [[PR_HEAD_QUERY, { url: LINK }], [PR_QUERY, { url: LINK, head: 'feature', open: true }]]);
  assert.match(PR_QUERY, /baseRef \{ compare\(headRef: \$head\) @include\(if: \$open\) \{ behindBy \} \}/);
  assert.ok(!PR_QUERY.includes('feature'));
});

test('a merged PR, whose head branch may be gone, is read without the compare: open false, and an answer with no compare has no behindBy (#849)', async () => {
  const sent: (Record<string, string | number | boolean> | undefined)[] = [];
  const gql: Gql = async (query, variables) => {
    sent.push(variables);
    return query === PR_HEAD_QUERY ? { resource: { headRefOid: HEAD, headRefName: 'feature', state: 'MERGED' } } : answer({ state: 'MERGED', baseRef: {} });
  };
  const view = await readView(gql, LINK);
  assert.deepEqual(sent.at(-1), { url: LINK, head: 'feature', open: false });
  assert.deepEqual([view.state, 'behindBy' in view], ['merged', false]);
  assert.match(PR_QUERY, /^query\(\$url: URI!, \$head: String!, \$open: Boolean!\)/);
  assert.match(PR_HEAD_QUERY, /headRefOid headRefName state/);
});

test('the timeline reads its last items, so the newest reviews and comments of a long PR show (#758)', () => {
  assert.match(PR_QUERY, /timelineItems\(last: 100,/);
});

const requestOf = (reviewer: unknown) => ({ requestedReviewer: reviewer });

test('parsePrData reads the pending review requests: a user one naming the viewer with its latest request time, a team one never the viewer\'s, a malformed one skipped; none reads [] (#67)', () => {
  const EARLY = '2026-09-29T10:00:00Z';
  const view = parsePrData(answer({
    reviewRequests: { nodes: [
      requestOf({ __typename: 'User', login: 'ana' }), requestOf({ __typename: 'Team', slug: 'core' }), requestOf({ __typename: 'User', login: 'caio' }),
      requestOf(null), requestOf({ __typename: 'User', login: 7 }), requestOf({ __typename: 'Team' }), 'junk',
    ] },
    requested: { nodes: [
      { createdAt: EARLY, requestedReviewer: { __typename: 'User', login: 'ana' } },
      { createdAt: AT, requestedReviewer: { __typename: 'User', login: 'ana' } },
      { createdAt: EARLY, requestedReviewer: { __typename: 'Team', slug: 'core' } },
      { createdAt: AT, requestedReviewer: { __typename: 'User', login: 'core' } }, // a user named like the team: not the team's request
      { createdAt: 5, requestedReviewer: { __typename: 'User', login: 'caio' } },
      {},
    ] },
  }));
  assert.deepEqual(view.reviewRequests, [
    { reviewer: 'ana', team: false, viewer: true, at: AT },
    { reviewer: 'core', team: true, viewer: false, at: EARLY },
    { reviewer: 'caio', team: false, viewer: false },
  ]);
  assert.deepEqual(parsePrData(answer()).reviewRequests, [], 'no requests: []');
  const anonymous = parsePrData({ ...answer({ reviewRequests: { nodes: [requestOf({ __typename: 'User', login: 'ana' })] } }), viewer: null });
  assert.deepEqual(anonymous.reviewRequests, [{ reviewer: 'ana', team: false, viewer: false }], 'no viewer login: nobody is the viewer');
});

test('PR_QUERY asks the review requests and, under their own alias, the ReviewRequestedEvents; the conversation\'s timeline keeps its two kinds (#67)', () => {
  assert.match(PR_QUERY, /reviewRequests\(first: 100\) \{ nodes \{ requestedReviewer \{ __typename \.\.\. on User \{ login \} \.\.\. on Team \{ slug \} \.\.\. on Mannequin \{ login \} \} \} \}/);
  assert.match(PR_QUERY, /requested: timelineItems\(last: 100, itemTypes: \[REVIEW_REQUESTED_EVENT\]\) \{ nodes \{ \.\.\. on ReviewRequestedEvent \{ createdAt requestedReviewer \{ __typename /);
  assert.match(PR_QUERY, / timelineItems\(last: 100, itemTypes: \[PULL_REQUEST_REVIEW, ISSUE_COMMENT\]\)/);
});

test('parsePrChecks reads the checks, the merge state and updatedAt alone; a PR without checks has none; a null resource is PrNotFound (#758)', () => {
  const resource = { mergeStateStatus: 'BLOCKED', updatedAt: AT, headCommit: PAGE.headCommit };
  assert.deepEqual(parsePrChecks({ resource }), { mergeState: 'blocked', updatedAt: AT, checks: PAGE_VIEW.checks });
  assert.deepEqual(parsePrChecks({ resource: { ...resource, headCommit: { nodes: [] } } }), { mergeState: 'blocked', updatedAt: AT });
  assert.throws(() => parsePrChecks({ resource: null }), PrNotFound);
  assert.ok(!PR_CHECKS_QUERY.includes('reviewThreads') && !PR_CHECKS_QUERY.includes('timelineItems'), 'no threads, no timeline');
});

test('the PR\'s checks carry the workflows awaiting a maintainer\'s approval; with no check run the box still has them (#854)', () => {
  const suites = { nodes: [{ conclusion: 'ACTION_REQUIRED', app: { slug: 'github-actions' }, workflowRun: { workflow: { name: 'CI' } } }] };
  const read = parsePrChecks({ resource: { mergeStateStatus: 'BLOCKED', updatedAt: AT, headCommit: { nodes: [{ commit: { statusCheckRollup: null, checkSuites: suites } }] } } });
  assert.deepEqual(read.checks, { state: 'pending', items: [], awaiting: ['CI'] });
  assert.match(PR_CHECKS_QUERY, /checkSuites\(first: 50\)/);
  assert.match(PR_QUERY, /checkSuites\(first: 50\)/);
});

test('parsePrData reads both owners and the push rights on the base repository; none or READ is no rights (#854)', () => {
  assert.match(PR_QUERY, /headRepositoryOwner \{ login \} baseRepository \{ owner \{ login \} viewerPermission \}/);
  for (const permission of ['ADMIN', 'MAINTAIN', 'WRITE']) assert.equal(parsePrData(answer({ baseRepository: { owner: { login: 'acme' }, viewerPermission: permission } })).canPush, true, permission);
  assert.equal(parsePrData(answer({ baseRepository: { owner: { login: 'acme' }, viewerPermission: 'READ' } })).canPush, false);
  assert.deepEqual([parsePrData(answer({ headRepositoryOwner: null, baseRepository: null })).canPush, parsePrData(answer({ headRepositoryOwner: null })).headOwner], [false, '']);
});

test('PR_QUERY asks the issues the PR closes; parsePrData maps them to closes in GitHub\'s order, drops a malformed node, and reads [] without the connection (#66)', () => {
  assert.match(PR_QUERY, /closingIssuesReferences\(first: 10\) \{ nodes \{ number url repository \{ nameWithOwner \} \} \}/);
  const view = parsePrData(answer({ closingIssuesReferences: { nodes: [
    { number: 458, url: 'https://github.com/acme/app/issues/458', repository: { nameWithOwner: 'acme/app' } },
    { number: 3, url: 'https://github.com/acme/docs/issues/3', repository: { nameWithOwner: 'acme/docs' } },
    { number: '9', url: 'https://github.com/acme/app/issues/9', repository: { nameWithOwner: 'acme/app' } },
    { number: 10, url: null, repository: { nameWithOwner: 'acme/app' } },
    { number: 11, url: 'https://github.com/acme/app/issues/11', repository: null },
    null,
  ] } }));
  assert.deepEqual(view.closes, [
    { repository: 'acme/app', number: 458, url: 'https://github.com/acme/app/issues/458' },
    { repository: 'acme/docs', number: 3, url: 'https://github.com/acme/docs/issues/3' },
  ]);
  assert.deepEqual(parsePrData(answer()).closes, [], 'no connection: []');
  assert.deepEqual(parsePrData(answer({ closingIssuesReferences: null })).closes, [], 'a null connection: []');
});

test('parseThreads reads the head and the threads, skipping one it cannot read and naming why; past 100 it says truncated; a null resource is PrNotFound (#187)', () => {
  const skipped: string[] = [];
  const read = parseThreads({ resource: { headRefOid: HEAD, reviewThreads: { totalCount: 140, nodes: [threadNode({ path: 42 }), threadNode({ id: 'T2' })] } } }, (reason) => skipped.push(reason));
  assert.deepEqual([read.head, read.threads.map((thread) => thread.id), read.truncated, skipped.length], [HEAD, ['T2'], true, 1]);
  assert.throws(() => parseThreads({ resource: null }), PrNotFound);
  assert.match(PR_THREADS_QUERY, /^query\(\$url: URI!\) \{ resource\(url: \$url\) \{ \.\.\. on PullRequest \{ headRefOid reviewThreads\(first: 100\)/);
});

test('requestTimesOf reads each review_requested line gh printed, a user\'s or a team\'s, dropping one it cannot read; withRequestTimes puts the latest on each request (#67, #187)', () => {
  const EARLY = '2026-09-29T10:00:00Z';
  const lines = [{ at: EARLY, user: 'ana', team: null }, { at: AT, user: 'ana', team: null }, { at: EARLY, user: null, team: 'core' }, { at: 5, user: 'caio' }]
    .map((line) => JSON.stringify(line)).concat('junk').join('\n');
  const times = requestTimesOf(lines);
  assert.deepEqual(times, [{ reviewer: 'ana', team: false, at: EARLY }, { reviewer: 'ana', team: false, at: AT }, { reviewer: 'core', team: true, at: EARLY }]);
  const requests = [{ reviewer: 'ana', team: false, viewer: true }, { reviewer: 'core', team: true, viewer: false }, { reviewer: 'caio', team: false, viewer: false }];
  assert.deepEqual(withRequestTimes(requests, times), [{ ...requests[0], at: AT }, { ...requests[1], at: EARLY }, requests[2]]);
  assert.deepEqual(timelineArgs('acme/app', 7).slice(0, 3), ['api', 'repos/acme/app/issues/7/timeline?per_page=100', '--paginate']);
});

test('parseGuard reads what the writes check: id, state, head, updatedAt, author, viewer, push rights and methods; a null resource is PrNotFound (#187)', () => {
  const resource = {
    id: 'PR_1', state: 'OPEN', headRefOid: HEAD, updatedAt: AT, author: null, baseRepository: { viewerPermission: 'READ' },
    repository: { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true },
  };
  assert.deepEqual(parseGuard({ viewer: { login: 'ana' }, resource }), { id: 'PR_1', state: 'open', head: HEAD, updatedAt: AT, author: 'ghost', viewer: 'ana', canPush: false, methods: ['squash', 'rebase'] });
  assert.throws(() => parseGuard({ viewer: null, resource: null }), PrNotFound);
  assert.ok(!PR_GUARD_QUERY.includes('reviewThreads') && !PR_GUARD_QUERY.includes('timelineItems'), 'lean: no threads, no timeline');
});

test('each PR write asks back the PR\'s row, and the comment or the review it made (#187)', () => {
  for (const query of [REVIEW_MUTATION, EDIT_MUTATION, COMMENT_MUTATION, MERGE_MUTATION]) assert.ok(query.includes(PR_ROW_FIELDS), query.slice(0, 40));
  assert.ok(REVIEW_MUTATION.includes(`pullRequestReview { ${REVIEW_ROW_FIELDS} pullRequest { ${PR_ROW_FIELDS} } }`));
  assert.ok(COMMENT_MUTATION.includes(`commentEdge { node { ${COMMENT_ROW_FIELDS} } }`));
});
