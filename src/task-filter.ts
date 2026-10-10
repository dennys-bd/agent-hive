import { isBlocked } from './tasks.js';
import type { FilterOptions, FilterRule, Item, ItemFacets } from './types.js';

// The task filter's one reading of a rule (#245, #374, #441). The GitHub adapter runs it for a source's filter over the polled item, and a
// stage runs it for its view filter over each task's item, so the two can never read a rule differently. No Node imports: the UI
// bundles it, like tasks.ts (the one place it imports from).

/** What a rule reads of a task: its facets (GitHub only) and its open blockers (#441). */
type Filterable = Pick<Item, 'facets' | 'blockedBy'>;
/** A rule with values to compare: every criterion but blocked. */
type ValuedRule = Exclude<FilterRule, { field: 'blocked' }>;

export const ME = '@me'; // gh's shorthand for the logged-in user; in an assignee rule, the account the Hive polls with

/** GitHub logins, labels, repository names and field names are case-insensitive: every comparison goes through this. */
export const norm = (text: string): string => text.trim().toLowerCase();
export const isMe = (value: string): boolean => norm(value) === ME;
/** The picker's "nenhum" (#524): the task has no value for the criterion (no assignee, no milestone…). Never a value GitHub returns here:
 * it matches on emptiness only, so a label spelled like it stays a plain value. */
export const NO_VALUE = '@none';

/** A task's own values for a rule's criterion. No facets (a local task) or no value gives [], which fails `any` and passes `none`.
 * A projectField rule reads the named single-select field's option and no other field's. A blocked rule has no values: matchesRules reads
 * the blockers instead. */
export function valuesOf(item: Filterable | undefined, rule: FilterRule): string[] {
  const facets = item?.facets;
  if (facets === undefined) return [];
  switch (rule.field) {
    case 'assignee': return facets.assignees;
    case 'label': return facets.labels;
    case 'milestone': return facets.milestone === undefined ? [] : [facets.milestone];
    case 'repository': return facets.repository === undefined ? [] : [facets.repository];
    case 'projectField': return Object.entries(facets.fields).flatMap(([name, value]) => (norm(name) === norm(rule.name) ? [value] : []));
    case 'blocked': return [];
  }
}

// Whether the task carries one of the rule's values; `@me` in an assignee rule becomes `me`, NO_VALUE is a task with none.
function carriesValue(rule: ValuedRule, item: Filterable | undefined, me?: string): boolean {
  const have = new Set(valuesOf(item, rule).map(norm));
  return rule.values.some((value) =>
    (value === NO_VALUE ? have.size === 0 : have.has(norm(rule.field === 'assignee' && isMe(value) ? (me ?? value) : value))));
}

/**
 * Whether a task passes the rules (#245): a rule's values OR together, `none` negates it, the rules AND; [] passes everything. `@me` in an
 * assignee rule becomes `me`. Left unresolved it stays "@me", which no login equals, so an `any` rule fails and a `none` rule excludes
 * nobody: an unresolved `@me` never widens the filter. A blocked rule (#441) is hit when the task has an open blocker (isBlocked).
 */
export function matchesRules(rules: FilterRule[], item: Filterable | undefined, me?: string): boolean {
  return rules.every((rule) => {
    const hit = rule.field === 'blocked' ? item !== undefined && isBlocked(item) : carriesValue(rule, item, me);
    return rule.op === 'any' ? hit : !hit;
  });
}

/** A rule that means something (#245): a criterion (a projectField rule names its field) and at least one value; a blocked rule always
 * (#441), it has nothing to pick. What Settings saves and what a stage's Aplicar keeps (#374). */
export const isRuleComplete = (rule: FilterRule): boolean =>
  rule.field === 'blocked' || (rule.values.length > 0 && (rule.field !== 'projectField' || rule.name.trim() !== ''));

/** Distinct under the matcher's own case rule, the first spelling kept, sorted case-insensitively: what a picker lists. */
export function distinct(values: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) if (!byKey.has(norm(value))) byKey.set(norm(value), value.trim());
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** What a picker offers over these facets (#374): each criterion's distinct values, and each single-select field found in them with its
 * options. No `@me`: only a caller that knows the polling account adds it. */
export function facetOptions(facets: ItemFacets[]): FilterOptions {
  const fields = facets.flatMap((f) => Object.entries(f.fields));
  const optionsOf = (name: string): string[] => distinct(fields.flatMap(([n, value]) => (norm(n) === norm(name) ? [value] : [])));
  return {
    assignees: distinct(facets.flatMap((f) => f.assignees)),
    labels: distinct(facets.flatMap((f) => f.labels)),
    milestones: distinct(facets.flatMap((f) => (f.milestone === undefined ? [] : [f.milestone]))),
    repositories: distinct(facets.flatMap((f) => (f.repository === undefined ? [] : [f.repository]))),
    projectFields: distinct(fields.map(([name]) => name)).map((name) => ({ name, options: optionsOf(name) })),
  };
}
