import type { FieldValue, FieldWrite, ItemField } from './types.js';

// The kinds no editor writes (#686): a repository (changing it is a transfer), the sub-issues' progress, the parent issue (a picker of its
// own) and any kind GitHub sets no value for. One rule: the adapter flags them, checkValue refuses them, the table renders them as text
const READ_ONLY: ReadonlySet<ItemField['type']> = new Set(['repository', 'progress', 'parentIssue', 'other']);
export const STATUS = 'Status'; // the Hive's columns: the one single-select that is never cleared, a task is always in one
export const MAX_TEXT = 1024; // a text field's longest value; GitHub's own limit is far larger, the cap only bounds what one request carries
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isReadOnly = (type: ItemField['type']): boolean => READ_ONLY.has(type);

// The round trip refuses a day the calendar lacks: Date.parse takes 2026-02-31 and moves it to March
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && ISO_DAY.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isLogins = (value: unknown): value is string[] => Array.isArray(value) && value.every((login) => typeof login === 'string');

// Only the logins being added must be assignable: one already assigned stays, whatever the one page of assignable users lists
function checkAssignees(field: ItemField, value: unknown): { value: FieldValue } | { error: string } {
  if (!isLogins(value)) return { error: `"${field.name}" takes a list of logins` };
  const current = Array.isArray(field.value) ? field.value : [];
  const unknown = value.find((login) => !current.includes(login) && !(field.options ?? []).includes(login));
  return unknown === undefined ? { value: [...new Set(value)] } : { error: `"${unknown}" cannot be assigned` };
}

function checkText(field: ItemField, value: unknown): { value: FieldValue } | { error: string } {
  if (typeof value !== 'string') return { error: `"${field.name}" takes text` };
  return value.length > MAX_TEXT ? { error: `"${field.name}" takes at most ${MAX_TEXT} characters` } : { value };
}

/** A field write's value checked against its field (#686): the value, or why it is refused: a read-only field, a value of another kind, or a
 * choice its options lack. null clears any kind but the assignees, which clear with []. Pure: the route's 400 before any write. */
export function checkValue(field: ItemField, value: unknown): { value: FieldValue } | { error: string } {
  if (field.readOnly || isReadOnly(field.type)) return { error: `"${field.name}" is read only` };
  if (field.type === 'assignees') return checkAssignees(field, value);
  if (value === null) return field.name === STATUS ? { error: `"${STATUS}" cannot be cleared` } : { value: null };
  switch (field.type) {
    case 'text': return checkText(field, value);
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? { value } : { error: `"${field.name}" takes a number` };
    case 'date': return isDay(value) ? { value } : { error: `"${field.name}" takes a date (YYYY-MM-DD)` };
    default: return typeof value === 'string' && (field.options ?? []).includes(value) ? { value } : { error: `"${field.name}" takes one of its options` };
  }
}

/** A write that failed after it may have changed the item (#686): the source's own words, and what the item reads now, so the route can answer
 * both and the UI resyncs instead of showing a value the source no longer has. */
export class PartialWriteError extends Error {
  constructor(message: string, readonly written: FieldWrite) { super(message); }
}

/** The item is not on the source (#686): a 404 where any other failure of the source is a 502. */
export class ItemNotOnSourceError extends Error {
  constructor(itemId: string) { super(`item ${itemId} is not on the source`); }
}
