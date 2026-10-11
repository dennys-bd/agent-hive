// A source's native view as the viewer left it (#756, handoff 01b, addendum 2): its grouping, its collapsed groups, its visible columns, its
// header sort and its column widths, kept in the view state (#484) under projectViews, keyed by source, like the stage filters. Anything
// unreadable is dropped on read; a view saved before sort and widths existed reads with neither.
import { onSource } from '../../tasks.js';
import { parseWidths } from './column-widths.js';
import { readView, writeView } from './view-state.js';

/** The header sort: a column's key (`issue` or a hideable column's) and its direction. */
export interface ProjectSort { key: string; desc: boolean }

/** `groupBy`: null, `status`, `assignee` or `field:<name>`; `collapsed`: the group names folded; `columns`: the visible column keys;
 * `sort`: null for the project's own order; `widths`: px by column key, a column absent at its kind's width; `blockedByShown`: the view
 * knows the blocked-by column (#61), always set on read, so every save writes it. */
export interface ProjectViewPrefs {
  groupBy: string | null; collapsed: string[]; columns: string[]; sort: ProjectSort | null; widths: Record<string, number>; blockedByShown?: true;
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isSort = (value: unknown): value is ProjectSort | null =>
  value === null || (isRecord(value) && typeof value.key === 'string' && typeof value.desc === 'boolean');

const BLOCKED_BY = 'blockedBy';
// #61: a view saved before the blocked-by column existed has no blockedByShown, so it gets the column, on by default as the handoff says.
// One saved since carries the flag and keeps the user's choice. The order comes from projectColumns, not from this list
const withBlockedBy = (columns: string[], isKnown: unknown): string[] =>
  (isKnown === true || columns.includes(BLOCKED_BY) ? columns : [...columns, BLOCKED_BY]);

// What a saved view holds, sort and widths filled in when it predates them, the blocked-by column added when it predates that (#61)
function prefsOf(value: unknown): ProjectViewPrefs | undefined {
  if (!isRecord(value)) return undefined;
  const { groupBy, collapsed, columns, sort = null, widths = {}, blockedByShown } = value;
  const parsed = parseWidths(widths);
  const isRead = (groupBy === null || typeof groupBy === 'string') && isStringList(collapsed) && isStringList(columns) && isSort(sort) && parsed !== undefined;
  return isRead ? { groupBy, collapsed, columns: withBlockedBy(columns, blockedByShown), sort, widths: parsed, blockedByShown: true } : undefined;
}

const stored = (): Record<string, unknown> => {
  const all = readView('projectViews');
  return isRecord(all) ? all : {};
};

/** The source's saved view; undefined when none is saved or it cannot be read, which the table reads as its defaults. */
export function readProjectView(source: string): ProjectViewPrefs | undefined {
  return prefsOf(onSource(stored(), source));
}

export function writeProjectView(source: string, prefs: ProjectViewPrefs): void {
  writeView('projectViews', { ...stored(), [source]: prefs });
}
