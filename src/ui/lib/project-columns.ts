// The native view's columns (#756, handoff 01b): issue first and the action last, neither hideable; between them status, labels and resp.
// at their built-in fields' project position among the field columns, in the project's order, then PR, the Hive's own. Each as wide as
// its kind.
import type { ProjectField, ProjectView } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';

/** A hideable column: `status`, `labels`, `assignee`, an issue date (`created`, `updated`, `closed`), `pr` or `field:<name>`, its width in
 * px and, on a field column, its field. */
export interface ProjectColumn { key: string; width: number; field?: ProjectField }

export const FIELD_KEY = 'field:';
export const ACTION_WIDTH = 76;

type Builtin = 'status' | 'labels' | 'assignee';
/** The issue's own dates (addendum 2): after the project's fields, before PR, each read off the item's property of the same name. */
export const DATES = { created: 'createdAt', updated: 'updatedAt', closed: 'closedAt' } as const;
export type DateKey = keyof typeof DATES;
const DATE_WIDTH = 72;
const BUILTINS: { key: Builtin; at: keyof ProjectView['builtins']; width: number }[] = [
  { key: 'status', at: 'status', width: 128 }, { key: 'labels', at: 'labels', width: 136 }, { key: 'assignee', at: 'assignees', width: 56 },
];
const PR: ProjectColumn = { key: 'pr', width: 104 };
const FIELD_WIDTH: Record<ProjectField['type'], number> = {
  singleSelect: 88, iteration: 88, number: 72, date: 72, progress: 56, text: 120, milestone: 88, repository: 120, parentIssue: 120, issueType: 72, other: 88,
};
// What shows with nothing saved (handoff 01b, addendum 2): the kinds the view had before every field became a column, iteration and number aside
const DEFAULT_KINDS = new Set<ProjectField['type']>(['singleSelect', 'text', 'date', 'progress']);
const PRIORITY_WIDTH = 64; // a P0–P3 chip
const HEAD: Record<Builtin | DateKey | 'pr', MessageKey> = {
  status: 'project.col.status', labels: 'project.col.labels', assignee: 'project.col.assignee', pr: 'project.col.pr',
  created: 'project.col.created', updated: 'project.col.updated', closed: 'project.col.closed',
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
  return [...slots.flat(), ...dateColumns, PR];
}

/** Visible with nothing saved: the built-ins, PR and the single-select, text, date and progress fields; every other kind and the issue's
 * dates start hidden. */
export const defaultColumns = (columns: ProjectColumn[]): string[] =>
  columns.filter((c) => (c.field === undefined ? !Object.hasOwn(DATES, c.key) : DEFAULT_KINDS.has(c.field.type))).map((c) => c.key);

export const columnLabel = (column: ProjectColumn): string =>
  column.field?.name ?? t(HEAD[column.key as Builtin | DateKey | 'pr']);
