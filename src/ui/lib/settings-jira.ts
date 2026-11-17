// A Jira source's draft and its pure edges (#822), out of settings-form.ts, which is near 400 lines. Pure, so node:test checks it.
import type { JiraIssueType, JiraLinkType, JiraProject } from '../../sources/jira-queries.js';
import type { SourceFields } from '../../types.js';

export type { JiraIssueType, JiraLinkType, JiraProject };
type JiraFields = Extract<SourceFields, { type: 'jira' }>;

/** The jira member's own keys as the form edits them (#822): filled on a Jira row, ignored on a GitHub one, as owner and number are on a Jira row. */
export type JiraDraft = Pick<JiraFields, 'site' | 'project' | 'tree' | 'blockingLinkTypes' | 'issueType' | 'subtaskType' | 'doneStatus'>;

// Both tree levels on: a new Jira source's default (#822, criterion 4); only ever spread, never edited in place
export const EMPTY_JIRA: JiraDraft = { site: '', project: '', tree: { epics: true, subtasks: true }, blockingLinkTypes: [], issueType: '', subtaskType: '', doneStatus: '' };

export const jiraDraft = ({ site, project, tree, blockingLinkTypes, issueType, subtaskType, doneStatus }: JiraFields): JiraDraft =>
  ({ site, project, tree, blockingLinkTypes, issueType, subtaskType, doneStatus });

/** Whether the row names a site and a project: what every project-keyed read needs. */
export const isJiraChosen = ({ site, project }: Pick<JiraDraft, 'site' | 'project'>): boolean => site !== '' && project !== '';

const query = (params: Record<string, string>): string => new URLSearchParams(params).toString();
export const jiraProjectsUrl = (site: string): string => `/settings/jira/projects?${query({ site })}`;
export const jiraLinkTypesUrl = (site: string): string => `/settings/jira/link-types?${query({ site })}`;
export const jiraIssueTypesUrl = ({ site, project }: Pick<JiraDraft, 'site' | 'project'>): string => `/settings/jira/issue-types?${query({ site, project })}`;
// #821: the two routes GitHub shares take type=jira; the Jira-only ones need no type
export const jiraColumnsUrl = ({ site, project }: Pick<JiraDraft, 'site' | 'project'>): string => `/settings/source-columns?${query({ type: 'jira', site, project })}`;
export const jiraFilterOptionsUrl = ({ site, project }: Pick<JiraDraft, 'site' | 'project'>): string => `/settings/filter-options?${query({ type: 'jira', site, project })}`;

/** What a Jira read's failure shows (#822): the copy is the UI's, never the server's message. */
export type JiraReadError = { kind: 'not-connected' } | { kind: 'rate-limited'; resetsAt: string } | { kind: 'failed' };

const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;

// parseJson's rejection carries the status and the body (api.ts); anything else, a network failure included, is failed
export function jiraReadError(err: unknown): JiraReadError {
  const { status, body } = (typeof err === 'object' && err !== null ? err : {}) as { status?: unknown; body?: { error?: unknown; resetsAt?: unknown } };
  if (status === HTTP_CONFLICT && body?.error === 'not-connected') return { kind: 'not-connected' };
  if (status === HTTP_TOO_MANY_REQUESTS) return { kind: 'rate-limited', resetsAt: typeof body?.resetsAt === 'string' ? body.resetsAt : '' };
  return { kind: 'failed' };
}

/** A select's values: the saved one first while the options load, then the listed ones, each once (as RepositoryRow keeps its repository). */
export const withCurrent = (current: string, listed: readonly string[]): string[] => [...new Set([...(current === '' ? [] : [current]), ...listed])];
