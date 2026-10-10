// A PR's head-commit checks, its review decision and its state as GitHub answers them (#758), shared by the PR page's read, its checks' poll
// and the repository's PR list; and the reading helpers those parsers share. Pure, no node module: the UI may import it.
import type { PrCheck, PrChecks, PrMergeState, PrReviewDecision, PrRow, PrState } from './types.js';

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const nodesOf = (connection: unknown): unknown[] => (isObject(connection) && Array.isArray(connection.nodes) ? (connection.nodes as unknown[]) : []);
export const countOf = (connection: unknown): number => (isObject(connection) && typeof connection.totalCount === 'number' ? connection.totalCount : 0);

/** Each node read alone (#592, #758): one GitHub answers in a shape this code cannot read is skipped and named, never failing the whole. */
export function readable<T>(nodes: unknown[], read: (node: unknown) => T, skip: (reason: string) => void): T[] {
  return nodes.flatMap((node) => {
    try {
      return [read(node)];
    } catch (err) {
      skip(err instanceof Error ? err.message : String(err));
      return [];
    }
  });
}

/** The head commit's checks as the page and its poll ask them (#758), with what another reader adds (#834: the wait for CI adds the head's
 * `oid ` before the rollup and ` checkSuite { workflowRun { databaseId } }` to each check run). ponytail: the first 100 contexts, no
 * pagination past them. */
export const rollupFields = (commit = '', checkRun = ''): string =>
  `headCommit: commits(last: 1) { nodes { commit { ${commit}statusCheckRollup { state contexts(first: 100) { nodes { __typename `
  + `... on CheckRun { name status conclusion detailsUrl completedAt${checkRun} } ... on StatusContext { context state targetUrl createdAt } } } } } } }`;
export const ROLLUP_FIELDS = rollupFields();

const SUCCESS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILURE = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/** A conclusion, a status context's state or the rollup's (#758), in GitHub's own buckets; anything else, a new value included, pending. */
export function checkState(raw: unknown): PrCheck['state'] {
  if (typeof raw !== 'string') return 'pending';
  if (SUCCESS.has(raw)) return 'success';
  return FAILURE.has(raw) ? 'failure' : 'pending';
}

const filled = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

// url and at only when GitHub gave them
function withLinks(check: Pick<PrCheck, 'name' | 'state'>, url: unknown, at: unknown): PrCheck {
  const [link, time] = [filled(url), filled(at)];
  return { ...check, ...(link === undefined ? {} : { url: link }), ...(time === undefined ? {} : { at: time }) };
}

// A check run not completed yet is pending whatever its conclusion says; ci-checks.ts reads the wait's checks with it (#834)
export function checkOf(node: unknown): PrCheck {
  if (!isObject(node)) throw new Error('check is not an object');
  if (node.__typename === 'CheckRun' && typeof node.name === 'string') {
    return withLinks({ name: node.name, state: node.status === 'COMPLETED' ? checkState(node.conclusion) : 'pending' }, node.detailsUrl, node.completedAt);
  }
  if (node.__typename === 'StatusContext' && typeof node.context === 'string') {
    return withLinks({ name: node.context, state: checkState(node.state) }, node.targetUrl, node.createdAt);
  }
  throw new Error(`unreadable check (${String(node.__typename)})`);
}

/** The rollup of a PR's `headCommit: commits(last: 1)` (#758), undefined without one. */
export function headRollup(headCommit: unknown): Record<string, unknown> | undefined {
  const [node] = nodesOf(headCommit);
  const rollup = isObject(node) && isObject(node.commit) ? node.commit.statusCheckRollup : undefined;
  return isObject(rollup) ? rollup : undefined;
}

/** The head commit's checks (#758): each one it can read and the latest completion; undefined without a rollup or a check. */
export function checksOf(rollup: Record<string, unknown> | undefined, skip: (reason: string) => void = () => undefined): PrChecks | undefined {
  if (rollup === undefined) return undefined;
  const items = readable(nodesOf(rollup.contexts), checkOf, skip);
  if (items.length === 0) return undefined;
  const at = items.flatMap((c) => (c.at === undefined ? [] : [c.at])).sort().at(-1); // ISO strings in GitHub's one format sort as the instants
  return { state: checkState(rollup.state), items, ...(at === undefined ? {} : { at }) };
}

