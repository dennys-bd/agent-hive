import { STATUS } from '../field-values.js';
import type { SourceField, SourceItems, StoredSourceItem } from '../read-model/source-items.js';
import type { ProjectBuiltins, ProjectField, ProjectItem, ProjectView, ReadOptions, SourceItem } from '../types.js';
import { type ListedSource, taskOf } from './jira-listing.js';
import { jiraProjectItem, outOf } from './jira-project-item.js';
import { NO_CATEGORIES } from './jira-relations.js';
import { treeLinks, withTree } from './jira-tree.js';

// The stored kinds are exactly the ones the view's cells already draw (#827); a kind the mapping never stores reads as other
const TYPES: Readonly<Record<string, ProjectField['type']>> = { text: 'text', number: 'number', date: 'date', option: 'singleSelect', iteration: 'iteration' };
const CHOICES: ReadonlySet<ProjectField['type']> = new Set(['singleSelect', 'iteration']);

const typeOf = (kind: string | null): ProjectField['type'] => (kind !== null && Object.hasOwn(TYPES, kind) ? TYPES[kind] : 'other');
// The table's own comparison (ProjectTable's compare): case-insensitive, digits by value, so Sprint 9 comes before Sprint 10
const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The Status options in the stored order, Jira's answer to GET /project/{key}/statuses; withStages adds each one's stage. */
export function viewStatuses(fields: readonly SourceField[]): ProjectView['statuses'] {
  return (fields.find((f) => f.name === STATUS)?.options ?? []).map((name) => ({ name }));
}

/** Every stored field but Status, in the stored order. Jira gives no options, so a choice field's are the distinct values its issues carry,
 * one per stored value: a multi-valued field counts each. A field no issue has a value for has none. */
export function viewFields(fields: readonly SourceField[], stored: readonly Pick<StoredSourceItem, 'values'>[]): ProjectField[] {
  return fields.filter((f) => f.name !== STATUS).map((f): ProjectField => {
    const type = typeOf(f.kind);
    if (!CHOICES.has(type)) return { name: f.name, type };
    const options = [...new Set(stored.flatMap((s) => s.values.filter((v) => v.field === f.name).map((v) => v.value)))].sort(byText);
    return options.length === 0 ? { name: f.name, type } : { name: f.name, type, options };
  });
}

/** What the view reads (#827): the store under the account's rows key, the source, the account's filter (@me), and the refresh fresh runs. */
export interface JiraProjectContext {
  items: Pick<SourceItems, 'fields' | 'listing' | 'items'>;
  rows: string;
  source: ListedSource;
  isFiltered(task: SourceItem): boolean;
  refresh(): Promise<void>;
}

// Jira has no project field order to place them in, so status, labels and assignees come before every field column
const BUILTINS: ProjectBuiltins = { status: 0, labels: 0, assignees: 0 };

// Each issue's task with its tree, read over the whole listing as listedTasks does: epics: hide needs a parent's children to mark it.
// No blocker is shown, so no category is read (#828), as jiraProjectItem does.
function viewItems(ctx: JiraProjectContext, stored: readonly StoredSourceItem[]): ProjectItem[] {
  const links = treeLinks(stored, ctx.source.tree);
  return stored.map((s) => {
    const task = withTree(taskOf(s, ctx.source, NO_CATEGORIES), links.get(s.item.nodeId), ctx.source);
    return jiraProjectItem(s, ctx.source, outOf(task, ctx.isFiltered(task), ctx.source));
  });
}

/** The native view (#827), from the read model alone: the store holds the whole project, so nothing is truncated. fresh refreshes the
 * store first: the issues changed since the last round, then the ids, fields and statuses that also catch a moved or deleted issue. */
export async function jiraProject(ctx: JiraProjectContext, options: ReadOptions = {}): Promise<ProjectView> {
  if (options.fresh === true) await ctx.refresh();
  const { project } = ctx.source;
  const fields = ctx.items.fields(ctx.rows, project);
  const stored = ctx.items.items(ctx.rows, ctx.items.listing(ctx.rows, project));
  return { statuses: viewStatuses(fields), fields: viewFields(fields, stored), builtins: BUILTINS, items: viewItems(ctx, stored), truncated: false };
}
