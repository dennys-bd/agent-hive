// The PR page's GitHub side (#592, #758): the GraphQL documents and the parsing of their answers. Pure: every user value (link, node id,
// text, path, line, method, head) travels as a variable, never inside a query's text. No node module either: the UI reads mergeBlocker from here.
import { AWAITING_ROLLUP, canPushOf, countOf, decisionOf, isObject, mergeState, nodesOf, prChecksOf, prStateOf, readable } from './pr-checks.js';
import type { Gql, LineAnchor, MergeMethod, PrChecksRead, PrComment, PrData, PrDraft, PrIssueComment, PrMergeState, PrReviewEvent, PrReviewEventInput, PrReviewRequest, PrThread } from './types.js';

export { mergeState };

/** What the PR query reads, before the diff (#592): the route adds the link, the files and the conflicts. */
export type PrView = Omit<PrData, 'url' | 'files' | 'conflicts'>;

/** Threads per PR, comments per thread, reviews and timeline items (#592, #758): no pagination past it. */
export const PR_PAGE = 100;

const PR_FIELDS = 'id number title state isDraft mergeStateStatus headRefOid repository { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }';
// The page's own fields (#758): the description, the branches and counts, the review decision and the approvals, how far the base moved past
// the head, the head commit's checks, and the timeline's reviews and general comments
const PAGE_FIELDS = 'body author { login } createdAt updatedAt headRefName baseRefName commits { totalCount } additions deletions reviewDecision viewerCanUpdate '
  + 'headRepositoryOwner { login } baseRepository { owner { login } viewerPermission } '
  + `latestOpinionatedReviews(first: ${PR_PAGE}) { nodes { state } } baseRef { compare(headRef: $head) @include(if: $open) { behindBy } } ${AWAITING_ROLLUP} `
  + `timelineItems(last: ${PR_PAGE}, itemTypes: [PULL_REQUEST_REVIEW, ISSUE_COMMENT]) { nodes { __typename `
  + '... on PullRequestReview { id author { login } submittedAt state body } ... on IssueComment { id author { login } createdAt body } } }';
const THREAD_FIELDS = 'id path diffSide line startLine originalLine originalStartLine isOutdated isResolved subjectType '
  + `comments(first: ${PR_PAGE}) { totalCount nodes { id body createdAt author { login } } }`;
const REVIEWER = '__typename ... on User { login } ... on Team { slug } ... on Mannequin { login }';
// Who is asked to review (#67): the pending requests, and when each was made from the ReviewRequestedEvents, read under their own alias so
// the conversation's timeline keeps its two kinds
const REQUEST_FIELDS = `reviewRequests(first: ${PR_PAGE}) { nodes { requestedReviewer { ${REVIEWER} } } } `
  + `requested: timelineItems(last: ${PR_PAGE}, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ${REVIEWER} } } } }`;

/** Everything the page draws in one call (#592, #758); $head is the head branch's name, which PR_HEAD_QUERY reads first, and $open whether the
 * PR is open: a merged or closed PR may have lost its branch, so it is read without the compare (#849). ponytail: GitHub's errors win over its
 * data, so a compare GitHub refuses on an open PR still fails the whole read; a fork's branch answers null, which reads as no behindBy. */
export const PR_QUERY = `query($url: URI!, $head: String!, $open: Boolean!) { viewer { login } resource(url: $url) { ... on PullRequest { ${PR_FIELDS} ${PAGE_FIELDS} ${REQUEST_FIELDS} `
  + `reviewThreads(first: ${PR_PAGE}) { totalCount nodes { ${THREAD_FIELDS} } } } } }`;
/** The head alone (#592): its oid, read again after the diff, which carries none; its branch's name, what PR_QUERY compares the base to (#758);
 * and its state, since only an open PR is compared (#849). */
export const PR_HEAD_QUERY = 'query($url: URI!) { resource(url: $url) { ... on PullRequest { headRefOid headRefName state } } }';

