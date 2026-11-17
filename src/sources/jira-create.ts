import { WireError } from '../read-model/normalize.js';
import { CreateRefusedError, IssuePlacementError } from '../source-create.js';
import type { CreatedRef, Source } from '../types.js';
import { markdownToAdf } from './adf-parse.js';
import { JiraNotFoundError } from './jira-fetch.js';
import type { JiraSourceConfig } from './jira-listing.js';
import { createIssue, type JiraCall, type JiraIssueType, readIssue, readIssueTypes, readLabels, readStatuses } from './jira-queries.js';

// A Jira source's create (#831), out of jira.ts so it stays small: the checks before any write, the POST, then the placement the adapter hands
type CreateFields = Parameters<NonNullable<Source['create']>>[0];
type CreateOptions = Awaited<ReturnType<NonNullable<Source['createOptions']>>>;

const SUBTASK_LEVEL = -1; // Jira's hierarchyLevel: -1 a subtask, 0 a standard issue, 1 an epic
const WHITESPACE = /\s/;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface JiraCreateDeps {
  call: JiraCall;
  source: Pick<JiraSourceConfig, 'site' | 'project' | 'issueType' | 'subtaskType'>;
  place(itemId: string, status: string): Promise<void>; // the adapter's move: re-reads, stores and lists the new issue
}

interface Parent { id: string; key: string; level: number }

// Jira has no "off the Project", and answers 400 for a label with a space: both refused before any call
function columnOf(fields: CreateFields): string {
  if (fields.column === null) throw new CreateRefusedError('a Jira issue always has a status');
  const spaced = fields.labels.find((l) => WHITESPACE.test(l));
  if (spaced !== undefined) throw new CreateRefusedError(`label "${spaced}" has a space: Jira labels cannot`);
  return fields.column;
}

// Read live: an epic under epics: hide is no task and is still a parent, and a gone one is a refusal with nothing written
async function readParent(call: JiraCall, id: string): Promise<Parent> {
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
  if (parent?.level === SUBTASK_LEVEL) throw new CreateRefusedError(`${parent.key} is a subtask: nothing can be created under it`);
  const expected = parent === undefined ? undefined : parent.level - 1;
  const name = fields.issueType ?? (expected === SUBTASK_LEVEL ? source.subtaskType : source.issueType);
  const type = types.find((t) => t.name === name);
  if (type === undefined) throw new CreateRefusedError(`issue type "${name}" is not one of ${source.project}'s: ${types.map((t) => t.name).join(', ')}`);
  if (parent === undefined && type.hierarchyLevel === SUBTASK_LEVEL) throw new CreateRefusedError(`issue type "${name}" needs a parent`);
  if (parent !== undefined && type.hierarchyLevel !== expected) {
    const takes = types.filter((t) => t.hierarchyLevel === expected).map((t) => t.name).join(', ');
    throw new CreateRefusedError(`issue type "${name}" cannot go under ${parent.key}: it takes ${takes}`);
  }
  return type;
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
  });
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