const DECISIONS: Record<string, PrReviewDecision> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'pending' };
/** GitHub's reviewDecision (#758); null (no review required) or anything new reads as none. */
export const decisionOf = (raw: unknown): PrReviewDecision | undefined => (typeof raw === 'string' && Object.hasOwn(DECISIONS, raw) ? DECISIONS[raw] : undefined);

const STATES: Record<string, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
/** GitHub's PullRequestState, lowercased (#592, #758); anything else none. */
export const prStateOf = (raw: unknown): PrState | undefined => (typeof raw === 'string' && Object.hasOwn(STATES, raw) ? STATES[raw] : undefined);

const MERGE_STATES: Record<string, PrMergeState> = {
  CLEAN: 'clean', UNSTABLE: 'unstable', HAS_HOOKS: 'hooks', DIRTY: 'conflicts', BLOCKED: 'blocked', BEHIND: 'behind', DRAFT: 'draft',
};

/** GitHub's mergeStateStatus, lowercased and shortened (#592); anything else, a new status included, reads unknown. */
export const mergeState = (raw: unknown): PrMergeState => (typeof raw === 'string' && Object.hasOwn(MERGE_STATES, raw) ? MERGE_STATES[raw] : 'unknown');

/** Push rights on a repository (#854): GitHub's viewerPermission ADMIN, MAINTAIN or WRITE; anything else, none included, is read only. */
export const canPushOf = (permission: unknown): boolean => permission === 'ADMIN' || permission === 'MAINTAIN' || permission === 'WRITE';

/** The head commit's check suites (#854): an Actions workflow a maintainer must approve has a suite but no check run. */
export const SUITE_FIELDS = 'checkSuites(first: 50) { nodes { conclusion app { slug } workflowRun { workflow { name } } } }';
/** #758's rollup with the suites beside it (#854): what the PR page, its poll and the CI read ask. */
export const AWAITING_ROLLUP = rollupFields(`${SUITE_FIELDS} `);
const ACTIONS_APP = 'github-actions';

/** The workflows awaiting a maintainer's approval on the head commit (#854): its github-actions suites concluded ACTION_REQUIRED, once each. */
export function awaitingOf(headCommit: unknown): string[] {
  const [node] = nodesOf(headCommit);
  const commit = isObject(node) && isObject(node.commit) ? node.commit : undefined;
  const names = nodesOf(commit?.checkSuites).flatMap((suite) => {
    if (!isObject(suite) || suite.conclusion !== 'ACTION_REQUIRED' || !isObject(suite.app) || suite.app.slug !== ACTIONS_APP) return [];
    const workflow = isObject(suite.workflowRun) && isObject(suite.workflowRun.workflow) ? suite.workflowRun.workflow.name : undefined;
    return [typeof workflow === 'string' ? workflow : ACTIONS_APP];
  });
  return [...new Set(names)];
}

/** The PR's checks with the workflows awaiting approval (#854): those alone still make a box, pending, with no item. */
export function prChecksOf(headCommit: unknown, skip: (reason: string) => void = () => undefined): PrChecks | undefined {
  const checks = checksOf(headRollup(headCommit), skip);
  const awaiting = awaitingOf(headCommit);
  return awaiting.length === 0 ? checks : { ...(checks ?? { state: 'pending', items: [] }), awaiting };
}

/** A list row's checks (#758, #854): the rollup's state; with no rollup, awaiting when a workflow waits for approval. */
export function rowChecks(headCommit: unknown): PrRow['checks'] {
  const rollup = headRollup(headCommit);
  if (rollup !== undefined) return checkState(rollup.state);
  return awaitingOf(headCommit).length > 0 ? 'awaiting' : undefined;
}
