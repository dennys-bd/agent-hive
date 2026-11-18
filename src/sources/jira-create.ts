import { WireError } from '../read-model/normalize.js';
import { CreateRefusedError, IssuePlacementError } from '../source-create.js';
import type { CreatedRef, Source } from '../types.js';
import { markdownToAdf } from './adf-parse.js';
import { JiraHttpError, JiraNotFoundError } from './jira-fetch.js';
import type { JiraSourceConfig } from './jira-listing.js';
import { createIssue, isIssueRef, type JiraCall, type JiraIssueType, readIssue, readIssueTypes, readLabels, readStatuses } from './jira-queries.js';

// A Jira source's create (#831), out of jira.ts so it stays small: the checks before any write, the POST, then the placement the adapter hands
type CreateFields = Parameters<NonNullable<Source['create']>>[0];
type CreateOptions = Awaited<ReturnType<NonNullable<Source['createOptions']>>>;

const HTTP_BAD_REQUEST = 400;
const SUBTASK_LEVEL = -1; // Jira's hierarchyLevel: -1 a subtask, 0 a standard issue, 1 an epic
const EPIC_LEVEL = 1;
const WHITESPACE = /\s/;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface JiraCreateDeps {
  call: JiraCall;
  source: Pick<JiraSourceConfig, 'site' | 'project' | 'issueType' | 'subtaskType'>;
  place(itemId: string, status: string): Promise<void>; // the adapter's move: re-reads, stores and lists the new issue
}

interface Parent { id: string; key: string; level: number }

/** The levels of issues an issue of Jira's hierarchy `level` takes under it (#832): 2 under an epic, 1 under a standard issue, 0 under a
 * subtask; undefined above the epic (an Advanced Roadmaps level), which 6.5 leaves out of the tree too. */
export const depthUnder = (level: number): number | undefined => (level >= SUBTASK_LEVEL && level <= EPIC_LEVEL ? level + 1 : undefined);

// One rule for the create and the decomposition's depth check (#832), so the two never disagree on what goes under a parent
function depthOf(parent: Parent): number {
  const depth = depthUnder(parent.level);
  if (depth === undefined) throw new CreateRefusedError(`${parent.key} is at hierarchy level ${parent.level}: the Hive creates nothing under it`);
  return depth;
}

/** Source.createDepth (#832): from the stored level when the adapter has the row, else read live as a create's parent is. */
export async function jiraCreateDepth(call: JiraCall, id: string, stored?: { key: string; level: number }): Promise<number> {
  return depthOf(stored === undefined ? await readParent(call, id) : { id, ...stored });
}

// Jira has no "off the Project", and answers 400 for a label with a space: both refused before any call
function columnOf(fields: CreateFields): string {
  if (fields.column === null) throw new CreateRefusedError('a Jira issue always has a status');
  const spaced = fields.labels.find((l) => WHITESPACE.test(l));
  if (spaced !== undefined) throw new CreateRefusedError(`label "${spaced}" has a space: Jira labels cannot`);
  return fields.column;
}

// Read live: an epic under epics: hide is no task and is still a parent, and a gone one is a refusal with nothing written
async function readParent(call: JiraCall, id: string): Promise<Parent> {
  // a malformed id would fail in issuePath as a plain error, a 502; it is the caller's input, so a 400 with nothing sent
  if (!isIssueRef(id)) throw new CreateRefusedError(`parent ${id} is not a Jira issue id or key`);
  const read = await readIssue(call, id).catch((err: unknown) => {
    throw err instanceof JiraNotFoundError ? new CreateRefusedError(`parent ${id} is not an issue Jira has`) : err;
  });
  const type = read.issue.fields.issuetype;
  const level = typeof type === 'object' && type !== null && !Array.isArray(type) ? (type as Record<string, unknown>).hierarchyLevel : undefined;
  if (typeof level !== 'number') throw new WireError('jira issue issuetype hierarchyLevel');
  return { id: read.issue.id ?? id, key: read.issue.key ?? id, level };
}

