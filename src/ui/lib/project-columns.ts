// The native view's columns (#756, handoff 01b): issue first and the task column last (#583, 150px), neither hideable; between them status, labels and resp.
// at their built-in fields' project position among the field columns, in the project's order, then the issue's dates, blocked by (#61) and PR, the Hive's own. Each as wide as
// its kind.
import type { BlockerRef, ProjectField, ProjectView } from '../../types.js';
import { WORKSPACE_FIELD } from '../../hive-project.js';
import { type MessageKey, t } from '../i18n.js';

/** A hideable column: `status`, `labels`, `assignee`, an issue date (`created`, `updated`, `closed`), `blockedBy`, `pr` or `field:<name>`, its width in
 * px and, on a field column, its field. */
export interface ProjectColumn { key: string; width: number; field?: ProjectField }

export const FIELD_KEY = 'field:';
export const ACTION_WIDTH = 150; // #583 decision 8: the task column, {flow} · {stage} › cut with …

// The hive's columns (#583 decision 3): fixed, no columns menu. Filtered out of projectColumns, which would put labels and resp. first since
// the hive's view has neither built-in
const HIVE_KEYS: readonly string[] = ['status', `${FIELD_KEY}${WORKSPACE_FIELD}`, 'pr'];

type Builtin = 'status' | 'labels' | 'assignee';
/** The issue's own dates (addendum 2): after the project's fields, before PR, each read off the item's property of the same name. */
export const DATES = { created: 'createdAt', updated: 'updatedAt', closed: 'closedAt' } as const;
export type DateKey = keyof typeof DATES;
const DATE_WIDTH = 72;
const BUILTINS: { key: Builtin; at: keyof ProjectView['builtins']; width: number }[] = [
  { key: 'status', at: 'status', width: 128 }, { key: 'labels', at: 'labels', width: 136 }, { key: 'assignee', at: 'assignees', width: 56 },
];
const PR: ProjectColumn = { key: 'pr', width: 104 };
const BLOCKED_BY: ProjectColumn = { key: 'blockedBy', width: 112 }; // #61, handoff §4: a project column, on by default
const FIELD_WIDTH: Record<ProjectField['type'], number> = {
  singleSelect: 88, iteration: 88, number: 72, date: 72, progress: 56, text: 120, milestone: 88, repository: 120, parentIssue: 120, issueType: 72, other: 88,
};
// What shows with nothing saved (#583 decision 12, handoff §5): status, labels and PR, and every milestone and progress field (GitHub's
// Sub-issues progress). By kind, not name, so it holds for a Project in any language
const DEFAULT_KEYS: ReadonlySet<string> = new Set(['status', 'labels', 'pr']);
const DEFAULT_KINDS: ReadonlySet<ProjectField['type']> = new Set<ProjectField['type']>(['milestone', 'progress']);
const PRIORITY_WIDTH = 64; // a P0–P3 chip
const HEAD: Record<Builtin | DateKey | 'blockedBy' | 'pr', MessageKey> = {
  status: 'project.col.status', labels: 'project.col.labels', assignee: 'project.col.assignee', pr: 'project.col.pr',
  created: 'project.col.created', updated: 'project.col.updated', closed: 'project.col.closed', blockedBy: 'project.col.blockedBy',
};
const dateColumns = (Object.keys(DATES) as DateKey[]).map((key): ProjectColumn => ({ key, width: DATE_WIDTH }));

const fieldWidth = (f: ProjectField): number => (f.type === 'singleSelect' && f.name.toLowerCase() === 'priority' ? PRIORITY_WIDTH : FIELD_WIDTH[f.type]);

/** Every hideable column in order: before each field, the built-ins the project puts there; a built-in the project lacks comes first. */
export function projectColumns(view: Pick<ProjectView, 'fields' | 'builtins'>): ProjectColumn[] {
  const { fields } = view;
  const builtinsAt = (at: number): ProjectColumn[] =>
    BUILTINS.filter((b) => Math.min(view.builtins[b.at] ?? 0, fields.length) === at).map((b) => ({ key: b.key, width: b.width }));
  const fieldColumn = (field: ProjectField): ProjectColumn => ({ key: `${FIELD_KEY}${field.name}`, width: fieldWidth(field), field });
  const slots = Array.from({ length: fields.length + 1 }, (_, at) => [...builtinsAt(at), ...(at < fields.length ? [fieldColumn(fields[at])] : [])]);
  return [...slots.flat(), ...dateColumns, BLOCKED_BY, PR];
}

/** Visible with nothing saved: status, labels, PR and the milestone and progress fields; assignees, blocked by, the issue's dates and every
 * other field kind start hidden. A source with saved columns keeps them. */
export const defaultColumns = (columns: ProjectColumn[]): string[] =>
  columns.filter((c) => (c.field === undefined ? DEFAULT_KEYS.has(c.key) : DEFAULT_KINDS.has(c.field.type))).map((c) => c.key);

/** The hive's five columns but issue and task: status, its Workspace text field and PR. */
export const hiveColumns = (view: Pick<ProjectView, 'fields' | 'builtins'>): ProjectColumn[] =>
  projectColumns(view).filter((c) => HIVE_KEYS.includes(c.key));

export const columnLabel = (column: ProjectColumn): string =>
  column.field?.name ?? t(HEAD[column.key as keyof typeof HEAD]);

/** A blocked-by list in the order its cell shows it (#61): the open refs, then the closed ones, each in GitHub's order. The header sorts by
 * the same first ref. */
export const openFirst = (refs: readonly BlockerRef[]): BlockerRef[] =>
  [...refs.filter((r) => r.state === 'open'), ...refs.filter((r) => r.state === 'closed')];
