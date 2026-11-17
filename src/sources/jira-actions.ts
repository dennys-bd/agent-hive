import { errorKeysOf, JiraHttpError } from './jira-fetch.js';
import { issuePath, type JiraCall, type JiraIssue } from './jira-queries.js';

// The writes of a Jira source's actions (#823), out of jira.ts so it stays under 400 lines. jira-queries.ts holds the reads.
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
// Jira's error keys for the refusals a user can act on (PUT /issue/archive): off Premium and Enterprise, and a subtask asked alone
const REFUSALS: Readonly<Record<string, string>> = {
  issuesInUnlicensedProjects: 'this site\'s plan does not archive issues (Jira Premium or Enterprise)',
  issueIsSubtask: 'a subtask is archived only with its parent',
};
const NEEDS_ADMIN = 'archiving needs a Jira admin or site admin';

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const refusalOf = (keys: readonly string[]): string | undefined => {
  const key = keys.find((k) => Object.hasOwn(REFUSALS, k));
  return key === undefined ? undefined : REFUSALS[key];
};

function refusalOfError(err: unknown): string | undefined {
  if (!(err instanceof JiraHttpError)) return undefined;
  if (err.status === FORBIDDEN) return NEEDS_ADMIN;
  return err.status === BAD_REQUEST ? refusalOf(err.errorKeys) : undefined;
}

/** The ids of an issue's subtasks, as a read answers fields.subtasks; anything else is skipped. */
export function subtaskIds(issue: JiraIssue): string[] {
  const { subtasks } = issue.fields;
  if (!Array.isArray(subtasks)) return [];
  return subtasks.flatMap((s: unknown) => (isJson(s) && typeof s.id === 'string' ? [s.id] : []));
}

/** Deletes the issue for good. The flag is required: Jira refuses (400) to delete an issue that has subtasks without it. */
export async function deleteIssue(call: JiraCall, id: string): Promise<void> {
  await call(`${issuePath(id)}?deleteSubtasks=true`, { method: 'DELETE' });
}

/** Archives the issue (and Jira its subtasks with it). A refusal the user can act on rejects naming the key; any other error is rethrown as is. */
export async function archiveIssue(call: JiraCall, id: string, key: string): Promise<void> {
  let answer: unknown;
  try {
    answer = await call('/issue/archive', { method: 'PUT', body: JSON.stringify({ issueIdsOrKeys: [id] }) });
  } catch (err) {
    const reason = refusalOfError(err);
    if (reason === undefined) throw err;
    throw new Error(`${key}: ${reason}`);
  }
  // a 200 also carries per-issue errors: one that archived nothing is a refusal too
  if (!isJson(answer) || answer.numberOfIssuesUpdated !== 0) return;
  throw new Error(`${key}: ${refusalOf(errorKeysOf(answer)) ?? 'Jira archived nothing'}`);
}
