import { WireError } from '../read-model/normalize.js';
import { arrayAt, ISSUE_REF, issueAt, issuePath, type Json, type JiraCall, type JiraFieldMeta, type JiraIssue, type JiraSchema, MAX_PAGES, metaOf, PAGE_SIZE, PROJECT_KEY, recordAt, schemaOf, textAt } from './jira-queries.js';

// The reads and the write behind the fields panel (#826), apart from jira-queries.ts to keep each file one concern and under its size cap
export const EDIT_FIELDS = '*all';
export const EDIT_EXPAND = 'editmeta,names,schema';

/** An allowed value of a choice (#826): its id and what the panel shows, its `value`, else its `name`. */
export interface JiraAllowed { id: string; label: string }
/** One field of the issue's edit screen, in the screen's order. */
export interface JiraEditable { id: string; name: string; schema: JiraSchema | null; required: boolean; operations: string[]; allowedValues: JiraAllowed[] }
export interface JiraEditRead extends JiraFieldMeta { issue: JiraIssue; editable: JiraEditable[] }
export interface JiraUser { accountId: string; displayName: string }
export interface JiraSprint { id: number; name: string; state: string }

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function allowedChoicesOf(value: unknown): JiraAllowed[] {
  return (Array.isArray(value) ? value : []).flatMap((v): JiraAllowed[] => {
    if (!isJson(v) || typeof v.id !== 'string') return [];
    const label = typeof v.value === 'string' ? v.value : v.name;
    return typeof label === 'string' ? [{ id: v.id, label }] : [];
  });
}

// Lenient as metaOf: an entry it cannot read is dropped, and the field then reads as one the account cannot edit
function editableOf(json: Json): JiraEditable[] {
  const fields = isJson(json.editmeta) && isJson(json.editmeta.fields) ? json.editmeta.fields : {};
  return Object.entries(fields).flatMap(([id, raw]): JiraEditable[] => {
    if (!isJson(raw)) return [];
    const operations = Array.isArray(raw.operations) ? raw.operations.filter((o): o is string => typeof o === 'string') : [];
    return [{ id, name: typeof raw.name === 'string' ? raw.name : id, schema: schemaOf(raw.schema) ?? null, required: raw.required === true, operations, allowedValues: allowedChoicesOf(raw.allowedValues) }];
  });
}

/** #826: the fields panel's one read: every field's value, names and schema, and the edit screen in its order. */
export async function readEditable(call: JiraCall, id: string): Promise<JiraEditRead> {
  const query = new URLSearchParams({ fields: EDIT_FIELDS, expand: EDIT_EXPAND });
  const json = recordAt(await call(`${issuePath(id)}?${query}`), 'jira issue');
  return { issue: issueAt(json, 'jira issue'), ...metaOf(json), editable: editableOf(json) };
}

function userOf(value: unknown): JiraUser {
  const user = recordAt(value, 'jira assignable');
  return { accountId: textAt(user, 'accountId', 'jira assignable'), displayName: textAt(user, 'displayName', 'jira assignable') };
}

/** Every user the issue can be assigned to, with the account id a write names (readAssignable, #821, answers only the names of a project);
 * paged by startAt until a short page, and MAX_PAGES bounds a server that never ends it. */
export async function readAssignableUsers(call: JiraCall, key: string): Promise<JiraUser[]> {
  if (!ISSUE_REF.test(key)) throw new Error('jira issue id or key is not one');
  const users: JiraUser[] = [];
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const query = new URLSearchParams({ issueKey: key, startAt: String(users.length), maxResults: String(PAGE_SIZE) });
    const page = arrayAt(await call(`/user/assignable/search?${query}`), 'jira assignable').map(userOf);
    users.push(...page);
    if (page.length < PAGE_SIZE) return users;
  }
  throw new WireError('jira assignable page count');
}

// The Agile API's paging: values until isLast, startAt advanced by what came
async function agileValues(agile: JiraCall, path: string, params: Record<string, string>, what: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = recordAt(await agile(`${path}?${new URLSearchParams({ ...params, startAt: String(values.length) })}`), what);
    const read = arrayAt(page.values, what);
    values.push(...read);
    if (page.isLast === true || read.length === 0) return values;
  }
  throw new WireError(`${what} page count`);
}

function idAt(json: Json, what: string): number {
  if (typeof json.id !== 'number' || !Number.isInteger(json.id)) throw new WireError(`${what} id`);
  return json.id;
}

function sprintOf(value: unknown): JiraSprint {
  const sprint = recordAt(value, 'jira sprints');
  return { id: idAt(sprint, 'jira sprint'), name: textAt(sprint, 'name', 'jira sprint'), state: textAt(sprint, 'state', 'jira sprint') };
}

/** The active and future sprints of the project's scrum boards (#826), each once by id, active first, else in Jira's order. */
export async function readSprints(agile: JiraCall, project: string): Promise<JiraSprint[]> {
  if (!PROJECT_KEY.test(project)) throw new Error('jira project key is not a Jira key');
  const boards = (await agileValues(agile, '/board', { projectKeyOrId: project, type: 'scrum' }, 'jira boards')).map((b) => idAt(recordAt(b, 'jira boards'), 'jira board'));
  const all: JiraSprint[] = [];
  for (const board of boards) all.push(...(await agileValues(agile, `/board/${board}/sprint`, { state: 'active,future' }, 'jira sprints')).map(sprintOf));
  const once = all.filter((s, i) => all.findIndex((o) => o.id === s.id) === i);
  return [...once.filter((s) => s.state === 'active'), ...once.filter((s) => s.state !== 'active')];
}

/** #826: one field write; Jira answers 204, and its refusal is the transport's JiraBadRequestError. */
export async function putFields(call: JiraCall, id: string, fields: Record<string, unknown>): Promise<void> {
  await call(issuePath(id), { method: 'PUT', body: JSON.stringify({ fields }) });
}
