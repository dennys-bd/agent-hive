import type { FieldValue, FieldWrite, ItemField } from './types.js';

// The kinds no editor writes (#686): a repository (changing it is a transfer), the sub-issues' progress, the parent issue (a picker of its
// own) and any kind GitHub sets no value for. One rule: the adapter flags them, checkValue refuses them, the table renders them as text
const READ_ONLY: ReadonlySet<ItemField['type']> = new Set(['repository', 'progress', 'parentIssue', 'other']);
export const STATUS = 'Status'; // the Hive's columns: the one single-select that is never cleared, a task is always in one
export const MAX_TEXT = 1024; // a text field's longest value; GitHub's own limit is far larger, the cap only bounds what one request carries
export const MAX_LONG_TEXT = 32_768; // #826: Jira's own limit for a text field
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// An ISO date-time with Z or an offset, with or without its colon, as Jira answers it and the panel sends it
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
const WHITESPACE = /\s/;

export const isReadOnly = (type: ItemField['type']): boolean => READ_ONLY.has(type);

// The round trip refuses a day the calendar lacks: Date.parse takes 2026-02-31 and moves it to March
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && ISO_DAY.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string');

type Checked = { value: FieldValue } | { error: string };

// The rule the assignees and the labels share (#60): only a name being added must be listed, one already on the issue stays
function checkNames(field: ItemField, value: unknown, takes: string, unknownError: (name: string) => string): Checked {
  if (!isNames(value)) return { error: `"${field.name}" takes ${takes}` };
  const current = Array.isArray(field.value) ? field.value : [];
  const unknown = value.find((name) => !current.includes(name) && !(field.options ?? []).includes(name));
  return unknown === undefined ? { value: [...new Set(value)] } : { error: unknownError(unknown) };
}

// #826: a Jira label is free text, refused only where Jira refuses it
function checkOpenLabels(field: ItemField, value: unknown): Checked {
  if (!isNames(value)) return { error: `"${field.name}" takes a list of label names` };
  const spaced = value.find((label) => WHITESPACE.test(label));
  return spaced === undefined ? { value: [...new Set(value)] } : { error: `"${spaced}" cannot contain a space` };
}

function checkText(field: ItemField, value: unknown, cap: number): Checked {
  if (typeof value !== 'string') return { error: `"${field.name}" takes text` };
  return value.length > cap ? { error: `"${field.name}" takes at most ${cap} characters` } : { value };
}

const isEmpty = (value: unknown): boolean => value === null || (Array.isArray(value) && value.length === 0);
const isInstant = (value: unknown): value is string => typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));

/** A field write's value checked against its field (#686): the value, or why it is refused: a read-only field, a value of another kind, or a
 * choice its options lack. null clears any kind but the list kinds, which clear with []; a required field clears with neither (#826). Pure: the route's 400 before any write. */
export function checkValue(field: ItemField, value: unknown): Checked {
  if (field.readOnly || isReadOnly(field.type)) return { error: `"${field.name}" is read only` };
  if (field.isRequired && isEmpty(value)) return { error: `"${field.name}" is required` };
  if (field.type === 'assignees') return checkNames(field, value, 'a list of logins', (login) => `"${login}" cannot be assigned`);
  if (field.type === 'users') return checkNames(field, value, 'a list of names', (name) => `"${name}" cannot be assigned`);
  if (field.type === 'multiSelect') return checkNames(field, value, 'a list of names', () => `"${field.name}" takes one of its options`);
  if (field.type === 'labels') return field.isOpen ? checkOpenLabels(field, value) : checkNames(field, value, 'a list of label names', (name) => `"${name}" is not a label of the repository`);
  if (value === null) return field.name === STATUS ? { error: `"${STATUS}" cannot be cleared` } : { value: null };
  switch (field.type) {
    case 'text': return checkText(field, value, MAX_TEXT);
    case 'longText': return checkText(field, value, MAX_LONG_TEXT);
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? { value } : { error: `"${field.name}" takes a number` };
    case 'date': return isDay(value) ? { value } : { error: `"${field.name}" takes a date (YYYY-MM-DD)` };
    case 'datetime': return isInstant(value) ? { value } : { error: `"${field.name}" takes a date and time with its offset` };
    default: return typeof value === 'string' && (field.options ?? []).includes(value) ? { value } : { error: `"${field.name}" takes one of its options` }; // user too: a name in options
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
