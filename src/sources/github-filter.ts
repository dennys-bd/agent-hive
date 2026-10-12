import { facetOptions, isMe, matchesRules, ME, NO_VALUE, norm } from '../task-filter.js';
import type { FilterOptions, FilterRule, ItemFacets } from '../types.js';
import type { GhItemNode, GhSelectField } from './github-queries.js';

export { ME }; // github.ts resolves an `@me` owner with it

const STATUS_FIELD = 'Status'; // the Hive's columns: a rule on it would fight the stages, so neither the form nor a task's facets offer it

/**
 * What a task filter rule reads of an issue item (#245, #374): logins, label names, the milestone's title, the repository's owner/name, and
 * each set single-select field's option by field name, Status left out. A text field is never read here (#293's workspace rules read those).
 * What the source filter matches, and what the task carries to the UI as item.facets for a stage's view filter.
 */
export function facetsOf(item: GhItemNode): ItemFacets {
  const c = item.content;
  const fields = (item.fieldValues?.nodes ?? []).flatMap((v): [string, string][] =>
    (v.name !== undefined && v.field?.name !== undefined && norm(v.field.name) !== norm(STATUS_FIELD) ? [[v.field.name, v.name]] : []));
  return {
    assignees: (c?.assignees?.nodes ?? []).map((n) => n.login),
    labels: (c?.labels?.nodes ?? []).map((n) => n.name),
    ...(c?.milestone ? { milestone: c.milestone.title } : {}),
    ...(c?.repository ? { repository: c.repository.nameWithOwner } : {}),
    fields: Object.fromEntries(fields),
  };
}

/** Whether one issue item passes a source's rules (#245): matchesRules over its facets, `@me` being the polling login `me`. The item carries no
 * relations, so a blocked rule here reads every item as free: listItems hands this the other rules only (#441, splitBlocked). */
export const matchesFilter = (filter: FilterRule[], me: string | undefined, item: GhItemNode): boolean => matchesRules(filter, { facets: facetsOf(item) }, me);

/** Whether an assignee rule says `@me`: the one case resolveFields asks for the viewer's login. */
export const usesMe = (filter: FilterRule[]): boolean => filter.some((r) => r.field === 'assignee' && r.values.some(isMe));

/** A source filter in the two halves listItems runs apart (#441): the blocked rules wait for the relations query, the others read the item
 * alone and run first, so a task they drop costs no relations alias. */
export const splitBlocked = (filter: FilterRule[]): { blocked: FilterRule[]; other: FilterRule[] } =>
  ({ blocked: filter.filter((r) => r.field === 'blocked'), other: filter.filter((r) => r.field !== 'blocked') });

/** The settings form's filter options from a source's items and fields (#245): `@me` first among the assignees, even on an empty source;
 * single-select fields only, Status left out. */
export function filterOptionsFrom(items: GhItemNode[], fields: GhSelectField[]): FilterOptions {
  const found = facetOptions(items.map(facetsOf));
  return {
    ...found,
    assignees: [ME, ...found.assignees],
    projectFields: fields.flatMap((f) => (f.name && f.options && norm(f.name) !== norm(STATUS_FIELD) ? [{ name: f.name, options: f.options.map((o) => o.name) }] : [])),
  };
}

const QUALIFIER = { assignee: 'assignee', label: 'label', milestone: 'milestone', repository: 'repo' } as const;

/** One rule in the Project's filter syntax (#234), or undefined for a rule the query leaves to matchesFilter: a project field (its name's
 * quoting is not settled), "nenhum" mixed with values (one qualifier cannot OR emptiness with a value), a value holding a quote. */
function qualifierOf(rule: FilterRule): string | undefined {
  if (rule.field === 'blocked' || rule.field === 'projectField' || rule.values.length === 0) return undefined;
  const key = QUALIFIER[rule.field];
  if (rule.values.every((v) => v === NO_VALUE)) return rule.op === 'any' ? `no:${key}` : `has:${key}`;
  if (rule.values.some((v) => v === NO_VALUE || v.includes('"'))) return undefined;
  const values = rule.values.map((v) => (isMe(v) ? ME : `"${v.trim()}"`)).join(',');
  return `${rule.op === 'none' ? '-' : ''}${key}:${values}`;
}

/** The source's filter as the `query` the poll hands GitHub (#234), so a Project past the poll's pages still yields every item the filter
 * keeps. Never stricter than matchesFilter: an untranslatable rule is left out, and matchesFilter still runs over what comes back, since
 * GitHub matches more loosely (a milestone's title in any case). Undefined when no rule translates: the whole Project, as before. */
export function projectQuery(filter: FilterRule[]): string | undefined {
  const parts = filter.flatMap((rule) => qualifierOf(rule) ?? []);
  return parts.length === 0 ? undefined : parts.join(' ');
}
