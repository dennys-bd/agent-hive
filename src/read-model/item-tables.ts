import type { DatabaseSync } from 'node:sqlite';
import type { ReadModel } from './db.js';
import type { IssueDetails, StoredItemRows } from './rows.js';
import type { SourceItems } from './source-items.js';
import { groupBy, issueOf, nullable, prOf, type Row, stamp, text, WRITE_WINDOW_MS, written } from './sql.js';

// A Project item's GitHub side (#190, #282, #833): the issue's own columns only the Project read says, and the join of the store's items with
// their issues rows, details and closing PRs. The items themselves live in source-items.ts.
type ItemTables = Pick<ReadModel, 'setIssueDetails' | 'githubItemRows'>;

const IN_IDS = 'IN (SELECT value FROM json_each(?))';
// The issue's own columns only the Project read says (#282), under the replace rule's terms: at this read's updated_at, and never a write's inside
// its window. A REST row stored first at the same updated_at takes them, which "only when the issue row wrote" would leave stale for good
const DETAILS = `UPDATE issues SET url = $url, milestone = $milestone, issue_type = $issueType, parent_number = $parentNumber, parent_title = $parentTitle,
  sub_issues_total = $subIssuesTotal, sub_issues_completed = $subIssuesCompleted,
  written_at = CASE WHEN $writtenAt IS NOT NULL THEN $writtenAt ELSE written_at END
  WHERE source = $source AND node_id = $nodeId AND updated_at = $updatedAt
    AND ($writtenAt IS NOT NULL OR written_at IS NULL OR $now - written_at >= ${WRITE_WINDOW_MS})`;
export const count = (row: Row, key: string): number | null => (row[key] === null ? null : Number(row[key]));

// Written only by a Project read (#282): an issue the REST sync stored and no Project read reached yet has none
const detailsOf = (row: Row): IssueDetails | undefined => (row.url === null ? undefined : {
  url: text(row, 'url'), milestone: nullable(row, 'milestone'), issueType: nullable(row, 'issue_type'), parentNumber: count(row, 'parent_number'),
  parentTitle: nullable(row, 'parent_title'), subIssuesTotal: count(row, 'sub_issues_total'), subIssuesCompleted: count(row, 'sub_issues_completed'),
});

// Three queries for any number of items: the store's, then the issues rows and their closing PRs by content_id
function githubRowsReader(db: DatabaseSync, items: SourceItems): ReadModel['githubItemRows'] {
  const issues = db.prepare(`SELECT * FROM issues WHERE source = ? AND node_id ${IN_IDS}`);
  const prs = db.prepare(`SELECT * FROM issue_pull_requests WHERE source = ? AND issue_node_id ${IN_IDS} ORDER BY number`);
  return (source, nodeIds) => {
    const stored = items.items(source, nodeIds);
    const issueIds = JSON.stringify(stored.flatMap((s) => s.item.contentId ?? []));
    const issueRows = new Map(issues.all(source, issueIds).map((row): [string, Row] => [text(row, 'node_id'), row]));
    const prsBy = groupBy(prs.all(source, issueIds), 'issue_node_id', prOf);
    return stored.map((s): StoredItemRows => {
      const issueId = s.item.contentId ?? '';
      const issue = issueRows.get(issueId);
      const details = issue === undefined ? undefined : detailsOf(issue);
      return { ...s, ...(issue === undefined ? {} : { issue: issueOf(issue) }), ...(details === undefined ? {} : { details }), pullRequests: prsBy.get(issueId) ?? [] };
    });
  };
}

export function itemTablesOf(db: DatabaseSync, now: () => number, items: SourceItems): ItemTables {
  const details = db.prepare(DETAILS);
  return {
    setIssueDetails: (source, nodeId, updatedAt, value, origin) => written(details.run({ source, nodeId, updatedAt, ...value, ...stamp(now(), origin) })),
    githubItemRows: githubRowsReader(db, items),
  };
}
