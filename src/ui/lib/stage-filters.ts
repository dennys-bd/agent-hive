// A stage's view filter (#374): per-viewer UI state, like the terminal layout (#251), kept in the view state (#484) and never a setting. It only
// hides tasks on screen; the source's own filter (Settings, #245) is never read or written here. Anything unreadable is dropped on read.
import { isRuleComplete, matchesRules } from '../../task-filter.js';
import { onSource } from '../../tasks.js';
import { type Task, FILTER_FIELDS, FILTER_OPS, type FilterRule } from '../../types.js';
import { readView, writeView } from './view-state.js';

/** A stage's name → its rules; a stage with none is absent. */
export type StageFilters = Record<string, FilterRule[]>;

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

// What FilterRules produces: a known criterion and operator, string values, and a field name on a projectField rule only; a blocked rule
// (#441) carries neither values nor a name.
function isRule(value: unknown): value is FilterRule {
  if (typeof value !== 'object' || value === null) return false;
  const { field, op, values, name } = value as Record<string, unknown>;
  if (!(FILTER_FIELDS as readonly unknown[]).includes(field) || !(FILTER_OPS as readonly unknown[]).includes(op)) return false;
  if (field === 'blocked') return values === undefined && name === undefined;
  if (!isStringList(values)) return false;
  return field === 'projectField' ? typeof name === 'string' : name === undefined;
}

const isRules = (value: unknown): value is FilterRule[] =>
  Array.isArray(value) && value.length > 0 && value.every((rule) => isRule(rule) && isRuleComplete(rule));

/** The saved filters, stored under stageFilters and keyed by the Hive's stages (#484): {} when there are none or the value is no object;
 * a stage whose value is not a list of complete rules is dropped alone. */
export function readStageFilters(): StageFilters {
  const stored = readView('stageFilters');
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).flatMap(([stage, rules]): [string, FilterRule[]][] => (isRules(rules) ? [[stage, rules]] : [])));
}

export function writeStageFilters(filters: StageFilters): void {
  writeView('stageFilters', Object.fromEntries(Object.entries(filters).filter(([, rules]) => rules.length > 0)));
}

/** A stage's rules, [] when it has none. Own keys only: a stage named like an Object method reads nothing it did not set. */
export const rulesFor = (filters: StageFilters, stage: string): FilterRule[] => onSource(filters, stage) ?? [];

/** The map with `stage`'s rules replaced ([] clears it), keeping only `stages`, the Hive's current stage names: a filter saved for a
 * removed or renamed stage is ignored until this next write drops it. */
export function withStageFilter(filters: StageFilters, stage: string, rules: FilterRule[], stages: string[]): StageFilters {
  return Object.fromEntries(Object.entries({ ...filters, [stage]: rules }).filter(([name, r]) => stages.includes(name) && r.length > 0));
}

/** The tasks that pass the rules, in their order: what the stage pages and counts (#374). A task without facets (a local one) fails
 * any valued `any` rule and passes every valued `none` one; a blocked rule reads its open blockers (#441). */
export const visibleUnderFilter = (tasks: Task[], rules: FilterRule[]): Task[] => tasks.filter((c) => matchesRules(rules, c.item));
