// A repository's PR list (#758): one state's first rows, newest update first, and the open, merged and closed counts in the same call. Pure;
// owner and name travel as variables and the state as one of this file's three enum literals, never a request's text.
import { canPushOf, countOf, decisionOf, isObject, mergeState, nodesOf, prStateOf, readable, rowChecks, SUITE_FIELDS } from './pr-checks.js';
import type { PrRow, PrState, RepoPrs } from './types.js';

/** Rows per list (#758). ponytail: no pagination past it; the list says so. */
export const PR_LIST_LIMIT = 100;
const STATE_ENUM: Record<PrState, string> = { open: 'OPEN', merged: 'MERGED', closed: 'CLOSED' };
const ROW_FIELDS = 'url number title state isDraft mergeStateStatus updatedAt reviewDecision '
  + `headCommit: commits(last: 1) { nodes { commit { ${SUITE_FIELDS} statusCheckRollup { state } } } }`;
const countField = (state: PrState): string => `${state}: pullRequests(states: [${STATE_ENUM[state]}]) { totalCount }`;

/** The list's query for one state (#758). */
export const prsQuery = (state: PrState): string => 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { viewerPermission '
  + `${countField('open')} ${countField('merged')} ${countField('closed')} `
  + `rows: pullRequests(first: ${PR_LIST_LIMIT}, states: [${STATE_ENUM[state]}], orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { ${ROW_FIELDS} } } } }`;

// One row; checks and decision only when GitHub has them
function rowOf(node: unknown): PrRow {
  const state = isObject(node) ? prStateOf(node.state) : undefined;
  if (!isObject(node) || state === undefined || typeof node.url !== 'string' || typeof node.number !== 'number' || typeof node.title !== 'string' || typeof node.updatedAt !== 'string') {
    throw new Error('unreadable PR row');
  }
  const checks = rowChecks(node.headCommit); // #854: awaiting when only a maintainer's approval is missing
  const decision = decisionOf(node.reviewDecision);
  return {
    url: node.url, number: node.number, title: node.title, state, isDraft: node.isDraft === true, mergeState: mergeState(node.mergeStateStatus), updatedAt: node.updatedAt,
    ...(checks === undefined ? {} : { checks }), ...(decision === undefined ? {} : { decision }),
  };
}

/** prsQuery's answer (#758): a row it cannot read is skipped and named; truncated when GitHub holds more than the rows it sent. */
export function parsePrRows(data: unknown, skip: (reason: string) => void = () => undefined): RepoPrs {
  const repository = isObject(data) ? data.repository : undefined;
  if (!isObject(repository)) throw new Error('repository not found');
  return {
    rows: readable(nodesOf(repository.rows), rowOf, skip),
    counts: { open: countOf(repository.open), merged: countOf(repository.merged), closed: countOf(repository.closed) },
    truncated: countOf(repository.rows) > nodesOf(repository.rows).length,
    canPush: canPushOf(repository.viewerPermission),
  };
}

const SEARCH_STATE: Record<PrState, string> = { open: 'is:open', merged: 'is:merged', closed: 'is:closed is:unmerged' };
const issueCountOf = (search: unknown): number => (isObject(search) && typeof search.issueCount === 'number' ? search.issueCount : 0);

/** An original's PR list (#854): only the PRs the user's fork opened, GitHub search per state, since GraphQL's pullRequests has no head-owner
 * filter. Every search text is a variable; the counts ask one node each, which nothing reads. */
export const SEARCH_PRS_QUERY = 'query($owner: String!, $name: String!, $open: String!, $merged: String!, $closed: String!, $rows: String!) { '
  + 'repository(owner: $owner, name: $name) { viewerPermission } '
  + 'open: search(query: $open, type: ISSUE, first: 1) { issueCount } merged: search(query: $merged, type: ISSUE, first: 1) { issueCount } '
  + 'closed: search(query: $closed, type: ISSUE, first: 1) { issueCount } '
  + `rows: search(query: $rows, type: ISSUE, first: ${PR_LIST_LIMIT}) { issueCount nodes { ... on PullRequest { ${ROW_FIELDS} } } } }`;

/** SEARCH_PRS_QUERY's variables (#854): the three counts' searches and the rows' one, newest update first. The author is the viewer: a fork's
 * owner may be an organization, or differ from the login, and search has no head-owner qualifier. */
export function searchVariables(repository: string, state: PrState): Record<string, string> {
  const [owner = '', name = ''] = repository.split('/');
  const q = (s: PrState): string => `repo:${repository} is:pr author:@me ${SEARCH_STATE[s]} sort:updated-desc`;
  return { owner, name, open: q('open'), merged: q('merged'), closed: q('closed'), rows: q(state) };
}

/** SEARCH_PRS_QUERY's answer (#854), as parsePrRows reads its own. */
export function parseSearchRows(data: unknown, skip: (reason: string) => void = () => undefined): RepoPrs {
  const answer = isObject(data) ? data : {};
  if (!isObject(answer.repository)) throw new Error('repository not found');
  return {
    rows: readable(nodesOf(answer.rows), rowOf, skip),
    counts: { open: issueCountOf(answer.open), merged: issueCountOf(answer.merged), closed: issueCountOf(answer.closed) },
    truncated: issueCountOf(answer.rows) > nodesOf(answer.rows).length,
    canPush: canPushOf(answer.repository.viewerPermission),
  };
}