// The type asked for, else the source's own for where the issue goes; checked against the project's types and one level under the parent
function typeFor(types: readonly JiraIssueType[], fields: CreateFields, source: JiraCreateDeps['source'], parent: Parent | undefined): JiraIssueType {
  if (parent !== undefined && depthOf(parent) === 0) throw new CreateRefusedError(`${parent.key} is a subtask: nothing can be created under it`);
  const expected = parent === undefined ? undefined : parent.level - 1;
  const name = fields.issueType ?? (expected === SUBTASK_LEVEL ? source.subtaskType : source.issueType);
  const type = types.find((t) => t.name === name);
  // when the name is the source's own default, say so: the fix is in Settings, not in the request
  const whose = fields.issueType === undefined ? `the source's ${expected === SUBTASK_LEVEL ? 'subtaskType' : 'issueType'} ` : '';
  if (type === undefined) throw new CreateRefusedError(`${whose}issue type "${name}" is not one of ${source.project}'s: ${types.map((t) => t.name).join(', ')}`);
  if (parent === undefined && type.hierarchyLevel === SUBTASK_LEVEL) throw new CreateRefusedError(`issue type "${name}" needs a parent`);
  if (parent !== undefined && type.hierarchyLevel !== expected) {
    const takes = types.filter((t) => t.hierarchyLevel === expected).map((t) => t.name).join(', ');
    throw new CreateRefusedError(`issue type "${name}" cannot go under ${parent.key}: it takes ${takes}`);
  }
  return type;
}

// A 400 on the POST created nothing (a required field, a type the screen refuses): a refusal, not a retry. The transport keeps only the
// errors object's keys (field ids), never Jira's words, so those are what the line names
function refused(err: unknown): never {
  if (err instanceof JiraHttpError && err.status === HTTP_BAD_REQUEST) {
    throw new CreateRefusedError(err.errorKeys.length === 0 ? 'Jira refused the issue' : `Jira refused the issue: ${err.errorKeys.join(', ')}`);
  }
  throw err;
}

/** A new issue in the source's project (#831), checked before any write, then placed in `column`. Nothing is rolled back: a failure once the
 * issue exists is an IssuePlacementError carrying its ref, so no retry makes a second one. Required custom fields are not sent: Jira's 400
 * reaches the user as the dialog's refused line. */
export async function createJiraIssue({ call, source, place }: JiraCreateDeps, fields: CreateFields): Promise<{ itemId: string; ref: CreatedRef }> {
  const column = columnOf(fields);
  const types = await readIssueTypes(call, source.project);
  const parent = fields.parent === undefined ? undefined : await readParent(call, fields.parent);
  const type = typeFor(types, fields, source, parent);
  const body = fields.body ?? '';
  const made = await createIssue(call, {
    project: { key: source.project }, summary: fields.title, issuetype: { id: type.id }, labels: fields.labels,
    ...(body === '' ? {} : { description: markdownToAdf(body) }), ...(parent === undefined ? {} : { parent: { id: parent.id } }),
  }).catch(refused);
  const ref = { id: made.key, url: `https://${source.site}/browse/${encodeURIComponent(made.key)}` };
  try {
    await place(made.id, column); // POST /issue leaves it in the workflow's first status
  } catch (err) {
    throw new IssuePlacementError(`issue ${made.key} was created but did not reach "${column}": ${errorMessage(err)}`, ref);
  }
  return { itemId: made.id, ref };
}

/** The create dialog's menus for a Jira source (#831), read live: the dialog asks once per source picked. Types keep the project's order. */
export async function readJiraCreateOptions(call: JiraCall, project: string): Promise<CreateOptions> {
  const [statuses, labels, types] = await Promise.all([readStatuses(call, project), readLabels(call), readIssueTypes(call, project)]);
  return { statuses: statuses.map((s) => s.name), labels, issueTypes: types.map((t) => ({ name: t.name, level: t.hierarchyLevel })) };
}
