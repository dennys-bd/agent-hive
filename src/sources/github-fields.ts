import { isReadOnly, ItemNotOnSourceError, PartialWriteError, STATUS } from '../field-values.js';
import type { FieldValue, FieldWrite, Gql, ItemField, ProjectField, SourceItem } from '../types.js';
import type { Logger } from '../log.js';
import type { ReadModel } from '../read-model/db.js';
import { rebuildFieldsNode } from '../read-model/items-rebuild.js';
import { projectFields, projectItem, valuesOf, type ProjectRead } from './github-project.js';
import {
  assigneesMutation, CLEAR_FIELD, CLEAR_ISSUE_TYPE, CLEAR_MILESTONE, ITEM_FIELDS, labelsMutation, SET_DATE, SET_ISSUE_TYPE, SET_ITERATION, SET_MILESTONE, SET_NUMBER,
  SET_OPTION, SET_TEXT, type GhItemFieldsNode, type GhProjectField, type ItemFieldsData,
} from './github-queries.js';

const ASSIGNEES = 'ASSIGNEES'; // GitHub's dataType of the built-in Assignees field
const LABELS = 'LABELS'; // GitHub's dataType of the built-in Labels field
const WRITABLE = new Set(['SINGLE_SELECT', 'ITERATION', 'TEXT', 'NUMBER', 'DATE']); // the kinds updateProjectV2ItemFieldValue takes

/** What a field write needs of the adapter (#686): its transport, what projectItem reads, and the poll's own steps on one item. answer (#190):
 * the re-read node stored in the read model, before the write answers and before the next poll. */
export interface FieldsContext {
  gql: Gql; projectId: string; read: ProjectRead; entry(node: GhItemFieldsNode): Promise<SourceItem | undefined>; answer?(node: GhItemFieldsNode): Promise<void>;
}

/** One mutation of a write (#686). */
export interface FieldMutation { query: string; variables: Record<string, string | number> }

// An item id is any node id the caller names: one of another project is refused here, before a mutation names its ids
export async function readItem(gql: Gql, itemId: string, projectId: string): Promise<GhItemFieldsNode> {
  const node = ((await gql(ITEM_FIELDS, { itemId })) as ItemFieldsData).node;
  if (node?.project?.id !== projectId) throw new ItemNotOnSourceError(itemId);
  return node;
}

/** #191: a column write's answer, the item re-read and handed to `answer` (the read model's write answer). The mutation already landed, so a
 * failed re-read is logged and never fails the write: staleRead's window covers the poll that follows. */
