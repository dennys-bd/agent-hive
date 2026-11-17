import { STATUS } from '../field-values.js';
import type { JsonValue, SourceItems, SourceItemValue, StoredSourceItem } from '../read-model/source-items.js';
import { matchesRules } from '../task-filter.js';
import { matchTaskProps } from '../task-props.js';
import type { Item, ItemFacets, SourceConfig, SourceItem } from '../types.js';
import type { JiraIssue } from './jira-queries.js';
import { groupUnderParents, isHidden, treeLinks, withTree } from './jira-tree.js';

export type JiraSourceConfig = Extract<SourceConfig, { type: 'jira' }>;
/** What the mapping reads of a stored issue: its row and its values, as the store and jiraItemOf both answer them. */
type Stored = Pick<StoredSourceItem, 'item' | 'values'>;
type Listed = Pick<JiraSourceConfig, 'site' | 'taskProps'>;

const textOf = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '');
const textsOf = (value: JsonValue | undefined): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

// One entry per field in its stored order, a multi-valued one joined as the view shows it; Status is the column, never a facet
function fieldsOf(values: readonly SourceItemValue[]): Record<string, string> {
  const shown = values.filter((v) => v.field !== STATUS);
  const names = [...new Set(shown.map((v) => v.field))];
  return Object.fromEntries(names.map((name) => [name, shown.filter((v) => v.field === name).map((v) => v.value).join(', ')]));
}

/** What a task-properties rule reads of a stored issue (#820), as GitHub's itemReader: title, each label, the assignee's name, else the
 * stored values of the field with that name. */
export function issueReader({ item, values }: Stored): (field: string) => string[] {
  return (field) => {
    if (field === 'title') return [textOf(item.data.title)];
    if (field === 'labels') return textsOf(item.data.labels);
    if (field === 'assignee') return textsOf(item.data.assignees);
    return values.filter((v) => v.field === field).map((v) => v.value);
  };
}

/** A stored issue as the Hive's task, its status the column. As GitHub's issueItem: the hint only from a rule, auto and entry resolved whole
 * (never ??: a rule's null entry is a value). Its tree is jira-tree.ts's, read over the whole listing (#830). */
export function taskOf(stored: Stored, source: Listed): SourceItem {
  const { item: row, values } = stored;
  const facets: ItemFacets = { assignees: textsOf(row.data.assignees), labels: textsOf(row.data.labels), fields: fieldsOf(values) };
  const createdAt = textOf(row.data.createdAt);
  const item: Item = {
    itemId: row.nodeId, id: row.key, title: textOf(row.data.title), body: textOf(row.data.body),
    url: `https://${source.site}/browse/${row.key}`, facets, ...(createdAt === '' ? {} : { createdAt }),
  };
  const { workspace, auto, entry } = matchTaskProps(source.taskProps.rules, issueReader(stored));
  const { defaults } = source.taskProps;
  return {
    item: { ...item, ...(workspace === undefined ? {} : { workspaceHint: workspace }), autoOnEntry: auto ?? defaults.auto, entry: entry === undefined ? defaults.entry : entry },
    column: textOf(row.data.status),
  };
}

/** Whether listItems lists a task: its status a cited column and the source's filter passed, `@me` read as the stored name. */
export const isListed = (task: SourceItem, source: Pick<JiraSourceConfig, 'filter'>, columns: ReadonlySet<string>, me: string | undefined): boolean =>
  columns.has(task.column) && matchesRules(source.filter, task.item, me);

/** The project key a read issue answers, from its project field; undefined when Jira answered none. */
export function projectOf(issue: JiraIssue): string | undefined {
  const project = issue.fields.project;
  if (typeof project !== 'object' || project === null || Array.isArray(project)) return undefined;
  const { key } = project as Record<string, unknown>;
  return typeof key === 'string' ? key : undefined;
}

/** What a listing reads of the source: its mapping, its project, its tree toggles and its epics keys. */
export type ListedSource = Listed & Pick<JiraSourceConfig, 'project' | 'tree' | 'epics' | 'epicFollows' | 'switchAt'>;

/** The scope's listing in its stored order, each issue as its task with its tree (#830), kept when its status is a cited column and it is no
 * parent `epics: hide` takes off; children follow their parent. The links are read over every stored issue, before a status drops one. */
export function listedTasks(items: Pick<SourceItems, 'listing' | 'items'>, rows: string, source: ListedSource, columns: ReadonlySet<string>): SourceItem[] {
  const stored = items.items(rows, items.listing(rows, source.project));
  const links = treeLinks(stored, source.tree);
  const tasks = stored.map((s) => withTree(taskOf(s, source), links.get(s.item.nodeId), source)).filter((task) => columns.has(task.column));
  return groupUnderParents(tasks).filter((task) => !isHidden(task, source));
}