/** A link GitHub answers no PR for (#592). */
export class PrNotFound extends Error {
  constructor() {
    super('PR não encontrado');
    this.name = 'PrNotFound';
  }
}

/** The `gh api` argv of a PR's diff (#592): owner, repo and number read off a link the route checked. */
export function prDiffArgs(url: string): string[] {
  const [, owner, repo, , number] = new URL(url).pathname.split('/');
  return ['api', `repos/${owner}/${repo}/pulls/${number}`, '-H', 'Accept: application/vnd.github.diff'];
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} is not a string`);
  return value;
}
const lineOf = (value: unknown): number | undefined => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined);
const isCut = (connection: unknown): boolean => isObject(connection) && typeof connection.totalCount === 'number' && connection.totalCount > nodesOf(connection).length;
// a deleted account answers a null author
const loginOf = (author: unknown): string => (isObject(author) && typeof author.login === 'string' ? author.login : 'ghost');
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Where a GitHub thread sits (#592): its path and side, startLine (else line) to line. A null line (outdated, or out of the diff) falls back
 * to the original lines. A file-level thread has no line: 0 to 0, which no diff line carries. startDiffSide is ignored: one side per anchor. */
export function threadAnchor(node: Record<string, unknown>): LineAnchor {
  const path = text(node.path, 'path');
  const side = node.diffSide === 'LEFT' ? 'old' : 'new';
  if (node.subjectType === 'FILE') return { path, side, start: 0, end: 0 };
  const current = lineOf(node.line);
  const end = current ?? lineOf(node.originalLine);
  if (end === undefined) throw new Error('no line');
  const start = (current === undefined ? lineOf(node.originalStartLine) : lineOf(node.startLine)) ?? end;
  return { path, side, start: Math.min(start, end), end };
}

function commentOf(node: unknown): PrComment {
  if (!isObject(node)) throw new Error('comment is not an object');
  return { id: text(node.id, 'comment id'), author: loginOf(node.author), at: text(node.createdAt, 'createdAt'), text: text(node.body, 'body') };
}

function threadOf(node: unknown): PrThread {
  if (!isObject(node)) throw new Error('thread is not an object');
  const isFile = node.subjectType === 'FILE';
  return {
    id: text(node.id, 'thread id'), anchor: threadAnchor(node), outdated: node.isOutdated === true || (!isFile && lineOf(node.line) === undefined),
    resolved: node.isResolved === true, subject: isFile ? 'file' : 'line', more: isCut(node.comments), comments: nodesOf(node.comments).map(commentOf),
  };
}

const METHOD_FLAGS: ReadonlyArray<[MergeMethod, string]> = [['merge', 'mergeCommitAllowed'], ['squash', 'squashMergeAllowed'], ['rebase', 'rebaseMergeAllowed']];
const methodsOf = (repository: unknown): MergeMethod[] =>
  METHOD_FLAGS.flatMap(([method, flag]) => (isObject(repository) && repository[flag] === true ? [method] : []));

const REVIEW_KINDS: Record<string, PrReviewEvent['kind']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' };

// A review on the timeline (#758); a pending (unsubmitted) or a dismissed one is no event the page shows
function reviewOf(node: Record<string, unknown>): PrReviewEvent {
  const kind = typeof node.state === 'string' && Object.hasOwn(REVIEW_KINDS, node.state) ? REVIEW_KINDS[node.state] : undefined;
  if (kind === undefined) throw new Error(`review in state ${String(node.state)}`);
  return { id: text(node.id, 'review id'), author: loginOf(node.author), at: text(node.submittedAt, 'submittedAt'), kind, text: text(node.body, 'review body') };
}

const issueCommentOf = (node: Record<string, unknown>): PrIssueComment =>
  ({ id: text(node.id, 'comment id'), author: loginOf(node.author), at: text(node.createdAt, 'createdAt'), text: text(node.body, 'comment body') });

type TimelineEntry = { review: PrReviewEvent } | { comment: PrIssueComment };

function entryOf(node: unknown): TimelineEntry {
  if (!isObject(node)) throw new Error('timeline item is not an object');
  if (node.__typename === 'PullRequestReview') return { review: reviewOf(node) };
  if (node.__typename === 'IssueComment') return { comment: issueCommentOf(node) };
  throw new Error(`timeline item ${String(node.__typename)}`);
}

/** The timeline's reviews and general comments (#758), each in GitHub's order; an item it cannot read is skipped and named, as a thread is. */
export function timelineOf(connection: unknown, skip: (reason: string) => void = () => undefined): { reviews: PrReviewEvent[]; comments: PrIssueComment[] } {
  const entries = readable(nodesOf(connection), entryOf, skip);
  return { reviews: entries.flatMap((e) => ('review' in e ? [e.review] : [])), comments: entries.flatMap((e) => ('comment' in e ? [e.comment] : [])) };
}

// How many commits the base moved past the head (#758); none when GitHub cannot compare them (a fork's branch is no ref of the base repository) or did not, on a PR that is not open (#849)
function behindOf(baseRef: unknown): number | undefined {
  const compare = isObject(baseRef) ? baseRef.compare : undefined;
  return isObject(compare) && typeof compare.behindBy === 'number' ? compare.behindBy : undefined;
}
const approvalsOf = (connection: unknown): number => nodesOf(connection).filter((node) => isObject(node) && node.state === 'APPROVED').length;

const ownerLogin = (owner: unknown): string => (isObject(owner) && typeof owner.login === 'string' ? owner.login : '');

// Whose head and base these are, and whether the login may push to the base (#854); '' and false when GitHub answers none
function originOf(pr: Record<string, unknown>): Pick<PrData, 'headOwner' | 'baseOwner' | 'canPush'> {
  const base = isObject(pr.baseRepository) ? pr.baseRepository : {};
  return { headOwner: ownerLogin(pr.headRepositoryOwner), baseOwner: ownerLogin(base.owner), canPush: canPushOf(base.viewerPermission) };
}

type Reviewer = Pick<PrReviewRequest, 'reviewer' | 'team'>;

// Who a request or a ReviewRequestedEvent names (#67): a team by its slug, a user or a mannequin by its login; none for a deleted account, a
// bot (not selected) or a name that is no non-empty string
function reviewerOf(node: unknown): Reviewer | undefined {
  const who = isObject(node) ? node.requestedReviewer : undefined;
  if (!isObject(who)) return undefined;
  const team = who.__typename === 'Team';
  const name = team ? who.slug : who.login;
  return typeof name === 'string' && name !== '' ? { reviewer: name, team } : undefined;
}

const sameReviewer = (a: Reviewer, b: Reviewer): boolean => a.reviewer === b.reviewer && a.team === b.team;

// The pending review requests (#67), in GitHub's order. viewer: a user request naming the viewer's login (ponytail: GitHub does not say whether
// the viewer is in a requested team, so a team request is never the viewer's); at: the latest event for that reviewer among the last PR_PAGE
function reviewRequestsOf(pr: Record<string, unknown>, viewer: string): PrReviewRequest[] {
  const events = nodesOf(pr.requested).flatMap((node) => {
    const who = reviewerOf(node);
    return who !== undefined && isObject(node) && typeof node.createdAt === 'string' ? [{ ...who, at: node.createdAt }] : [];
  });
  return nodesOf(pr.reviewRequests).flatMap((node) => {
    const who = reviewerOf(node);
    if (who === undefined) return [];
    const at = events.filter((e) => sameReviewer(e, who)).at(-1)?.at; // the timeline reads oldest first
    return [{ ...who, viewer: !who.team && who.reviewer === viewer, ...(at === undefined ? {} : { at }) }];
  });
}

type PageFields = Omit<PrView, 'id' | 'number' | 'title' | 'state' | 'isDraft' | 'mergeState' | 'head' | 'methods' | 'viewer' | 'reviewRequests' | 'threads' | 'truncated'>;

// The page's fields (#758); the optional ones only when GitHub answered them
function pageOf(pr: Record<string, unknown>, skip: (reason: string) => void): PageFields {
  const decision = decisionOf(pr.reviewDecision);
  const checks = prChecksOf(pr.headCommit, skip);
  const behindBy = behindOf(pr.baseRef);
  return {
    body: text(pr.body, 'body'), author: loginOf(pr.author), createdAt: text(pr.createdAt, 'createdAt'), updatedAt: text(pr.updatedAt, 'updatedAt'),
    headRef: text(pr.headRefName, 'headRefName'), baseRef: text(pr.baseRefName, 'baseRefName'), commits: countOf(pr.commits),
    additions: numberOf(pr.additions), deletions: numberOf(pr.deletions), approvals: approvalsOf(pr.latestOpinionatedReviews), canEdit: pr.viewerCanUpdate === true,
    ...originOf(pr), ...timelineOf(pr.timelineItems, skip),
    ...(decision === undefined ? {} : { decision }), ...(checks === undefined ? {} : { checks }), ...(behindBy === undefined ? {} : { behindBy }),
  };
}

/** The PR query's answer (#592, #758): the PR's own fields checked, a null resource PrNotFound, anything that is no PR an error. */
export function parsePrData(data: unknown, skip: (reason: string) => void = () => undefined): PrView {
  const answer = isObject(data) ? data : {};
  const pr = answer.resource;
  if (!isObject(pr)) throw new PrNotFound();
  const state = prStateOf(pr.state);
  if (state === undefined || typeof pr.number !== 'number') throw new Error('not a pull request answer');
  const viewer = isObject(answer.viewer) && typeof answer.viewer.login === 'string' ? answer.viewer.login : '';
  return {
    id: text(pr.id, 'id'), number: pr.number, title: text(pr.title, 'title'), state, isDraft: pr.isDraft === true, mergeState: mergeState(pr.mergeStateStatus),
    head: text(pr.headRefOid, 'headRefOid'), methods: methodsOf(pr.repository), viewer, reviewRequests: reviewRequestsOf(pr, viewer),
    threads: readable(nodesOf(pr.reviewThreads), threadOf, skip), truncated: isCut(pr.reviewThreads), ...pageOf(pr, skip),
  };
}

/** PR_HEAD_QUERY's answer (#592, #758, #849): the head's oid, its branch's name, and whether the PR is open. */
export function parseHead(data: unknown): { oid: string; ref: string; open: boolean } {
  const pr = isObject(data) ? data.resource : undefined;
  if (!isObject(pr)) throw new PrNotFound();
  return { oid: text(pr.headRefOid, 'headRefOid'), ref: text(pr.headRefName, 'headRefName'), open: pr.state === 'OPEN' };
}

/** The PR as PR_QUERY reads it (#592, #758): its head branch's name first, which the query compares the base to while the PR is open (#849). */
export async function readView(gql: Gql, url: string, skip?: (reason: string) => void): Promise<PrView> {
  const { ref, open } = parseHead(await gql(PR_HEAD_QUERY, { url }));
  return parsePrData(await gql(PR_QUERY, { url, head: ref, open }), skip);
}

/** The checks' poll (#758): the head commit's checks, the merge state and when the PR last changed; no diff, no threads, no timeline. */
export const PR_CHECKS_QUERY = `query($url: URI!) { resource(url: $url) { ... on PullRequest { mergeStateStatus updatedAt ${AWAITING_ROLLUP} } } }`;

/** PR_CHECKS_QUERY's answer (#758): a null resource PrNotFound. */
export function parsePrChecks(data: unknown, skip: (reason: string) => void = () => undefined): PrChecksRead {
  const pr = isObject(data) ? data.resource : undefined;
  if (!isObject(pr)) throw new PrNotFound();
  const checks = prChecksOf(pr.headCommit, skip);
  return { mergeState: mergeState(pr.mergeStateStatus), updatedAt: text(pr.updatedAt, 'updatedAt'), ...(checks === undefined ? {} : { checks }) };
}

/** Why mergear is off (#592), the tooltip's reason: GitHub's own verdict, never re-derived. */
export type MergeBlocker = 'merged' | 'closed' | 'draft' | 'conflicts' | 'blocked' | 'behind' | 'unknown';
const isMergeable = (state: PrMergeState): state is 'clean' | 'hooks' | 'unstable' => state === 'clean' || state === 'hooks' || state === 'unstable';

/** undefined when GitHub lets it merge: an open PR, not a draft, clean, with hooks or unstable (#592). */
export function mergeBlocker(view: Pick<PrData, 'state' | 'isDraft' | 'mergeState'>): MergeBlocker | undefined {
  if (view.state !== 'open') return view.state;
  if (view.isDraft) return 'draft';
  const { mergeState: status } = view;
  return isMergeable(status) ? undefined : status;
}

/** Every method, in the order a repository's first allowed one is picked when none is remembered (#592). */
export const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];
export const isMergeMethod = (value: unknown): value is MergeMethod => MERGE_METHODS.includes(value as MergeMethod);

/** One review of the user's (#592, #758): a comment, an approval or a change request, its summary and every draft as a thread. */
export const REVIEW_MUTATION = 'mutation($pr: ID!, $head: GitObjectID!, $event: PullRequestReviewEvent!, $body: String, $threads: [DraftPullRequestReviewThread]) '
  + '{ addPullRequestReview(input: { pullRequestId: $pr, commitOID: $head, body: $body, event: $event, threads: $threads }) { pullRequestReview { id } } }';
/** The page's title and description (#758): a variable left out leaves its field as it is. */
export const EDIT_MUTATION = 'mutation($pr: ID!, $title: String, $body: String) '
  + '{ updatePullRequest(input: { pullRequestId: $pr, title: $title, body: $body }) { pullRequest { id } } }';
/** A general comment on the PR (#758), issue-style. */
export const COMMENT_MUTATION = 'mutation($pr: ID!, $body: String!) { addComment(input: { subjectId: $pr, body: $body }) { clientMutationId } }';
export const REPLY_MUTATION = 'mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }';
export const RESOLVE_MUTATION = 'mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id } } }';
export const UNRESOLVE_MUTATION = 'mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id } } }';
export const MERGE_MUTATION = 'mutation($pr: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) '
  + '{ mergePullRequest(input: { pullRequestId: $pr, mergeMethod: $method, expectedHeadOid: $head }) { pullRequest { state } } }';

const SIDE = { old: 'LEFT', new: 'RIGHT' } as const;

// A draft as addPullRequestReview's thread input: its text as body, its side as LEFT / RIGHT, a range's start only when it has one
function draftThread({ anchor, text: body }: Pick<PrDraft, 'anchor' | 'text'>): Record<string, unknown> {
  const side = SIDE[anchor.side];
  return { path: anchor.path, line: anchor.end, side, body, ...(anchor.start < anchor.end ? { startLine: anchor.start, startSide: side } : {}) };
}

const REVIEW_EVENTS: Record<PrReviewEventInput, string> = { comment: 'COMMENT', approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' };

/** What the review popover may send (#758). */
export const isReviewEvent = (value: unknown): value is PrReviewEventInput => typeof value === 'string' && Object.hasOwn(REVIEW_EVENTS, value);

/** REVIEW_MUTATION's variables (#592, #758): the head the page showed, the event as GitHub names it, the summary when there is one, and every
 * draft as a thread. */
export function reviewVariables(prId: string, head: string, event: PrReviewEventInput, body: string, drafts: Pick<PrDraft, 'anchor' | 'text'>[]): Record<string, unknown> {
  return { pr: prId, head, event: REVIEW_EVENTS[event], threads: drafts.map(draftThread), ...(body === '' ? {} : { body }) };
}

/** MERGE_MUTATION's variables (#592): GitHub's method upper-cased, and the head the page showed as expectedHeadOid. */
export const mergeVariables = (prId: string, head: string, method: MergeMethod): Record<string, unknown> => ({ pr: prId, head, method: method.toUpperCase() });
