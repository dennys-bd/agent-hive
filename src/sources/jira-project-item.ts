import { STATUS } from '../field-values.js';
import type { SourceItemValue, StoredSourceItem } from '../read-model/source-items.js';
import type { ProjectItem, SourceItem } from '../types.js';
import { type JiraSourceConfig, taskOf } from './jira-listing.js';
import { NO_CATEGORIES } from './jira-relations.js';
import { isHidden } from './jira-tree.js';

type Stored = Pick<StoredSourceItem, 'item' | 'values'>;

// Each stored field by name, as the view shows it (#756): one value as itself, a number as a number, several joined; Status is the row's status
function fieldsOf(values: readonly SourceItemValue[]): Record<string, string | number> {
  const shown = values.filter((v) => v.field !== STATUS);
  return Object.fromEntries([...new Set(shown.map((v) => v.field))].map((name) => {
    const own = shown.filter((v) => v.field === name);
    return [name, own.length === 1 && own[0].kind === 'number' ? Number(own[0].value) : own.map((v) => v.value).join(', ')];
  }));
}

/** Why the Hive does not take the issue (#827), in listItems' order: the filter's rules, then a parent `epics: hide` takes off. The task
 * must carry its tree (withTree), or no parent has children. */
export const outOf = (task: SourceItem, isFiltered: boolean, source: Pick<JiraSourceConfig, 'epics'>): ProjectItem['out'] =>
  isFiltered ? 'filter' : isHidden(task, source) ? 'epic' : undefined;

/** A stored Jira issue as a project row (#826), its parent named by the parent's key: the field write's `row` now, and 6.2's view (#827). The id is the key; the itemId the adapter's own,
 * namespaced by source.ts as every row is. No pull requests and no blockers: the row shows none, so no blocker's category is read (#828). */
export function jiraProjectItem(stored: Stored, source: Pick<JiraSourceConfig, 'site' | 'taskProps' | 'blockingLinkTypes'>, out?: ProjectItem['out']): ProjectItem {
  const { item, column } = taskOf(stored, source, NO_CATEGORIES);
  const { labels, assignees } = item.facets ?? { labels: [], assignees: [] }; // taskOf always sets them
  return {
    itemId: item.itemId, id: item.id, title: item.title, body: item.body, url: item.url,
    ...(column === '' ? {} : { status: column }),
    ...(stored.item.parentKey === null ? {} : { parent: stored.item.parentKey }),
    labels, assignees,
    ...(item.workspaceHint === undefined ? {} : { workspaceHint: item.workspaceHint }),
    fields: fieldsOf(stored.values), pullRequests: [],
    ...(out === undefined ? {} : { out }),
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }), updatedAt: stored.item.updatedAt,
  };
}
