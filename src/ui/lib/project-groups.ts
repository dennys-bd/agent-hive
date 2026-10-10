// The native view's groups (#756, handoff 01b): by status, a single-select field, the assignees or an iteration field. Groups follow the
// field's order in the project, then values it does not list in the order they first appear; a group with no issue is not shown, and the
// issues with no value close the list.
import type { ProjectItem, ProjectView } from '../../types.js';
import { t } from '../i18n.js';
import { FIELD_KEY } from './project-columns.js';

/** What a view can group by: `status`, `assignee` or `field:<name>`, and its label. */
export interface GroupOption { key: string; label: string }

/** One group: its key (what `collapsed` saves), its label, its issues in the rows' order and, grouped by status, its stage. */
export interface ProjectGroup { key: string; label: string; items: ProjectItem[]; stage?: string }

/** The key of the group of issues with no value: no Status option, field option or login is empty. */
export const NO_VALUE = '';

/** The menu's options after nenhum, in the handoff's order: status, the single-select fields, resp., the iteration fields. */
export function groupOptions(view: Pick<ProjectView, 'fields'>): GroupOption[] {
  const fieldsOf = (type: 'singleSelect' | 'iteration'): GroupOption[] =>
    view.fields.filter((f) => f.type === type).map((f) => ({ key: `${FIELD_KEY}${f.name}`, label: f.name }));
  return [{ key: 'status', label: t('project.col.status') }, ...fieldsOf('singleSelect'), { key: 'assignee', label: t('project.col.assignee') }, ...fieldsOf('iteration')];
}

// An issue's group: its Status, its logins joined (one group per combination, as GitHub does), or its field's value
function groupValue(item: ProjectItem, key: string): string | undefined {
  if (key === 'status') return item.status;
  if (key === 'assignee') return item.assignees.length === 0 ? undefined : item.assignees.join(', ');
  const name = key.slice(FIELD_KEY.length);
  return Object.hasOwn(item.fields, name) ? String(item.fields[name]) : undefined;
}

// The project's order of the values: the Status options, a field's options or iterations; logins have none
function orderOf(view: Pick<ProjectView, 'statuses' | 'fields'>, key: string): string[] {
  if (key === 'status') return view.statuses.map((s) => s.name);
  return view.fields.find((f) => `${FIELD_KEY}${f.name}` === key)?.options ?? [];
}

// Grouped by status, where a group's issues enter the flow
function stageOf(view: Pick<ProjectView, 'statuses'>, status: string): string {
  const stage = view.statuses.find((s) => s.name === status)?.stage;
  return stage === undefined ? t('project.group.noStage') : `→ ${stage}`;
}

/** The rows, already searched and sorted, in their groups; each group keeps the rows' order. */
export function groupItems(items: ProjectItem[], option: GroupOption, view: Pick<ProjectView, 'statuses' | 'fields'>): ProjectGroup[] {
  const values = items.map((item) => groupValue(item, option.key));
  const seen = [...new Set(values.filter((v): v is string => v !== undefined))];
  const known = orderOf(view, option.key);
  const names = [...known.filter((name) => seen.includes(name)), ...seen.filter((name) => !known.includes(name))];
  const groups = names.map((name): ProjectGroup => ({
    key: name, label: name, items: items.filter((_, at) => values[at] === name),
    ...(option.key === 'status' ? { stage: stageOf(view, name) } : {}),
  }));
  const empty = items.filter((_, at) => values[at] === undefined);
  return empty.length === 0 ? groups : [...groups, { key: NO_VALUE, label: t('project.group.empty', { field: option.label }), items: empty }];
}

/** Collapsed with nothing saved (handoff 01b): the Status option named Done, in any case. */
export const defaultCollapsed = (view: Pick<ProjectView, 'statuses'> | undefined): string[] =>
  (view?.statuses ?? []).filter((s) => s.name.toLowerCase() === 'done').map((s) => s.name);
