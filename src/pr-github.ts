// The PR page's GitHub side (#592, #758, #187): the threads, the writes' guard and mutations, and the timeline's request times. Pure: every user
// value (link, node id, text, path, line, method, head) travels as a variable, never inside a query's text. No node module either: the UI reads
// mergeBlocker from here.
import { canPushOf, isObject, mergeState, nodesOf, prStateOf, readable } from './pr-checks.js';
import { COMMENT_ROW_FIELDS, PR_ROW_FIELDS, REVIEW_ROW_FIELDS } from './repos/github-repo-queries.js';
import type { LineAnchor, MergeMethod, PrClosingIssue, PrComment, PrData, PrDraft, PrMergeState, PrReviewEventInput, PrReviewRequest, PrThread } from './types.js';

export { mergeState };

/** Threads per PR, comments per thread, reviews and timeline items (#592, #758): no pagination past it. */
export const PR_PAGE = 100;

const CLOSES_PAGE = 10; // #66: enough for one PR; more are cut silently
/** The issues a PR closes on merge (#66), as the read model's batch (#187) asks them. */
export const CLOSES_FIELDS = `closingIssuesReferences(first: ${CLOSES_PAGE}) { nodes { number url repository { nameWithOwner } } }`;
const THREAD_FIELDS = 'id path diffSide line startLine originalLine originalStartLine isOutdated isResolved subjectType '
  + `comments(first: ${PR_PAGE}) { totalCount nodes { id body createdAt author { login } } }`;
/** The threads alone (#187): what the read model does not hold, with the head they were read at, for the page's head guard. */
export const PR_THREADS_QUERY = `query($url: URI!) { resource(url: $url) { ... on PullRequest { headRefOid reviewThreads(first: ${PR_PAGE}) { totalCount nodes { ${THREAD_FIELDS} } } } } }`;

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

/** What a write checks before it goes out (#187): GitHub's current answer for the guards (open, head, own PR, push rights, methods). */
export type PrGuard = Pick<PrData, 'id' | 'state' | 'head' | 'updatedAt' | 'author' | 'viewer' | 'canPush' | 'methods'>;
export const PR_GUARD_QUERY = 'query($url: URI!) { viewer { login } resource(url: $url) { ... on PullRequest { id state headRefOid updatedAt author { login } '
  + 'baseRepository { viewerPermission } repository { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed } } } }';

/** PR_GUARD_QUERY's answer (#187): a null resource is PrNotFound, anything that is no PR an error. */
export function parseGuard(data: unknown): PrGuard {
  const answer = isObject(data) ? data : {};
  const pr = answer.resource;
  if (!isObject(pr)) throw new PrNotFound();
  const state = prStateOf(pr.state);
  if (state === undefined) throw new Error('not a pull request answer');
  const base = isObject(pr.baseRepository) ? pr.baseRepository : {};
  return {
    id: text(pr.id, 'id'), state, head: text(pr.headRefOid, 'headRefOid'), updatedAt: text(pr.updatedAt, 'updatedAt'), author: loginOf(pr.author),
    viewer: isObject(answer.viewer) && typeof answer.viewer.login === 'string' ? answer.viewer.login : '', canPush: canPushOf(base.viewerPermission), methods: methodsOf(pr.repository),
  };
}

/** PR_THREADS_QUERY's answer (#187): the head, each thread it can read, and whether GitHub holds more than PR_PAGE. */
export function parseThreads(data: unknown, skip: (reason: string) => void = () => undefined): { head: string; threads: PrThread[]; truncated: boolean } {
  const pr = isObject(data) ? data.resource : undefined;
  if (!isObject(pr)) throw new PrNotFound();
  return { head: text(pr.headRefOid, 'headRefOid'), threads: readable(nodesOf(pr.reviewThreads), threadOf, skip), truncated: isCut(pr.reviewThreads) };
}

// One compact JSON line per review_requested event: when, and the user or the team it named
const TIMELINE_FILTER = '.[] | select(.event == "review_requested") | {at: .created_at, user: .requested_reviewer.login, team: .requested_team.slug} | tojson';

/** The `gh api` argv of a PR's review_requested events (#67, #187), every page: their times exist only on the timeline. */
export const timelineArgs = (repository: string, number: number): string[] =>
  ['api', `repos/${repository}/issues/${number}/timeline?per_page=100`, '--paginate', '--jq', TIMELINE_FILTER];

type RequestTime = Pick<PrReviewRequest, 'reviewer' | 'team'> & { at: string };

// One line gh printed, or none when it is not a request this code can read
function requestTimeOf(line: string): RequestTime | undefined {
  try {
    const event: unknown = JSON.parse(line);
    if (!isObject(event) || typeof event.at !== 'string') return undefined;
    if (typeof event.team === 'string' && event.team !== '') return { reviewer: event.team, team: true, at: event.at };
    return typeof event.user === 'string' && event.user !== '' ? { reviewer: event.user, team: false, at: event.at } : undefined;
  } catch {
    return undefined;
  }
}

/** timelineArgs' output as request times (#187), oldest first as the timeline reads; a line it cannot read is dropped. */
export const requestTimesOf = (output: string): RequestTime[] => output.split('\n').flatMap((line) => requestTimeOf(line) ?? []);

/** Each pending request with the latest time the timeline has for that reviewer (#67, #187); none when it has none. */
export function withRequestTimes(requests: PrReviewRequest[], times: RequestTime[]): PrReviewRequest[] {
  return requests.map((request) => {
    const at = times.filter((t) => t.reviewer === request.reviewer && t.team === request.team).at(-1)?.at;
    return at === undefined ? request : { ...request, at };
  });
}

// The issues the PR closes on merge (#66): a node with no number, url or repository name is no issue the block can open, so it is dropped
export function closesOf(connection: unknown): PrClosingIssue[] {
  return nodesOf(connection).flatMap((node) => {
    if (!isObject(node) || typeof node.number !== 'number' || typeof node.url !== 'string') return [];
    const name = isObject(node.repository) ? node.repository.nameWithOwner : undefined;
    return typeof name === 'string' ? [{ repository: name, number: node.number, url: node.url }] : [];
  });
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
  + `{ addPullRequestReview(input: { pullRequestId: $pr, commitOID: $head, body: $body, event: $event, threads: $threads }) { pullRequestReview { ${REVIEW_ROW_FIELDS} pullRequest { ${PR_ROW_FIELDS} } } } }`;
/** The page's title and description (#758): a variable left out leaves its field as it is. */
export const EDIT_MUTATION = 'mutation($pr: ID!, $title: String, $body: String) '
  + `{ updatePullRequest(input: { pullRequestId: $pr, title: $title, body: $body }) { pullRequest { ${PR_ROW_FIELDS} } } }`;
/** A general comment on the PR (#758), issue-style. */
export const COMMENT_MUTATION = 'mutation($pr: ID!, $body: String!) '
  + `{ addComment(input: { subjectId: $pr, body: $body }) { commentEdge { node { ${COMMENT_ROW_FIELDS} } } subject { ... on PullRequest { ${PR_ROW_FIELDS} } } } }`;
export const REPLY_MUTATION = 'mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }';
export const RESOLVE_MUTATION = 'mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id } } }';
export const UNRESOLVE_MUTATION = 'mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id } } }';
export const MERGE_MUTATION = 'mutation($pr: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) '
  + `{ mergePullRequest(input: { pullRequestId: $pr, mergeMethod: $method, expectedHeadOid: $head }) { pullRequest { ${PR_ROW_FIELDS} } } }`;

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