export async function answerColumn(gql: Gql, itemId: string, projectId: string, answer: (node: GhItemFieldsNode) => Promise<void>, log?: Logger): Promise<void> {
  try {
    await answer(await readItem(gql, itemId, projectId));
  } catch (err) {
    log?.error(`item ${itemId}: the column write was not re-read for the read model: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// What a choice can be: a milestone or an issue type from the issue's repository, anything else from the project's own options
function choicesOf(field: ProjectField, node: GhItemFieldsNode): string[] | undefined {
  const repo = node.content?.repository;
  if (field.type === 'milestone') return (repo?.milestones?.nodes ?? []).map((m) => m.title);
  if (field.type === 'issueType') return (repo?.issueTypes?.nodes ?? []).map((t) => t.name);
  return field.options;
}

function shownField(field: ProjectField, values: Record<string, string | number>, node: GhItemFieldsNode): ItemField {
  const value = Object.hasOwn(values, field.name) ? values[field.name] : null;
  if (isReadOnly(field.type)) return { name: field.name, type: field.type, value, readOnly: true };
  const options = choicesOf(field, node);
  return { name: field.name, type: field.type, value, ...(options === undefined ? {} : { options }) };
}

/** An item's fields for its editors (#686), in the project's order: Status, the assignees, the labels and every field the native view shows;
 * the title and linked PRs are #757's or the view's own. */
export function itemFields(node: GhItemFieldsNode): ItemField[] {
  const raw = node.project?.fields?.nodes ?? [];
  const shown = new Map(projectFields(raw).map((f) => [f.name, f]));
  const values = valuesOf(node, [...shown.values()]);
  const logins = (node.content?.assignees?.nodes ?? []).map((a) => a.login);
  const assignable = (node.content?.repository?.assignableUsers?.nodes ?? []).map((u) => u.login);
  const labels = (node.content?.labels?.nodes ?? []).map((l) => l.name);
  const repoLabels = (node.content?.repository?.labels?.nodes ?? []).map((l) => l.name);
  return raw.flatMap((f): ItemField[] => {
    if (f.name === undefined) return [];
    if (f.name === STATUS) return [{ name: f.name, type: 'singleSelect', value: node.fieldValueByName?.name ?? null, options: (f.options ?? []).map((o) => o.name) }];
    if (f.dataType === ASSIGNEES) return [{ name: f.name, type: 'assignees', value: logins, options: assignable }];
    if (f.dataType === LABELS) return [{ name: f.name, type: 'labels', value: labels, options: repoLabels }];
    const field = shown.get(f.name);
    return field ? [shownField(field, values, node)] : [];
  });
}

// A name to its id; no match stops the write here, before anything is sent
function idOf<T extends { id?: string }>(list: readonly T[] | null | undefined, label: (t: T) => string, value: FieldValue, what: string): string {
  const id = (list ?? []).find((t) => label(t) === value)?.id;
  if (id === undefined) throw new Error(`"${String(value)}" is not ${what}`);
  return id;
}

function text(name: string, value: FieldValue): string {
  if (typeof value !== 'string') throw new Error(`"${name}" takes a string`);
  return value;
}

function numeric(name: string, value: FieldValue): number {
  if (typeof value !== 'number') throw new Error(`"${name}" takes a number`);
  return value;
}

// The assignees' difference from the current set: a write of the whole set adds and removes only who changed
function assigneeWrites(node: GhItemFieldsNode, issueId: string, value: FieldValue): FieldMutation[] {
  if (!Array.isArray(value)) throw new Error('the assignees take a list of logins');
  const wanted = [...new Set(value)];
  const current = node.content?.assignees?.nodes ?? [];
  const users = node.content?.repository?.assignableUsers?.nodes;
  const added = wanted.filter((login) => !current.some((a) => a.login === login)).map((login) => idOf(users, (u) => u.login, login, 'an assignable user'));
  const removed = current.filter((a) => !wanted.includes(a.login)).map((a) => idOf([a], (u) => u.login, a.login, 'an assignee'));
  const write = (op: 'addAssigneesToAssignable' | 'removeAssigneesFromAssignable', ids: string[]): FieldMutation[] =>
    (ids.length === 0 ? [] : [{ query: assigneesMutation(op, ids.length), variables: { assignableId: issueId, ...Object.fromEntries(ids.map((id, i) => [`u${i}`, id])) } }]);
  return [...write('addAssigneesToAssignable', added), ...write('removeAssigneesFromAssignable', removed)];
}

// The labels' difference from the current set, as the assignees': a label being added resolves against the issue's repository
function labelWrites(node: GhItemFieldsNode, issueId: string, value: FieldValue): FieldMutation[] {
  if (!Array.isArray(value)) throw new Error('the labels take a list of names');
  const wanted = [...new Set(value)];
  const current = node.content?.labels?.nodes ?? [];
  const known = node.content?.repository?.labels?.nodes;
  const added = wanted.filter((name) => !current.some((l) => l.name === name)).map((name) => idOf(known, (l) => l.name, name, 'a label of the repository'));
  const removed = current.filter((l) => !wanted.includes(l.name)).map((l) => idOf([l], (x) => x.name, l.name, 'a label'));
  const write = (op: 'addLabelsToLabelable' | 'removeLabelsFromLabelable', ids: string[]): FieldMutation[] =>
    (ids.length === 0 ? [] : [{ query: labelsMutation(op, ids.length), variables: { labelableId: issueId, ...Object.fromEntries(ids.map((id, i) => [`l${i}`, id])) } }]);
  return [...write('addLabelsToLabelable', added), ...write('removeLabelsFromLabelable', removed)];
}

// The milestone and the issue type are the issue's, written on the issue, resolved against its repository
function issueWrite(node: GhItemFieldsNode, issueId: string, kind: 'MILESTONE' | 'ISSUE_TYPE', value: FieldValue): FieldMutation {
  const repo = node.content?.repository;
  if (kind === 'MILESTONE') {
    return value === null
      ? { query: CLEAR_MILESTONE, variables: { issueId } }
      : { query: SET_MILESTONE, variables: { issueId, milestoneId: idOf(repo?.milestones?.nodes, (m) => m.title, value, 'an open milestone') } };
  }
  return value === null
    ? { query: CLEAR_ISSUE_TYPE, variables: { issueId } }
    : { query: SET_ISSUE_TYPE, variables: { issueId, issueTypeId: idOf(repo?.issueTypes?.nodes, (t) => t.name, value, 'an issue type of the repository') } };
}

function projectWrite(f: GhProjectField, ids: Record<string, string>, value: FieldValue): FieldMutation {
  const name = f.name ?? '';
  if (!WRITABLE.has(f.dataType ?? '')) throw new Error(`"${name}" is read only`);
  if (value === null) return { query: CLEAR_FIELD, variables: ids };
  switch (f.dataType) {
    case 'SINGLE_SELECT': return { query: SET_OPTION, variables: { ...ids, singleSelectOptionId: idOf(f.options, (o) => o.name, value, `an option of "${name}"`) } };
    case 'ITERATION': return { query: SET_ITERATION, variables: { ...ids, iterationId: idOf(f.configuration?.iterations, (i) => i.title, value, `an iteration of "${name}"`) } };
    case 'NUMBER': return { query: SET_NUMBER, variables: { ...ids, number: numeric(name, value) } };
    case 'DATE': return { query: SET_DATE, variables: { ...ids, date: text(name, value) } };
    default: return { query: SET_TEXT, variables: { ...ids, text: text(name, value) } };
  }
}

/** The mutations one write sends (#686), every name resolved to its id first: a field, option, iteration, milestone, issue type, login or label with no
 * match throws before anything is sent. */
export function writesFor(node: GhItemFieldsNode, field: string, value: FieldValue): FieldMutation[] {
  const f = (node.project?.fields?.nodes ?? []).find((n) => n.name === field);
  if (!node.project || f?.id === undefined) throw new Error(`"${field}" is not a field of the project`);
  const issueId = node.content?.__typename === 'Issue' ? node.content.id : undefined;
  if (issueId === undefined) throw new Error('the item is not an issue');
  if (f.dataType === ASSIGNEES) return assigneeWrites(node, issueId, value);
  if (f.dataType === LABELS) return labelWrites(node, issueId, value);
  if (f.dataType === 'MILESTONE' || f.dataType === 'ISSUE_TYPE') return [issueWrite(node, issueId, f.dataType, value)];
  return [projectWrite(f, { projectId: node.project.id, itemId: node.id, fieldId: f.id }, value)];
}

/** An item's fields for its editors (#686). */
export async function readItemFields(gql: Gql, itemId: string, projectId: string): Promise<ItemField[]> {
  return itemFields(await readItem(gql, itemId, projectId));
}

/** #282: the editors' fields from the read model, when it holds the item and its repository's options; undefined sends the caller to the live read. */
export function storedItemFields(db: ReadModel, source: string, project: string, itemId: string): ItemField[] | undefined {
  const node = rebuildFieldsNode(db, source, project, itemId);
  return node === undefined ? undefined : itemFields(node);
}

// The item as it reads now: the fields, the native view row and the entry the next poll would list (none when it would not)
export async function reread(ctx: FieldsContext, itemId: string): Promise<FieldWrite> {
  const node = await readItem(ctx.gql, itemId, ctx.projectId);
  const row = projectItem(node, projectFields(node.project?.fields?.nodes ?? []), ctx.read);
  if (row === undefined) throw new Error(`item ${itemId} is not an issue`);
  const entry = await ctx.entry(node);
  await ctx.answer?.(node); // #190: after entry, which read the relations the answer stores beside the row
  return { fields: itemFields(node), row, ...(entry === undefined ? {} : { entry }) };
}

// The mutations in order. They are not atomic (the assignees' second may fail after the first landed), so a failure re-reads the item and
// carries what it found: the caller shows the source's value, not the one the write meant. A failed re-read leaves the mutation's own error.
async function send(ctx: FieldsContext, itemId: string, mutations: FieldMutation[]): Promise<void> {
  try {
    for (const mutation of mutations) await ctx.gql(mutation.query, mutation.variables);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw await reread(ctx, itemId).then((written) => new PartialWriteError(message, written), () => err);
  }
}

/** A field write (#686). The ids resolve on a fresh read and the mutations go in order. Then the item is re-read for its fields, its native view
 * row and, through the poll's own steps, the entry the next poll would list (none when it would not). Last write wins: nothing is compared. A
 * mutation that fails throws a PartialWriteError with the re-read, when the re-read works. */
export async function writeItemField(ctx: FieldsContext, itemId: string, field: string, value: FieldValue): Promise<FieldWrite> {
  await send(ctx, itemId, writesFor(await readItem(ctx.gql, itemId, ctx.projectId), field, value));
  return reread(ctx, itemId);
}
