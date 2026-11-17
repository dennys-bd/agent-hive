import { checkValue, STATUS } from '../field-values.js';
import type { FieldValue, FieldWrite, ItemField, SourceItem } from '../types.js';
import { bodyOf, type Choice, currentChoices, type Kind, kindOf, shownValue } from './jira-field-kinds.js';
import type { JiraEditable, JiraEditRead, JiraSprint, JiraUser } from './jira-edit.js';
import { putFields, readAssignableUsers, readEditable, readSprints } from './jira-edit.js';
import { JiraBadRequestError, JiraHttpError, JiraNotFoundError } from './jira-fetch.js';
import type { JiraItemRows } from './jira-item.js';
import type { JiraSourceConfig } from './jira-listing.js';
import { jiraProjectItem } from './jira-project-item.js';
import { type JiraCall, type JiraFieldMeta, type JiraIssue, readTransitions } from './jira-queries.js';

/** What the field reads and writes run on (#826): the site's two calls, the source, and the adapter's own store, move and listing reads. */
export interface JiraFieldsContext {
  call: JiraCall;
  agile: JiraCall;
  source: JiraSourceConfig;
  keep(read: JiraFieldMeta & { issue: JiraIssue }): { rows: JiraItemRows; task: SourceItem; isOwn: boolean }; // stored as a write, as readTask does
  setColumn(itemId: string, column: string): Promise<void>;
  labels(): string[]; // the labels on the source's stored issues, deduplicated and sorted
  isListed(task: SourceItem): boolean; // a cited column, and the filter passed
  isFiltered(task: SourceItem): boolean; // the filter drops it: the row's `out`
}

// Shown elsewhere in the Hive (the title, the body, the relations, the dates), or first (Status)
const HIDDEN: ReadonlySet<string> = new Set(['summary', 'description', 'issuelinks', 'parent', 'attachment', 'comment', 'worklog', 'timetracking', 'created', 'updated', 'status']);
const SET = 'set';

/** One field as the panel and a write read it: the editor's field, the Jira id it writes to, and the ids its labels name. */
interface FieldRead { field: ItemField; id: string; kind: Kind; choices: Choice[] }
interface FieldsRead { fields: FieldRead[]; kept: ReturnType<JiraFieldsContext['keep']>; key: string; names: Record<string, string> }
interface Extras { users: JiraUser[]; sprints: JiraSprint[]; hasUsers: boolean; hasSprints: boolean } // hasX: the read answered, so the kind is editable

const dedupe = (labels: readonly string[]): string[] => [...new Set(labels)];

const DENIED = new Set([403, 404]);
// A site that hides users, sprints or transitions from this login leaves the panel up; any other failure (401, 429, 5xx) is the caller's
const isDenied = (err: unknown): boolean => err instanceof JiraNotFoundError || (err instanceof JiraHttpError && DENIED.has(err.status));
async function orDenied<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (err) {
    if (isDenied(err)) return undefined;
    throw err;
  }
}

// The reads past the issue's own, made only when a field of that kind is editable: an issue with no user picker never pages the site's users
async function extras(ctx: JiraFieldsContext, key: string, editable: readonly JiraEditable[]): Promise<Extras> {
  const kinds = new Set(editable.map((e) => kindOf(e.schema)));
  const [users, sprints] = await Promise.all([
    kinds.has('user') || kinds.has('users') ? orDenied(readAssignableUsers(ctx.call, key)) : Promise.resolve([]),
    kinds.has('iteration') ? orDenied(readSprints(ctx.agile, ctx.source.project)) : Promise.resolve([]),
  ]);
  return { users: users ?? [], sprints: sprints ?? [], hasUsers: users !== undefined, hasSprints: sprints !== undefined };
}

// Status first (#826): the current status and the statuses its transitions reach, once each, in Jira's order; written by setColumn
function statusField(issue: JiraIssue, targets: readonly string[]): FieldRead {
  const current = (issue.fields.status as { name?: unknown } | null | undefined)?.name;
  const value = typeof current === 'string' ? current : null;
  const options = dedupe([...(value === null ? [] : [value]), ...targets]);
  return { field: { name: STATUS, type: 'singleSelect', value, options }, id: 'status', kind: 'singleSelect', choices: [] };
}

// What the editor offers and the write names, by kind: the allowed values, the assignable users or the sprints, then the issue's own values
function choicesOf(kind: Kind, e: JiraEditable, more: Extras): Choice[] {
  switch (kind) {
    case 'singleSelect': case 'issueType': case 'multiSelect': return e.allowedValues;
    case 'user': case 'users': return more.users.map((u) => ({ id: u.accountId, label: u.displayName }));
    case 'iteration': return more.sprints.map((s) => ({ id: String(s.id), label: s.name }));
    default: return [];
  }
}

