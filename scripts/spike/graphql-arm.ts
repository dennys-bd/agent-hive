import { setTimeout as sleep } from 'node:timers/promises';
import { COMMENT_ROW_FIELDS, ISSUE_ROW_FIELDS, REPO_ISSUE_PAGE_SIZE } from '../../src/repos/github-repo-queries.js';
import { ownerName, repositoryOf } from '../../src/repos/github-repos.js';
import type { GqlJson } from '../../src/sources/github-gql.js';

const COMMENTS_PER_ISSUE = 20; // `comments(last: N)`: what the GraphQL-only sync would read of each changed issue

/** The GraphQL-only arm's read (#765): the issues updated since the cursor, each with its latest comments. `recent` because the row's fields
 * already ask comments' totalCount, and one field name cannot take two argument sets. No ETag: every round costs points. */
export const SINCE_SYNC = `query($owner: String!, $name: String!, $since: DateTime, $after: String) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $name) {
    issues(first: ${REPO_ISSUE_PAGE_SIZE}, after: $after, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_ROW_FIELDS} recent: comments(last: ${COMMENTS_PER_ISSUE}) { nodes { ${COMMENT_ROW_FIELDS} } } }
    }
  }
}`;

export interface GqlTally { requests: number; points: number; remainingFirst?: number; remainingLast?: number }

interface SinceIssues { issues: { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: { updatedAt: string }[] } }

// One repository's read since its cursor, page after page: the cursor it ends on, and the tally with its cost added
async function syncSince(gql: GqlJson, repository: string, since: string | undefined, tally: GqlTally): Promise<{ last?: string; tally: GqlTally }> {
  let after: string | null = null;
  let last = since;
  let spent = tally;
  do {
    const data = await gql(SINCE_SYNC, { ...ownerName(repository), since: since ?? null, after });
    const rate = (data as { rateLimit?: { cost: number; remaining: number } | null } | null)?.rateLimit;
    const { issues } = repositoryOf<SinceIssues>(data, repository);
    spent = {
      requests: spent.requests + 1, points: spent.points + (rate?.cost ?? 0),
      remainingFirst: spent.remainingFirst ?? rate?.remaining, remainingLast: rate?.remaining ?? spent.remainingLast,
    };
    last = issues.nodes.at(-1)?.updatedAt ?? last;
    after = issues.pageInfo.hasNextPage ? (issues.pageInfo.endCursor ?? null) : null;
  } while (after !== null);
  return { last, tally: spent };
}

/** The same window as the hybrid arm, on GraphQL only (#765): `rounds` rounds `intervalMs` apart over `repositories`. */
export async function graphqlArm(gql: GqlJson, repositories: string[], rounds: number, intervalMs: number): Promise<{ fill: GqlTally; total: GqlTally; errors: number }> {
  let cursors = new Map<string, string>();
  let tally: GqlTally = { requests: 0, points: 0 };
  let fill: GqlTally | undefined;
  let errors = 0;
  for (let round = 0; round < rounds; round++) {
    const started = Date.now();
    for (const repository of repositories) {
      try {
        const read = await syncSince(gql, repository, cursors.get(repository), tally);
        tally = read.tally;
        if (read.last !== undefined) cursors = new Map(cursors).set(repository, read.last);
      } catch {
        errors += 1;
      }
    }
    fill ??= tally;
    await sleep(Math.max(0, intervalMs - (Date.now() - started)));
  }
  return { fill: fill ?? tally, total: tally, errors };
}
