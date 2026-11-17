import type { FieldValue, ItemField } from '../types.js';
import { type AdfNode, adfToMarkdown } from './adf.js';
import { markdownToAdf } from './adf-parse.js';
import { SPRINT_FIELD, sprintName, TEXTAREA_FIELD } from './jira-item.js';
import type { JiraSchema } from './jira-queries.js';

// The kind table of the spec (#826), out of jira-fields.ts so each file stays one concern: what a schema is, reads as, and writes as
export type Kind = ItemField['type'];
/** What a write can name by id: an allowed value, an assignable user (accountId), a sprint (its number as text), or a value already on the issue. */
export interface Choice { id: string; label: string }

const SINGLE: ReadonlySet<string> = new Set(['option', 'priority', 'version']);
const MULTI: ReadonlySet<string> = new Set(['option', 'component', 'version']);

type Json = Record<string, unknown>;
const recordOf = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined);
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const labelOf = (value: unknown): string | undefined => textOf(recordOf(value)?.value) ?? textOf(recordOf(value)?.name);
const userNameOf = (value: unknown): string | undefined => textOf(recordOf(value)?.displayName);
const present = (values: (string | undefined)[]): string[] => values.filter((v): v is string => v !== undefined);

export function kindOf(schema: JiraSchema | null | undefined): Kind {
  if (schema === null || schema === undefined) return 'other';
  if (schema.type === 'array') return arrayKind(schema);
  if (schema.type === 'string') return schema.custom === TEXTAREA_FIELD ? 'longText' : 'text';
  if (schema.type === 'issuetype') return 'issueType';
  if (SINGLE.has(schema.type)) return 'singleSelect';
  const plain: Record<string, Kind> = { number: 'number', date: 'date', datetime: 'datetime', user: 'user' };
  return Object.hasOwn(plain, schema.type) ? plain[schema.type] : 'other';
}

function arrayKind({ items, system, custom }: JiraSchema): Kind {
  if (items === 'user') return 'users';
  if (items === 'string' && system === 'labels') return 'labels';
  if (items === 'json' && custom === SPRINT_FIELD) return 'iteration';
  return items !== undefined && MULTI.has(items) ? 'multiSelect' : 'other';
}

/** The text of a compound value (#826): `Parent - Child` for a cascading select, else its displayName, value or name, else nothing. */
export function otherText(raw: unknown): string | null {
  if (typeof raw === 'string') return textOf(raw) ?? null;
  if (typeof raw === 'number') return String(raw);
  const record = recordOf(raw);
  if (record === undefined) return null;
  const child = labelOf(record.child);
  const parent = textOf(record.value);
  if (parent !== undefined && child !== undefined) return `${parent} - ${child}`;
  return userNameOf(record) ?? parent ?? textOf(record.name) ?? null;
}

function markdownOf(raw: unknown): string | null {
  // the codec checks every node before reading it (adf.ts), so the unchecked wire value is safe to hand it
  const markdown = typeof raw === 'string' ? raw : adfToMarkdown(raw as AdfNode | null | undefined);
  return markdown === '' ? null : markdown;
}

/** A raw `fields` value as the panel shows it, by kind: null or [] when unset. */
export function shownValue(kind: Kind, raw: unknown): FieldValue {
  switch (kind) {
    case 'singleSelect': case 'issueType': return labelOf(raw) ?? null;
    case 'multiSelect': return present(listOf(raw).map(labelOf));
    case 'user': return userNameOf(raw) ?? null;
    case 'users': return present(listOf(raw).map(userNameOf));
    case 'labels': return listOf(raw).filter((l): l is string => typeof l === 'string');
    case 'iteration': return sprintName(raw) ?? null;
    case 'longText': return markdownOf(raw);
    case 'number': return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    case 'text': case 'date': case 'datetime': return textOf(raw) ?? null;
    default: return otherText(raw);
  }
}

function choiceAt(id: unknown, label: string | undefined): Choice[] {
  const text = typeof id === 'number' ? String(id) : textOf(id);
  return text === undefined || label === undefined ? [] : [{ id: text, label }];
}

/** The ids the issue's own read carries for its current values, so a kept value an allowed list lacks still writes. */
export function currentChoices(kind: Kind, raw: unknown): Choice[] {
  const each = kind === 'singleSelect' || kind === 'issueType' || kind === 'user' ? [raw] : listOf(raw);
  switch (kind) {
    case 'singleSelect': case 'issueType': case 'multiSelect': return each.flatMap((v) => choiceAt(recordOf(v)?.id, labelOf(v)));
    case 'user': case 'users': return each.flatMap((v) => choiceAt(recordOf(v)?.accountId, userNameOf(v)));
    case 'iteration': return each.flatMap((v) => choiceAt(recordOf(v)?.id, textOf(recordOf(v)?.name)));
    default: return [];
  }
}

const INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Jira's documented yyyy-MM-ddTHH:mm:ss.SSS±hhmm: the same instant and offset, written without the colon and with Z as +0000. */
function jiraInstant(value: string): string {
  const m = INSTANT.exec(value);
  if (m === null) return value; // checkValue answered it already; nothing to normalise
  const offset = m[4] === 'Z' ? '+0000' : m[4].replace(':', '');
  return `${m[1]}:${m[2] ?? '00'}.${(m[3] ?? '').padEnd(3, '0')}${offset}`;
}

/** The PUT body of one field, by kind; a refusal throws before any call. */
export function bodyOf(kind: Kind, name: string, choices: readonly Choice[], value: FieldValue): unknown {
  switch (kind) {
    case 'singleSelect': case 'issueType': return value === null ? null : { id: idOf(choices, String(value), name) };
    case 'multiSelect': return names(value).map((label) => ({ id: idOf(choices, label, name) }));
    case 'user': return value === null ? null : { accountId: accountOf(choices, String(value)) };
    case 'users': return names(value).map((label) => ({ accountId: accountOf(choices, label) }));
    case 'iteration': return value === null ? null : Number(idOf(choices, String(value), name));
    case 'longText': return typeof value === 'string' ? markdownToAdf(value) : null;
    case 'datetime': return typeof value === 'string' ? jiraInstant(value) : value;
    default: return value; // text, number, date and labels: as checkValue answered them
  }
}

// First in Jira's order wins when two allowed values share a label (#826)
function idOf(choices: readonly Choice[], label: string, field: string): string {
  const found = choices.find((c) => c.label === label);
  if (found === undefined) throw new Error(`"${field}" takes one of its options`);
  return found.id;
}

// A name two accounts share would write a guess, so it is refused (#826); the same account listed twice (assignable and current) is one
function accountOf(choices: readonly Choice[], label: string): string {
  const ids = [...new Set(choices.filter((c) => c.label === label).map((c) => c.id))];
  if (ids.length > 1) throw new Error(`"${label}" names more than one account`);
  if (ids.length === 0) throw new Error(`"${label}" cannot be assigned`);
  return ids[0];
}

const names = (value: FieldValue): string[] => (Array.isArray(value) ? value : []);