// An edit-screen field: read only without a set operation or when the kind table has no write for it
function editableField(ctx: JiraFieldsContext, e: JiraEditable, raw: unknown, more: Extras): FieldRead {
  const kind = kindOf(e.schema);
  const value = shownValue(kind, raw);
  const denied = (kind === 'iteration' && !more.hasSprints) || ((kind === 'user' || kind === 'users') && !more.hasUsers);
  if (kind === 'other' || denied || !e.operations.includes(SET)) return { field: { name: e.name, type: kind, value, readOnly: true }, id: e.id, kind, choices: [] };
  const offered = choicesOf(kind, e, more);
  const listed = kind === 'labels' ? ctx.labels() : dedupe(offered.map((c) => c.label));
  const hasOptions = kind !== 'text' && kind !== 'longText' && kind !== 'number' && kind !== 'date' && kind !== 'datetime';
  const field: ItemField = {
    name: e.name, type: kind, value, ...(hasOptions ? { options: listed } : {}),
    ...(e.required ? { isRequired: true as const } : {}), ...(kind === 'labels' ? { isOpen: true as const } : {}),
  };
  return { field, id: e.id, kind, choices: [...offered, ...currentChoices(kind, raw)] };
}

const isUnset = (value: FieldValue): boolean => value === null || (Array.isArray(value) && value.length === 0);

// A field off the edit screen that has a value: shown read only, by its schema from expand=schema
function readOnlyField(id: string, read: JiraEditRead): FieldRead[] {
  const kind = kindOf(Object.hasOwn(read.schema, id) ? read.schema[id] : undefined);
  const value = shownValue(kind, read.issue.fields[id]);
  if (isUnset(value)) return [];
  const name = Object.hasOwn(read.names, id) ? read.names[id] : id;
  return [{ field: { name, type: kind, value, readOnly: true }, id, kind, choices: [] }];
}

async function readAll(ctx: JiraFieldsContext, id: string): Promise<FieldsRead> {
  const read = await readEditable(ctx.call, id);
  const kept = ctx.keep(read);
  const key = read.issue.key ?? id;
  const [transitions, more] = await Promise.all([orDenied(readTransitions(ctx.call, id)), extras(ctx, key, read.editable)]);
  const targets = (transitions ?? []).map((t) => t.to);
  const onScreen = new Set(read.editable.map((e) => e.id));
  const screen = read.editable.filter((e) => !HIDDEN.has(e.id)).map((e) => editableField(ctx, e, read.issue.fields[e.id], more));
  const rest = Object.keys(read.issue.fields).filter((f) => !HIDDEN.has(f) && !onScreen.has(f)).flatMap((f) => readOnlyField(f, read));
  return { fields: [statusField(read.issue, targets), ...screen, ...rest], kept, key, names: read.names };
}

/** #826: the issue's fields in the panel's order, read live each time (ReadOptions.fresh has nothing to add) and stored as a write. */
export async function jiraFieldsOf(ctx: JiraFieldsContext, id: string): Promise<ItemField[]> {
  return (await readAll(ctx, id)).fields.map((f) => f.field);
}

// The PUT of one field; Jira's refusal shows its reason under the fields' names, which only the read knows (#826)
async function put(ctx: JiraFieldsContext, id: string, found: FieldRead, value: FieldValue, names: Record<string, string>): Promise<void> {
  const body = bodyOf(found.kind, found.field.name, found.choices, value); // a refusal throws here, before the call
  try {
    await putFields(ctx.call, id, { [found.id]: body });
  } catch (err) {
    throw err instanceof JiraBadRequestError ? new Error(err.named(names)) : err;
  }
}

/** #826, the #686 contract: checked against a fresh read, written at once (Status by its transition), then read again, which stores it; the
 * answer is that read's fields, the row and, for a listed task, the entry. */
export async function jiraSetField(ctx: JiraFieldsContext, id: string, name: string, value: FieldValue): Promise<FieldWrite> {
  const before = await readAll(ctx, id);
  // Status wins a name a custom field shares; any other shared name would write a guess
  const named = before.fields.filter((f) => f.field.name === name);
  const found = name === STATUS ? before.fields[0] : named[0];
  if (found === undefined) throw new Error(`"${name}" is not a field of ${before.key}`);
  if (name !== STATUS && named.length > 1) throw new Error(`"${name}" names more than one field of ${before.key}`);
  const checked = checkValue(found.field, value);
  if ('error' in checked) throw new Error(checked.error);
  if (name === STATUS) await ctx.setColumn(id, String(checked.value));
  else await put(ctx, id, found, checked.value, before.names);
  // ponytail: the route's fresh read, this one and the re-read are three panel reads per write; one cached read if a site's rate limit bites
  const after = await readAll(ctx, id);
  const { rows, task, isOwn } = after.kept;
  return {
    fields: after.fields.map((f) => f.field),
    row: jiraProjectItem(rows, ctx.source, ctx.isFiltered(task)),
    ...(isOwn && ctx.isListed(task) ? { entry: task } : {}),
  };
}
