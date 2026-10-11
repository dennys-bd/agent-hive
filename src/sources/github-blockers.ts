import type { BlockerRef, ItemBlockers } from '../types.js';
import type { GhBlockerRef, GhIssueRelations } from './github-queries.js';

// #56: the id the UI shows a related issue by: its number in the item's own repository, `owner/repo#n` in another. GitHub's casing of a name
// need not be the user's, so the repositories compare case-blind
const refId = (nameWithOwner: string, number: number, repo: string): string =>
  (nameWithOwner.toLowerCase() === repo.toLowerCase() ? String(number) : `${nameWithOwner}#${number}`);

const refsOf = (nodes: GhBlockerRef[] | undefined, repo: string): BlockerRef[] =>
  (nodes ?? []).map((n): BlockerRef => ({ id: refId(n.repository.nameWithOwner, n.number, repo), title: n.title, state: n.state === 'OPEN' ? 'open' : 'closed' }));

/** An issue's blocker relations as the UI shows them (#56), both directions. Sub-issues never: they gate a start, they are no relation.
 * `repo` is the item's own `owner/name`. */
export function blockersOf(issue: GhIssueRelations, repo: string): ItemBlockers {
  return { blockedBy: refsOf(issue.blockedBy?.nodes, repo), blocking: refsOf(issue.blocking?.nodes, repo) };
}
