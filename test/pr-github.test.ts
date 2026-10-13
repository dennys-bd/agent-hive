import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMENT_MUTATION, EDIT_MUTATION, isReviewEvent, MERGE_MUTATION, mergeBlocker, mergeState, mergeVariables, parseGuard, parseThreads, PR_GUARD_QUERY, PR_THREADS_QUERY,
  prDiffArgs, PrNotFound, REPLY_MUTATION, requestTimesOf, RESOLVE_MUTATION, REVIEW_MUTATION, reviewVariables, threadAnchor, timelineArgs, UNRESOLVE_MUTATION, withRequestTimes,
} from '../src/pr-github.js';
import { COMMENT_ROW_FIELDS, PR_ROW_FIELDS, REVIEW_ROW_FIELDS } from '../src/repos/github-repo-queries.js';

const LINK = 'https://github.com/acme/app/pull/7';
const HEAD = 'a'.repeat(40);
const AT = '2026-09-30T10:00:00Z';
const comment = (id: string, login: string | null) => ({ id, body: `text ${id}`, createdAt: AT, author: login === null ? null : { login } });
const threadNode = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'T1', path: 'src/a.ts', diffSide: 'RIGHT', line: 4, startLine: null, originalLine: 4, originalStartLine: null, isOutdated: false, isResolved: false,
  subjectType: 'LINE', comments: { totalCount: 1, nodes: [comment('C1', 'bia')] }, ...extra,
});

test('threadAnchor: one line, a range, the old side, a line gone from the diff, a file-level thread; no line at all throws (#592)', () => {
  assert.deepEqual(threadAnchor(threadNode()), { path: 'src/a.ts', side: 'new', start: 4, end: 4 });
  assert.deepEqual(threadAnchor(threadNode({ startLine: 2 })), { path: 'src/a.ts', side: 'new', start: 2, end: 4 });
  assert.deepEqual(threadAnchor(threadNode({ diffSide: 'LEFT', line: 3 })), { path: 'src/a.ts', side: 'old', start: 3, end: 3 });
  assert.deepEqual(threadAnchor(threadNode({ line: null, originalLine: 9, originalStartLine: 7 })), { path: 'src/a.ts', side: 'new', start: 7, end: 9 });
  assert.deepEqual(threadAnchor(threadNode({ subjectType: 'FILE', line: null, originalLine: null })), { path: 'src/a.ts', side: 'new', start: 0, end: 0 });
  assert.throws(() => threadAnchor(threadNode({ line: null, originalLine: null })), /no line/);
  const nodes = [threadNode({ line: null, originalLine: 9 }), threadNode({ id: 'T2', subjectType: 'FILE', line: null, originalLine: null })];
  const [gone, file] = parseThreads({ resource: { headRefOid: HEAD, reviewThreads: { totalCount: 2, nodes } } }).threads;
  assert.deepEqual([gone.outdated, file.outdated, file.subject], [true, false, 'file']);
});

test('prDiffArgs asks gh api for the PR as a diff, owner, repo and number off the link (#592)', () => {
  assert.deepEqual(prDiffArgs(LINK), ['api', 'repos/acme/app/pulls/7', '-H', 'Accept: application/vnd.github.diff']);
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
  const queries = [PR_THREADS_QUERY, PR_GUARD_QUERY, REVIEW_MUTATION, EDIT_MUTATION, COMMENT_MUTATION, REPLY_MUTATION, RESOLVE_MUTATION, UNRESOLVE_MUTATION, MERGE_MUTATION];
  for (const query of queries) {
    for (const value of ['PR_1', HEAD, 'why?', 'src/a.ts', 'evil', LINK]) assert.ok(!query.includes(value), `${value} in ${query.slice(0, 40)}`);
  }
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
